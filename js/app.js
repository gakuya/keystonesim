/**
 * app.js
 * カメラ台形補正シミュレーター - メインアプリケーション
 */

'use strict';

// ==========================================
// DOM 要素の取得
// ==========================================
const dom = {
  cameraSelect:      document.getElementById('camera-select'),
  startBtn:          document.getElementById('start-btn'),
  stopBtn:           document.getElementById('stop-btn'),
  cameraStatus:      document.getElementById('camera-status'),
  topWidthSlider:    document.getElementById('top-width-slider'),
  topWidthValue:     document.getElementById('top-width-value'),
  vertOffsetSlider:  document.getElementById('vert-offset-slider'),
  vertOffsetValue:   document.getElementById('vert-offset-value'),
  horizOffsetSlider: document.getElementById('horiz-offset-slider'),
  horizOffsetValue:  document.getElementById('horiz-offset-value'),
  resetBtn:          document.getElementById('reset-btn'),
  showGrid:          document.getElementById('show-grid'),
  showOriginal:      document.getElementById('show-original'),
  screenshotBtn:     document.getElementById('screenshot-btn'),
  outputCanvas:      document.getElementById('output-canvas'),
  overlayCanvas:     document.getElementById('overlay-canvas'),
  placeholder:       document.getElementById('placeholder'),
  sourceVideo:       document.getElementById('source-video'),
  infoResolution:    document.getElementById('info-resolution'),
  infoFps:           document.getElementById('info-fps'),
  infoTopWidth:      document.getElementById('info-top-width'),
  infoTransform:     document.getElementById('info-transform'),
  trapezoidShape:    document.getElementById('trapezoid-shape'),
  topLine:           document.getElementById('top-line'),
};

// ==========================================
// アプリケーション状態
// ==========================================
const state = {
  isRunning:        false,
  stream:           null,
  animFrameId:      null,
  topWidth:         100,   // %
  vertOffset:       0,     // %
  horizOffset:      0,     // %
  useNearest:       false,
  showGrid:         false,
  showOriginal:     false,
  lastFrameTime:    0,
  frameCount:       0,
  fps:              0,
  canvasW:          0,
  canvasH:          0,
};

// ==========================================
// キャンバスサイズ設定（16:9 固定）
// ==========================================
function setupCanvasSize() {
  const wrapper = dom.outputCanvas.parentElement;
  const W = wrapper.clientWidth;
  const H = wrapper.clientHeight;

  dom.outputCanvas.width  = W;
  dom.outputCanvas.height = H;
  dom.overlayCanvas.width  = W;
  dom.overlayCanvas.height = H;

  state.canvasW = W;
  state.canvasH = H;
}

// ==========================================
// カメラ列挙
// ==========================================
async function enumerateCameras() {
  try {
    // 権限を取得するために一度ストリームを開く
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
    tempStream.getTracks().forEach(t => t.stop());
  } catch (e) {
    console.warn('カメラへのアクセスが拒否されました:', e);
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    dom.cameraSelect.innerHTML = '';

    if (videoDevices.length === 0) {
      dom.cameraSelect.innerHTML = '<option value="">カメラが見つかりません</option>';
      return;
    }

    videoDevices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `カメラ ${index + 1}`;
      dom.cameraSelect.appendChild(option);
    });
  } catch (e) {
    console.error('デバイス列挙エラー:', e);
    dom.cameraSelect.innerHTML = '<option value="">デバイスの取得に失敗</option>';
  }
}

