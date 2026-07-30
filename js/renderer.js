/**
 * renderer.js  — Canvas 2D 専用レンダラー（WebGL 不使用）
 *
 * アルゴリズム: 水平スキャンライン分割法
 * ──────────────────────────────────────────
 * 出力キャンバスを N 本の水平スライスに分割し、
 * 各スライスについて「その y 位置での入力幅・左端」を
 * 台形の線形補間で求め、ctx.drawImage で横方向にストレッチ描画する。
 *
 *   入力映像（台形）:
 *       topLeft ─────── topRight      ← 上辺（幅が可変）
 *      /                         \
 *    botLeft ─────────────── botRight  ← 下辺（= 出力全幅）
 *
 *   → 各 y 行ごとに入力側の [srcX, srcW] を線形補間して求め、
 *     出力側の [0, outW] にスケールして描画
 * ──────────────────────────────────────────
 */

'use strict';

const Renderer = (() => {
  let _canvas    = null;   // 出力用 Canvas
  let _ctx       = null;   // 2D コンテキスト
  let _offscreen = null;   // オフスクリーン Canvas（映像フレーム保持用）
  let _offCtx    = null;

  // スキャンライン分割数（大きいほど高品質・重い）
  let _slices = 120;

  // ──────────────────────────────
  // 初期化
  // ──────────────────────────────
  function init(canvas) {
    _canvas = canvas;
    _ctx    = canvas.getContext('2d');
    if (!_ctx) return false;

    // オフスクリーン Canvas を生成
    _offscreen = document.createElement('canvas');
    _offCtx    = _offscreen.getContext('2d');

    return true;
  }

  // ──────────────────────────────
  // フレーム描画（台形 → 長方形 変換）
  //
  //  source           : HTMLVideoElement
  //  topWidthPercent  : 上辺幅 % (100 = 等幅, 50 = 上半分の幅, 200 = 2倍)
  //  vertOffsetPct    : 垂直オフセット %
  //  horizOffsetPct   : 水平オフセット %
  //  quality          : 'low'|'medium'|'high' でスライス数変更
  // ──────────────────────────────
  function renderFrame(source, topWidthPercent, vertOffsetPct, horizOffsetPct, quality) {
    if (!_canvas || !_ctx) return;

    const outW = _canvas.width;
    const outH = _canvas.height;

    // スライス数をクオリティで切り替え
    _slices = quality === 'high' ? 240 : quality === 'low' ? 60 : 120;

    // ── オフスクリーンに映像フレームを描画 ──
    _offscreen.width  = outW;
    _offscreen.height = outH;
    try {
      _offCtx.drawImage(source, 0, 0, outW, outH);
    } catch (_e) {
      return;
    }

    // ── パラメータ計算 ──
    const topRatio  = topWidthPercent / 100;
    const vertOff   = (vertOffsetPct  / 100) * outH;
    const horizOff  = (horizOffsetPct / 100) * outW;

    // 入力座標系（オフスクリーン上）の台形頂点
    //   下辺: x=[botLeft, botRight], y=botY
    //   上辺: x=[topLeft, topRight], y=topY  （幅 = outW * topRatio）
    const topW     = outW * topRatio;
    const topLeft  = (outW - topW) / 2 + horizOff;
    const topRight = topLeft + topW;
    const botLeft  = 0  + horizOff * 0.5;
    const botRight = outW + horizOff * 0.5;
    const topY     = 0   + vertOff;
    const botY     = outH + vertOff;

    // ── 出力キャンバスをクリア ──
    _ctx.clearRect(0, 0, outW, outH);

    const sliceH = outH / _slices;   // 出力1スライスの高さ

    // ── 各スライスを描画 ──
    for (let i = 0; i < _slices; i++) {
      // スライスの出力 Y 範囲
      const outY0 = i       * sliceH;
      const outY1 = (i + 1) * sliceH;

      // 出力上端・下端の t（0=上, 1=下）
      const t0 = outY0 / outH;
      const t1 = outY1 / outH;

      // 入力側の対応 Y（線形補間）
      const srcY0 = topY + (botY - topY) * t0;
      const srcY1 = topY + (botY - topY) * t1;

      // 入力側のその y での左端・幅（線形補間）
      const srcX0  = topLeft  + (botLeft  - topLeft)  * t0;
      const srcX1r = topRight + (botRight - topRight) * t0;
      const srcW0  = srcX1r - srcX0;

      // 入力の高さスライス（srcY0 〜 srcY1）
      const srcSliceH = srcY1 - srcY0;

      if (srcW0 <= 0 || srcSliceH <= 0) continue;

      // ctx.drawImage で台形スライスを長方形にストレッチ
      _ctx.drawImage(
        _offscreen,
        srcX0,     srcY0,           // 入力: 左上
        srcW0,     srcSliceH,       // 入力: 幅・高さ
        0,         outY0,           // 出力: 左上
        outW,      sliceH + 0.5     // 出力: 幅・高さ（+0.5 でスキマ防止）
      );
    }
  }

  // ──────────────────────────────
  // ユーティリティ
  // ──────────────────────────────
  function isReady() {
    return !!_ctx;
  }

  function getCanvas() {
    return _canvas;
  }

  function clear() {
    if (_ctx) _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
  }

  return {
    init,
    renderFrame,
    isReady,
    getCanvas,
    clear,
  };
})();
