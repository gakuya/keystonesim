/* =============================================================
 * geometry.js
 * 台形（カメラの斜め映像）と長方形（真上からの映像）を結ぶ
 * 射影変換（ホモグラフィ）の計算ユーティリティ
 * =============================================================
 *
 * ■ 考え方
 *   テーブル面（平面）をピンホールカメラで撮影した像は、
 *   平面 → 像平面 の「射影変換（homography）」で表せる。
 *   射影変換は 4 組の対応点で一意に決まるため、
 *   「映像内でテーブルが写っている四隅」を求められれば、
 *   それを長方形に戻す変換が確定する。
 *
 * ■ テーブル四隅の形（台形）の導出
 *   カメラ高さ h、焦点距離 f、鉛直（真下）からの傾き φ とすると、
 *   テーブル面の点 (X, Y) の像座標は
 *
 *       u = f·X / (Y·sinφ + h/cosφ)
 *       v = -f·Y·cosφ / (Y·sinφ + h/cosφ)
 *
 *   ここで像の垂直方向の視野角 β（光軸からの角度, 下向き正）に対し
 *   v = tanβ を代入して整理すると、その行での半幅は
 *
 *       u(β) ∝ cosφ · (1 + tanβ · tanφ)
 *
 *   という非常に簡単な式になる。
 *   テーブルが垂直視野角 ±α を占めるとすれば（p = tanα）、
 *
 *       上辺（奥）の半幅 ∝ 1 - p·tanφ
 *       下辺（手前）半幅 ∝ 1 + p·tanφ
 *       上下方向の半分  ∝ p
 *
 *   となり、「台形の強さ」は p（= spread）1 つで調整できる。
 *   φ = 0（真上）のとき上辺 = 下辺 となり長方形に戻る。
 * ============================================================= */

(function (global) {
  'use strict';

  /** カメラ角度プリセット（PDF 要件の 3 段階） */
  var ANGLE_PRESETS = [
    { id: 'top',   label: '真上',   detail: '90度', elevation: 90 },
    { id: 'tilt1', label: '斜め①', detail: '60度', elevation: 60 },
    { id: 'tilt2', label: '斜め②', detail: '45度', elevation: 45 }
  ];

  /* 枠が映像内で占める最大比率 */
  var FILL_X = 0.94;
  var FILL_Y = 0.90;

  var DEG = Math.PI / 180;

  /**
   * 台形の上辺／下辺の比（テーパー比）
   * @param {number} elevation テーブル面からのカメラ仰角（90 = 真上）
   * @param {number} spread    奥行き量 p = tanα
   * @returns {number} 上辺幅 / 下辺幅 （0〜1）
   */
  function taperRatio(elevation, spread) {
    var phi = (90 - elevation) * DEG;       // 鉛直からの傾き
    var k = spread * Math.tan(phi);
    // 数値安定化（上辺が潰れ切らないよう下限を設ける）
    k = Math.min(k, 0.82);
    return (1 - k) / (1 + k);
  }

  /**
   * 映像フレーム内の「テーブル台形」四隅を求める。
   * 戻り値は正規化座標（0〜1。x は左→右、y は上→下）。
   * 頂点順は 左上 → 右上 → 右下 → 左下。
   *
   * @param {Object} opt
   * @param {number} opt.elevation カメラ仰角（90/60/45）
   * @param {number} opt.spread    台形の強さ
   * @param {number} [opt.offsetY] 上下位置オフセット（-0.4〜0.4）
   * @returns {Array<{x:number,y:number}>}
   */
  function trapezoidNormalized(opt) {
    var spread = clamp(opt.spread == null ? 0.35 : opt.spread, 0.02, 0.9);
    var taper = taperRatio(opt.elevation, spread);

    var halfBottom = FILL_X / 2;
    var halfTop = halfBottom * taper;
    var halfH = FILL_Y / 2;

    var cx = 0.5;
    var cy = 0.5 + (opt.offsetY || 0);
    // 画面外に出すぎないように抑制
    cy = clamp(cy, halfH, 1 - halfH);

    return [
      { x: cx - halfTop,    y: cy - halfH },  // 左上（奥・左）
      { x: cx + halfTop,    y: cy - halfH },  // 右上（奥・右）
      { x: cx + halfBottom, y: cy + halfH },  // 右下（手前・右）
      { x: cx - halfBottom, y: cy + halfH }   // 左下（手前・左）
    ];
  }

  /**
   * 正規化四隅を実ピクセル座標へ変換
   */
  function toPixels(quadN, width, height) {
    return quadN.map(function (p) {
      return { x: p.x * width, y: p.y * height };
    });
  }

  /**
   * 単位正方形 (0,0)(1,0)(1,1)(0,1) → 任意四角形 への射影変換行列を求める。
   * （Heckbert, "Fundamentals of Texture Mapping and Image Warping" の手法）
   *
   * @param {Array<{x,y}>} q 左上→右上→右下→左下 の順
   * @returns {number[]} 長さ 9 の行優先行列 [a,b,c, d,e,f, g,h,1]
   */
  function squareToQuad(q) {
    var x0 = q[0].x, y0 = q[0].y;
    var x1 = q[1].x, y1 = q[1].y;
    var x2 = q[2].x, y2 = q[2].y;
    var x3 = q[3].x, y3 = q[3].y;

    var dx1 = x1 - x2, dy1 = y1 - y2;
    var dx2 = x3 - x2, dy2 = y3 - y2;
    var sx = x0 - x1 + x2 - x3;
    var sy = y0 - y1 + y2 - y3;

    var den = dx1 * dy2 - dy1 * dx2;
    var g, h;
    if (Math.abs(den) < 1e-12) {
      g = 0; h = 0;                              // 平行四辺形（アフィン）
    } else {
      g = (sx * dy2 - sy * dx2) / den;
      h = (dx1 * sy - dy1 * sx) / den;
    }

    return [
      x1 - x0 + g * x1,  x3 - x0 + h * x3,  x0,
      y1 - y0 + g * y1,  y3 - y0 + h * y3,  y0,
      g,                 h,                 1
    ];
  }

  /**
   * 行列を点に適用（同次座標の正規化込み）
   */
  function applyMatrix(m, u, v) {
    var w = m[6] * u + m[7] * v + m[8];
    if (Math.abs(w) < 1e-12) w = 1e-12;
    return {
      x: (m[0] * u + m[1] * v + m[2]) / w,
      y: (m[3] * u + m[4] * v + m[5]) / w
    };
  }

  /**
   * 出力長方形の正規化座標 (u,v) ∈ [0,1]² から
   * 入力映像のピクセル座標へ写す行列を作る。
   * （= プレビュー描画に必要な逆方向の写像）
   *
   * @param {Array<{x,y}>} quadPx 入力映像における台形四隅（ピクセル）
   * @returns {number[]} 3x3 行列
   */
  function outputToSource(quadPx) {
    return squareToQuad(quadPx);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  global.Geometry = {
    ANGLE_PRESETS: ANGLE_PRESETS,
    FILL_X: FILL_X,
    FILL_Y: FILL_Y,
    taperRatio: taperRatio,
    trapezoidNormalized: trapezoidNormalized,
    toPixels: toPixels,
    squareToQuad: squareToQuad,
    outputToSource: outputToSource,
    applyMatrix: applyMatrix,
    clamp: clamp
  };
})(window);