// ==========================================
// カメラ開始
// ==========================================
async function startCamera() {
  const deviceId = dom.cameraSelect.value;
  if (!deviceId) return;

  setStatus('active', '接続中...');
  dom.startBtn.disabled = true;

  try {
    // 既存ストリームを停止
    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
    }

    const constraints = {
      video: {
        deviceId: { exact: deviceId },
        width:    { ideal: 1920 },
        height:   { ideal: 1080 },
      }
    };

    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    dom.sourceVideo.srcObject = state.stream;

    await new Promise((resolve) => {
      dom.sourceVideo.onloadedmetadata = resolve;
    });
    await dom.sourceVideo.play();

    const track = state.stream.getVideoTracks()[0];
    const settings = track.getSettings();
    dom.infoResolution.textContent = `解像度: ${settings.width || '?'} × ${settings.height || '?'}`;

    state.isRunning = true;
    dom.stopBtn.disabled = false;
    dom.screenshotBtn.disabled = false;
    dom.placeholder.classList.add('hidden');
    setStatus('active', '配信中 ●');

    // WebGL レンダラー初期化
    setupCanvasSize();
    if (!Renderer.isReady()) {
      Renderer.init(dom.outputCanvas);
    }

    // 描画ループ開始
    renderLoop();

  } catch (e) {
    console.error('カメラ起動エラー:', e);
    setStatus('error', 'エラー: ' + (e.message || e.name));
    dom.startBtn.disabled = false;
  }
}

// ==========================================
// カメラ停止
// ==========================================
function stopCamera() {
  state.isRunning = false;

  if (state.animFrameId) {
    cancelAnimationFrame(state.animFrameId);
    state.animFrameId = null;
  }

  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }

  dom.sourceVideo.srcObject = null;
  dom.placeholder.classList.remove('hidden');
  dom.startBtn.disabled = false;
  dom.stopBtn.disabled  = true;
  dom.screenshotBtn.disabled = true;
  setStatus('idle', '待機中');
  dom.infoFps.textContent = 'FPS: --';

  // キャンバスをクリア
  const gl = Renderer.getContext();
  if (gl) {
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  clearOverlay();
}

// ==========================================
// メイン描画ループ
// ==========================================
function renderLoop() {
  if (!state.isRunning) return;

  const now = performance.now();

  // FPS 計算
  state.frameCount++;
  if (now - state.lastFrameTime >= 1000) {
    state.fps = state.frameCount;
    state.frameCount = 0;
    state.lastFrameTime = now;
    dom.infoFps.textContent = `FPS: ${state.fps}`;
  }

  // ビデオが再生可能かチェック
  if (dom.sourceVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    renderFrame();
  }

  state.animFrameId = requestAnimationFrame(renderLoop);
}

// ==========================================
// フレーム描画（射影変換）
// ==========================================
function renderFrame() {
  const W = state.canvasW;
  const H = state.canvasH;

  // 変換点を計算
  const { src, dst } = Homography.buildTransformPoints(
    state.topWidth,
    state.vertOffset,
    state.horizOffset,
    W, H
  );

  // 射影変換行列を計算（src → dst）
  const H_mat = Homography.computeHomography(src, dst);
  if (!H_mat) return;

  // 逆行列（dst → src）で逆マッピング
  const invH = Homography.invertMatrix3x3(H_mat);
  if (!invH) return;

  // WebGL で描画
  Renderer.renderFrame(dom.sourceVideo, invH, state.useNearest);

  // 原映像オーバーレイ
  if (state.showOriginal) {
    drawOriginalOverlay(src);
  }

  // グリッドオーバーレイ
  if (state.showGrid) {
    drawGridOverlay();
  } else if (!state.showOriginal) {
    clearOverlay();
  }
}

