/**
 * homography.js  — 台形パラメータ計算ユーティリティ（Canvas 2D 専用）
 *
 * WebGL 版で使用していた射影変換行列演算は不要になったため、
 * 台形のプレビュー用座標計算のみを提供するシンプルなモジュールに変更。
 */

'use strict';

const Homography = (() => {

  /**
   * 台形プレビュー用の SVG 頂点座標を計算して返す
   *
   * @param {number} topWidthPercent  上辺幅 %
   * @param {number} svgW             SVG 幅
   * @param {number} svgH             SVG 高さ
   * @param {number} margin           余白 px
   * @returns {{ topLeft, topRight, botLeft, botRight, topY, botY }}
   */
  function calcPreviewPoints(topWidthPercent, svgW, svgH, margin = 10) {
    const topRatio = topWidthPercent / 100;
    const botLeft  = margin;
    const botRight = svgW - margin;
    const botW     = botRight - botLeft;
    const topW     = botW * topRatio;
    const topLeft  = (svgW - topW) / 2;
    const topRight = topLeft + topW;
    const topY     = margin;
    const botY     = svgH - margin;
    return { topLeft, topRight, botLeft, botRight, topY, botY };
  }

  return { calcPreviewPoints };
})();
