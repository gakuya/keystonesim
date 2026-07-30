/**
 * app.js — カメラ台形補正シミュレーター（Canvas 2D 専用）
 */

'use strict';

// ==========================================
// DOM 要素
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
  qualitySelect:     document.getElementById('quality-select'),
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
  isRunning:     false,
  stream:        null,
  animFrameId:   null,
  topWidth:      100,   // %
  vertOffset:    0,     // %
  horizOffset:   0,     // %
  quality:       'medium',
  showGrid:      false,
  showOriginal:  false,
  lastFrameTime: 0,
  frameCount:    0,
  fps:           0,
  canvasW:       0,
  canvasH:       0,
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
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
    tempStream.getTracks().forEach(t => t.stop());
  } catch (_e) { /* 権限取得失敗は握りつぶす */ }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');

    dom.cameraSelect.innerHTML = '';

    if (videoDevices.length === 0) {
      dom.cameraSelect.innerHTML = '<option value="">カメラが見つかりません</option>';
      return;
    }

    videoDevices.forEach((device, index) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `カメラ ${index + 1}`;
      dom.cameraSelect.appendChild(opt);
    });
  } catch (e) {
    console.error('デバイス列挙エラー:', e);
    dom.cameraSelect.innerHTML = '<option value="">デバイス取得失敗</option>';
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
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());

    const constraints = {
      video: {
        deviceId: { exact: deviceId },
        width:    { ideal: 1920 },
        height:   { ideal: 1080 },
      }
    };

    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    dom.sourceVideo.srcObject = state.stream;

    await new Promise(resolve => { dom.sourceVideo.onloadedmetadata = resolve; });
    await dom.sourceVideo.play();

    const settings = state.stream.getVideoTracks()[0].getSettings();
    dom.infoResolution.textContent = `解像度: ${settings.width || '?'} × ${settings.height || '?'}`;

    state.isRunning = true;
    dom.stopBtn.disabled       = false;
    dom.screenshotBtn.disabled = false;
    dom.placeholder.classList.add('hidden');
    setStatus('active', '配信中 ●');

    setupCanvasSize();
    if (!Renderer.isReady()) Renderer.init(dom.outputCanvas);

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
  dom.startBtn.disabled      = false;
  dom.stopBtn.disabled       = true;
  dom.screenshotBtn.disabled = true;
  setStatus('idle', '待機中');
  dom.infoFps.textContent = 'FPS: --';

  Renderer.clear();
  clearOverlay();
}

// ==========================================
// 描画ループ
// ==========================================
function renderLoop() {
  if (!state.isRunning) return;

  const now = performance.now();
  state.frameCount++;
  if (now - state.lastFrameTime >= 1000) {
    state.fps = state.frameCount;
    state.frameCount = 0;
    state.lastFrameTime = now;
    dom.infoFps.textContent = `FPS: ${state.fps}`;
  }

  if (dom.sourceVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    renderFrame();
  }

  state.animFrameId = requestAnimationFrame(renderLoop);
}

// ==========================================
// フレーム描画（Canvas 2D 台形補正）
// ==========================================
function renderFrame() {
  // Canvas 2D レンダラに丸投げ
  Renderer.renderFrame(
    dom.sourceVideo,
    state.topWidth,
    state.vertOffset,
    state.horizOffset,
    state.quality
  );

  // オーバーレイ描画
  if (state.showOriginal) drawTrapezoidOutline();
  if (state.showGrid)     drawGridOverlay();
  if (!state.showOriginal && !state.showGrid) clearOverlay();
}

