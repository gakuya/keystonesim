/* =============================================================
 * renderer.js
 *  1) SetupRenderer   … 設定モード：カメラ映像 ＋ 半透明の台形イメージ
 *  2) PreviewRenderer … プレビューモード：台形を長方形に戻した映像
 *
 *  プレビューは WebGL（フラグメントシェーダで厳密な射影変換）を使い、
 *  WebGL が使えない環境では Canvas 2D の水平スライス法へ自動切替する。
 * ============================================================= */

(function (global) {
  'use strict';

  var G = global.Geometry;

  /* ============================================================
   * 共通ユーティリティ
   * ========================================================== */

  /** 要素サイズと devicePixelRatio に合わせてキャンバスの実解像度を更新 */
  function fitCanvas(canvas, maxDpr) {
    var rect = canvas.getBoundingClientRect();
    var dpr = Math.min(global.devicePixelRatio || 1, maxDpr || 2);
    var w = Math.max(1, Math.round(rect.width * dpr));
    var h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      return true;
    }
    return false;
  }

  /** contain（レターボックス）で映像を収める矩形を計算 */
  function containRect(srcW, srcH, dstW, dstH) {
    var scale = Math.min(dstW / srcW, dstH / srcH);
    var w = srcW * scale;
    var h = srcH * scale;
    return { x: (dstW - w) / 2, y: (dstH - h) / 2, w: w, h: h };
  }

  /* ============================================================
   * 1) 設定モード用レンダラー
   * ========================================================== */

  function SetupRenderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {Array<{x,y}>} quadN  台形四隅（正規化座標）
   * @param {Object} opt {mirror:boolean, label:string, detail:string}
   */
  SetupRenderer.prototype.render = function (video, quadN, opt) {
    fitCanvas(this.canvas, 2);
    var ctx = this.ctx;
    var W = this.canvas.width;
    var H = this.canvas.height;

    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (!video || !video.videoWidth) { ctx.restore(); return; }

    var r = containRect(video.videoWidth, video.videoHeight, W, H);

    // --- 映像を描画（必要ならミラー） ---
    ctx.save();
    if (opt.mirror) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, r.x, r.y, r.w, r.h);
    ctx.restore();

    // --- 半透明の台形イメージを被せる ---
    this._drawTrapezoid(ctx, quadN, r, opt);

    ctx.restore();
  };

  SetupRenderer.prototype._drawTrapezoid = function (ctx, quadN, r, opt) {
    var pts = quadN.map(function (p) {
      return { x: r.x + p.x * r.w, y: r.y + p.y * r.h };
    });

    var path = new Path2D();
    path.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    path.closePath();

    var unit = Math.max(1, Math.min(r.w, r.h) / 320);

    // 台形の外側だけを暗く落として範囲を強調する。
    // rect と台形を 1 つのパスにまとめ "evenodd" で塗ることで、
    // 台形の内側（＝映像を見せたい部分）を塗り残す。
    // （destination-out は映像ごと消してしまうため使わない）
    var outside = new Path2D();
    outside.rect(r.x, r.y, r.w, r.h);
    outside.addPath(path);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill(outside, 'evenodd');
    ctx.restore();

    // 台形本体（半透明の塗り）
    ctx.save();
    var top = pts[0].y, bottom = pts[3].y;
    var grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, 'rgba(45,170,255,0.22)');
    grad.addColorStop(1, 'rgba(45,170,255,0.06)');
    ctx.fillStyle = grad;
    ctx.fill(path);

    // 内部のガイドライン（台形グリッド）
    if (opt.grid) {
      ctx.save();
      ctx.clip(path);
      ctx.strokeStyle = 'rgba(255,255,255,0.26)';
      ctx.lineWidth = Math.max(1, unit * 0.7);
      var m = G.outputToSource(pts);   // 単位正方形 → 台形
      var n = 4, k, a, b, t;
      for (k = 1; k < n; k++) {
        t = k / n;
        // 縦線
        a = G.applyMatrix(m, t, 0);
        b = G.applyMatrix(m, t, 1);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        // 横線
        a = G.applyMatrix(m, 0, t);
        b = G.applyMatrix(m, 1, t);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.restore();
    }

    // 外枠
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(2, unit * 3.4);
    ctx.stroke(path);
    ctx.strokeStyle = '#43b6ff';
    ctx.lineWidth = Math.max(1.5, unit * 2);
    ctx.stroke(path);

    // 四隅のハンドル
    var hr = Math.max(4, unit * 4.2);
    pts.forEach(function (p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, hr, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, unit * 1.6);
      ctx.strokeStyle = '#1b84cc';
      ctx.stroke();
    });

    // 奥／手前のラベル（台形の内側に描いて画面外に切れないようにする）
    ctx.font = (unit * 11).toFixed(1) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.shadowColor = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur = unit * 5;
    ctx.textBaseline = 'top';
    ctx.fillText('奥', (pts[0].x + pts[1].x) / 2, pts[0].y + hr * 1.3);
    ctx.textBaseline = 'bottom';
    ctx.fillText('手前', (pts[2].x + pts[3].x) / 2, pts[3].y - hr * 1.3);
    ctx.restore();

    // 左上に現在の角度ラベル
    ctx.save();
    var label = opt.label + '（' + opt.detail + '）';
    ctx.font = '600 ' + (unit * 13).toFixed(1) + 'px system-ui, sans-serif';
    var tw = ctx.measureText(label).width;
    var padX = unit * 10, padY = unit * 7;
    var bx = r.x + unit * 10, by = r.y + unit * 10;
    ctx.fillStyle = 'rgba(14,18,24,0.74)';
    roundRect(ctx, bx, by, tw + padX * 2, unit * 13 + padY * 2, unit * 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(67,182,255,0.6)';
    ctx.lineWidth = Math.max(1, unit);
    ctx.stroke();
    ctx.fillStyle = '#eaf6ff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, bx + padX, by + padY);
    ctx.restore();
  };

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ============================================================
   * 2) プレビュー用レンダラー
   * ========================================================== */

  var VERT_SRC = [
    'attribute vec2 aPos;',
    'varying vec2 vUV;',
    'void main() {',
    '  vUV = aPos * 0.5 + 0.5;',          // -1..1 -> 0..1
    '  vUV.y = 1.0 - vUV.y;',            // 上を 0 にする
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FRAG_SRC = [
    'precision highp float;',
    'uniform sampler2D uTex;',
    'uniform mat3 uMat;',                // 出力(0..1) -> 入力(0..1)
    'uniform float uMirror;',
    'varying vec2 vUV;',
    'void main() {',
    '  vec3 p = uMat * vec3(vUV, 1.0);',
    '  vec2 s = p.xy / p.z;',
    '  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) {',
    '    gl_FragColor = vec4(0.03, 0.04, 0.05, 1.0);',
    '    return;',
    '  }',
    '  if (uMirror > 0.5) s.x = 1.0 - s.x;',
    '  gl_FragColor = texture2D(uTex, s);',
    '}'
  ].join('\n');

  function PreviewRenderer(canvas) {
    this.canvas = canvas;
    this.engine = 'none';
    this.gl = null;
    this.ctx2d = null;
    this.slices = 160;
    this._initWebGL() || this._init2D();
  }

  PreviewRenderer.prototype.engineLabel = function () {
    return this.engine === 'webgl'
      ? 'WebGL 射影変換'
      : (this.engine === '2d' ? 'Canvas 2D スライス' : '利用不可');
  };

  PreviewRenderer.prototype._initWebGL = function () {
    var gl = null;
    var attrs = { alpha: false, antialias: false, depth: false, stencil: false,
                  preserveDrawingBuffer: true, premultipliedAlpha: false };
    try {
      gl = this.canvas.getContext('webgl', attrs) ||
           this.canvas.getContext('experimental-webgl', attrs);
    } catch (e) { gl = null; }
    if (!gl) return false;

    try {
      var vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
      var fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
      var prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
      }
      gl.useProgram(prog);

      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

      this.gl = gl;
      this._prog = prog;
      this._tex = tex;
      this._uMat = gl.getUniformLocation(prog, 'uMat');
      this._uMirror = gl.getUniformLocation(prog, 'uMirror');
      gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
      this.engine = 'webgl';
      return true;
    } catch (e) {
      this.gl = null;
      return false;
    }
  };

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'compile failed');
    }
    return sh;
  }

  PreviewRenderer.prototype._init2D = function () {
    this.ctx2d = this.canvas.getContext('2d');
    this.engine = this.ctx2d ? '2d' : 'none';
    return !!this.ctx2d;
  };

  /**
   * @param {HTMLVideoElement} video
   * @param {Array<{x,y}>} quadN  入力映像内の台形四隅（正規化）
   * @param {Object} opt {mirror, grid}
   */
  PreviewRenderer.prototype.render = function (video, quadN, opt) {
    fitCanvas(this.canvas, this.engine === 'webgl' ? 2 : 1.5);
    if (!video || !video.videoWidth) return;

    // 出力の単位正方形 → 入力の台形（正規化座標）
    var m = G.outputToSource(quadN);

    if (this.engine === 'webgl') this._renderGL(video, m, opt);
    else if (this.engine === '2d') this._render2D(video, m, opt);

    if (opt.grid) this._drawGrid(opt);
  };

  PreviewRenderer.prototype._renderGL = function (video, m, opt) {
    var gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (e) {
      return; // フレーム未準備
    }
    // GLSL の mat3 は列優先なので転置して渡す
    gl.uniformMatrix3fv(this._uMat, false, new Float32Array([
      m[0], m[3], m[6],
      m[1], m[4], m[7],
      m[2], m[5], m[8]
    ]));
    gl.uniform1f(this._uMirror, opt.mirror ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  PreviewRenderer.prototype._render2D = function (video, m, opt) {
    var ctx = this.ctx2d;
    var W = this.canvas.width, H = this.canvas.height;
    var vw = video.videoWidth, vh = video.videoHeight;

    ctx.save();
    ctx.fillStyle = '#08090b';
    ctx.fillRect(0, 0, W, H);

    if (opt.mirror) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }

    // 出力を水平スライスへ分割し、対応する入力の帯を引き伸ばして描画
    var n = this.slices;
    var prev = G.applyMatrix(m, 0.5, 0);
    for (var i = 0; i < n; i++) {
      var v0 = i / n, v1 = (i + 1) / n;
      var l = G.applyMatrix(m, 0, v1);
      var r = G.applyMatrix(m, 1, v1);
      var sy0 = prev.y * vh;
      var sy1 = r.y * vh;
      var sx = Math.min(l.x, r.x) * vw;
      var sw = Math.abs(r.x - l.x) * vw;
      var sh = sy1 - sy0;
      prev = r;
      if (sw <= 0 || sh <= 0) continue;

      var dy = v0 * H;
      var dh = (v1 - v0) * H + 1;   // 継ぎ目対策で 1px 重ねる
      try {
        ctx.drawImage(video, sx, sy0, sw, sh, 0, dy, W, dh);
      } catch (e) { /* 範囲外は無視 */ }
    }
    ctx.restore();
  };

  PreviewRenderer.prototype._drawGrid = function () {
    // WebGL の場合はオーバーレイ用の 2D 文脈が取れないため
    // グリッドは CSS 側（.grid-overlay）で描画する。
    return;
  };

  /** PNG 書き出し（WebGL は preserveDrawingBuffer: true 済み） */
  PreviewRenderer.prototype.toDataURL = function () {
    try { return this.canvas.toDataURL('image/png'); }
    catch (e) { return null; }
  };

  global.SetupRenderer = SetupRenderer;
  global.PreviewRenderer = PreviewRenderer;
  global.RenderUtil = { fitCanvas: fitCanvas, containRect: containRect, roundRect: roundRect };
})(window);
