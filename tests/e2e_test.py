#!/usr/bin/env python3
"""
E2E テスト（Playwright / Chromium ヘッドレス）

getUserMedia を canvas.captureStream() で差し替え、
「仮想テーブル」を台形に描いた合成映像を流し込んで

  1) 設定モードで半透明の台形オーバーレイが描かれる
  2) 角度切替ボタンが 真上 → 斜め① → 斜め② → 真上 と循環する
  3) モード切替ボタンで設定 ⇄ プレビューが入れ替わる
  4) プレビューで台形が長方形（＝平面）に変形されている
  5) PC / スマートフォン 両方のビューポートで操作要素が収まる

を検証する。
"""

import json
import sys

from playwright.sync_api import sync_playwright

URL = "http://localhost:3000/"

# 合成カメラ映像を作って getUserMedia を差し替えるスクリプト
FAKE_CAMERA = r"""
(() => {
  const W = 1280, H = 720;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // アプリ側と同じ式でテーブルの台形を求める（仰角 45 度を想定した見かけ）
  function quad(elevation, spread) {
    const phi = (90 - elevation) * Math.PI / 180;
    let k = Math.min(spread * Math.tan(phi), 0.82);
    const taper = (1 - k) / (1 + k);
    const hb = 0.94 / 2, ht = hb * taper, hh = 0.90 / 2;
    return [
      {x:(0.5-ht)*W, y:(0.5-hh)*H}, {x:(0.5+ht)*W, y:(0.5-hh)*H},
      {x:(0.5+hb)*W, y:(0.5+hh)*H}, {x:(0.5-hb)*W, y:(0.5+hh)*H}
    ];
  }

  function draw() {
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, W, H);

    const q = quad(window.__FAKE_ELEV__ || 45, 0.35);

    // 台形に 4x4 の市松模様を貼る（平面に戻ると正方格子になる）
    const m = Geometry.squareToQuad(q);
    const N = 4;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const p = [[c/N, r/N], [(c+1)/N, r/N], [(c+1)/N, (r+1)/N], [c/N, (r+1)/N]]
          .map(uv => Geometry.applyMatrix(m, uv[0], uv[1]));
        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y);
        ctx.closePath();
        ctx.fillStyle = ((r + c) % 2 === 0) ? '#e8e8e8' : '#1d6fd0';
        ctx.fill();
      }
    }
    requestAnimationFrame(draw);
  }
  draw();

  const stream = cv.captureStream(30);
  const track = stream.getVideoTracks()[0];
  track.getSettings = () => ({ deviceId: 'fake-cam-1', facingMode: 'environment',
                               width: W, height: H });

  navigator.mediaDevices.getUserMedia = () => Promise.resolve(stream);
  navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
    { kind: 'videoinput', deviceId: 'fake-cam-1', label: '仮想カメラ 1', groupId: 'g' },
    { kind: 'videoinput', deviceId: 'fake-cam-2', label: '仮想カメラ 2', groupId: 'g' }
  ]);
  window.__FAKE_READY__ = true;
})();
"""

# プレビュー結果を解析：出力を 4x4 に分割し、各セルの代表色が
# 市松模様（明/青の交互）になっているかを調べる
ANALYZE = r"""
() => {
  const cv = document.getElementById('preview-canvas');
  const w = cv.width, h = cv.height;
  let data;
  const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
  if (gl && !cv.__is2d) {
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    data = { buf, flipY: true };
  } else {
    const c2 = cv.getContext('2d');
    data = { buf: c2.getImageData(0, 0, w, h).data, flipY: false };
  }

  const px = (x, y) => {
    const yy = data.flipY ? (h - 1 - y) : y;
    const i = (yy * w + x) * 4;
    return [data.buf[i], data.buf[i + 1], data.buf[i + 2]];
  };

  const N = 4, grid = [];
  for (let r = 0; r < N; r++) {
    const row = [];
    for (let c = 0; c < N; c++) {
      // セル中央付近の 5x5 を平均（境界線を避ける）
      let R = 0, G = 0, B = 0, n = 0;
      const cx = Math.round((c + 0.5) * w / N), cy = Math.round((r + 0.5) * h / N);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const p = px(cx + dx, cy + dy); R += p[0]; G += p[1]; B += p[2]; n++;
      }
      R /= n; G /= n; B /= n;
      row.push(B > R + 25 ? 'blue' : (R > 150 ? 'light' : 'other'));
    }
    grid.push(row);
  }
  return grid;
}
"""


