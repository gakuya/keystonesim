#!/usr/bin/env python3
"""
画面回転テスト（Playwright / Chromium ヘッドレス）

スマートフォンの回転を「ビューポートの縦横入れ替え」で再現し、

  1) 回転後もレイアウトが 1 画面に収まる（スクロールが出ない）
  2) 回転後もキャンバスがステージ内に収まる（はみ出さない）
  3) 回転後も映像が余白だらけにならない（ステージ占有率）
  4) 回転しても設定（モード・角度）が保持される
  5) 回転を繰り返しても破綻しない
  6) 回転後もプレビューの変形が正しい

を検証する。カメラトラックの解像度は端末のように
「回転しても変わらない」挙動を再現する。
"""

import sys

from playwright.sync_api import sync_playwright

URL = "http://localhost:3000/"

# 仮想カメラ。
# 実機のカメラと同様に applyConstraints() で解像度（＝縦横）が切り替わり、
# 切り替え後もテーブル全体が画角に収まった映像を返す。
FAKE_CAMERA = r"""
(() => {
  let W = window.__CAM_W__ || 1280, H = window.__CAM_H__ || 720;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // 現在のフレームサイズに対する台形（常に画角いっぱいに収まる）
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
    const m = Geometry.squareToQuad(quad(window.__FAKE_ELEV__ || 45, 0.35));
    const N = 4;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const p = [[c/N, r/N], [(c+1)/N, r/N], [(c+1)/N, (r+1)/N], [c/N, (r+1)/N]]
        .map(uv => Geometry.applyMatrix(m, uv[0], uv[1]));
      ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y);
      ctx.closePath();
      ctx.fillStyle = ((r + c) % 2 === 0) ? '#e8e8e8' : '#1d6fd0';
      ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  draw();

  const stream = cv.captureStream(30);
  const track = stream.getVideoTracks()[0];

  track.getSettings = () =>
    ({ deviceId: 'fake-cam-1', facingMode: 'environment', width: W, height: H });

  // 実機のカメラと同じく、要求された向き・解像度へ再構成する。
  // captureStream のトラックは canvas のサイズに追従するため、
  // 本物の applyConstraints は呼ばず（Chromium では canvas 側と
  // 競合して正方形に丸められてしまう）canvas の寸法だけを変更する。
  track.applyConstraints = (c) => {
    const w = c && c.width && (c.width.ideal || c.width.exact);
    const h = c && c.height && (c.height.ideal || c.height.exact);
    if (w && h) {
      W = w; H = h;
      cv.width = W; cv.height = H;   // 画角を保ったままフレームサイズを変更
      window.__CAM_APPLIED__ = (window.__CAM_APPLIED__ || 0) + 1;
    }
    return Promise.resolve();
  };

  navigator.mediaDevices.getUserMedia = () => Promise.resolve(stream);
  navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
    { kind: 'videoinput', deviceId: 'fake-cam-1', label: '仮想カメラ 1', groupId: 'g' }
  ]);
  window.__FAKE_READY__ = true;
})();
"""

ANALYZE = r"""
() => {
  const cv = document.getElementById('preview-canvas');
  const w = cv.width, h = cv.height;
  let buf, flipY = false;
  const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
  if (gl) {
    buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    flipY = true;
  } else {
    buf = cv.getContext('2d').getImageData(0, 0, w, h).data;
  }
  const px = (x, y) => {
    const yy = flipY ? (h - 1 - y) : y;
    const i = (yy * w + x) * 4;
    return [buf[i], buf[i+1], buf[i+2]];
  };
  const N = 4, grid = [];
  for (let r = 0; r < N; r++) {
    const row = [];
    for (let c = 0; c < N; c++) {
      let R=0,G=0,B=0,n=0;
      const cx = Math.round((c+0.5)*w/N), cy = Math.round((r+0.5)*h/N);
      for (let dy=-2; dy<=2; dy++) for (let dx=-2; dx<=2; dx++) {
        const p = px(cx+dx, cy+dy); R+=p[0]; G+=p[1]; B+=p[2]; n++;
      }
      R/=n; G/=n; B/=n;
      row.push(B > R + 25 ? 'blue' : (R > 150 ? 'light' : 'other'));
    }
    grid.push(row);
  }
  return grid;
}
"""

EXPECTED = [["light" if (r + c) % 2 == 0 else "blue" for c in range(4)] for r in range(4)]


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


def rotate(page, w, h):
    """ビューポートを入れ替えて回転を再現する"""
    page.set_viewport_size({"width": w, "height": h})
    page.evaluate(
        """([w, h]) => {
        // 実機と同じく screen.orientation / orientationchange も通知する
        const portrait = h > w;
        try {
            Object.defineProperty(screen.orientation, 'angle',
                { value: portrait ? 0 : 90, configurable: true });
            Object.defineProperty(screen.orientation, 'type',
                { value: portrait ? 'portrait-primary' : 'landscape-primary',
                  configurable: true });
        } catch (e) {}
        try {
            Object.defineProperty(window, 'orientation',
                { value: portrait ? 0 : 90, configurable: true });
        } catch (e) {}
        window.dispatchEvent(new Event('orientationchange'));
        if (screen.orientation && screen.orientation.dispatchEvent) {
            screen.orientation.dispatchEvent(new Event('change'));
        }
    }""",
        [w, h],
    )
    # 実装側の回転後リレイアウト待ち（orientationchange のディレイを含む）
    page.wait_for_timeout(900)


