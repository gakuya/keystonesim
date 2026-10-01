/* =============================================================
 * app.js  —  アプリケーション本体
 *   ・カメラ取得（PC / スマートフォン両対応）
 *   ・「設定」⇄「プレビュー」モード切替（ボタン1つ）
 *   ・カメラ角度 真上 → 斜め①(60度) → 斜め②(45度) の循環切替（ボタン1つ）
 *   ・描画ループ
 * ============================================================= */

(function () {
  'use strict';

  var G = window.Geometry;
  var PRESETS = G.ANGLE_PRESETS;
  var STORE_KEY = 'keystone-sim-v2';

  /* ---------- DOM ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    app: $('app'),
    video: $('video'),
    stageInner: $('stage-inner'),
    setupCanvas: $('setup-canvas'),
    previewCanvas: $('preview-canvas'),
    gridOverlay: $('grid-overlay'),

    splash: $('splash'),
    splashStart: $('splash-start'),
    errorOverlay: $('error-overlay'),
    errorText: $('error-text'),
    errorRetry: $('error-retry'),
    hint: $('hint'),
    hintText: $('hint-text'),

    modeChip: $('mode-chip'),
    angleChip: $('angle-chip'),

    modeBtn: $('mode-btn'),
    angleBtn: $('angle-btn'),
    angleBtnValue: $('angle-btn-value'),
    angleBtnNext: $('angle-btn-next'),
    angleSteps: $('angle-steps'),
    switchCamBtn: $('switch-cam-btn'),
    settingsBtn: $('settings-btn'),

    panel: $('panel'),
    panelClose: $('panel-close'),
    cameraSelect: $('camera-select'),
    spreadRange: $('spread-range'),
    spreadOut: $('spread-out'),
    offsetRange: $('offset-range'),
    offsetOut: $('offset-out'),
    ratioSelect: $('ratio-select'),
    mirrorCheck: $('mirror-check'),
    gridCheck: $('grid-check'),
    shotBtn: $('shot-btn'),
    resetBtn: $('reset-btn'),

    infoState: $('info-state'),
    infoRes: $('info-res'),
    infoFps: $('info-fps'),
    infoEngine: $('info-engine'),

    toast: $('toast')
  };

  /* ---------- 状態 ---------- */
  var DEFAULTS = {
    angleIndex: 0,
    spread: 0.35,
    offsetY: 0,
    ratio: 1.3333,
    mirror: false,
    grid: true,
    deviceId: '',
    facing: 'environment'
  };

  var state = Object.assign({}, DEFAULTS, loadSettings());
  state.mode = 'setup';           // 'setup' | 'preview'
  state.streaming = false;

  var stream = null;
  var devices = [];
  var setupRenderer = null;
  var previewRenderer = null;
  var rafId = null;
  var lastCamRatio = 0;
  var fps = { last: 0, frames: 0, value: 0 };

  /* =============================================================
   * 初期化
   * ========================================================== */
  function init() {
    setupRenderer = new window.SetupRenderer(el.setupCanvas);
    previewRenderer = new window.PreviewRenderer(el.previewCanvas);
    el.infoEngine.textContent = previewRenderer.engineLabel();

    applySettingsToUI();
    applyAspect();
    renderAngleUI();
    renderModeUI();
    bindEvents();

    // iOS Safari のアドレスバー変動・画面回転に追従
    updateStageSize();
    bindViewportEvents();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('このブラウザは getUserMedia に対応していません。Chrome / Safari / Edge の最新版をお試しください。');
    } else if (!window.isSecureContext && location.hostname !== 'localhost') {
      showError('カメラの利用には HTTPS 接続が必要です。URL が https:// で始まっているか確認してください。');
    }

    loop();
  }

  /* =============================================================
   * イベント
   * ========================================================== */
  function bindEvents() {
    el.splashStart.addEventListener('click', function () { startCamera(); });
    el.errorRetry.addEventListener('click', function () {
      hide(el.errorOverlay);
      startCamera();
    });

    // ── モード切替（ボタン1つ）──
    el.modeBtn.addEventListener('click', toggleMode);

    // ── 角度切替（ボタン1つ・押す度に循環）──
    el.angleBtn.addEventListener('click', function () {
      setAngleIndex((state.angleIndex + 1) % PRESETS.length);
    });

    // インジケーターからの直接指定（補助）
    el.angleSteps.addEventListener('click', function (e) {
      var btn = e.target.closest('.step');
      if (!btn) return;
      setAngleIndex(parseInt(btn.dataset.index, 10) || 0);
    });

    el.switchCamBtn.addEventListener('click', switchCamera);

    el.settingsBtn.addEventListener('click', function () { togglePanel(true); });
    el.panelClose.addEventListener('click', function () { togglePanel(false); });

    el.cameraSelect.addEventListener('change', function () {
      state.deviceId = el.cameraSelect.value;
      saveSettings();
      if (state.streaming) startCamera();
    });

    el.spreadRange.addEventListener('input', function () {
      state.spread = parseFloat(el.spreadRange.value);
      el.spreadOut.textContent = state.spread.toFixed(2);
      saveSettings();
    });

    el.offsetRange.addEventListener('input', function () {
      state.offsetY = parseInt(el.offsetRange.value, 10) / 100;
      el.offsetOut.textContent = el.offsetRange.value + '%';
      saveSettings();
    });

    el.ratioSelect.addEventListener('change', function () {
      state.ratio = parseFloat(el.ratioSelect.value);
      applyAspect();
      saveSettings();
    });

    el.mirrorCheck.addEventListener('change', function () {
      state.mirror = el.mirrorCheck.checked;
      saveSettings();
    });

    el.gridCheck.addEventListener('change', function () {
      state.grid = el.gridCheck.checked;
      syncGridOverlay();
      saveSettings();
    });

    el.shotBtn.addEventListener('click', saveShot);
    el.resetBtn.addEventListener('click', resetSettings);

    // キーボード（PC 向けショートカット）
    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space' || e.key === 'p' || e.key === 'P') {
        e.preventDefault(); toggleMode();
      } else if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowRight') {
        setAngleIndex((state.angleIndex + 1) % PRESETS.length);
      } else if (e.key === 'ArrowLeft') {
        setAngleIndex((state.angleIndex + PRESETS.length - 1) % PRESETS.length);
      } else if (e.key === 'Escape') {
        togglePanel(false);
      } else if (e.key >= '1' && e.key <= '3') {
        setAngleIndex(parseInt(e.key, 10) - 1);
      }
    });

    // プレビュー中に画面をタップしても設定に戻れるようにする
    el.stageInner.addEventListener('dblclick', toggleMode);

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopLoop(); else loop();
    });
  }

  /* =============================================================
   * カメラ
   * ========================================================== */
  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('このブラウザは getUserMedia に対応していません。');
      return;
    }
    setState('カメラ起動中…');
    stopStream();

    // 端末の向きに合わせた解像度を要求する
    // （スマートフォン縦持ちで横長の映像になり余白が出るのを防ぐ）
    var video = orientedResolution();
    if (state.deviceId) {
      video.deviceId = { exact: state.deviceId };
    } else {
      video.facingMode = { ideal: state.facing };
    }

    navigator.mediaDevices.getUserMedia({ video: video, audio: false })
      .then(onStream)
      .catch(function (err) {
        // deviceId 固定で失敗したらフォールバック
        if (state.deviceId) {
          state.deviceId = '';
          saveSettings();
          return navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: state.facing } }, audio: false
          }).then(onStream);
        }
        throw err;
      })
      .catch(function (err) {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false })
          .then(onStream)
          .catch(function () { throw err; });
      })
      .catch(handleCameraError);
  }

  /** 現在の画面の向きに適した解像度の制約を返す */
  function isPortrait() {
    return window.innerHeight >= window.innerWidth;
  }

  function orientedResolution() {
    return isPortrait()
      ? { width: { ideal: 1080 }, height: { ideal: 1920 } }
      : { width: { ideal: 1920 }, height: { ideal: 1080 } };
  }

  /**
   * 画面回転に合わせてカメラトラックの縦横を切り替える。
   *
   * 端末のカメラは起動時の向きの解像度で固定されるため、回転しても
   * 映像は縦長／横長のままとなり、ステージに大きな余白が出てしまう。
   * そこで applyConstraints() でトラックを再構成する。
   * （ストリームを張り替えないので映像が途切れず、権限も再要求されない）
   */
  var orientingNow = false;
  function reorientCamera() {
    if (!stream || orientingNow) return;
    var track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live' || !track.applyConstraints) return;

    var vw = el.video.videoWidth, vh = el.video.videoHeight;
    if (!vw || !vh) return;

    // 既に画面の向きと一致していれば何もしない
    var videoPortrait = vh > vw;
    if (videoPortrait === isPortrait()) return;

    orientingNow = true;
    track.applyConstraints(orientedResolution())
      .then(function () {
        // 反映されるまで数フレーム待ってから再レイアウト
        setTimeout(layoutCanvases, 120);
      })
      .catch(function () {
        // 非対応端末（回転に追従できないカメラ）では
        // そのままの解像度で contain 表示を維持する
      })
      .then(function () { orientingNow = false; });
  }

  function onStream(s) {
    stream = s;
    el.video.srcObject = s;
    var p = el.video.play();
    if (p && p.catch) p.catch(function () { /* 自動再生制限は muted で回避済み */ });

    state.streaming = true;
    hide(el.splash);
    hide(el.errorOverlay);
    setState('動作中');

    var track = s.getVideoTracks()[0];
    if (track) {
      var st = track.getSettings ? track.getSettings() : {};
      if (st.deviceId) state.deviceId = st.deviceId;
      if (st.facingMode) state.facing = st.facingMode;
      // フロントカメラは自然に見えるよう初回のみミラー
      if (st.facingMode === 'user' && !sessionStorage.getItem('mirror-touched')) {
        state.mirror = true;
        el.mirrorCheck.checked = true;
      }
      track.addEventListener('ended', function () {
        state.streaming = false;
        setState('停止中');
      });
    }
    saveSettings();
    refreshDevices();
    showToast('カメラを開始しました');
    loop();
  }

  function handleCameraError(err) {
    state.streaming = false;
    var name = err && err.name ? err.name : '';
    var msg;
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        msg = 'カメラの使用が許可されていません。ブラウザのアドレスバーのカメラアイコンから許可してください。';
        break;
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        msg = '利用できるカメラが見つかりませんでした。接続を確認してください。';
        break;
      case 'NotReadableError':
      case 'TrackStartError':
        msg = 'カメラが他のアプリで使用中の可能性があります。他のアプリを終了してから再試行してください。';
        break;
      case 'OverconstrainedError':
        msg = '指定した解像度・カメラに対応していません。別のカメラを選択してください。';
        break;
      default:
        msg = 'カメラの初期化に失敗しました。' + (err && err.message ? '（' + err.message + '）' : '');
    }
    showError(msg);
  }

  function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (list) {
      devices = list.filter(function (d) { return d.kind === 'videoinput'; });
      el.cameraSelect.innerHTML = '';
      if (!devices.length) {
        el.cameraSelect.appendChild(opt('', 'カメラが見つかりません'));
        return;
      }
      devices.forEach(function (d, i) {
        el.cameraSelect.appendChild(opt(d.deviceId, d.label || ('カメラ ' + (i + 1))));
      });
      if (state.deviceId) el.cameraSelect.value = state.deviceId;
      el.switchCamBtn.disabled = devices.length < 2;
    }).catch(function () { /* 無視 */ });
  }

  function switchCamera() {
    if (devices.length > 1) {
      var idx = devices.findIndex(function (d) { return d.deviceId === state.deviceId; });
      state.deviceId = devices[(idx + 1 + devices.length) % devices.length].deviceId;
    } else {
      state.deviceId = '';
      state.facing = state.facing === 'environment' ? 'user' : 'environment';
    }
    saveSettings();
    startCamera();
  }

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
  }

  function opt(value, label) {
    var o = document.createElement('option');
    o.value = value; o.textContent = label;
    return o;
  }

  /* =============================================================
   * モード / 角度
   * ========================================================== */
  function toggleMode() {
    state.mode = state.mode === 'setup' ? 'preview' : 'setup';
    renderModeUI();
    showToast(state.mode === 'preview' ? 'プレビューモード' : '設定モード');
  }

  function renderModeUI() {
    var preview = state.mode === 'preview';

    el.app.classList.toggle('mode-preview', preview);
    el.app.classList.toggle('mode-setup', !preview);

    toggle(el.setupCanvas, !preview);
    toggle(el.previewCanvas, preview);
    syncGridOverlay();

    el.modeChip.textContent = preview ? 'プレビューモード' : '設定モード';
    el.modeChip.className = 'chip ' + (preview ? 'chip-preview' : 'chip-setup');

    el.modeBtn.querySelector('.btn-label').textContent =
      preview ? '設定へ切替' : 'プレビューへ切替';
    el.modeBtn.querySelector('.btn-ico').textContent = preview ? '⚙' : '👁';
    el.modeBtn.classList.toggle('is-preview', preview);

    el.hintText.textContent = preview
      ? '真上から見たように変形した映像です。歪みが残る場合は「設定」でカメラ角度を調整してください'
      : '台形の枠がテーブルの範囲に合うように、カメラの角度を選んでください';
    flashHint();

    layoutCanvases();

    // プレビュー中も角度は切り替えられる（効果を確認しやすい）
    el.angleBtn.disabled = false;
  }

  function setAngleIndex(i) {
    state.angleIndex = ((i % PRESETS.length) + PRESETS.length) % PRESETS.length;
    saveSettings();
    renderAngleUI();
    showToast('カメラ角度：' + PRESETS[state.angleIndex].label +
              '（' + PRESETS[state.angleIndex].detail + '）');
  }

  function renderAngleUI() {
    var p = PRESETS[state.angleIndex];
    var next = PRESETS[(state.angleIndex + 1) % PRESETS.length];

    el.angleChip.textContent = p.label;
    el.angleBtnValue.textContent = p.label + '（' + p.detail + '）';
    el.angleBtnNext.textContent = '次：' + next.label + '（' + next.detail + '）';

    Array.prototype.forEach.call(el.angleSteps.children, function (c, i) {
      c.classList.toggle('active', i === state.angleIndex);
    });
  }

  /* =============================================================
   * 描画ループ
   * ========================================================== */
  function currentQuad() {
    return G.trapezoidNormalized({
      elevation: PRESETS[state.angleIndex].elevation,
      spread: state.spread,
      offsetY: state.offsetY
    });
  }

  function loop() {
    if (rafId !== null) return;
    var tick = function (ts) {
      rafId = null;
      draw(ts);
      loop();
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function draw(ts) {
    var quad = currentQuad();
    var opt = { mirror: state.mirror, grid: state.grid,
                label: PRESETS[state.angleIndex].label,
                detail: PRESETS[state.angleIndex].detail };

    if (state.mode === 'setup') {
      setupRenderer.render(el.video, quad, opt);
    } else {
      previewRenderer.render(el.video, quad, opt);
    }

    // カメラの縦横比が変わったら（＝初回フレーム／カメラ切替時）再レイアウト
    if (el.video.videoWidth && el.video.videoHeight) {
      var cr = el.video.videoWidth / el.video.videoHeight;
      if (cr !== lastCamRatio) {
        lastCamRatio = cr;
        layoutCanvases();
      }
    }

    // FPS
    fps.frames++;
    if (!fps.last) fps.last = ts;
    if (ts - fps.last >= 1000) {
      fps.value = Math.round(fps.frames * 1000 / (ts - fps.last));
      fps.frames = 0; fps.last = ts;
      el.infoFps.textContent = fps.value + ' fps';
      if (el.video.videoWidth) {
        el.infoRes.textContent = el.video.videoWidth + ' × ' + el.video.videoHeight;
      }
    }
  }

  /* =============================================================
   * レイアウト
   * ========================================================== */
  function applyAspect() {
    el.stageInner.style.setProperty('--out-ratio', String(state.ratio));
    layoutCanvases();
  }

  function updateStageSize() {
    // iOS の 100vh 問題対策
    document.documentElement.style.setProperty('--vh', window.innerHeight + 'px');
    layoutCanvases();
  }

  /**
   * ステージ内に収まる最大サイズを縦横比から計算し、
   * キャンバスの CSS サイズを px で明示する。
   * （設定モードはカメラ映像の比、プレビューは出力指定の比）
   */
  function layoutCanvases() {
    var box = el.stageInner.getBoundingClientRect();
    if (!box.width || !box.height) return;

    var camRatio = (el.video.videoWidth && el.video.videoHeight)
      ? el.video.videoWidth / el.video.videoHeight
      : state.ratio;

    fitOne(el.setupCanvas, camRatio, box);
    fitOne(el.previewCanvas, state.ratio, box);
    fitOne(el.gridOverlay, state.ratio, box);
  }

  function fitOne(node, ratio, box) {
    var w = box.width, h = box.width / ratio;
    if (h > box.height) { h = box.height; w = box.height * ratio; }
    node.style.width = Math.round(w) + 'px';
    node.style.height = Math.round(h) + 'px';
  }

  function onResize() {
    updateStageSize();
  }

  /* =============================================================
   * ビューポート変化（リサイズ・画面回転）の監視
   *
   * 回転の検知方法は端末差が大きいため、複数の経路を併用する。
   *   - resize            : 最も確実。PC のウィンドウ操作もここ
   *   - orientationchange : iOS Safari では resize より先に飛ぶ
   *   - screen.orientation: 新しい標準イベント
   *   - visualViewport    : iOS のアドレスバー伸縮・ズーム
   * いずれも最終的に同じ再レイアウト処理へ集約する。
   * ========================================================== */
  function bindViewportEvents() {
    window.addEventListener('resize', scheduleRelayout, { passive: true });
    window.addEventListener('orientationchange', onOrientationChange, { passive: true });

    if (window.screen && window.screen.orientation &&
        window.screen.orientation.addEventListener) {
      window.screen.orientation.addEventListener('change', onOrientationChange);
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', scheduleRelayout, { passive: true });
    }
  }

  /**
   * 回転直後は端末が報告するサイズがまだ古い場合があるため
   * （特に iOS Safari）、複数回に分けて再計測する。
   */
  function onOrientationChange() {
    [0, 80, 200, 420, 700].forEach(function (d) {
      setTimeout(function () {
        updateStageSize();
        reorientCamera();
      }, d);
    });
  }

  /** 連続する resize をまとめて 1 回の再レイアウトにする */
  var relayoutRaf = null;
  var relayoutTimer = null;
  function scheduleRelayout() {
    if (relayoutRaf === null) {
      relayoutRaf = requestAnimationFrame(function () {
        relayoutRaf = null;
        updateStageSize();
      });
    }
    // 変化が落ち着いた後にカメラの向きも合わせる
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(function () {
      updateStageSize();
      reorientCamera();
    }, 260);
  }

  /** ヒントを数秒だけ表示して自動で薄くする */
  var hintTimer = null;
  function flashHint() {
    el.hint.classList.remove('faded');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () {
      el.hint.classList.add('faded');
    }, 4500);
  }

  function syncGridOverlay() {
    var show = state.grid && state.mode === 'preview';
    toggle(el.gridOverlay, show);
  }

  /* =============================================================
   * パネル / 保存
   * ========================================================== */
  function togglePanel(open) {
    toggle(el.panel, open);
    el.panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    el.app.classList.toggle('panel-open', open);
  }

  function applySettingsToUI() {
    el.spreadRange.value = state.spread;
    el.spreadOut.textContent = Number(state.spread).toFixed(2);
    el.offsetRange.value = Math.round(state.offsetY * 100);
    el.offsetOut.textContent = el.offsetRange.value + '%';
    el.ratioSelect.value = String(state.ratio);
    if (!el.ratioSelect.value) el.ratioSelect.value = '1.3333';
    el.mirrorCheck.checked = !!state.mirror;
    el.gridCheck.checked = !!state.grid;
    el.mirrorCheck.addEventListener('change', function () {
      sessionStorage.setItem('mirror-touched', '1');
    });
  }

  function resetSettings() {
    var keepDevice = state.deviceId, keepFacing = state.facing;
    state = Object.assign({}, DEFAULTS, {
      deviceId: keepDevice, facing: keepFacing,
      mode: state.mode, streaming: state.streaming
    });
    applySettingsToUI();
    applyAspect();
    renderAngleUI();
    syncGridOverlay();
    saveSettings();
    showToast('設定を初期値に戻しました');
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        angleIndex: state.angleIndex,
        spread: state.spread,
        offsetY: state.offsetY,
        ratio: state.ratio,
        mirror: state.mirror,
        grid: state.grid,
        deviceId: state.deviceId,
        facing: state.facing
      }));
    } catch (e) { /* 無視 */ }
  }

  function loadSettings() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      var o = JSON.parse(raw) || {};
      return {
        angleIndex: clampInt(o.angleIndex, 0, PRESETS.length - 1, 0),
        spread: G.clamp(Number(o.spread) || 0.35, 0.1, 0.7),
        offsetY: G.clamp(Number(o.offsetY) || 0, -0.4, 0.4),
        ratio: Number(o.ratio) || 1.3333,
        mirror: !!o.mirror,
        grid: o.grid !== false,
        deviceId: typeof o.deviceId === 'string' ? o.deviceId : '',
        facing: o.facing === 'user' ? 'user' : 'environment'
      };
    } catch (e) { return {}; }
  }

  function clampInt(v, lo, hi, def) {
    v = parseInt(v, 10);
    if (isNaN(v)) return def;
    return Math.max(lo, Math.min(hi, v));
  }

  /* =============================================================
   * スクリーンショット
   * ========================================================== */
  function saveShot() {
    var canvas = state.mode === 'preview' ? el.previewCanvas : el.setupCanvas;
    var url;
    try { url = canvas.toDataURL('image/png'); }
    catch (e) { url = null; }
    if (!url) { showToast('画像の保存に失敗しました'); return; }

    var a = document.createElement('a');
    a.href = url;
    a.download = 'camera-' + state.mode + '-' +
      new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('PNG を保存しました');
  }

  /* =============================================================
   * 小物
   * ========================================================== */
  function hide(node) { node.classList.add('hidden'); }
  function toggle(node, on) { node.classList.toggle('hidden', !on); }

  function setState(text) { el.infoState.textContent = text; }

  function showError(msg) {
    el.errorText.textContent = msg;
    hide(el.splash);
    el.errorOverlay.classList.remove('hidden');
    setState('エラー');
  }

  var toastTimer = null;
  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('show');
      setTimeout(function () { el.toast.classList.add('hidden'); }, 220);
    }, 1500);
  }

  /* 起動 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