// ==========================================
// グリッドオーバーレイ
// ==========================================
function drawGridOverlay() {
  const ctx = dom.overlayCanvas.getContext('2d');
  const W = dom.overlayCanvas.width;
  const H = dom.overlayCanvas.height;

  ctx.clearRect(0, 0, W, H);

  const DIV = 8;
  ctx.strokeStyle = 'rgba(79,142,247,0.35)';
  ctx.lineWidth   = 1;

  for (let i = 1; i < DIV; i++) {
    const x = (W / DIV) * i;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let j = 1; j < DIV; j++) {
    const y = (H / DIV) * j;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // 中央十字（点線）
  ctx.strokeStyle = 'rgba(247,195,79,0.5)';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  ctx.setLineDash([]);
}

// ==========================================
// 台形輪郭オーバーレイ（原映像の切り取り範囲を表示）
// ==========================================
function drawTrapezoidOutline() {
  const ctx = dom.overlayCanvas.getContext('2d');
  const W = dom.overlayCanvas.width;
  const H = dom.overlayCanvas.height;

  ctx.clearRect(0, 0, W, H);

  const topRatio  = state.topWidth / 100;
  const vertOff   = (state.vertOffset   / 100) * H;
  const horizOff  = (state.horizOffset  / 100) * W;

  const topW     = W * topRatio;
  const topLeft  = (W - topW) / 2 + horizOff;
  const topRight = topLeft + topW;
  const botLeft  = 0   + horizOff * 0.5;
  const botRight = W   + horizOff * 0.5;
  const topY     = 0   + vertOff;
  const botY     = H   + vertOff;

  ctx.beginPath();
  ctx.moveTo(topLeft,  topY);
  ctx.lineTo(topRight, topY);
  ctx.lineTo(botRight, botY);
  ctx.lineTo(botLeft,  botY);
  ctx.closePath();

  ctx.strokeStyle = 'rgba(247,195,79,0.8)';
  ctx.lineWidth   = 2;
  ctx.setLineDash([8, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // 上辺を赤でハイライト
  ctx.beginPath();
  ctx.moveTo(topLeft, topY);
  ctx.lineTo(topRight, topY);
  ctx.strokeStyle = 'rgba(247,95,95,0.9)';
  ctx.lineWidth   = 3;
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
  dom.cameraStatus.className  = `status-badge status-${type}`;
  dom.cameraStatus.textContent = text;
}

// ==========================================
// 台形 SVG プレビュー更新
// ==========================================
function updateTrapezoidPreview() {
  const svgW = 200, svgH = 120, margin = 10;
  const p = Homography.calcPreviewPoints(state.topWidth, svgW, svgH, margin);

  const points = `${p.topLeft},${p.topY} ${p.topRight},${p.topY} ${p.botRight},${p.botY} ${p.botLeft},${p.botY}`;
  dom.trapezoidShape.setAttribute('points', points);
  dom.topLine.setAttribute('x1', p.topLeft);
  dom.topLine.setAttribute('x2', p.topRight);
  dom.topLine.setAttribute('y1', p.topY);
  dom.topLine.setAttribute('y2', p.topY);
}

// ==========================================
// 情報バー更新
// ==========================================
function updateInfoBar() {
  dom.infoTopWidth.textContent = `上辺幅: ${state.topWidth}%`;
}

// ==========================================
// スライダートラック色更新
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
  [dom.topWidthSlider, dom.vertOffsetSlider, dom.horizOffsetSlider].forEach(sl => {
    updateSliderTrack(sl);
    sl.addEventListener('input', () => updateSliderTrack(sl));
  });
}

// ==========================================
// スライダーと数値入力の同期
// ==========================================
function syncSliderAndInput(slider, input, key) {
  slider.addEventListener('input', () => {
    const val = parseFloat(slider.value);
    state[key] = val;
    input.value = val;
    updateSliderTrack(slider);
    onParamChange();
  });
  input.addEventListener('change', () => {
    let val = parseFloat(input.value);
    val = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), val));
    state[key] = val;
    slider.value = val;
    input.value  = val;
    updateSliderTrack(slider);
    onParamChange();
  });
}

// ==========================================
// パラメータ変更共通処理
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
// スクリーンショット保存
// ==========================================
function saveScreenshot() {
  try {
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
    const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
    a.download = `trapezoid_${ts}.png`;
    a.click();
  } catch (e) {
    alert('スクリーンショットの保存に失敗しました: ' + e.message);
  }
}

// ==========================================
// リサイズ
// ==========================================
function onResize() {
  setupCanvasSize();
  if (!state.isRunning) clearOverlay();
}

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

// ==========================================
// イベント登録
// ==========================================
function registerEvents() {
  dom.startBtn.addEventListener('click', startCamera);
  dom.stopBtn.addEventListener('click', stopCamera);
  dom.resetBtn.addEventListener('click', resetParams);
  dom.screenshotBtn.addEventListener('click', saveScreenshot);

  syncSliderAndInput(dom.topWidthSlider,    dom.topWidthValue,    'topWidth');
  syncSliderAndInput(dom.vertOffsetSlider,  dom.vertOffsetValue,  'vertOffset');
  syncSliderAndInput(dom.horizOffsetSlider, dom.horizOffsetValue, 'horizOffset');

  dom.qualitySelect.addEventListener('change', () => {
    state.quality = dom.qualitySelect.value;
  });

  dom.showGrid.addEventListener('change', () => {
    state.showGrid = dom.showGrid.checked;
    if (!state.showGrid && !state.showOriginal) clearOverlay();
  });
  dom.showOriginal.addEventListener('change', () => {
    state.showOriginal = dom.showOriginal.checked;
    if (!state.showGrid && !state.showOriginal) clearOverlay();
  });

  window.addEventListener('resize', debounce(onResize, 200));
  navigator.mediaDevices.addEventListener('devicechange', enumerateCameras);
}

// ==========================================
// 初期化
// ==========================================
async function init() {
  setupCanvasSize();
  Renderer.init(dom.outputCanvas);

  dom.infoTransform.textContent = '変形: Canvas 2D スキャンライン';

  registerEvents();
  initSliderTracks();
  updateTrapezoidPreview();
  updateInfoBar();
  await enumerateCameras();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('error', 'カメラAPI非対応');
    dom.startBtn.disabled = true;
    dom.cameraSelect.innerHTML = '<option value="">このブラウザは非対応です</option>';
  }
}

document.addEventListener('DOMContentLoaded', init);