def metrics(page, canvas_id):
    return page.evaluate(
        """(id) => {
        const cv = document.getElementById(id);
        const st = document.getElementById('stage-inner');
        const c = cv.getBoundingClientRect(), s = st.getBoundingClientRect();
        return {
            cw: c.width, ch: c.height, sw: s.width, sh: s.height,
            overflowW: c.width - s.width, overflowH: c.height - s.height,
            fill: (c.width * c.height) / (s.width * s.height),
            docScrollW: document.documentElement.scrollWidth,
            docScrollH: document.body.scrollHeight,
            winW: window.innerWidth, winH: window.innerHeight,
            camW: document.getElementById('video').videoWidth,
            camH: document.getElementById('video').videoHeight
        };
    }""",
        canvas_id,
    )


def assert_sane(res, page, label, canvas_id):
    m = metrics(page, canvas_id)
    print(
        f"      [{label}] viewport={m['winW']:.0f}x{m['winH']:.0f} "
        f"canvas={m['cw']:.0f}x{m['ch']:.0f} stage={m['sw']:.0f}x{m['sh']:.0f} "
        f"cam={m['camW']}x{m['camH']} 占有率={m['fill']*100:.0f}%"
    )
    res.check(f"{label}: 横スクロールが出ない", m["docScrollW"] <= m["winW"] + 1,
              f"(scrollW={m['docScrollW']} > {m['winW']})")
    res.check(f"{label}: 縦スクロールが出ない", m["docScrollH"] <= m["winH"] + 2,
              f"(scrollH={m['docScrollH']} > {m['winH']})")
    res.check(f"{label}: キャンバスがステージ内に収まる",
              m["overflowW"] <= 1 and m["overflowH"] <= 1,
              f"(はみ出し {m['overflowW']:.0f}x{m['overflowH']:.0f}px)")
    res.check(f"{label}: 映像がステージを十分に使う（占有率45%以上）",
              m["fill"] >= 0.45, f"(占有率={m['fill']*100:.0f}%)")
    return m


