'use strict';
// 摄像头：声效、网格检测、捕获流程、Dev Mode
// 注意：不再有 IIFE 包裹，各 JS 文件共享全局作用域；加载顺序见 index.html（help→data→camera→ui→app），不要调换。
  function loadROI(){
    try{
      var raw = localStorage.getItem(ROI_KEY);
      var v = raw ? JSON.parse(raw) : null;
      if(v && typeof v.left === 'number' && typeof v.top === 'number' && typeof v.width === 'number' && typeof v.height === 'number'){
        roiState = v;
      }
    }catch(e){}
  }

  function saveROI(){
    try{ localStorage.setItem(ROI_KEY, JSON.stringify(roiState)); }catch(e){}
  }

  function clampROI(){
    roiState.width = Math.max(8, Math.min(96, roiState.width));
    roiState.height = Math.max(6, Math.min(96, roiState.height));
    roiState.left = Math.max(0, Math.min(100 - roiState.width, roiState.left));
    roiState.top = Math.max(0, Math.min(100 - roiState.height, roiState.top));
  }

  function applyROIStyle(){
    var el = document.getElementById('roiGuide');
    if(!el){ return; }
    el.style.left = roiState.left + '%';
    el.style.top = roiState.top + '%';
    el.style.width = roiState.width + '%';
    el.style.height = roiState.height + '%';
  }

  function setupROIInteraction(){
    var stage = document.querySelector('.cameraStage');
    var guide = document.getElementById('roiGuide');
    var handle = document.getElementById('roiResizeHandle');
    var mode = null;
    var startX = 0, startY = 0, startState = null;

    function onDown(e, m){
      mode = m;
      startX = e.clientX; startY = e.clientY;
      startState = { left: roiState.left, top: roiState.top, width: roiState.width, height: roiState.height };
      try{ e.target.setPointerCapture(e.pointerId); }catch(err){}
      e.preventDefault();
      e.stopPropagation();
    }

    guide.addEventListener('pointerdown', function(e){
      if(e.target === handle){ return; }
      onDown(e, 'drag');
    });
    handle.addEventListener('pointerdown', function(e){
      onDown(e, 'resize');
    });

    function onMove(e){
      if(!mode){ return; }
      var rect = stage.getBoundingClientRect();
      var dxPct = (e.clientX - startX) / rect.width * 100;
      var dyPct = (e.clientY - startY) / rect.height * 100;
      if(mode === 'drag'){
        roiState.left = startState.left + dxPct;
        roiState.top = startState.top + dyPct;
      } else if(mode === 'resize'){
        roiState.width = startState.width + dxPct;
        roiState.height = startState.height + dyPct;
      }
      clampROI();
      applyROIStyle();
    }

    function onUp(){
      if(mode){ saveROI(); resetDetectionBaseline(); }
      mode = null;
    }

    guide.addEventListener('pointermove', onMove);
    guide.addEventListener('pointerup', onUp);
    guide.addEventListener('pointercancel', onUp);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);

    document.getElementById('roiResetBtn').addEventListener('click', function(){
      roiState = { left: ROI_DEFAULT.left, top: ROI_DEFAULT.top, width: ROI_DEFAULT.width, height: ROI_DEFAULT.height };
      saveROI();
      applyROIStyle();
      resetDetectionBaseline();
    });
  }

  // ==== v4.16.0 摄像头页操作声效 ====
  // 用Web Audio API现场合成，不依赖外部音频文件，跟"单文件HTML PWA"的原则保持一致。
  // iOS Safari要求AudioContext必须在用户手势内创建/resume——"开始监测"按钮点击本身
  // 就是一次用户手势，在playStartSound()触发时顺带唤醒/resume一次即可；之后连拍等
  // 由检测循环自动触发的声效复用同一个已解锁的AudioContext，不需要每次都靠新的用户手势。
  // 三处声效调用全部放在各自捕获逻辑(addRecordAtTime/session记录/state更新)完全跑完之后
  // 才触发，且Web Audio的node创建和start()本身是非阻塞的，不会拖慢下一帧的触发检测速度。
  var soundCtx = null;
  function getSoundCtx(){
    if(!soundCtx){
      try{ soundCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch(e){ return null; }
    }
    if(soundCtx.state === 'suspended'){ soundCtx.resume().catch(function(){}); }
    return soundCtx;
  }
  function playTone(freq, startDelay, durationSec, waveType, gainPeak){
    var ctx = getSoundCtx();
    if(!ctx){ return; }
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = waveType || 'sine';
    osc.frequency.value = freq;
    var t0 = ctx.currentTime + (startDelay || 0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(gainPeak || 0.2, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + durationSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.02);
  }
  // "开始监测"按下：轻快上扬双音，跟按钮变红/文案变"停止监测"的视觉反馈呼应
  function playStartSound(){
    playTone(880, 0, 0.09, 'sine', 0.18);
    playTone(1320, 0.09, 0.10, 'sine', 0.16);
  }
  // 连拍模式每次抓拍：模拟iOS快门"咔哒"两段声——用带通滤波器把噪声限制在
  // 类似真实快门的频段，前一下偏高更脆(模拟开)、后一下偏低更闷(模拟合)，
  // 比直接放一段宽频白噪声柔和很多，不再有"太硬朗"的刺耳感。
  function playShutterSound(){
    var ctx = getSoundCtx();
    if(!ctx){ return; }
    var t0 = ctx.currentTime;
    var clicks = [
      { delay: 0,     freq: 4200, q: 1.1, dur: 0.012, gain: 0.20 },
      { delay: 0.055, freq: 2600, q: 1.3, dur: 0.016, gain: 0.14 }
    ];
    clicks.forEach(function(c){
      var bufSize = Math.max(1, Math.floor(ctx.sampleRate * c.dur));
      var buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      var data = buf.getChannelData(0);
      for(var i=0;i<bufSize;i++){ data[i] = (Math.random()*2-1) * (1 - i/bufSize); }
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = c.freq;
      filter.Q.value = c.q;
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(c.gain, t0+c.delay);
      gain.gain.exponentialRampToValueAtTime(0.001, t0+c.delay+c.dur);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      src.start(t0+c.delay);
    });
  }
  // 快捷模式单次捕获结束 / 连拍模式整组结束：三音上行完成提示音，跟快门声区分，
  // 一听就知道"这轮结束了"而不是"还在拍"
  function playCompleteSound(){
    playTone(660, 0, 0.08, 'sine', 0.16);
    playTone(880, 0.08, 0.08, 'sine', 0.16);
    playTone(1100, 0.16, 0.14, 'sine', 0.18);
  }

  // v4.19.0：连拍不合格警报音——低沉下行的两声方波"嗡—嗡"，音色/音高/节奏都跟快门声(高频咔哒)、
  // 完成声(上行三音正弦)完全不同；不合格时用它替代快门声/完成声，不会跟它们叠在一起。
  function playAlarmSound(){
    playTone(330, 0, 0.16, 'square', 0.12);
    playTone(220, 0.22, 0.32, 'square', 0.12);
  }

  var cameraStream = null;
  var cameraState = 'idle';
  var cameraLoopActive = false;
  var shakeToleranceRadius = 2;
  var SENSITIVITY_MAX = 50;
  var sensitivityThreshold = 10; // 会在init()里被loadSensitivity()覆盖，这里只是兜底默认
  var DIFF_METER_MAX = 200; // v4.0.6: 100时细网格常规读数(170-220)长期顶格，看不出相对大小；实测细网格最高220+，200仍不能完全覆盖，但比100好得多
  var DIFF_METER_DANGER = 250; // v4.0.7: 超过DIFF_METER_MAX后电平条满格显示，200~250黄色，>250红色，不再需要靠不断上调MAX来追峰值
  var cameraRafId = null;
  var cooldownTimer = null;
  var consecutiveHits = 0;
  var firstHitTimestamp = null;
  var REQUIRED_CONSECUTIVE_HITS = 2;

  // ==== v3.7 网格局部检测（新Trigger链路，取代旧的整ROI/Mask二值化比对） ====
  var gridCols = 5;
  var gridRows = 7;
  var baselineCellAvg = null; // v3.8.4: 冻结基线，只在初始化/触发确认后刷新，不再逐帧滚动更新
  var GRID_GLOBAL_RATIO_LIMIT = 0.85; // v3.9.8: 紧框选场景下真实跳变本身就会覆盖大半格子，50%误伤太多，调高让真信号通过
  var GRID_MIN_CELLS_TO_TRIGGER = 1;
  var lastGridDiag = { changedCells: 0, totalCells: 0, globalRatio: 0, maxCellDelta: 0 };

  // v3.8.4: baseline统一重置入口。ROI/网格密度/变焦等任何改变画面内容或格子布局的操作都必须调用，
  // 否则baseline会跟新画面/新格子数错位，产生无意义的delta。
  function resetDetectionBaseline(){
    baselineCellAvg = null;
    consecutiveHits = 0;
    firstHitTimestamp = null;
  }

  var GRID_DENSITY_KEY = 'cc_griddensity_v1';
  var GRID_DENSITY_PX = { coarse: 20, medium: 12, fine: 8 };
  var gridDensityMode = 'medium';

  function loadGridDensity(){
    try{
      var v = localStorage.getItem(GRID_DENSITY_KEY);
      gridDensityMode = (v === 'coarse' || v === 'medium' || v === 'fine') ? v : 'medium';
    }catch(e){ gridDensityMode = 'medium'; }
  }

  function saveGridDensity(){
    try{ localStorage.setItem(GRID_DENSITY_KEY, gridDensityMode); }catch(e){}
  }
  var lastCellChanged = new Uint8Array(0);

  var GRID_OVERLAY_KEY = 'cc_gridoverlay_v1';
  var showGridOverlay = false;

  function loadGridOverlay(){
    try{ showGridOverlay = localStorage.getItem(GRID_OVERLAY_KEY) === '1'; }catch(e){ showGridOverlay = false; }
  }

  function saveGridOverlay(){
    try{ localStorage.setItem(GRID_OVERLAY_KEY, showGridOverlay ? '1' : '0'); }catch(e){}
  }

  var gridOverlayLastW = 0;
  var gridOverlayLastH = 0;

  function clearGridOverlayCanvas(){
    var canvas = document.getElementById('gridOverlayCanvas');
    if(!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawGridOverlay(){
    var canvas = document.getElementById('gridOverlayCanvas');
    if(!canvas || !showGridOverlay){ return; }
    var guide = document.getElementById('roiGuide');
    if(!guide){ return; }
    var rect = guide.getBoundingClientRect();
    var w = Math.round(rect.width), h = Math.round(rect.height);
    if(w <= 0 || h <= 0){ return; }
    if(w !== gridOverlayLastW || h !== gridOverlayLastH){
      canvas.width = w; canvas.height = h;
      gridOverlayLastW = w; gridOverlayLastH = h;
    }
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    var cols = gridCols, rows = gridRows;
    var cellW = w / cols, cellH = h / rows;

    ctx.save();
    if(lastCellChanged.length === cols*rows){
      ctx.fillStyle = 'rgba(255,87,34,0.25)';
      for(var ci=0; ci<lastCellChanged.length; ci++){
        if(lastCellChanged[ci]){
          var gx = ci % cols, gy = Math.floor(ci/cols);
          ctx.fillRect(gx*cellW, gy*cellH, cellW, cellH);
        }
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3,3]);
    for(var c=1; c<cols; c++){
      var x = Math.round(c*cellW) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for(var r=1; r<rows; r++){
      var y = Math.round(r*cellH) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.restore();
  }

  function computeGridDims(){
    var video = document.getElementById('cameraVideo');
    if(!video || !video.videoWidth){ gridCols = 5; gridRows = 7; return; }
    var vr = getVisibleVideoRect(video);
    var sw = vr.visW * (roiState.width/100);
    var sh = vr.visH * (roiState.height/100);
    var effW = Math.min(SAMPLE_W, sw);
    var effH = Math.min(SAMPLE_H, sh);
    var targetPx = GRID_DENSITY_PX[gridDensityMode] || GRID_DENSITY_PX.medium;
    gridCols = Math.max(3, Math.min(8, Math.round(effW/targetPx)));
    gridRows = Math.max(4, Math.min(10, Math.round(effH/targetPx)));
    lastCellChanged = new Uint8Array(gridCols*gridRows);
    gridOverlayLastW = 0;
    gridOverlayLastH = 0;
  }

  function computeGridCellAvg(frame, w, h, cols, rows){
    var cellSum = new Float32Array(cols*rows);
    var cellCount = new Int32Array(cols*rows);
    for(var y=0; y<h; y++){
      var cy = Math.min(rows-1, Math.floor(y*rows/h));
      var rowBase = cy*cols;
      for(var x=0; x<w; x++){
        var cx = Math.min(cols-1, Math.floor(x*cols/w));
        var idx = (y*w+x)*4;
        var redness = frame[idx] - Math.max(frame[idx+1], frame[idx+2]);
        var ci = rowBase+cx;
        cellSum[ci] += redness;
        cellCount[ci]++;
      }
    }
    for(var i=0; i<cellSum.length; i++){ if(cellCount[i]>0){ cellSum[i] /= cellCount[i]; } }
    return cellSum;
  }

  function updateCameraBadge(text){
    var el = document.getElementById('cameraStatusBadge');
    if(el){ el.textContent = text; }
  }

  function startCamera(){
    if(cameraStream){ return; }
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      updateCameraBadge('浏览器不支持摄像头');
      return;
    }
    updateCameraBadge('请求摄像头权限...');
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: {ideal:1280}, height: {ideal:960} },
      audio: false
    }).then(function(stream){
      cameraStream = stream;
      var video = document.getElementById('cameraVideo');
      video.srcObject = stream;
      updateCameraBadge('预览中，未开始监测');
      trySetupFocusLock(stream);
      trySetupZoom(stream);
      // 相机首次授权/启动这段异步过程可能抢走 responder，这里在流真正就绪后
      // 多试几次(而不是只在切屏那一刻聚焦一次)，专门堵住这个时间差。
      [0, 300, 1000, 2500].forEach(function(delay){
        setTimeout(function(){
          if(currentScreen === 'camera'){ focusGhostInput(); }
        }, delay);
      });
    }).catch(function(err){
      updateCameraBadge('无法访问摄像头');
      alert('无法打开摄像头: ' + ((err && err.message) || '未知错误') + '。请检查系统设置里是否已授权摄像头权限。');
    });
  }

  function trySetupFocusLock(stream){
    var row = document.getElementById('focusBtnRow');
    row.style.display = 'none';
    var track = stream.getVideoTracks()[0];
    if(!track || !track.getCapabilities){ return; }
    var caps;
    try{ caps = track.getCapabilities(); }catch(e){ return; }
    if(!caps || !caps.focusMode || caps.focusMode.indexOf('manual') === -1){ return; }
    row.style.display = 'flex';
    var btn = document.getElementById('focusLockBtn');
    btn.onclick = function(){
      track.applyConstraints({ advanced: [{ focusMode: 'manual' }] })
        .then(function(){ btn.textContent = '已锁定对焦'; })
        .catch(function(){ showCamToast('这台设备/浏览器不支持手动锁定对焦，请让镜头静置几秒等自动对焦稳定后再开始监测。', 4000); });
    };
  }

  function trySetupZoom(stream){
    var row = document.getElementById('hwZoomRow');
    row.style.display = 'none';
    var track = stream.getVideoTracks()[0];
    if(!track || !track.getCapabilities){ return; }
    var caps;
    try{ caps = track.getCapabilities(); }catch(e){ return; }
    if(!caps || !caps.zoom){ return; }
    row.style.display = 'flex';
    var slider = document.getElementById('hwZoomSlider');
    var valEl = document.getElementById('hwZoomVal');
    slider.min = caps.zoom.min;
    slider.max = caps.zoom.max;
    slider.step = caps.zoom.step || 0.1;
    var settings = track.getSettings ? track.getSettings() : {};
    var savedZoom = null;
    try{ savedZoom = parseFloat(localStorage.getItem(ZOOM_KEY + '_hw')); }catch(e){}
    var initialZoom = (savedZoom && savedZoom >= caps.zoom.min && savedZoom <= caps.zoom.max) ? savedZoom : (settings.zoom || caps.zoom.min);
    slider.value = initialZoom;
    valEl.textContent = parseFloat(slider.value).toFixed(1) + 'x';
    track.applyConstraints({ advanced: [{ zoom: initialZoom }] }).catch(function(){});
    slider.oninput = function(){
      var v = parseFloat(slider.value);
      valEl.textContent = v.toFixed(1) + 'x';
      track.applyConstraints({ advanced: [{ zoom: v }] }).catch(function(){});
      try{ localStorage.setItem(ZOOM_KEY + '_hw', String(v)); }catch(e){}
      resetDetectionBaseline();
    };
  }


  function stopCamera(){
    resetUndoBtnState();
    clearBurstState();
    if(cameraStream){
      cameraStream.getTracks().forEach(function(tr){ tr.stop(); });
      cameraStream = null;
    }
    var video = document.getElementById('cameraVideo');
    if(video){ video.srcObject = null; }
    cameraState = 'idle';
    cameraLoopActive = false;
    resetDetectionBaseline();
    lastStatsSampleTime = 0;
    clearGridOverlayCanvas();
    analysisFrameCount = 0;
    analysisTimeSamples = [];
    frameArrivalTimestamps = [];
    lastTotalVideoFrames = 0;
    lastDroppedVideoFrames = 0;
    if(cameraRafId){ cancelAnimationFrame(cameraRafId); cameraRafId = null; }
    if(cooldownTimer){ clearTimeout(cooldownTimer); cooldownTimer = null; }
    updateCameraBadge('未启动');
    document.getElementById('cameraStatusBadge').classList.remove('captured', 'armed');
    updateStartBtnLabel();
    resetDiffMeter();
    var latEl = document.getElementById('estLatencyDisplay');
    if(latEl){ latEl.textContent = '系统估算延迟: --'; }
  }

  function armCameraDetection(){
    if(!cameraStream){ startCamera(); }
    cameraState = 'armed';
    resetUndoBtnState();
    computeGridDims();
    resetDetectionBaseline();
    updateCameraBadge('监测中...');
    var badgeEl = document.getElementById('cameraStatusBadge');
    badgeEl.classList.remove('captured');
    badgeEl.classList.add('armed');

    lastStatsSampleTime = performance.now();
    analysisFrameCount = 0;
    analysisTimeSamples = [];
    frameArrivalTimestamps = [];
    var video = document.getElementById('cameraVideo');
    if(video && video.getVideoPlaybackQuality){
      var q = video.getVideoPlaybackQuality();
      lastTotalVideoFrames = q.totalVideoFrames || 0;
      lastDroppedVideoFrames = q.droppedVideoFrames || 0;
    }

    if(!cameraLoopActive){
      cameraLoopActive = true;
      runCameraLoop();
    }
    updateStartBtnLabel();
  }

  function disarmCameraDetection(){
    cameraState = 'idle';
    resetDetectionBaseline();
    updateCameraBadge('已取消监测');
    document.getElementById('cameraStatusBadge').classList.remove('captured', 'armed');
    resetDiffMeter();
    updateStartBtnLabel();
    clearBurstState();
  }

  function toggleCameraArm(){
    if(cameraState === 'armed'){
      if(devState === 'RUNNING'){ devStopExperiment('Manual_Stop'); }
      disarmCameraDetection();
    } else {
      if(devState === 'READY'){ devStartExperiment(); }
      armCameraDetection();
      playStartSound();
    }
  }

  function updateStartBtnLabel(){
    var btn = document.getElementById('cameraStartBtn');
    if(!btn){ return; }
    var isArmed = (cameraState === 'armed');
    if(devState === 'RUNNING'){
      btn.textContent = '停止 Dev 采样';
    } else {
      btn.textContent = isArmed ? '停止监测' : '开始监测';
    }
    btn.classList.toggle('bigCamBtn-stop', isArmed);
    btn.classList.toggle('bigCamBtn-primary', !isArmed);
  }

  function runCameraLoop(){
    var video = document.getElementById('cameraVideo');
    if(!video){ cameraLoopActive = false; return; }
    if(video.requestVideoFrameCallback){
      video.requestVideoFrameCallback(function(){
        recordFrameArrival();
        processCameraFrame(nowCorrected());
        sampleCameraStats();
        if(cameraLoopActive){ runCameraLoop(); }
      });
    } else {
      cameraRafId = requestAnimationFrame(function(){
        recordFrameArrival();
        processCameraFrame(nowCorrected());
        sampleCameraStats();
        if(cameraLoopActive){ runCameraLoop(); }
      });
    }
  }

  function recordFrameArrival(){
    var now = performance.now();
    if(frameArrivalTimestamps.length > 0){
      var lastT = frameArrivalTimestamps[frameArrivalTimestamps.length-1];
      if(now - lastT > 1000){
        frameArrivalTimestamps = [];
      }
    }
    frameArrivalTimestamps.push(now);
    if(frameArrivalTimestamps.length > 40){ frameArrivalTimestamps.shift(); }
  }

  function updateDiffMeter(avgDiff){
    var fillEl = document.getElementById('diffMeterFill');
    var threshEl = document.getElementById('diffMeterThresholdMarker');
    var labelEl = document.getElementById('diffMeterLabel');
    if(!fillEl){ return; }
    var fillPct = Math.min(100, (avgDiff / DIFF_METER_MAX) * 100);
    var threshPct = Math.min(100, (sensitivityThreshold / DIFF_METER_MAX) * 100);
    var triggered = avgDiff > sensitivityThreshold;
    fillEl.style.width = fillPct + '%';
    fillEl.classList.toggle('triggered', triggered);
    fillEl.classList.toggle('overWarn', avgDiff > DIFF_METER_MAX && avgDiff <= DIFF_METER_DANGER);
    fillEl.classList.toggle('overDanger', avgDiff > DIFF_METER_DANGER);
    if(threshEl){ threshEl.style.left = threshPct + '%'; }
    if(labelEl){ labelEl.textContent = avgDiff.toFixed(1) + ' / ' + sensitivityThreshold.toFixed(1); }
  }

  function resetDiffMeter(){
    var fillEl = document.getElementById('diffMeterFill');
    var threshEl = document.getElementById('diffMeterThresholdMarker');
    var labelEl = document.getElementById('diffMeterLabel');
    if(fillEl){ fillEl.style.width = '0%'; fillEl.classList.remove('triggered', 'overWarn', 'overDanger'); }
    if(threshEl){ threshEl.style.left = Math.min(100, (sensitivityThreshold/DIFF_METER_MAX)*100) + '%'; }
    if(labelEl){ labelEl.textContent = '-- / ' + sensitivityThreshold.toFixed(1); }
  }

  var SAMPLE_W = 50;
  var SAMPLE_H = 70;

  var ZOOM_KEY = 'cc_zoom_v1';
  var CAMERA_PARAMS_COLLAPSED_KEY = 'cc_camparams_collapsed_v1';

  function loadCameraParamsCollapsed(){
    try{
      var raw = localStorage.getItem(CAMERA_PARAMS_COLLAPSED_KEY);
      return raw === null ? true : raw === '1';
    }catch(e){ return true; }
  }

  function saveCameraParamsCollapsed(collapsed){
    try{ localStorage.setItem(CAMERA_PARAMS_COLLAPSED_KEY, collapsed ? '1' : '0'); }catch(e){}
  }

  function updateCameraParamsSummary(){
    var el = document.getElementById('cameraParamsSummaryText');
    if(!el){ return; }
    var sensSlider = document.getElementById('sensitivitySlider');
    var shakeSlider = document.getElementById('shakeToleranceSlider');
    // v4.12.3：触发阈值滑条step本身是整数(1)，摘要行没必要显示小数位，
    // 且"触发阈值"四个字在这一行里太占地方——缩短成"阈值"+整数，
    // 连拍模式/快捷模式也去掉"模式"二字，给电平表腾出空间。
    var sensText = sensSlider ? Math.round(parseFloat(sensSlider.value)) : '--';
    var shakeText = shakeSlider ? shakeSlider.value + 'px' : '--';
    var modeText = burstModeEnabled ? '连拍' : '快捷';
    el.textContent = '阈值' + sensText + ' · 防抖' + shakeText + ' · ' + modeText;
  }

  function getVisibleVideoRect(video){
    var stage = document.querySelector('.cameraStage');
    var boxRect = stage.getBoundingClientRect();
    var videoAspect = video.videoWidth / video.videoHeight;
    var boxAspect = boxRect.width / boxRect.height;
    var visW, visH, cropX, cropY;
    if(videoAspect > boxAspect){
      visH = video.videoHeight;
      visW = video.videoHeight * boxAspect;
      cropX = (video.videoWidth - visW) / 2;
      cropY = 0;
    } else {
      visW = video.videoWidth;
      visH = video.videoWidth / boxAspect;
      cropX = 0;
      cropY = (video.videoHeight - visH) / 2;
    }
    return { cropX: cropX, cropY: cropY, visW: visW, visH: visH };
  }

  function processCameraFrame(captureT){
    var video = document.getElementById('cameraVideo');
    if(!video || !video.videoWidth){ return; }
    analysisFrameCount++;
    var perfStart = performance.now();

    var sampleW = SAMPLE_W, sampleH = SAMPLE_H;
    var canvas = document.getElementById('cameraCanvas');
    canvas.width = sampleW;
    canvas.height = sampleH;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    var vr = getVisibleVideoRect(video);
    var sx = vr.cropX + vr.visW * (roiState.left/100);
    var sy = vr.cropY + vr.visH * (roiState.top/100);
    var sw = vr.visW * (roiState.width/100);
    var sh = vr.visH * (roiState.height/100);

    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sampleW, sampleH);
    var frame = ctx.getImageData(0, 0, sampleW, sampleH).data;

    // ==== v3.8.4 网格局部检测（Baseline比对Trigger链路，取代逐帧比对） ====
    var curCellAvg = computeGridCellAvg(frame, sampleW, sampleH, gridCols, gridRows);

    if(!baselineCellAvg){
      // 基线尚未建立（首帧/刚reset）：本帧只确立基线，不做比较
      baselineCellAvg = curCellAvg;
    } else {
      var totalCells = gridCols * gridRows;
      var changedCells = 0, maxCellDelta = 0;
      if(lastCellChanged.length !== totalCells){ lastCellChanged = new Uint8Array(totalCells); }
      for(var ci=0; ci<totalCells; ci++){
        var cellDelta = Math.abs(curCellAvg[ci] - baselineCellAvg[ci]);
        if(cellDelta > maxCellDelta){ maxCellDelta = cellDelta; }
        var isChanged = cellDelta > sensitivityThreshold;
        lastCellChanged[ci] = isChanged ? 1 : 0;
        if(isChanged){ changedCells++; }
      }
      var globalRatio = changedCells / totalCells;
      lastGridDiag.changedCells = changedCells;
      lastGridDiag.totalCells = totalCells;
      lastGridDiag.globalRatio = globalRatio;
      lastGridDiag.maxCellDelta = maxCellDelta;
      updateDiffMeter(maxCellDelta);
      if(showGridOverlay){ drawGridOverlay(); }

      if(cameraState === 'armed'){
        var isGlobalEvent = globalRatio > GRID_GLOBAL_RATIO_LIMIT;
        var candidateHit = !isGlobalEvent && changedCells >= GRID_MIN_CELLS_TO_TRIGGER;
        if(candidateHit){
          consecutiveHits++;
          if(consecutiveHits === 1){
            firstHitTimestamp = captureT;
          }
          if(consecutiveHits >= REQUIRED_CONSECUTIVE_HITS){
            onCameraDetected(firstHitTimestamp);
            baselineCellAvg = curCellAvg; // 触发确认后刷新基线为当前（新稳定）值
          }
        } else {
          consecutiveHits = 0;
          firstHitTimestamp = null;
          // 基线保持不变：未确认的候选不污染基线，这是baseline模型抗瞬态噪声的关键
        }
      }
    }

    var analysisMs = performance.now() - perfStart;
    analysisTimeSamples.push(analysisMs);
    if(analysisTimeSamples.length > 30){ analysisTimeSamples.shift(); }
  }

  var STATS_SAMPLE_MS = 1000;
  var analysisFrameCount = 0;
  var analysisTimeSamples = [];
  var lastStatsSampleTime = 0;
  var lastTotalVideoFrames = 0;
  var lastDroppedVideoFrames = 0;
  var frameArrivalTimestamps = [];
  var droppedFramesSupported = null;
  var cameraDiagStats = { cameraFps:0, analysisFps:0, droppedFps:0, avgAnalysisMs:0, estLatencyMs:0 };

  function sampleCameraStats(){
    var video = document.getElementById('cameraVideo');
    if(!video || !cameraStream){ return; }
    var now = performance.now();
    if(now - lastStatsSampleTime < STATS_SAMPLE_MS){ return; }
    var elapsedSec = (now - lastStatsSampleTime) / 1000;
    lastStatsSampleTime = now;

    var measuredFps = 0;
    if(frameArrivalTimestamps.length >= 2){
      var span = frameArrivalTimestamps[frameArrivalTimestamps.length-1] - frameArrivalTimestamps[0];
      measuredFps = span > 0 ? ((frameArrivalTimestamps.length - 1) / span) * 1000 : 0;
    }

    var totalFrames = 0, droppedFrames = 0;
    if(video.getVideoPlaybackQuality){
      var q = video.getVideoPlaybackQuality();
      totalFrames = q.totalVideoFrames || 0;
      droppedFrames = q.droppedVideoFrames || 0;
    }
    var totalDelta = totalFrames - lastTotalVideoFrames;
    if(droppedFramesSupported === null && totalDelta > 0){ droppedFramesSupported = true; }
    var droppedFps = elapsedSec > 0 ? (droppedFrames - lastDroppedVideoFrames) / elapsedSec : 0;
    var analysisFps = elapsedSec > 0 ? analysisFrameCount / elapsedSec : 0;
    lastTotalVideoFrames = totalFrames;
    lastDroppedVideoFrames = droppedFrames;
    analysisFrameCount = 0;

    var avgAnalysisMs = analysisTimeSamples.length
      ? analysisTimeSamples.reduce(function(a,b){ return a+b; }, 0) / analysisTimeSamples.length
      : 0;

    var effectiveFps = measuredFps > 0 ? measuredFps : analysisFps;
    var quantizationMs = effectiveFps > 0 ? (1000/effectiveFps)/2 : 0;
    var estLatencyMs = quantizationMs + avgAnalysisMs;

    cameraDiagStats = {
      cameraFps: measuredFps,
      analysisFps: analysisFps,
      droppedFps: droppedFps,
      droppedSupported: !!droppedFramesSupported,
      avgAnalysisMs: avgAnalysisMs,
      estLatencyMs: estLatencyMs
    };
    renderCameraDiag();
  }

  function renderCameraDiag(){
    var s = cameraDiagStats;
    var latEl = document.getElementById('estLatencyDisplay');
    var suspect = s.estLatencyMs > 1000;
    if(latEl){
      latEl.textContent = suspect ? '系统估算延迟: 数据异常，请重新开始监测'
        : (s.estLatencyMs > 0 ? ('系统估算延迟: 约' + Math.round(s.estLatencyMs) + 'ms') : '系统估算延迟: --');
    }
    var detailEl = document.getElementById('cameraDiagDetail');
    if(detailEl){
      var droppedText = s.droppedSupported ? (s.droppedFps.toFixed(1) + ' /秒') : 'N/A(此浏览器不支持测量)';
      var latText = suspect ? (Math.round(s.estLatencyMs) + 'ms (异常，可能刚从锁屏/切后台恢复，重新开始监测即可)') : (Math.round(s.estLatencyMs) + 'ms');
      var g = lastGridDiag;
      detailEl.innerHTML =
        '<div class="diagrow">相机帧率(Camera FPS,实测帧间隔): ' + s.cameraFps.toFixed(1) + '</div>' +
        '<div class="diagrow">分析帧率(Analysis FPS): ' + s.analysisFps.toFixed(1) + '</div>' +
        '<div class="diagrow">丢帧率(Dropped Frames): ' + droppedText + '</div>' +
        '<div class="diagrow">平均分析耗时(Avg Analysis Time): ' + s.avgAnalysisMs.toFixed(1) + 'ms</div>' +
        '<div class="diagrow">估算检测延迟(Estimated Detection Latency): ' + latText + '</div>' +
        '<div class="diagrow">网格(Grid): ' + gridCols + '×' + gridRows + ' (共' + g.totalCells + '格)</div>' +
        '<div class="diagrow">变化格数(Changed Cells): ' + g.changedCells + ' / ' + g.totalCells + '</div>' +
        '<div class="diagrow">全局占比(Global Ratio): ' + (g.globalRatio*100).toFixed(1) + '% (>' + (GRID_GLOBAL_RATIO_LIMIT*100) + '%判为全局噪声忽略)</div>' +
        '<div class="diagrow">最大格差(Max Cell Delta): ' + g.maxCellDelta.toFixed(1) + ' / 阈值' + sensitivityThreshold.toFixed(1) + '</div>';
    }
  }

  var lastCameraRecordId = null;

  // v4.19.0：连拍噪声触发——上一次真实抓拍后的噪声窗口内又触发了，不记录、不出声，
  // 只留一条噪声记录(组结束后挂在统计表连拍卡片上，填完挂钟时间即丢弃)，3秒后重新武装
  // (重新武装会重置检测基线，把累计的背景漂移清零)。
  function handleBurstNoiseHit(t){
    var afterMs = t - burstLastCaptureT;
    burstNoiseHits.push({ t: t, afterMs: afterMs });
    cameraState = 'cooldown';
    consecutiveHits = 0;
    firstHitTimestamp = null;
    updateCameraBadge('已忽略噪声触发(+' + Math.round(afterMs/1000) + 's)，冷却中');
    updateStartBtnLabel();
    cooldownTimer = setTimeout(function(){
      armCameraDetection();
    }, 3000);
  }

  // v4.19.1：每次真实抓拍(第1、2张，且组还要继续)后，到噪声窗口结束那一刻静默刷新一次检测基线，
  // 让背景漂移只累计窗口结束到真实跳变(约59-61秒)之间的10秒左右。不出声、不改界面；
  // 组结束/抓拍失败/停止监测时 clearBurstState 会清掉定时器，后面不再刷新。
  function scheduleBurstBaselineRefresh(sid, idx, t){
    if(burstBaselineTimer){ clearTimeout(burstBaselineTimer); }
    var delay = Math.max(0, BURST_NOISE_WINDOW_MS - (nowCorrected() - t));
    burstBaselineTimer = setTimeout(function(){
      burstBaselineTimer = null;
      // 只在"还是同一组、还是等这一张、正在监测"时刷新；噪声冷却中不刷新(冷却结束重新武装本来就会重置基线)
      if(burstSessionId === sid && burstCaptureIndex === idx && cameraState === 'armed'){
        resetDetectionBaseline();
      }
    }, delay);
  }

  function onCameraDetected(t, sourceTag){
    if(devState !== 'RUNNING' && burstModeEnabled && (sourceTag || 'camera') === 'camera' &&
       burstSessionId && burstLastCaptureT !== null && (t - burstLastCaptureT) < BURST_NOISE_WINDOW_MS){
      handleBurstNoiseHit(t);
      return;
    }
    devRecordCapture(t, sourceTag);
    cameraState = 'cooldown';
    consecutiveHits = 0;
    firstHitTimestamp = null;
    updateCameraBadge('已捕获，冷却中');
    document.getElementById('cameraStatusBadge').classList.add('captured');
    updateStartBtnLabel();

    if(devState !== 'RUNNING'){
      // v4.0.6: Dev模式RUNNING期间整段跳过——不写入普通records/统计表/迷你列表/
      // 撤销指针，因为Dev模式的唯一目的是拿11分钟实验日志(已经通过上面的
      // devRecordCapture记录)，不应该污染日常时钟漂移统计数据。
      resetUndoBtnState();
      var tag = sourceTag || 'camera';
      var latencyForThisCapture = (tag === 'camera') ? cameraDiagStats.estLatencyMs : null;

      var sessionIdForThisCapture = null;
      var isBurstActive = burstModeEnabled && tag === 'camera';
      if(isBurstActive){
        if(!burstSessionId){ burstSessionId = 'burst' + t; burstCaptureIndex = 0; }
        burstCaptureIndex++;
        sessionIdForThisCapture = burstSessionId;
      }

      var rec = addRecordAtTime(t, tag, latencyForThisCapture, sessionIdForThisCapture);
      lastCameraRecordId = rec.id;

      // v4.19.0：第2张抓拍后立刻判断与第1张的间隔，不在59-61秒就是不合格，
      // 不用等第3张(以前要等满3分钟才知道)，直接结束本组并报警。
      var burstFailEarly = false;
      if(isBurstActive){
        burstLastCaptureT = t;
        if(burstCaptureIndex === 2){
          var firstTwo = records.filter(function(r){ return r.sessionId === sessionIdForThisCapture; }).sort(function(a,b){ return a.t - b.t; });
          if(firstTwo.length >= 2 && !burstGapIsTight(firstTwo[1].t - firstTwo[0].t)){ burstFailEarly = true; }
        }
      }

      if(isBurstActive && !burstFailEarly && burstCaptureIndex < BURST_TARGET_COUNT){
        scheduleBurstBaselineRefresh(sessionIdForThisCapture, burstCaptureIndex, t);
        playShutterSound();
        cooldownTimer = setTimeout(function(){
          armCameraDetection();
        }, 3000);
        return;
      }

      if(isBurstActive){
        if(burstNoiseHits.length){
          if(!sessionMeta[sessionIdForThisCapture]){ sessionMeta[sessionIdForThisCapture] = {}; }
          sessionMeta[sessionIdForThisCapture].noiseHits = burstNoiseHits.slice();
        }
        computeSessionContinuity(sessionIdForThisCapture);
        var metaDone = sessionMeta[sessionIdForThisCapture];
        var burstMemberIds = records.filter(function(r){ return r.sessionId === sessionIdForThisCapture; }).map(function(r){ return r.id; });
        cameraSessionCaptures.unshift({
          kind:'burst', sessionId: sessionIdForThisCapture, ids: burstMemberIds, t: t,
          quality: metaDone ? metaDone.quality : null,
          qualityLabel: metaDone ? metaDone.qualityLabel : null,
          qualityReason: metaDone ? metaDone.qualityReason : null,
          missedMinutes: metaDone ? metaDone.missedMinutes : [],
          noiseHits: burstNoiseHits.slice()
        });
        renderCameraSessionList();
        clearBurstState();
        renderLog();
        // v4.19.0：不合格(第2张提前终止 或 第3张后评为不合格)放警报音，合格才放完成音，二者互斥
        if(metaDone && metaDone.quality === 'fail'){ playAlarmSound(); } else { playCompleteSound(); }
      } else {
        cameraSessionCaptures.unshift({ kind:'single', id: rec.id, t: t });
        renderCameraSessionList();
        playCompleteSound();
      }
    }

    cooldownTimer = setTimeout(function(){
      if(cameraState === 'cooldown'){
        cameraState = 'idle';
        updateCameraBadge(devState === 'RUNNING' ? 'Dev采样中...' : '已停止(点"开始监测"继续)');
        document.getElementById('cameraStatusBadge').classList.remove('captured', 'armed');
        updateStartBtnLabel();
        // v3.9.9.1: 快速模式/连拍最后一次capture结束都走这个共用收尾分支，
        // 之前从未调用resetDetectionBaseline，导致基线停留在旧数字，
        // 后续帧持续跟旧基线比对产生残留高位读数。这里复用跟stopCamera/
        // disarmCameraDetection完全一致的reset组合，只清状态不影响判定逻辑本身。
        resetDetectionBaseline();
        resetDiffMeter();
        // v4.0.9: 手动连拍第3张结束后ROI橘色/电平表残留高位的根因排查——
        // Dev模式收尾多了下面armCameraDetection()这一步，其内部会调用
        // computeGridDims()把lastCellChanged重新分配为全零数组，相当于
        // 比手动模式多一层保险，这也是Dev模式无人值守从未复现过这个bug的原因。
        // 这里把这层保险原样搬到手动路径，但不触发armCameraDetection()本身，
        // 不强制重新武装，行为仍是"拍完就停，等用户手动点开始监测"。
        computeGridDims();
        clearGridOverlayCanvas();
        if(devState === 'RUNNING'){
          // v4.0.1: Dev模式无人值守——一次capture(或一组连拍)完成后立即自动重新武装，
          // 不等待手动点击，直到11分钟/高频熔断/手动停止三种条件之一发生为止。
          armCameraDetection();
        }
      }
    }, 3000);
  }

  function undoLastCameraCapture(){
    if(!lastCameraRecordId){ return; }
    var rec = records.filter(function(r){ return r.id === lastCameraRecordId; })[0];
    if(rec && rec.sessionId){
      // v3.9.9.2: 连拍成员(不论手动中断后实际抓了2次还是完整3次)一律整组删除，
      // 复用迷你列表"删除整组"同一套deleteSessionGroup，不新写判断逻辑。
      deleteSessionGroup(rec.sessionId);
    } else {
      deleteRecord(lastCameraRecordId);
    }
    lastCameraRecordId = null;
    document.getElementById('cameraStatusBadge').classList.remove('captured');
  }

  var pendingCameraUndo = false;
  var pendingCameraUndoTimer = null;

  function resetUndoBtnState(){
    var wasPending = pendingCameraUndo;
    pendingCameraUndo = false;
    if(pendingCameraUndoTimer){ clearTimeout(pendingCameraUndoTimer); pendingCameraUndoTimer = null; }
    if(wasPending){
      // 撤下"退格再按一次＝删除上条"的临时提示，把状态徽章文案还原成当前实际状态
      if(cameraState === 'armed'){ updateCameraBadge('监测中...'); }
      else if(cameraState === 'cooldown'){ updateCameraBadge('已捕获，冷却中'); }
      else if(cameraState === 'idle'){ updateCameraBadge('已停止(点"开始监测"继续)'); }
    }
  }

  function requestUndoLastCameraCapture(){
    if(!lastCameraRecordId){ return; }
    if(pendingCameraUndo){
      resetUndoBtnState();
      undoLastCameraCapture();
    } else {
      pendingCameraUndo = true;
      var rec = records.filter(function(r){ return r.id === lastCameraRecordId; })[0];
      var isBurstRec = !!(rec && rec.sessionId);
      updateCameraBadge(isBurstRec ? '退格再按一次＝删除整组' : '退格再按一次＝删除上条');
      if(pendingCameraUndoTimer){ clearTimeout(pendingCameraUndoTimer); }
      pendingCameraUndoTimer = setTimeout(resetUndoBtnState, 3000);
    }
  }

  // v4.1.7 校准点删除漏洞修复：v4.1.5 只堵住了"原地取消校准点"这条路(toggleCalibration no-op)，
  // 但删除按钮(deleteRecord/deleteSessionGroup)完全没检查目标是不是当前校准点——只要校准点所在
  // 记录还没被数据包锁定，删除后 records 里就没有任何一条 isCalibration===true，
  // getActiveRecords() 的 lastCalIdx 退回 -1，直接退化成"全部历史参与回归"，正是 v4.1.5 想
  // 彻底消灭的危险状态。修法：在这两个真正的删除入口上加保护，所有删除路径(日志页、摄像头最近
  // 捕获列表)都走这两个函数，改一处即可全覆盖。清空全部数据仍走独立的 clearLog()，不受影响。
  // v4.9.5：记录被删除时，同步清掉它当初写入时留下的那条收敛趋势快照——
  // 两个季节桶都过一遍，按 groupKey 精确匹配，不影响其余没关系的快照。
  // v4.10.4：groupKey 取代了旧的 triggerRecordId 概念(连拍用sessionId去重后，
  // 单条快照可能对应一整组、而不只是某一条记录)，这里兼容老数据(v4.10.4及更早
  // 写入、只有 triggerRecordId 字段、没有 groupKey 字段的快照)，两个字段都认。
  function pruneDriftHistoryForRecordIds(idSet){
    var changed = false;
    ['summer','winter'].forEach(function(ssn){
      var arr = driftHistory[ssn];
      if(!arr || !arr.length){ return; }
      var filtered = arr.filter(function(h){
        var key = (h.groupKey !== undefined && h.groupKey !== null) ? h.groupKey : h.triggerRecordId;
        return !(key && idSet[key]);
      });
      if(filtered.length !== arr.length){ driftHistory[ssn] = filtered; changed = true; }
    });
    if(changed){ saveHistory(); }
  }

  function deleteRecord(id){
    var target = null;
    for(var i=0;i<records.length;i++){ if(records[i].id === id){ target = records[i]; break; } }
    if(target && target.isCalibration){
      alert('这条是当前校准点，不能直接删除。请先在另一条记录上点"设为校准点"完成转移，再回来删除这条。');
      return;
    }
    // v4.10.4：删除单条记录时，除了它自己的id，如果它本身属于某个连拍组(有
    // sessionId)，也要把组的groupKey一并纳入清理范围——避免只删了组里一张照片，
    // 组共享的那条收敛快照却没被清掉(虽然正常UI只提供整组删除，这里是双重保险)。
    var pruneKeys = { [id]: true };
    if(target && target.sessionId){ pruneKeys[target.sessionId] = true; }
    records = records.filter(function(r){ return r.id !== id; });
    recomputeAllDeltas();
    saveRecords();
    renderLog();
    renderStats();
    removeFromCameraSessionCaptures(id);
    pruneDriftHistoryForRecordIds(pruneKeys);
  }

  function deleteSessionGroup(sessionId){
    var hasCalibration = records.some(function(r){ return r.sessionId === sessionId && r.isCalibration; });
    if(hasCalibration){
      alert('这组包含当前校准点，不能整组删除。请先在另一条记录(或另一组)上设为校准点完成转移，再回来删除这组。');
      return;
    }
    // v4.10.4：整组的收敛快照现在是用sessionId本身当groupKey存的(不再是某个
    // 成员自己的id)，所以清理时主要靠sessionId命中；同时保留各成员id也一并纳入，
    // 兼容v4.10.4及更早、按成员id单独存了3条快照的老数据。
    var memberIds = { [sessionId]: true };
    records.forEach(function(r){ if(r.sessionId === sessionId){ memberIds[r.id] = true; } });
    records = records.filter(function(r){ return r.sessionId !== sessionId; });
    recomputeAllDeltas();
    delete sessionMeta[sessionId];
    delete lastCollapsedBySession[sessionId];
    saveSessionMeta();
    saveRecords();
    renderLog();
    renderStats();
    removeSessionGroupFromCameraSessionCaptures(sessionId);
    pruneDriftHistoryForRecordIds(memberIds);
  }

  // ==== v3.9.8 摄像头页"本次监测最近捕获"临时列表 ====
  // 纯内存变量，不落盘：普通切后台再切回来JS进程没死，内存自然还在，列表正常保留；
  // 一旦被系统杀掉进程重启(相当于重新走一遍init())，这个数组本来就会回到空——
  // 不需要专门判断"是杀后台还是普通resume"，内存生命周期本身就是这道分界线。
  // 另外点左上角"返回"也会显式清空，确保同一次运行内"退出再进"同样是空列表。
  var cameraSessionCaptures = [];
  var pendingSessionDeleteId = null;
  var pendingSessionDeleteTimer = null;

  function clearCameraSessionCaptures(){
    cameraSessionCaptures = [];
  }

  function removeFromCameraSessionCaptures(recordId){
    var before = cameraSessionCaptures.length;
    cameraSessionCaptures = cameraSessionCaptures.filter(function(c){
      return c.kind === 'single' ? c.id !== recordId : true;
    });
    if(cameraSessionCaptures.length !== before){
      renderCameraSessionList();
    }
  }

  function removeSessionGroupFromCameraSessionCaptures(sessionId){
    var before = cameraSessionCaptures.length;
    cameraSessionCaptures = cameraSessionCaptures.filter(function(c){
      return c.kind === 'burst' ? c.sessionId !== sessionId : true;
    });
    if(cameraSessionCaptures.length !== before){
      renderCameraSessionList();
    }
  }

  // ==== v4.0.0 Dev Mode Data Collector ====
  // 纯观察者：只读现有算法已经算好的数据(lastGridDiag/sensitivityThreshold等)，
  // 不重新实现任何一套Baseline/Noise/Capture判定逻辑，不影响普通模式行为。
  // 默认关闭，不落localStorage，每次启动/进入PWA都是IDLE，需用户主动开启。
  var DEV_MAX_DURATION_MS = 660000; // 11分钟
  var DEV_HEARTBEAT_MS = 5000;
  var DEV_HIGHFREQ_WINDOW_MS = 20000;
  var DEV_HIGHFREQ_THRESHOLD = 4; // 连续auto重新武装下限约3秒/次，20秒窗口理论上限约7次；阈值4(即5次+)远高于真实60秒走字节奏，同时留有余量不贴着理论上限
  var DEV_SESSION_KEY = 'cc_devsession_running_v1'; // 仅sessionStorage，用于kill后恢复识别

  var devState = 'IDLE'; // IDLE | READY | RUNNING | STOPPING | STOPPED
  var devRefreshParamsToggleLabel = function(){}; // 占位，真正实现在按钮事件绑定处赋值
  var devUpdateExportBtnVisibility = function(){}; // 占位，真正实现在按钮事件绑定处赋值
  var devLogBuffer = null;
  var devHeartbeatTimer = null;
  var devUiTickTimer = null;

  function devMakeId(prefix){
    return prefix + Date.now() + '_' + Math.floor(Math.random()*10000);
  }

  function devSnapshotConfig(){
    var vEl = document.getElementById('versionTag');
    return {
      appVersion: vEl ? vEl.textContent : null,
      gridDensityMode: gridDensityMode,
      gridCols: gridCols, gridRows: gridRows,
      sensitivityThreshold: sensitivityThreshold,
      burstModeEnabled: burstModeEnabled,
      GRID_GLOBAL_RATIO_LIMIT: GRID_GLOBAL_RATIO_LIMIT,
      DIFF_METER_MAX: DIFF_METER_MAX
    };
  }

  function devSetModeButtonsLocked(locked){
    var q = document.getElementById('quickModeBtn');
    var b = document.getElementById('burstModeBtn');
    [q, b].forEach(function(el){
      if(!el){ return; }
      el.disabled = locked;
      el.style.opacity = locked ? '0.4' : '';
      el.style.pointerEvents = locked ? 'none' : '';
    });
  }

  function devEnterReady(){
    devLogBuffer = {
      experimentId: devMakeId('exp'),
      sessionId: devMakeId('sess'),
      startTimestamp: null,
      startPerfTime: null,
      initialConfig: null,
      heartbeats: [],
      captures: [],
      stopReason: null,
      dataCompleteness: null,
      endTimestamp: null
    };
    devState = 'READY';
    devSetModeButtonsLocked(true);
    devRefreshParamsToggleLabel();
    devUpdateExportBtnVisibility();
  }

  var devWakeLock = null;

  function devRequestWakeLock(){
    if('wakeLock' in navigator){
      navigator.wakeLock.request('screen').then(function(lock){
        devWakeLock = lock;
      }).catch(function(e){
        // 请求失败(权限/设备不支持/低电量模式等)不阻塞实验本身，只是没有防锁屏保护
      });
    }
  }

  function devReleaseWakeLock(){
    if(devWakeLock){
      try{ devWakeLock.release(); }catch(e){}
      devWakeLock = null;
    }
  }

  function devStartExperiment(){
    if(devState !== 'READY'){ return; }
    devLogBuffer.startTimestamp = new Date().toISOString();
    devLogBuffer.startPerfTime = performance.now();
    devLogBuffer.initialConfig = devSnapshotConfig();
    devState = 'RUNNING';
    try{
      sessionStorage.setItem(DEV_SESSION_KEY, JSON.stringify(devLogBuffer));
    }catch(e){}
    devRequestWakeLock();
    devHeartbeatTimer = setInterval(devRecordHeartbeat, DEV_HEARTBEAT_MS);
    devUiTickTimer = setInterval(devUiTick, 1000);
    devUiTick();
  }

  function devRecordHeartbeat(){
    if(devState !== 'RUNNING'){ return; }
    var elapsedMs = performance.now() - devLogBuffer.startPerfTime;
    devLogBuffer.heartbeats.push({
      timestamp: new Date().toISOString(),
      elapsedMs: Math.round(elapsedMs),
      baselineNoiseLevel: lastGridDiag.maxCellDelta,
      noiseRatio: lastGridDiag.globalRatio
    });
    try{ sessionStorage.setItem(DEV_SESSION_KEY, JSON.stringify(devLogBuffer)); }catch(e){}
  }

  function devUiTick(){
    if(devState !== 'RUNNING'){ return; }
    var elapsedMs = performance.now() - devLogBuffer.startPerfTime;
    var remainingMs = Math.max(0, DEV_MAX_DURATION_MS - elapsedMs);
    if(remainingMs <= 0){
      devStopExperiment('11min_Completed');
      return;
    }
    var remainingSec = Math.ceil(remainingMs/1000);
    var mm = Math.floor(remainingSec/60), ss = remainingSec%60;
    updateCameraBadge('Dev ' + mm + ':' + (ss<10?'0':'')+ss + '（捕获：' + devLogBuffer.captures.length + '）');
  }

  function devRecordCapture(t, sourceTag){
    if(devState !== 'RUNNING'){ return; }
    var elapsedMs = performance.now() - devLogBuffer.startPerfTime;
    var caps = devLogBuffer.captures;
    var prev = caps.length ? caps[caps.length-1] : null;
    var tag = sourceTag || 'camera';
    var entry = {
      captureIndex: caps.length + 1,
      timestamp: new Date().toISOString(),
      elapsedMs: Math.round(elapsedMs),
      intervalMs: prev ? Math.round(elapsedMs - prev.elapsedMs) : null,
      peakLevel: lastGridDiag.maxCellDelta,
      noiseRatio: lastGridDiag.globalRatio,
      baselineNoiseLevel: lastGridDiag.maxCellDelta,
      // v4.0.10: 补上检测延迟，口径跟普通records(1859行)一致——只有真正
      // 自动检测触发的才有意义记录，手动强制拍(camera-manual)记null，
      // 目的是让11分钟快速模式的多次独立事件也能喂给AI做延迟抖动统计，
      // 不需要靠连拍模式凑组(2.2节的9-10ms数据来自手动连拍走的另一条
      // records管线，跟Dev导出无关，这里是给Dev日志单独补齐这项能力)。
      detectionLatencyMs: (tag === 'camera') ? cameraDiagStats.estLatencyMs : null,
      sourceTag: tag
    };
    caps.push(entry);
    // 高频异常熔断：10秒窗口内 >5 次
    var windowStart = elapsedMs - DEV_HIGHFREQ_WINDOW_MS;
    var recentCount = 0;
    for(var i=caps.length-1; i>=0; i--){
      if(caps[i].elapsedMs >= windowStart){ recentCount++; } else { break; }
    }
    if(recentCount > DEV_HIGHFREQ_THRESHOLD){
      devStopExperiment('High_Freq_Abort');
    }
  }

  function devBuildMarkdown(){
    var b = devLogBuffer;
    var lines = [];
    lines.push('# Clock Calibrator Dev Mode 实验日志');
    lines.push('');
    lines.push('- Experiment ID: ' + b.experimentId);
    lines.push('- Session ID: ' + b.sessionId);
    lines.push('- Start: ' + b.startTimestamp);
    lines.push('- End: ' + b.endTimestamp);
    lines.push('- Stop Reason: ' + b.stopReason);
    lines.push('- Data Completeness: ' + b.dataCompleteness);
    lines.push('- Capture Count: ' + b.captures.length);
    lines.push('- Heartbeat Count: ' + b.heartbeats.length);
    lines.push('');
    lines.push('## Initial Configuration');
    lines.push('```json');
    lines.push(JSON.stringify(b.initialConfig, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## Captures');
    lines.push('| # | timestamp | elapsedMs | intervalMs | peakLevel | noiseRatio | latencyMs | source |');
    lines.push('|---|---|---|---|---|---|---|---|');
    b.captures.forEach(function(c){
      lines.push('| ' + c.captureIndex + ' | ' + c.timestamp + ' | ' + c.elapsedMs + ' | ' + (c.intervalMs===null?'-':c.intervalMs) + ' | ' + c.peakLevel.toFixed(1) + ' | ' + (c.noiseRatio*100).toFixed(1) + '% | ' + (typeof c.detectionLatencyMs === 'number' ? Math.round(c.detectionLatencyMs) : '-') + ' | ' + c.sourceTag + ' |');
    });
    lines.push('');
    lines.push('## Heartbeats');
    lines.push('| elapsedMs | baselineNoiseLevel | noiseRatio |');
    lines.push('|---|---|---|');
    b.heartbeats.forEach(function(h){
      lines.push('| ' + h.elapsedMs + ' | ' + h.baselineNoiseLevel.toFixed(1) + ' | ' + (h.noiseRatio*100).toFixed(1) + '% |');
    });
    lines.push('');
    return lines.join('\n');
  }

  function devTriggerDownload(){
    // v4.1.16: 改用shareOrDownloadBlob——原来的<a download>触发的是一次真实页面导航，
    // 摄像头video流的生命周期被这次导航打断，回来后画面卡死黑屏(真机实测确认)。
    // 分享菜单是浮层，不是真的离开当前页，DOM/JS执行上下文全程不中断，
    // 真机验证过：不管点保存文件还是一路取消返回，相机画面都能正常工作，这个黑屏bug随之修复。
    // (蓝牙键盘在分享菜单展开到90%后返回会失焦——这是Ghost Input守卫本身没覆盖
    // "接管屏幕的浮层返回后重新武装焦点"这个场景，跟这里换不换分享方式无关，留给下一轮专门修。)
    var md = devBuildMarkdown();
    var blob = new Blob([md], {type:'text/markdown'});
    shareOrDownloadBlob(blob, 'dev-log-' + Date.now() + '.md', 'text/markdown');
  }

  var devPendingBackgroundExport = false;

  function devStopExperiment(reason){
    if(devState !== 'RUNNING'){ return; } // 防重复stop：已STOPPING/STOPPED直接忽略
    devState = 'STOPPING';
    devReleaseWakeLock();
    if(devHeartbeatTimer){ clearInterval(devHeartbeatTimer); devHeartbeatTimer = null; }
    if(devUiTickTimer){ clearInterval(devUiTickTimer); devUiTickTimer = null; }
    devLogBuffer.stopReason = reason;
    devLogBuffer.dataCompleteness = (reason === '11min_Completed') ? 'Complete' : 'Partial';
    devLogBuffer.endTimestamp = new Date().toISOString();
    if(reason === 'Interrupted_Background'){
      // v4.0.2: 切后台=当场停机，数据到此为止，不再尝试恢复/续接，避免产生"断了又续"的
      // 支离破碎日志误导AI分析。但切后台瞬间触发下载UI的可靠性没有把握，
      // 所以下载动作延后到用户回到前台的那一刻再触发；期间保留sessionStorage镜像，
      // 万一回前台之前App被系统彻底杀掉，还能走下面的killed-recovery路径捞回来。
      devPendingBackgroundExport = true;
      try{ sessionStorage.setItem(DEV_SESSION_KEY, JSON.stringify(devLogBuffer)); }catch(e){}
    } else {
      try{ sessionStorage.removeItem(DEV_SESSION_KEY); }catch(e){}
      devTriggerDownload();
    }
    devState = 'STOPPED';
    devSetModeButtonsLocked(false);
    devRefreshParamsToggleLabel();
    devUpdateExportBtnVisibility();
    updateCameraBadge(cameraState === 'armed' ? '监测中...' : '已停止(点"开始监测"继续)');
  }

  // 切后台/锁屏立即终止实验(只在RUNNING时生效，不影响蓝牙焦点那个已有的visibilitychange监听)
  document.addEventListener('visibilitychange', function(){
    if(document.hidden && devState === 'RUNNING'){
      devStopExperiment('Interrupted_Background');
    }
    if(!document.hidden && devPendingBackgroundExport){
      devPendingBackgroundExport = false;
      try{ sessionStorage.removeItem(DEV_SESSION_KEY); }catch(e){}
      devTriggerDownload();
      updateCameraBadge('Dev已中断并导出(捕获' + devLogBuffer.captures.length + '次)');
    }
  });

  function devCheckKilledRecovery(){
    var raw = null;
    try{ raw = sessionStorage.getItem(DEV_SESSION_KEY); }catch(e){}
    if(!raw){ return; }
    try{
      var recovered = JSON.parse(raw);
      devLogBuffer = recovered;
      devLogBuffer.stopReason = 'Killed_Background';
      devLogBuffer.dataCompleteness = 'Partial';
      devLogBuffer.endTimestamp = new Date().toISOString();
      devTriggerDownload();
      // v4.0.2: 不用alert通知——相机页此时可能还没显示，badge文字也不保证被看到，
      // 且弹窗在相机页有卡死历史(用户实测反馈)，这里索性不弹任何提示，
      // 下载的.md文件本身就是证据，用户在Files/下载目录能看到。
    }catch(e){}
    try{ sessionStorage.removeItem(DEV_SESSION_KEY); }catch(e){}
    devState = 'IDLE';
    devLogBuffer = null;
  }

  var pendingDevEntry = false;
  var pendingDevEntryTimer = null;

  function devHandleDevBtn(){
    if(devState === 'RUNNING'){ return; } // 运行中不响应，走主按钮"停止Dev采样"
    if(devState === 'IDLE' || devState === 'STOPPED'){
      if(pendingDevEntry){
        pendingDevEntry = false;
        if(pendingDevEntryTimer){ clearTimeout(pendingDevEntryTimer); }
        devState = 'IDLE'; // 若之前是STOPPED，先归位再进READY，避免残留上一轮buffer
        devLogBuffer = null;
        devEnterReady();
        updateCameraBadge('Dev就绪，点"开始监测"开始采样');
      } else {
        pendingDevEntry = true;
        updateCameraBadge('再按一次🛠️Dev＝进入11分钟采集模式');
        pendingDevEntryTimer = setTimeout(function(){
          pendingDevEntry = false;
          if(cameraState === 'armed'){ updateCameraBadge('监测中...'); }
          else if(cameraState === 'cooldown'){ updateCameraBadge('已捕获，冷却中'); }
          else { updateCameraBadge('已停止(点"开始监测"继续)'); }
        }, 3000);
      }
      return;
    }
    if(devState === 'READY'){
      // 已在READY，再点一次视为退出准备状态，回到IDLE(尚未开始记录，没有数据可丢)
      devState = 'IDLE';
      devLogBuffer = null;
      devSetModeButtonsLocked(false);
      devRefreshParamsToggleLabel();
      devUpdateExportBtnVisibility();
      updateCameraBadge(cameraState === 'armed' ? '监测中...' : '已停止(点"开始监测"继续)');
    }
  }

  function devHandleBackNavigation(){
    if(devState === 'RUNNING'){
      devStopExperiment('Manual_Stop'); // 离开前自动结算导出，不丢数据、不额外弹确认
    }
    devState = 'IDLE';
    devLogBuffer = null;
    devSetModeButtonsLocked(false);
    devRefreshParamsToggleLabel();
    devUpdateExportBtnVisibility();
  }
  // ==== End v4.0.0 Dev Mode Data Collector ====


