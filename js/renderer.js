/**
 * renderer.js
 * WebGL を使って映像をリアルタイムに射影変換して描画するレンダラー
 *
 * アルゴリズム:
 *   1. カメラ映像をテクスチャとしてアップロード
 *   2. フラグメントシェーダで逆射影変換を行い
 *      出力ピクセルごとに入力テクスチャの対応座標を参照（逆マッピング）
 *   3. バイリニア補間は WebGL の texture2D が自動的に行う
 */

'use strict';

const Renderer = (() => {
  // ---------------------------------------------------------
  // GLSL シェーダソース
  // ---------------------------------------------------------

  // 頂点シェーダ: クリップ空間の4頂点（フルスクリーン四角形）
  const VERT_SRC = `
    attribute vec2 a_position;
    varying vec2 v_texcoord;
    void main() {
      // NDC に変換（-1..1）
      gl_Position = vec4(a_position, 0.0, 1.0);
      // UV座標（0..1）
      v_texcoord = a_position * 0.5 + 0.5;
    }
  `;

  // フラグメントシェーダ: 逆ホモグラフィで入力テクスチャを参照
  const FRAG_SRC = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform mat3      u_invH;      // 逆射影変換行列（出力→入力）
    uniform vec2      u_resolution;// 出力解像度
    varying vec2      v_texcoord;

    void main() {
      // 出力ピクセル座標（0..W, 0..H）
      vec2 outPx = v_texcoord * u_resolution;
      // 出力座標を Y 反転（WebGL のテクスチャ座標系）
      vec2 outPxFlip = vec2(outPx.x, u_resolution.y - outPx.y);

      // 逆射影変換で入力テクスチャ座標を求める
      vec3 srcH = u_invH * vec3(outPxFlip, 1.0);
      vec2 srcPx = srcH.xy / srcH.z;

      // 正規化UV (0..1)
      vec2 uv = srcPx / u_resolution;

      // 範囲外はクランプ（黒）
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      } else {
        gl_FragColor = texture2D(u_texture, uv);
      }
    }
  `;

  let gl = null;
  let program = null;
  let texture = null;
  let positionBuffer = null;
  let uInvH = null;
  let uResolution = null;
  let uTexture = null;

  // ---------------------------------------------------------
  // 初期化
  // ---------------------------------------------------------
  function init(canvas) {
    // WebGL2 を優先し、フォールバックとして WebGL1 を試みる
    gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,  // スクリーンショット用
    }) || canvas.getContext('webgl', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    }) || canvas.getContext('experimental-webgl', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    });

    if (!gl) {
      console.error('WebGL が利用できません');
      return false;
    }

    // シェーダコンパイル
    const vert = compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const frag = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vert || !frag) return false;

    // プログラムリンク
    program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('シェーダのリンクに失敗:', gl.getProgramInfoLog(program));
      return false;
    }

    gl.useProgram(program);

    // フルスクリーン四角形 (2つの三角形)
    const positions = new Float32Array([
      -1, -1,   1, -1,   -1, 1,
      -1,  1,   1, -1,    1, 1,
    ]);
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    const aPosition = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    // テクスチャ作成
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Uniform ロケーション
    uInvH       = gl.getUniformLocation(program, 'u_invH');
    uResolution = gl.getUniformLocation(program, 'u_resolution');
    uTexture    = gl.getUniformLocation(program, 'u_texture');

    return true;
  }

  // ---------------------------------------------------------
  // フレーム描画
  // ---------------------------------------------------------
  /**
   * @param {HTMLVideoElement|HTMLCanvasElement} source  映像ソース
   * @param {Float64Array} invH  逆射影変換行列 (3x3, 行優先)
   * @param {boolean} useNearest  最近傍補間を使うか
   */
  function renderFrame(source, invH, useNearest = false) {
    if (!gl || !program) return;

    const W = gl.canvas.width;
    const H = gl.canvas.height;

    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // テクスチャ補間設定
    const filter = useNearest ? gl.NEAREST : gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

    // 映像フレームをテクスチャに転送
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (e) {
      return;
    }

    // 逆行列を uniform に設定（column-major で渡す）
    // WebGL の uniformMatrix3fv は列優先なので転置して渡す
    const invHT = new Float32Array([
      invH[0], invH[3], invH[6],
      invH[1], invH[4], invH[7],
      invH[2], invH[5], invH[8],
    ]);
    gl.uniformMatrix3fv(uInvH, false, invHT);
    gl.uniform2f(uResolution, W, H);
    gl.uniform1i(uTexture, 0);

    // 描画
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ---------------------------------------------------------
  // ユーティリティ
  // ---------------------------------------------------------
  function compileShader(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('シェーダコンパイルエラー:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function setNearestInterpolation(use) {
    if (!gl || !texture) return;
    const filter = use ? gl.NEAREST : gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  }

  function isReady() {
    return !!gl && !!program;
  }

  function getContext() {
    return gl;
  }

  return {
    init,
    renderFrame,
    setNearestInterpolation,
    isReady,
    getContext,
  };
})();