def run():
    res = Result()
    P = {"width": 390, "height": 844}
    L = {"width": 844, "height": 390}

    with sync_playwright() as pw:
        b = pw.chromium.launch(
            args=[
                "--enable-unsafe-swiftshader",
                "--use-fake-ui-for-media-stream",
                "--autoplay-policy=no-user-gesture-required",
            ]
        )

        # ========== 縦持ちで開始 → 横へ回転 ==========
        print("\n\033[1m[1] 縦持ちで起動 → 横向きへ回転\033[0m")
        ctx = b.new_context(viewport=P, is_mobile=True, has_touch=True,
                            device_scale_factor=2)
        ctx.grant_permissions(["camera"])
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        # 縦持ち起動なので縦長の映像が得られる想定
        page.add_init_script("window.__CAM_W__=1080; window.__CAM_H__=1920;"
                             "window.__FAKE_ELEV__=60;")
        page.goto(URL)
        page.add_script_tag(content=FAKE_CAMERA)
        page.wait_for_function("window.__FAKE_READY__===true")
        page.click("#splash-start")
        page.wait_for_function("()=>document.getElementById('video').videoWidth>0",
                               timeout=10000)
        page.wait_for_timeout(800)

        assert_sane(res, page, "縦持ち", "setup-canvas")

        # 角度を変えてから回転し、状態保持を確認
        page.tap("#angle-btn")
        page.wait_for_timeout(200)
        angle_before = page.inner_text("#angle-chip")

        rotate(page, L["width"], L["height"])
        m = assert_sane(res, page, "横向き", "setup-canvas")
        res.check("回転でカメラが横長に再構成される", m["camW"] >= m["camH"],
                  f"(cam={m['camW']}x{m['camH']})")
        res.check("applyConstraints が呼ばれている",
                  (page.evaluate("window.__CAM_APPLIED__ || 0") or 0) >= 1)
        res.check("回転後も角度が保持される",
                  page.inner_text("#angle-chip") == angle_before,
                  f"({angle_before} -> {page.inner_text('#angle-chip')})")
        res.check("回転後も設定モードのまま",
                  page.inner_text("#mode-chip") == "設定モード")

        # ========== 横のままプレビューへ ==========
        print("\n\033[1m[2] 横向きでプレビュー\033[0m")
        page.tap("#mode-btn")
        page.wait_for_timeout(700)
        assert_sane(res, page, "横/プレビュー", "preview-canvas")
        g = page.evaluate(ANALYZE)
        m = sum(1 for r in range(4) for c in range(4) if g[r][c] == EXPECTED[r][c])
        res.check("横向きでも平面に変形される", m >= 14, f"(一致={m}/16)")

        # ========== 縦へ戻す ==========
        print("\n\033[1m[3] プレビュー中に縦へ戻す\033[0m")
        rotate(page, P["width"], P["height"])
        m = assert_sane(res, page, "縦/プレビュー", "preview-canvas")
        res.check("縦に戻すとカメラが縦長に再構成される", m["camH"] >= m["camW"],
                  f"(cam={m['camW']}x{m['camH']})")
        res.check("回転後もプレビューモードのまま",
                  page.inner_text("#mode-chip") == "プレビューモード")
        g = page.evaluate(ANALYZE)
        m = sum(1 for r in range(4) for c in range(4) if g[r][c] == EXPECTED[r][c])
        res.check("縦に戻しても平面に変形される", m >= 14, f"(一致={m}/16)")

        # ========== 連続回転 ==========
        print("\n\033[1m[4] 連続回転（5往復）\033[0m")
        for i in range(5):
            rotate(page, L["width"], L["height"])
            rotate(page, P["width"], P["height"])
        mm = metrics(page, "preview-canvas")
        res.check("連続回転後もスクロールが出ない",
                  mm["docScrollW"] <= mm["winW"] + 1 and mm["docScrollH"] <= mm["winH"] + 2,
                  f"(scroll={mm['docScrollW']}x{mm['docScrollH']})")
        res.check("連続回転後もキャンバスがステージ内",
                  mm["overflowW"] <= 1 and mm["overflowH"] <= 1,
                  f"(はみ出し {mm['overflowW']:.0f}x{mm['overflowH']:.0f})")
        res.check("連続回転後も占有率が保たれる", mm["fill"] >= 0.45,
                  f"(占有率={mm['fill']*100:.0f}%)")
        res.check("連続回転で JS エラーが出ない", len(errs) == 0, f"({errs[:2]})")

        # ========== 詳細設定パネルを開いたまま回転 ==========
        print("\n\033[1m[5] 詳細設定を開いたまま回転\033[0m")
        page.tap("#settings-btn")
        page.wait_for_timeout(400)
        res.check("パネルが開く", page.locator("#panel").is_visible())
        rotate(page, L["width"], L["height"])
        res.check("回転後もパネルが見える", page.locator("#panel").is_visible())
        pb = page.locator("#panel").bounding_box()
        vw, vh = page.evaluate("[window.innerWidth, window.innerHeight]")
        res.check("回転後もパネルが画面内に収まる",
                  pb["y"] >= -1 and pb["y"] + pb["height"] <= vh + 2
                  and pb["x"] >= -1 and pb["x"] + pb["width"] <= vw + 2,
                  f"(panel={pb['x']:.0f},{pb['y']:.0f} {pb['width']:.0f}x{pb['height']:.0f} "
                  f"vs {vw}x{vh})")
        res.check("回転後もパネル内がスクロール可能",
                  page.evaluate(
                      "() => { const b = document.querySelector('.panel-body');"
                      "return b.scrollHeight <= b.clientHeight ||"
                      " getComputedStyle(b).overflowY === 'auto'; }"))
        page.tap("#panel-close")
        page.wait_for_timeout(300)

        # ========== 横持ちで起動するケース ==========
        print("\n\033[1m[6] 横持ちで起動（横長カメラ）\033[0m")
        res.check("ここまで JS エラーなし", len(errs) == 0, f"({errs[:2]})")
        ctx.close()

        ctx = b.new_context(viewport=L, is_mobile=True, has_touch=True)
        ctx.grant_permissions(["camera"])
        page = ctx.new_page()
        errs2 = []
        page.on("pageerror", lambda e: errs2.append(str(e)))
        page.add_init_script("window.__CAM_W__=1920; window.__CAM_H__=1080;"
                             "window.__FAKE_ELEV__=45;")
        page.goto(URL)
        page.add_script_tag(content=FAKE_CAMERA)
        page.wait_for_function("window.__FAKE_READY__===true")
        page.click("#splash-start")
        page.wait_for_function("()=>document.getElementById('video').videoWidth>0",
                               timeout=10000)
        page.wait_for_timeout(800)
        assert_sane(res, page, "横持ち起動", "setup-canvas")

        rotate(page, P["width"], P["height"])
        assert_sane(res, page, "縦へ回転", "setup-canvas")
        res.check("横持ち起動→回転で JS エラーなし", len(errs2) == 0, f"({errs2[:2]})")
        ctx.close()

        b.close()

    print(f"\n{'=' * 52}")
    print(f"  成功 {res.ok} 件 / 失敗 {res.fail} 件")
    print(f"{'=' * 52}\n")
    return 0 if res.fail == 0 else 1


if __name__ == "__main__":
    sys.exit(run())