// ==========================================
// グリッドオーバーレイ描画
// ==========================================
function drawGridOverlay() {
  const ctx = dom.overlayCanvas.getContext('2d');
  const W = dom.overlayCanvas.width;
  const H = dom.overlayCanvas.height;

  ctx.clearRect(0, 0, W, H);

  const DIVISIONS = 8;
  ctx.strokeStyle = 'rgba(79, 142, 247, 0.35)';
  ctx.lineWidth = 1;

  // 縦線
  for (let i = 1; i < DIVISIONS; i++) {
    const x = (W / DIVISIONS) * i;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }

  // 横線
  for (let j = 1; j < DIVISIONS; j++) {
    const y = (H / DIVISIONS) * j;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  // 中央十字
  ctx.strokeStyle = 'rgba(247, 195, 79, 0.5)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);

  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();

  ctx.setLineDash([]);
}

// ==========================================
// 原映像輪郭オーバーレイ（台形の枠線）
// ==========================================
function drawOriginalOverlay(srcPoints) {
  const ctx = dom.overlayCanvas.getContext('2d');
  const W = dom.overlayCanvas.width;
  const H = dom.overlayCanvas.height;

  ctx.clearRect(0, 0, W, H);

  // 台形を射影変換後の座標で表示
  // ここでは変換前の台形の形をキャンバス上に半透明で表示
  ctx.beginPath();
  ctx.moveTo(srcPoints[0].x, H - srcPoints[0].y);
  ctx.lineTo(srcPoints[1].x, H - srcPoints[1].y);
  ctx.lineTo(srcPoints[2].x, H - srcPoints[2].y);
  ctx.lineTo(srcPoints[3].x, H - srcPoints[3].y);
  ctx.closePath();

  ctx.strokeStyle = 'rgba(247, 195, 79, 0.8)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // 上辺をハイライト
  ctx.beginPath();
  ctx.moveTo(srcPoints[0].x, H - srcPoints[0].y);
  ctx.lineTo(srcPoints[1].x, H - srcPoints[1].y);
  ctx.strokeStyle = 'rgba(247, 95, 95, 0.9)';
  ctx.lineWidth = 3;
  ctx.stroke();
}

// ==========================================
// オーバーレイクリア
// ==========================================
function clearOverlay() {
  const ctx = dom.overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, dom.overlayCanvas.width, dom.overlayCanvas.height);
}

// ==========================================
// ステータス更新
// ==========================================
function setStatus(type, text) {
  dom.cameraStatus.className = `status-badge status-${type}`;
  dom.cameraStatus.textContent = text;
}

// ==========================================
// 台形プレビュー更新
// ==========================================
function updateTrapezoidPreview() {
  const topRatio = state.topWidth / 100;
  const svgW = 200, svgH = 120;
  const margin = 10;
  const botLeft  = margin;
  const botRight = svgW - margin;
  const botY     = svgH - margin;
  const topW     = (svgW - margin * 2) * topRatio;
  const topLeft  = (svgW - topW) / 2;
  const topRight = topLeft + topW;
  const topY     = margin;

  const points = `${topLeft},${topY} ${topRight},${topY} ${botRight},${botY} ${botLeft},${botY}`;
  dom.trapezoidShape.setAttribute('points', points);
  dom.topLine.setAttribute('x1', topLeft);
  dom.topLine.setAttribute('x2', topRight);
  dom.topLine.setAttribute('y1', topY);
  dom.topLine.setAttribute('y2', topY);
}

// ==========================================
// 情報バー更新
// ==========================================
function updateInfoBar() {
  dom.infoTopWidth.textContent = `上辺幅: ${state.topWidth}%`;
}

// ==========================================
// スライダーと数値入力の同期ヘルパー
// ==========================================
function syncSliderAndInput(slider, input, key, decimals = 0) {
  slider.addEventListener('input', () => {
    const val = parseFloat(slider.value);
    state[key] = val;
    input.value = val.toFixed(decimals);
    updateSliderTrack(slider);
    onParamChange();
  });

  input.addEventListener('change', () => {
    let val = parseFloat(input.value);
    val = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), val));
    state[key] = val;
    slider.value = val;
    input.value = val.toFixed(decimals);
    updateSliderTrack(slider);
    onParamChange();
  });
}

// ==========================================
// パラメータ変更時の共通処理
// ==========================================
function onParamChange() {
  updateTrapezoidPreview();
  updateInfoBar();
}

// ==========================================
// リセット
// ==========================================
function resetParams() {
  state.topWidth   = 100;
  state.vertOffset = 0;
  state.horizOffset = 0;

  dom.topWidthSlider.value    = 100;
  dom.topWidthValue.value     = 100;
  dom.vertOffsetSlider.value  = 0;
  dom.vertOffsetValue.value   = 0;
  dom.horizOffsetSlider.value = 0;
  dom.horizOffsetValue.value  = 0;

  [dom.topWidthSlider, dom.vertOffsetSlider, dom.horizOffsetSlider].forEach(updateSliderTrack);

  onParamChange();
}