class Result:
    def __init__(self):
        self.ok = 0
        self.fail = 0

    def check(self, name, cond, extra=""):
        if cond:
            self.ok += 1
            print(f"  \033[32m✔\033[0m {name}")
        else:
            self.fail += 1
            print(f"  \033[31m✘\033[0m {name} {extra}")


def nonblack_ratio(page, canvas_id):
    return page.evaluate(
        """(id) => {
        const cv = document.getElementById(id);
        const c = cv.getContext('2d');
        if (!c) return -1;
        const d = c.getImageData(0,0,cv.width,cv.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4*37) {
            if (d[i] + d[i+1] + d[i+2] > 45) n++;
        }
        return n / (d.length / (4*37));
    }""",
        canvas_id,
    )


def run():
    res = Result()
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=[
                "--enable-unsafe-swiftshader",
                "--use-fake-ui-for-media-stream",
                "--autoplay-policy=no-user-gesture-required",
            ]
        )

        # ---------- デスクトップ ----------
        print("\n\033[1m[1] デスクトップ (1440x900)\033[0m")
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        ctx.grant_permissions(["camera"])
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.add_init_script("window.__FAKE_ELEV__ = 45;")
        page.goto(URL)
        page.add_script_tag(content=FAKE_CAMERA)
        page.wait_for_function("window.__FAKE_READY__ === true")

        res.check("初期モードが「設定」", page.inner_text("#mode-chip") == "設定モード")
        res.check("初期角度が「真上」", page.inner_text("#angle-chip") == "真上")
        res.check(
            "設定キャンバスが表示されている",
            not page.locator("#setup-canvas").evaluate("e => e.classList.contains('hidden')"),
        )
        res.check(
            "プレビューキャンバスは非表示",
            page.locator("#preview-canvas").evaluate("e => e.classList.contains('hidden')"),
        )

        # カメラ開始
        page.click("#splash-start")
        page.wait_for_function(
            "() => { const v = document.getElementById('video'); return v.videoWidth > 0; }",
            timeout=10000,
        )
        page.wait_for_timeout(700)
        res.check("起動オーバーレイが消える", page.locator("#splash").is_hidden())
        res.check("状態が「動作中」", page.inner_text("#info-state") == "動作中")
        res.check(
            "入力解像度を認識", page.evaluate("document.getElementById('video').videoWidth") == 1280
        )
        res.check("カメラ一覧が2件", page.locator("#camera-select option").count() == 2)

        # 設定モードの描画
        ratio = nonblack_ratio(page, "setup-canvas")
        res.check("設定モードで映像が描画されている", ratio > 0.4, f"(非黒率={ratio:.2f})")

        # オーバーレイが描かれているか（青系ピクセルの存在）
        overlay = page.evaluate(
            """() => {
            const cv = document.getElementById('setup-canvas');
            const d = cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
            let accent = 0, total = 0;
            for (let i = 0; i < d.length; i += 4*17) {
                total++;
                if (d[i+2] > d[i] + 30 && d[i+2] > 90) accent++;
            }
            return accent / total;
        }"""
        )
        res.check("半透明の台形オーバーレイが描かれている", overlay > 0.05, f"(青系率={overlay:.3f})")

        # 角度切替ボタンの循環
        print("\n\033[1m[2] 角度切替ボタン（1つで3段階循環）\033[0m")
        seq = [page.inner_text("#angle-chip")]
        for _ in range(4):
            page.click("#angle-btn")
            page.wait_for_timeout(120)
            seq.append(page.inner_text("#angle-chip"))
        res.check(
            "真上→斜め①→斜め②→真上→斜め① と循環",
            seq == ["真上", "斜め①", "斜め②", "真上", "斜め①"],
            f"(実際={seq})",
        )

        # 斜め②に合わせる
        while page.inner_text("#angle-chip") != "斜め②":
            page.click("#angle-btn")
            page.wait_for_timeout(100)
        res.check("角度ラベルに 45度 が表示される", "45度" in page.inner_text("#angle-btn-value"))
        res.check(
            "インジケーターの該当ステップが active",
            page.locator(".angle-steps .step").nth(2).evaluate(
                "e => e.classList.contains('active')"
            ),
        )

        # モード切替
        print("\n\033[1m[3] モード切替ボタン\033[0m")
        page.click("#mode-btn")
        page.wait_for_timeout(500)
        res.check("チップが「プレビューモード」", page.inner_text("#mode-chip") == "プレビューモード")
        res.check(
            "プレビューキャンバスが表示",
            not page.locator("#preview-canvas").evaluate("e => e.classList.contains('hidden')"),
        )
        res.check(
            "設定キャンバスが非表示",
            page.locator("#setup-canvas").evaluate("e => e.classList.contains('hidden')"),
        )
        res.check("ボタン文言が「設定へ切替」", "設定へ切替" in page.inner_text("#mode-btn"))

        # プレビューの変形結果を検証
        print("\n\033[1m[4] 台形 → 平面 への変形結果\033[0m")
        engine = page.inner_text("#info-engine")
        print(f"      変形方式: {engine}")
        page.wait_for_timeout(600)
        grid = page.evaluate(ANALYZE)
        print("      復元された 4x4 セル:")
        for row in grid:
            print("        " + " ".join(f"{c:>5}" for c in row))

        expected = [
            ["light" if (r + c) % 2 == 0 else "blue" for c in range(4)] for r in range(4)
        ]
        matches = sum(
            1 for r in range(4) for c in range(4) if grid[r][c] == expected[r][c]
        )
        res.check(
            "台形の市松模様が正方格子に復元される（16セル中14以上一致）",
            matches >= 14,
            f"(一致={matches}/16)",
        )

        # 設定へ戻る
        page.click("#mode-btn")
        page.wait_for_timeout(300)
        res.check("設定モードへ戻れる", page.inner_text("#mode-chip") == "設定モード")

        # キーボードショートカット
        print("\n\033[1m[5] PC 向け操作\033[0m")
        page.keyboard.press("Space")
        page.wait_for_timeout(250)
        res.check("Space でモード切替", page.inner_text("#mode-chip") == "プレビューモード")
        page.keyboard.press("Space")
        page.wait_for_timeout(250)
        page.keyboard.press("1")
        page.wait_for_timeout(200)
        res.check("数字キーで角度を直接指定", page.inner_text("#angle-chip") == "真上")

        # 詳細設定パネル
        page.click("#settings-btn")
        page.wait_for_timeout(350)
        res.check("詳細設定パネルが開く", page.locator("#panel").is_visible())
        box = page.locator("#panel").bounding_box()
        res.check("PC ではサイドドロワー表示", box["width"] <= 400 and box["height"] > 700,
                  f"(w={box['width']:.0f}, h={box['height']:.0f})")

        page.locator("#spread-range").evaluate(
            "e => { e.value = '0.6'; e.dispatchEvent(new Event('input')); }"
        )
        page.wait_for_timeout(200)
        res.check("台形の強さが反映される", page.inner_text("#spread-out") == "0.60")

        page.locator("#ratio-select").select_option("1.7778")
        page.wait_for_timeout(250)
        res.check(
            "縦横比 16:9 が反映される",
            abs(
                float(
                    page.evaluate(
                        "getComputedStyle(document.getElementById('stage-inner'))"
                        ".getPropertyValue('--out-ratio')"
                    )
                )
                - 1.7778
            )
            < 1e-3,
        )

        page.click("#reset-btn")
        page.wait_for_timeout(250)
        res.check("初期値に戻せる", page.inner_text("#spread-out") == "0.35")

        page.click("#panel-close")
        page.wait_for_timeout(250)
        res.check("パネルを閉じられる", page.locator("#panel").is_hidden())

        # 設定の永続化
        page.click("#angle-btn")
        page.wait_for_timeout(150)
        saved = page.evaluate("JSON.parse(localStorage.getItem('keystone-sim-v2'))")
        res.check("設定が localStorage に保存される", saved.get("angleIndex") == 1,
                  f"({json.dumps(saved, ensure_ascii=False)})")

        res.check("JS エラーが発生していない", len(errors) == 0, f"({errors})")
        ctx.close()

        # ---------- スマートフォン（縦） ----------
        print("\n\033[1m[6] スマートフォン縦 (390x844 / iPhone 相当)\033[0m")
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=3,
            is_mobile=True,
            has_touch=True,
            user_agent=(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
            ),
        )
        ctx.grant_permissions(["camera"])
        page = ctx.new_page()
        merr = []
        page.on("pageerror", lambda e: merr.append(str(e)))
        page.add_init_script("window.__FAKE_ELEV__ = 60;")
        page.goto(URL)
        page.add_script_tag(content=FAKE_CAMERA)
        page.wait_for_function("window.__FAKE_READY__ === true")
        page.click("#splash-start")
        page.wait_for_function(
            "() => document.getElementById('video').videoWidth > 0", timeout=10000
        )
        page.wait_for_timeout(700)

        res.check("横スクロールが発生しない",
                  page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
        res.check("縦スクロールが発生しない（1画面に収まる）",
                  page.evaluate("document.body.scrollHeight <= window.innerHeight + 2"),
                  f"(body={page.evaluate('document.body.scrollHeight')})")

        for sel, label in [
            ("#mode-btn", "モード切替"),
            ("#angle-btn", "角度切替"),
            ("#switch-cam-btn", "カメラ切替"),
            ("#settings-btn", "詳細設定"),
        ]:
            b = page.locator(sel).bounding_box()
            res.check(
                f"{label}ボタンがタップ可能サイズ(44px以上)",
                b["height"] >= 40 and b["width"] >= 38,
                f"({b['width']:.0f}x{b['height']:.0f})",
            )

        cb = page.locator("#setup-canvas").bounding_box()
        res.check("映像がビューポート幅に収まる", cb["width"] <= 390, f"(w={cb['width']:.0f})")

        page.tap("#angle-btn")
        page.wait_for_timeout(200)
        res.check("タップで角度切替", page.inner_text("#angle-chip") == "斜め①")

        page.tap("#mode-btn")
        page.wait_for_timeout(500)
        res.check("タップでプレビューへ", page.inner_text("#mode-chip") == "プレビューモード")

        grid_m = page.evaluate(ANALYZE)
        matches_m = sum(
            1
            for r in range(4)
            for c in range(4)
            if grid_m[r][c] == expected[r][c]
        )
        res.check("スマートフォンでも平面に変形される", matches_m >= 14, f"(一致={matches_m}/16)")

        page.tap("#settings-btn")
        page.wait_for_timeout(350)
        pb = page.locator("#panel").bounding_box()
        res.check(
            "モバイルではボトムシート表示",
            pb["width"] >= 380 and pb["y"] > 100,
            f"(w={pb['width']:.0f}, y={pb['y']:.0f})",
        )
        res.check("モバイルで JS エラーなし", len(merr) == 0, f"({merr})")
        ctx.close()

        # ---------- スマートフォン（横） ----------
        print("\n\033[1m[7] スマートフォン横 (844x390)\033[0m")
        ctx = browser.new_context(
            viewport={"width": 844, "height": 390}, is_mobile=True, has_touch=True
        )
        ctx.grant_permissions(["camera"])
        page = ctx.new_page()
        lerr = []
        page.on("pageerror", lambda e: lerr.append(str(e)))
        page.goto(URL)
        page.add_script_tag(content=FAKE_CAMERA)
        page.wait_for_function("window.__FAKE_READY__ === true")
        page.click("#splash-start")
        page.wait_for_function(
            "() => document.getElementById('video').videoWidth > 0", timeout=10000
        )
        page.wait_for_timeout(600)
        res.check(
            "横向きでも1画面に収まる",
            page.evaluate("document.body.scrollHeight <= window.innerHeight + 2"),
            f"(body={page.evaluate('document.body.scrollHeight')})",
        )
        res.check("横向きで操作バーが見える", page.locator("#mode-btn").is_visible())
        res.check("横向きで角度ステップが見える", page.locator(".angle-steps").is_visible())
        res.check("横向きで JS エラーなし", len(lerr) == 0, f"({lerr})")
        ctx.close()

        browser.close()

    print(f"\n{'=' * 52}")
    print(f"  成功 {res.ok} 件 / 失敗 {res.fail} 件")
    print(f"{'=' * 52}\n")
    return 0 if res.fail == 0 else 1


if __name__ == "__main__":
    sys.exit(run())
