/**
 * homography.js
 * 射影変換（ホモグラフィ）行列の計算ライブラリ
 *
 * 台形（斜め撮影）から長方形（真上視点）への変換を
 * 4点対応の射影変換行列として計算します。
 */

'use strict';

const Homography = (() => {
  /**
   * 4点対応から射影変換行列を計算する
   * src: 変換元の4点 [{x,y}, ...]  (台形の頂点)
   * dst: 変換先の4点 [{x,y}, ...]  (長方形の頂点)
   * 戻り値: 3x3 射影変換行列（Float64Array, 行優先）
   */
  function computeHomography(src, dst) {
    // Ax = b の形式で8元連立方程式を立てる
    // src -> dst の射影変換 H を求める
    const A = [];
    const b = [];

    for (let i = 0; i < 4; i++) {
      const sx = src[i].x, sy = src[i].y;
      const dx = dst[i].x, dy = dst[i].y;

      A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
      A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
      b.push(dx);
      b.push(dy);
    }

    // ガウス消去法で解く
    const h = gaussianElimination(A, b);
    if (!h) return null;

    // 3x3 行列として返す（h33 = 1 と固定）
    return new Float64Array([
      h[0], h[1], h[2],
      h[3], h[4], h[5],
      h[6], h[7], 1.0
    ]);
  }

  /**
   * ガウス消去法（後退代入付き）
   * 8x8 の拡大係数行列を解く
   */
  function gaussianElimination(A, b) {
    const n = b.length;
    // 拡大係数行列を作る
    const M = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
      // ピボット選択
      let maxVal = Math.abs(M[col][col]);
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(M[row][col]) > maxVal) {
          maxVal = Math.abs(M[row][col]);
          maxRow = row;
        }
      }
      if (maxVal < 1e-10) return null; // 特異行列

      // 行の入れ替え
      [M[col], M[maxRow]] = [M[maxRow], M[col]];

      // 前進消去
      for (let row = col + 1; row < n; row++) {
        const factor = M[row][col] / M[col][col];
        for (let k = col; k <= n; k++) {
          M[row][k] -= factor * M[col][k];
        }
      }
    }

    // 後退代入
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      x[i] = M[i][n] / M[i][i];
      for (let k = i - 1; k >= 0; k--) {
        M[k][n] -= M[k][i] * x[i];
      }
    }
    return x;
  }

  /**
   * 射影変換行列の逆行列を求める（逆変換用）
   * 3x3 行列の逆行列（余因子展開）
   */
  function invertMatrix3x3(H) {
    const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;

    const det = h0 * (h4 * h8 - h5 * h7)
               - h1 * (h3 * h8 - h5 * h6)
               + h2 * (h3 * h7 - h4 * h6);

    if (Math.abs(det) < 1e-10) return null;

    const inv = new Float64Array(9);
    inv[0] =  (h4 * h8 - h5 * h7) / det;
    inv[1] = -(h1 * h8 - h2 * h7) / det;
    inv[2] =  (h1 * h5 - h2 * h4) / det;
    inv[3] = -(h3 * h8 - h5 * h6) / det;
    inv[4] =  (h0 * h8 - h2 * h6) / det;
    inv[5] = -(h0 * h5 - h2 * h3) / det;
    inv[6] =  (h3 * h7 - h4 * h6) / det;
    inv[7] = -(h0 * h7 - h1 * h6) / det;
    inv[8] =  (h0 * h4 - h1 * h3) / det;
    return inv;
  }

  /**
   * 射影変換行列で点を変換する
   * H: Float64Array[9], point: {x, y}
   * 戻り値: {x, y}
   */
  function transformPoint(H, point) {
    const wx = H[0] * point.x + H[1] * point.y + H[2];
    const wy = H[3] * point.x + H[4] * point.y + H[5];
    const  w = H[6] * point.x + H[7] * point.y + H[8];
    return { x: wx / w, y: wy / w };
  }

  /**
   * ツールのパラメータから射影変換の src/dst 4点を生成する
   *
   * @param {number} topWidthPercent  上辺の幅（%） 100=等幅, <100=台形（上が狭），>100=逆台形
   * @param {number} vertOffsetPercent 垂直オフセット（%）
   * @param {number} horizOffsetPercent 水平オフセット（%）
   * @param {number} W  出力キャンバス幅 (px)
   * @param {number} H  出力キャンバス高さ (px)
   * @returns {{ src: Array, dst: Array }}
   */
  function buildTransformPoints(topWidthPercent, vertOffsetPercent, horizOffsetPercent, W, H) {
    const topRatio   = topWidthPercent   / 100;
    const vertOff    = (vertOffsetPercent   / 100) * H;
    const horizOff   = (horizOffsetPercent  / 100) * W;

    // 出力側（dst）は常に 16:9 の長方形全体
    const dst = [
      { x: 0,     y: 0 },  // 左上
      { x: W,     y: 0 },  // 右上
      { x: W,     y: H },  // 右下
      { x: 0,     y: H },  // 左下
    ];

    // 入力側（src）は台形
    // 上辺を中央に合わせて伸縮させる
    const topW = W * topRatio;
    const topLeft  = (W - topW) / 2 + horizOff;
    const topRight = topLeft + topW;
    const botLeft  = 0  + horizOff * 0.5;
    const botRight = W  + horizOff * 0.5;

    const topY = 0 + vertOff;
    const botY = H + vertOff;

    const src = [
      { x: topLeft,  y: topY },  // 左上
      { x: topRight, y: topY },  // 右上
      { x: botRight, y: botY },  // 右下
      { x: botLeft,  y: botY },  // 左下
    ];

    return { src, dst };
  }

  return {
    computeHomography,
    invertMatrix3x3,
    transformPoint,
    buildTransformPoints,
  };
})();