// ==========================================
// リサイズハンドラ
// ==========================================
function onResize() {
  setupCanvasSize();
  if (!state.isRunning) {
    clearOverlay();
  }
}

// ==========================================
// 補間方式の変更
// ==========================================
function onInterpolationChange() {
  const selected = document.querySelector('input[name="interpolation"]:checked');
  state.useNearest = selected?.value === 'nearest';
}

// ==========================================
// イベントリスナー登録
// ==========================================
function registerEvents() {
  dom.startBtn.addEventListener('click', startCamera);
  dom.stopBtn.addEventListener('click', stopCamera);
  dom.resetBtn.addEventListener('click', resetParams);
  dom.screenshotBtn.addEventListener('click', saveScreenshot);

  syncSliderAndInput(dom.topWidthSlider,    dom.topWidthValue,    'topWidth');
  syncSliderAndInput(dom.vertOffsetSlider,  dom.vertOffsetValue,  'vertOffset');
  syncSliderAndInput(dom.horizOffsetSlider, dom.horizOffsetValue, 'horizOffset');

  dom.showGrid.addEventListener('change', () => {
    state.showGrid = dom.showGrid.checked;
    if (!state.showGrid && !state.showOriginal) clearOverlay();
  });

  dom.showOriginal.addEventListener('change', () => {
    state.showOriginal = dom.showOriginal.checked;
    if (!state.showGrid && !state.showOriginal) clearOverlay();
  });

  document.querySelectorAll('input[name="interpolation"]').forEach(radio => {
    radio.addEventListener('change', onInterpolationChange);
  });

  window.addEventListener('resize', debounce(onResize, 200));

  // デバイスの接続/切断を検知
  navigator.mediaDevices.addEventListener('devicechange', enumerateCameras);
}

// ==========================================
// デバウンス
// ==========================================
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ==========================================
// スクリーンショット保存
// ==========================================
function saveScreenshot() {
  try {
    // WebGL Canvas を preserveDrawingBuffer なしで取得するため
    // 合成 Canvas に描画してから保存する
    const merged = document.createElement('canvas');
    merged.width  = dom.outputCanvas.width;
    merged.height = dom.outputCanvas.height;
    const ctx = merged.getContext('2d');
    ctx.drawImage(dom.outputCanvas,  0, 0);
    ctx.drawImage(dom.overlayCanvas, 0, 0);

    const url = merged.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    a.download = `trapezoid_correction_${ts}.png`;
    a.click();
  } catch (e) {
    console.error('スクリーンショット保存エラー:', e);
    alert('スクリーンショットの保存に失敗しました。');
  }
}

// ==========================================
// スライダートラックの塗り色を更新
// ==========================================
function updateSliderTrack(slider) {
  const min = parseFloat(slider.min);
  const max = parseFloat(slider.max);
  const val = parseFloat(slider.value);
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background =
    `linear-gradient(to right, var(--accent-blue) 0%, var(--accent-cyan) ${pct}%, var(--bg-input) ${pct}%)`;
}

function initSliderTracks() {
  [dom.topWidthSlider, dom.vertOffsetSlider, dom.horizOffsetSlider].forEach(slider => {
    updateSliderTrack(slider);
    slider.addEventListener('input', () => updateSliderTrack(slider));
  });
}

// ==========================================
// アプリケーション初期化
// ==========================================
async function init() {
  setupCanvasSize();
  const webglOk = Renderer.init(dom.outputCanvas);
  if (!webglOk) {
    dom.infoTransform && (dom.infoTransform.textContent = '変形: Canvas2D（低速）');
  }
  registerEvents();
  initSliderTracks();
  updateTrapezoidPreview();
  updateInfoBar();
  await enumerateCameras();

  // navigator.mediaDevices が利用不可の場合
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('error', 'カメラAPI非対応');
    dom.startBtn.disabled = true;
    dom.cameraSelect.innerHTML = '<option value="">このブラウザは非対応です</option>';
  }
}

// ==========================================
// エントリーポイント
// ==========================================
document.addEventListener('DOMContentLoaded', init);
