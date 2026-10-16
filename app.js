'use strict';
// PWA标题、季节/继电器按钮、蓝牙小键盘守护、滑动返回、页面切换、init
// 注意：不再有 IIFE 包裹，各 JS 文件共享全局作用域；加载顺序见 index.html（help→data→camera→ui→app），不要调换。
  function getLocalizedAppName(){
    var lang = ((navigator.language || (navigator.languages && navigator.languages[0]) || 'en') + '').toLowerCase();
    if(lang.indexOf('zh') === 0){
      return { name: '校准计时器', shortName: '校准计时器' };
    }
    return { name: 'Clock Calibrator', shortName: 'Calibrator' };
  }

  function setupPWA(){
    var appNames = getLocalizedAppName();
    document.title = appNames.name;
    var appleTitleMeta = document.getElementById('appleTitleMeta');
    if(appleTitleMeta){ appleTitleMeta.setAttribute('content', appNames.shortName); }
  }

  function renderSeasonButtons(){
    var sBtn = document.getElementById('seasonSummerBtn');
    var wBtn = document.getElementById('seasonWinterBtn');
    sBtn.className = 'seasonbtn' + (seasonMode === 'summer' ? ' active' : '');
    wBtn.className = 'seasonbtn' + (seasonMode === 'winter' ? ' active' : '');
  }

  function setSeason(mode){
    seasonMode = mode;
    saveSeason();
    renderSeasonButtons();
    renderStats();
  }

  function renderRelayStatusButtons(){
    var oBtn = document.getElementById('relayObserveBtn');
    var iBtn = document.getElementById('relayInstalledBtn');
    if(!oBtn || !iBtn){ return; }
    oBtn.className = 'seasonbtn' + (!relayInstalled ? ' active' : '');
    iBtn.className = 'seasonbtn' + (relayInstalled ? ' active' : '');
  }

  function setRelayInstalled(installed){
    relayInstalled = installed;
    saveRelayInstalled();
    renderRelayStatusButtons();
    renderStats();
  }

  var currentScreen = 'capture';
  var helpReturnScreen = 'capture'; // 帮助页"返回"要回到打开它之前所在的页面(主页或摄像头页)

  // ===== 蓝牙小键盘 Ghost Input 焦点守护（iOS PWA 兼容偏方） =====
  // iOS PWA(standalone WKWebView) 下，如果页面没有任何真正获得焦点的可编辑元素，
  // 外置蓝牙键盘的按键事件不会被派发到 document，document 级 keydown 监听会完全收不到事件。
  // 这里用一个用户看不到、摸不到的 input 一直保持 focus 来"接住"物理键盘事件，
  // 再让原有的两段 keydown 逻辑把这个 ghost input 识别为"非文字输入"、正常放行快捷键。
  var BT_GHOST_ID = 'btKeypadGhost';
  var btGhostEl = null;
  var btFocusGuardActive = false;
  var btGhostWatchdogTimer = null;
  // v4.1.17: DOM 层面"聚焦成功"跟物理键盘 responder 是否真的接通是两件事，JS 拿不到后者的
  // 真实状态，唯一可信的信号是"确实收到过一次物理按键"。btKeyConfirmed 记录的就是这件事：
  // 任何一次重新聚焦(不管是看门狗、切屏返回、App回前台，还是手动点徽章)都会把它清成 false，
  // 只有 ghost input 真的收到 keydown 之后才会变回 true。徽章文案据此如实反映"未验证"还是"已确认"。
  var btKeyConfirmed = false;

  function isBtGhostTarget(target){
    return !!(target && target.id === BT_GHOST_ID);
  }

  function shouldSkipGhostRefocus(target){
    if(!target){ return false; }
    var tag = target.tagName;
    if(tag === 'TEXTAREA'){ return true; }
    if(tag === 'SELECT'){ return true; }
    if(tag === 'INPUT' && !isBtGhostTarget(target)){ return true; }
    return false;
  }

  function focusGhostInput(force){
    if(!btGhostEl || !btFocusGuardActive){ return; }
    if(shouldSkipGhostRefocus(document.activeElement)){ return; }
    if(document.activeElement === btGhostEl && !force){
      // DOM 焦点本来就在 ghost input 上，没必要重新走一遍 blur/focus——
      // 但这不代表物理键盘已确认可用，是否confirmed 维持原状，不在这里瞎改。
      updateBtKeyStatus();
      return;
    }
    // "先 blur 再 focus" 踢一脚：JS 层面调用 .focus() 有时会"假成功"(activeElement 显示对了，
    // 但没有真正建立物理键盘的 responder)，尤其是没有真实用户手势背书、或刚从系统权限框/后台恢复时。
    // 强制先失焦再聚焦，能让 WKWebView 重新走一遍完整的聚焦流程。
    // 不管这次重新聚焦最终是否"看起来"成功，之前的"已确认"状态都作废——真的可用与否，
    // 要等下一次真实按键进来才能重新确认，这里绝不提前声明。
    btKeyConfirmed = false;
    try{ btGhostEl.blur(); }catch(err){}
    try{ btGhostEl.focus({ preventScroll: true }); }
    catch(err){ try{ btGhostEl.focus(); }catch(err2){} }
    setTimeout(updateBtKeyStatus, 50);
  }

  function updateBtKeyStatus(){
    var btn = document.getElementById('btKeyStatusBtn');
    if(!btn){ return; }
    if(!btFocusGuardActive){
      btn.textContent = '⌨ 未激活';
      btn.className = 'btKeyStatus notready';
      return;
    }
    if(btKeyConfirmed){
      btn.textContent = '⌨ 已确认';
      btn.className = 'btKeyStatus ready';
    } else if(document.activeElement === btGhostEl){
      btn.textContent = '⌨ 未验证';
      btn.className = 'btKeyStatus notready';
    } else {
      btn.textContent = '⌨ 点此重新绑定';
      btn.className = 'btKeyStatus notready';
    }
  }

  function enableBtFocusGuard(){
    btFocusGuardActive = true;
    btKeyConfirmed = false;
    focusGhostInput();
  }

  function disableBtFocusGuard(){
    btFocusGuardActive = false;
    btKeyConfirmed = false;
    updateBtKeyStatus();
  }

  function setupBtKeypadGhost(){
    var el = document.createElement('input');
    el.type = 'text';
    el.id = BT_GHOST_ID;
    el.setAttribute('inputmode', 'none');   // 关键：不弹出系统虚拟键盘，但仍可接收物理/蓝牙键盘事件
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('aria-hidden', 'true');
    el.tabIndex = -1;
    el.style.cssText = 'position:fixed;top:-999px;left:-999px;width:1px;height:1px;padding:0;margin:0;border:none;opacity:0;pointer-events:none;';
    // Ghost Input 自身可能会把蓝牙按键当成真实文字输入，这里立刻清空，避免残留内容、避免被误判成"正在打字"
    el.addEventListener('input', function(){ el.value = ''; });
    // v4.1.17: 唯一可信的"确认可用"信号——ghost input 真的收到了一次物理按键。
    // 独立于下面摄像头页那段业务 keydown 逻辑，不受 currentScreen 限制，任何屏幕收到按键都算数。
    el.addEventListener('keydown', function(){
      btKeyConfirmed = true;
      updateBtKeyStatus();
    });
    el.addEventListener('blur', function(){
      if(!btFocusGuardActive){ return; }
      setTimeout(function(){
        if(shouldSkipGhostRefocus(document.activeElement)){ return; }
        focusGhostInput();
      }, 30);
    });
    document.body.appendChild(el);
    btGhostEl = el;

    // 用户点按屏幕(切页、拖动ROI、按按钮等)会让 ghost input 失焦，这里借着同一次用户手势尽快抢回焦点
    document.addEventListener('touchend', function(e){
      if(!btFocusGuardActive || shouldSkipGhostRefocus(e.target)){ return; }
      setTimeout(focusGhostInput, 0);
    }, { passive: true });
    document.addEventListener('mouseup', function(e){
      if(!btFocusGuardActive || shouldSkipGhostRefocus(e.target)){ return; }
      setTimeout(focusGhostInput, 0);
    });

    // App 从后台切回前台 / 页面重新可见时，焦点通常会丢失，需要重新抢回
    document.addEventListener('visibilitychange', function(){
      if(document.visibilityState === 'visible' && btFocusGuardActive){ setTimeout(focusGhostInput, 100); }
    });
    window.addEventListener('pageshow', function(){ if(btFocusGuardActive){ setTimeout(focusGhostInput, 100); } });
    window.addEventListener('focus', function(){ if(btFocusGuardActive){ setTimeout(focusGhostInput, 50); } });

    // 兜底看门狗：防止某些场景下焦点被静默夺走而没有触发上面任何事件。
    // v4.1.17：这里不再因为 activeElement===btGhostEl 就直接宣布"已就绪"——
    // DOM焦点对不代表物理键盘真的通，是否confirmed 只看有没有收到过真实按键，这里只负责刷新显示。
    btGhostWatchdogTimer = setInterval(function(){
      if(!btFocusGuardActive){ return; }
      if(document.activeElement === btGhostEl){ updateBtKeyStatus(); return; }
      if(shouldSkipGhostRefocus(document.activeElement)){ return; }
      focusGhostInput();
    }, 1500);

    // 手动兜底：这是一次100%有真实用户手势背书的点击，理论上必定能真正建立焦点。
    // 固定手机、准备用蓝牙键盘启动监测前，看一眼徽章，不放心就点一下，然后按一下键盘确认。
    // v4.1.17修复：原来 blur()后用 setTimeout(fn,0) 延迟执行 focus()，即便0毫秒延迟也会让这次
    // focus() 脱离本次点击的用户手势时效窗口，导致 WKWebView 没有真正重新接通物理键盘 responder——
    // 状态显示"已就绪"是假象，键盘其实是坏的。分享菜单展开触发保存后返回相机页这个场景下，
    // 真机测试确认过该bug会稳定复现。现在改成 blur()+focus() 全程同步执行、不经过任何 setTimeout，
    // 留在同一次点击手势里，真机验证过对同一场景确实生效；并且强制走 force 分支重新走一遍
    // blur/focus，即便 activeElement 已经显示是 ghost input 也不提前相信它。
    var statusBtn = document.getElementById('btKeyStatusBtn');
    if(statusBtn){
      statusBtn.addEventListener('click', function(){
        if(!btFocusGuardActive){ return; }
        btKeyConfirmed = false;
        try{ btGhostEl.blur(); }catch(err){}
        try{ btGhostEl.focus({ preventScroll: true }); }catch(err){ try{ btGhostEl.focus(); }catch(err2){} }
        updateBtKeyStatus();
      });
    }
  }
  // ===== Ghost Input 焦点守护 结束 =====

  // v4.10.4：除相机页外，其余页面支持右滑手势快速返回——不再写死回主页，
  // 改成"模拟点击当前页面自己的返回按钮"，复用每个页面已有的返回逻辑
  // (compare/projection实际回的是stats、help页有动态helpReturnScreen判断)，
  // 避免另写一套判断跟按钮行为对不上、以后按钮逻辑改了滑动却忘记同步。
  // 排除相机页的原因：相机页本身有ROI拖动等横向手势交互，混进全局滑动返回容易误触。
  var SWIPE_BACK_BUTTON_MAP = { settings:'backBtn', stats:'statsBackBtn',
    compare:'compareBackBtn', projection:'projectionBackBtn', help:'helpBackBtn' };

  // 滑动返回目标页面元素id映射——跟手拖拽阶段要直接改这个元素的transform/opacity，
  // 需要知道当前页面对应的是哪个DOM节点(showScreen里是写死的一串if，这里单独提一份映射表)。
  var SCREEN_ELEMENT_ID_MAP = { settings:'screenSettings', stats:'screenStats',
    compare:'screenCompare', projection:'screenProjection', help:'screenHelp' };

  // v4.10.5：给边缘滑动返回补上跟手实时视觉反馈(transform+opacity)和松手后的
  // 滑出/弹回过渡动画——此前(v4.10.4及更早)滑动到位是直接模拟点击返回按钮，
  // 中间没有touchmove阶段的实时反馈，视觉上是"瞬间跳转"。
  function setupSwipeBackGesture(){
    var touchStartX = 0, touchStartY = 0, touchStartTime = 0, tracking = false;
    var draggingEl = null, dragX = 0;
    var SWIPE_MIN_DX = 60;      // 最小水平位移(px)，太短容易跟普通点击/误触混淆
    var SWIPE_MAX_DY = 50;      // 最大垂直位移(px)，超过这个说明是在纵向滚动，不算滑动返回
    var SWIPE_MAX_MS = 600;     // 最长耗时(ms)，太慢的拖动不算"滑动"手势
    var SWIPE_EDGE_ZONE = 40;   // 只在屏幕最左侧这个宽度(px)内起手的滑动才触发，
                                 // 避免页面中间的正常横向滚动/拖动被误判成返回手势
    var DRAG_CAP = 160;         // 跟手拖拽的最大位移(px)，超过这个距离transform不再继续增加
    var SETTLE_MS = 220;        // 松手后"确认返回/弹回原位"动画时长，需跟下面transition写的时长一致

    function shouldSkipSwipeTarget(target){
      if(!target){ return false; }
      var tag = target.tagName;
      if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'){ return true; }
      // range滑块(灵敏度/缩放等)理论上只存在于相机页(已被整体排除)，这里再加一层
      // 保险，避免以后有人在其他页面加了新的range控件时被这个手势误触发。
      if(target.closest && target.closest('input[type="range"]')){ return true; }
      return false;
    }

    function resetDragStyle(el){
      el.style.transition = '';
      el.style.transform = '';
      el.style.opacity = '';
    }

    document.addEventListener('touchstart', function(e){
      if(currentScreen === 'camera' || currentScreen === 'capture'){ tracking = false; return; }
      if(e.touches.length !== 1){ tracking = false; return; }
      var t = e.touches[0];
      if(t.clientX > SWIPE_EDGE_ZONE){ tracking = false; return; }
      if(shouldSkipSwipeTarget(e.target)){ tracking = false; return; }
      var elId = SCREEN_ELEMENT_ID_MAP[currentScreen];
      draggingEl = elId ? document.getElementById(elId) : null;
      if(!draggingEl){ tracking = false; return; }
      touchStartX = t.clientX;
      touchStartY = t.clientY;
      touchStartTime = Date.now();
      dragX = 0;
      tracking = true;
      draggingEl.style.transition = 'none'; // 跟手阶段必须关掉过渡，否则每帧更新会有卡顿延迟感
    }, { passive: true });

    document.addEventListener('touchmove', function(e){
      if(!tracking || !draggingEl){ return; }
      var t = e.touches[0];
      var dx = t.clientX - touchStartX;
      var dy = Math.abs(t.clientY - touchStartY);
      if(dy > SWIPE_MAX_DY){
        // 纵向位移过多，判定为误触(比如在滚动列表)，直接取消并复位，不留半透明状态
        tracking = false;
        resetDragStyle(draggingEl);
        draggingEl = null;
        return;
      }
      if(dx < 0){ return; } // 只响应向右滑（返回手势方向）
      dragX = Math.min(dx, DRAG_CAP);
      draggingEl.style.transform = 'translateX(' + dragX + 'px)';
      draggingEl.style.opacity = String(1 - dragX / (DRAG_CAP * 2));
    }, { passive: true });

    document.addEventListener('touchend', function(e){
      if(!tracking || !draggingEl){ return; }
      tracking = false;
      var dt = Date.now() - touchStartTime;
      var el = draggingEl;
      draggingEl = null;
      var transitionCss = 'transform ' + SETTLE_MS + 'ms ease, opacity ' + SETTLE_MS + 'ms ease';
      if(dt > SWIPE_MAX_MS || dragX < SWIPE_MIN_DX){
        // 未达到阈值（或太慢）：弹回原位
        el.style.transition = transitionCss;
        void el.offsetHeight; // 强制重排，避免和上面transition的写入被合并成一次重绘导致动画被跳过
        el.style.transform = '';
        el.style.opacity = '';
        setTimeout(function(){ resetDragStyle(el); }, SETTLE_MS);
        return;
      }
      // 达到阈值：先播放"滑出"动画，动画播完后再真正调用原有的返回按钮逻辑切页，
      // 不能在这里立刻切页，否则新页面会瞬间顶替、滑出动画根本来不及播放。
      el.style.transition = transitionCss;
      void el.offsetHeight; // 同上，强制重排保证过渡确实生效(WKWebView下这一步不能省)
      el.style.transform = 'translateX(100%)';
      el.style.opacity = '0';
      setTimeout(function(){
        resetDragStyle(el);
        var backBtnId = SWIPE_BACK_BUTTON_MAP[currentScreen];
        var backBtnEl = backBtnId ? document.getElementById(backBtnId) : null;
        if(backBtnEl){ backBtnEl.click(); }
      }, SETTLE_MS);
    }, { passive: true });

    document.addEventListener('touchcancel', function(){
      if(!tracking || !draggingEl){ return; }
      tracking = false;
      var el = draggingEl;
      draggingEl = null;
      el.style.transition = 'transform ' + SETTLE_MS + 'ms ease, opacity ' + SETTLE_MS + 'ms ease';
      void el.offsetHeight;
      el.style.transform = '';
      el.style.opacity = '';
      setTimeout(function(){ resetDragStyle(el); }, SETTLE_MS);
    }, { passive: true });
  }

  function showScreen(name){
    currentScreen = name;
    document.getElementById('screenCapture').style.display = (name === 'capture') ? 'flex' : 'none';
    document.getElementById('screenSettings').style.display = (name === 'settings') ? 'flex' : 'none';
    document.getElementById('screenStats').style.display = (name === 'stats') ? 'flex' : 'none';
    document.getElementById('screenCompare').style.display = (name === 'compare') ? 'flex' : 'none';
    document.getElementById('screenProjection').style.display = (name === 'projection') ? 'flex' : 'none';
    document.getElementById('screenHelp').style.display = (name === 'help') ? 'flex' : 'none';
    document.getElementById('screenCamera').style.display = (name === 'camera') ? 'flex' : 'none';
    if(name === 'settings'){
      document.getElementById('delaySecInput').value = String(delaySec);
      document.getElementById('staleThresholdInput').value = String(staleThresholdMin);
    }
    if(name === 'stats'){
      renderLog();
      renderStats();
    }
    if(name === 'compare'){
      renderComparePage();
    }
    if(name === 'camera'){
      startCamera();
      renderCameraSessionList();
    } else {
      stopCamera();
    }
    // 蓝牙小键盘快捷键只在 capture / camera 页生效，其余页面需要用户正常打字(如手动改日期)，不抢焦点
    if(name === 'capture' || name === 'camera'){
      enableBtFocusGuard();
    } else {
      disableBtFocusGuard();
    }
  }

  function renderSourceToggleList(){
    var el = document.getElementById('sourceToggleList');
    el.innerHTML = SOURCE_DEFS.map(function(def){
      var checked = enabledSourceIds.indexOf(def.id) >= 0 ? 'checked' : '';
      return '<div class="sourcetogglerow"><input type="checkbox" id="src-' + def.id + '" ' + checked + '><label for="src-' + def.id + '">' + def.label + '</label></div>';
    }).join('');
    SOURCE_DEFS.forEach(function(def){
      document.getElementById('src-' + def.id).addEventListener('change', function(){
        toggleSourceEnabled(def.id);
      });
    });
  }

  function init(){
    devCheckKilledRecovery();
    loadRecords();
    loadSessionMeta();
    loadSeason();
    loadHistory();
    loadDelay();
    loadRelayInstalled();
    loadStaleThreshold();
    loadSensitivity();
    // 同步滑条控件的视觉位置和数字显示——此前只有JS内部的sensitivityThreshold
    // 变量是"权威值"，滑条HTML本身的value属性是写死的静态默认，从不读取实际值，
    // 会出现"数字显示对但滑块位置对不上"的情况，这里统一以loadSensitivity()的
    // 结果为准，把DOM也同步过去。
    (function(){
      var sSlider = document.getElementById('sensitivitySlider');
      var sVal = document.getElementById('sensitivityVal');
      if(sSlider){ sSlider.value = sensitivitySliderVal; }
      if(sVal){ sVal.textContent = sensitivitySliderVal.toFixed(1); }
    })();
    // v4.3.0 一次性清理：删掉"历史校准分期"旧功能遗留的 localStorage key，
    // 避免这份不再被任何代码读写的旧数据永久占着位置。try/catch防止隐私模式等
    // localStorage不可用场景下报错中断后续初始化。
    try{ localStorage.removeItem('cc_periods_v1'); }catch(e){}
    loadPackages();
    loadCalSwitchLog();
    loadTempHeldOut();
    loadEnabledSources();
    loadBurstMode();
    loadGridOverlay();
    loadGridDensity();
    renderLog();
    renderSeasonButtons();
    renderRelayStatusButtons();
    renderStats();
    renderSourceToggleList();
    renderBurstModeButtons();
    renderGridDensityButtons();
    loadROI();
    applyROIStyle();
    setupROIInteraction();
    renderSourceDiagnostics();
    setupPWA();
    requestAnimationFrame(renderClock);
    syncTime();
    setupBtKeypadGhost();
    setupSwipeBackGesture();
    showScreen('capture');

    document.getElementById('resyncBtn').addEventListener('click', syncTime);
    document.getElementById('syncStatusBtn').addEventListener('click', syncTime);
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('exportBackupBtn').addEventListener('click', exportFullBackup);
    document.getElementById('exportAnalysisMDBtn').addEventListener('click', exportAnalysisMarkdown);
    document.getElementById('importBackupBtn').addEventListener('click', function(){
      document.getElementById('importFileInput').click();
    });
    document.getElementById('importFileInput').addEventListener('change', function(e){
      importFullBackup(e.target.files[0]);
      e.target.value = '';
    });
    document.getElementById('clearDriftHistoryBtn').addEventListener('click', clearDriftHistory);
    document.getElementById('clearBtn').addEventListener('click', openClearAllModal);
    document.getElementById('clearAllCancelBtn').addEventListener('click', closeClearAllModal);
    document.getElementById('clearAllConfirmBtn').addEventListener('click', confirmClearAll);
    document.getElementById('clearAllBackupNowBtn').addEventListener('click', exportFullBackup);
    document.getElementById('seasonSummerBtn').addEventListener('click', function(){ setSeason('summer'); });
    document.getElementById('seasonWinterBtn').addEventListener('click', function(){ setSeason('winter'); });
    document.getElementById('relayObserveBtn').addEventListener('click', function(){ setRelayInstalled(false); });
    document.getElementById('relayInstalledBtn').addEventListener('click', function(){ setRelayInstalled(true); });

    setupSegmentedInputs();
    setupProjSegInputs();
    document.getElementById('projFillNowBtn').addEventListener('click', function(){
      fillProjSegmentsFromTime(nowCorrected());
    });
    document.getElementById('projCalcBtn').addEventListener('click', runProjectionCalc);

    document.getElementById('manualAddBtn').addEventListener('click', function(){
      var form = document.getElementById('manualForm');
      fillSegmentsFromTime(nowCorrected());
      form.classList.add('open');
    });
    document.getElementById('manualFillNowBtn').addEventListener('click', function(){
      fillSegmentsFromTime(nowCorrected());
    });
    document.getElementById('manualCancelBtn').addEventListener('click', function(){
      document.getElementById('manualForm').classList.remove('open');
    });
    document.getElementById('manualConfirmBtn').addEventListener('click', function(){
      var t = parseSegmentsToTimestamp();
      var latRaw = document.getElementById('manualLatencyInput').value;
      var latencyMs = latRaw !== '' ? parseFloat(latRaw) : null;
      if(latencyMs !== null && (isNaN(latencyMs) || latencyMs < 0)){ latencyMs = null; }
      if(manualAddRecord(t, latencyMs)){
        document.getElementById('manualForm').classList.remove('open');
        document.getElementById('manualLatencyInput').value = '';
      }
    });

    document.getElementById('openSettingsBtn').addEventListener('click', function(){ showScreen('settings'); });
    document.getElementById('openStatsBtn').addEventListener('click', function(){ showScreen('stats'); });
    document.getElementById('openHelpBtn').addEventListener('click', function(){ helpReturnScreen = 'capture'; showScreen('help'); });
    document.getElementById('statsBackBtn').addEventListener('click', function(){ showScreen('capture'); });
    document.getElementById('openCompareBtn').addEventListener('click', function(){ showScreen('compare'); });
    document.getElementById('compareBackBtn').addEventListener('click', function(){ showScreen('stats'); });
    document.getElementById('openProjectionBtn').addEventListener('click', function(){ showScreen('projection'); });
    document.getElementById('projectionBackBtn').addEventListener('click', function(){ showScreen('stats'); });
    document.getElementById('pkgDeleteCancelBtn').addEventListener('click', closePackageDeleteModal);
    document.getElementById('pkgDeleteConfirmBtn').addEventListener('click', confirmPackageDelete);
    window.addEventListener('resize', function(){
      if(currentScreen === 'compare'){ renderComparePage(); }
    });
    document.getElementById('helpBackBtn').addEventListener('click', function(){ showScreen(helpReturnScreen); });
    document.getElementById('cameraHelpBtn').addEventListener('click', function(){ helpReturnScreen = 'camera'; showScreen('help'); });
    document.getElementById('openCameraBigBtn').addEventListener('click', function(){ showScreen('camera'); });
    document.getElementById('cameraBackBtn').addEventListener('click', function(){
      clearCameraSessionCaptures();
      devHandleBackNavigation();
      showScreen('capture');
    });
    document.getElementById('devModeBtn').addEventListener('click', function(){ devHandleDevBtn(); });
    document.getElementById('cameraStartBtn').addEventListener('click', function(){ toggleCameraArm(); });
    document.getElementById('quickModeBtn').addEventListener('click', function(){
      burstModeEnabled = false;
      saveBurstMode();
      renderBurstModeButtons();
    });
    document.getElementById('burstModeBtn').addEventListener('click', function(){
      burstModeEnabled = true;
      saveBurstMode();
      renderBurstModeButtons();
    });

    function renderGridDensityButtons(){
      document.getElementById('gridDensityCoarseBtn').classList.toggle('active', gridDensityMode === 'coarse');
      document.getElementById('gridDensityMediumBtn').classList.toggle('active', gridDensityMode === 'medium');
      document.getElementById('gridDensityFineBtn').classList.toggle('active', gridDensityMode === 'fine');
    }
    document.getElementById('gridDensityCoarseBtn').addEventListener('click', function(){
      gridDensityMode = 'coarse';
      saveGridDensity();
      renderGridDensityButtons();
      computeGridDims();
      resetDetectionBaseline();
    });
    document.getElementById('gridDensityMediumBtn').addEventListener('click', function(){
      gridDensityMode = 'medium';
      saveGridDensity();
      renderGridDensityButtons();
      computeGridDims();
      resetDetectionBaseline();
    });
    document.getElementById('gridDensityFineBtn').addEventListener('click', function(){
      gridDensityMode = 'fine';
      saveGridDensity();
      renderGridDensityButtons();
      computeGridDims();
      resetDetectionBaseline();
    });

    function renderGridOverlayBtn(){
      var btn = document.getElementById('gridOverlayToggleBtn');
      var canvas = document.getElementById('gridOverlayCanvas');
      btn.classList.toggle('active', showGridOverlay);
      btn.textContent = showGridOverlay ? '网格 ✓' : '网格';
      if(canvas){ canvas.style.display = showGridOverlay ? 'block' : 'none'; }
      if(!showGridOverlay){ clearGridOverlayCanvas(); }
    }
    renderGridOverlayBtn();
    document.getElementById('gridOverlayToggleBtn').addEventListener('click', function(){
      showGridOverlay = !showGridOverlay;
      saveGridOverlay();
      renderGridOverlayBtn();
    });

    document.getElementById('cameraManualBtn').addEventListener('click', function(){
      onCameraDetected(nowCorrected(), 'camera-manual');
    });
    document.getElementById('sensitivitySlider').addEventListener('input', function(e){
      var sliderVal = parseFloat(e.target.value);
      sensitivitySliderVal = sliderVal;
      sensitivityThreshold = sliderVal;
      document.getElementById('sensitivityVal').textContent = sliderVal.toFixed(1);
      saveSensitivity();
      resetDiffMeter();
      updateCameraParamsSummary();
    });
    document.getElementById('shakeToleranceSlider').addEventListener('input', function(e){
      shakeToleranceRadius = parseInt(e.target.value, 10);
      document.getElementById('shakeToleranceVal').textContent = shakeToleranceRadius + 'px';
      updateCameraParamsSummary();
    });
    (function(){
      var detail = document.getElementById('cameraParamsDetail');
      var btn = document.getElementById('cameraParamsToggleBtn');
      var summary = document.getElementById('cameraParamsSummaryText');
      function currentCollapsedLabel(){
        var collapsed = detail.style.display === 'none';
        var devSuffix = (devState === 'READY' || devState === 'RUNNING') ? ' · 🛠️Dev模式' : '';
        return (collapsed ? '拍摄参数 ▾' : '收起拍摄参数 ▴') + devSuffix;
      }
      function applyCollapsed(collapsed){
        detail.style.display = collapsed ? 'none' : 'block';
        summary.style.display = collapsed ? '' : 'none';
        btn.textContent = currentCollapsedLabel();
        if(collapsed){ updateCameraParamsSummary(); }
      }
      devRefreshParamsToggleLabel = function(){ btn.textContent = currentCollapsedLabel(); };
      applyCollapsed(loadCameraParamsCollapsed());
      btn.addEventListener('click', function(){
        var currentlyCollapsed = detail.style.display === 'none';
        var next = !currentlyCollapsed;
        applyCollapsed(next);
        saveCameraParamsCollapsed(next);
      });
    })();
    (function(){
      var exportBtn = document.getElementById('devExportBtn');
      devUpdateExportBtnVisibility = function(){
        var hasExportableData = (devState === 'STOPPED' && devLogBuffer && devLogBuffer.stopReason);
        exportBtn.style.display = hasExportableData ? '' : 'none';
      };
      exportBtn.addEventListener('click', function(){
        if(devLogBuffer && devLogBuffer.stopReason){ devTriggerDownload(); }
      });
    })();
    document.getElementById('diagToggleBtn').addEventListener('click', function(){
      var el = document.getElementById('cameraDiagDetail');
      var btn = document.getElementById('diagToggleBtn');
      var open = el.style.display !== 'none';
      el.style.display = open ? 'none' : 'block';
      btn.textContent = open ? '查看诊断详情 ▾' : '收起诊断详情 ▴';
    });
    document.getElementById('backBtn').addEventListener('click', function(){ showScreen('capture'); });

    document.getElementById('delaySaveBtn').addEventListener('click', function(){
      var v = parseFloat(document.getElementById('delaySecInput').value);
      if(isNaN(v) || v < 0){ alert('请输入0或正数(秒)'); return; }
      delaySec = v;
      saveDelay();
      renderStats();
      document.getElementById('delaySaveBtn').textContent = '已保存';
      setTimeout(function(){ document.getElementById('delaySaveBtn').textContent = '保存'; }, 1500);
    });

    document.getElementById('staleThresholdSaveBtn').addEventListener('click', function(){
      var v = parseFloat(document.getElementById('staleThresholdInput').value);
      if(isNaN(v) || v <= 0){ alert('请输入大于0的正数(分钟)'); return; }
      staleThresholdMin = v;
      saveStaleThreshold();
      renderStats();
      document.getElementById('staleThresholdSaveBtn').textContent = '已保存';
      setTimeout(function(){ document.getElementById('staleThresholdSaveBtn').textContent = '保存'; }, 1500);
    });

    var sensHoldTimer = null;
    var sensHoldInterval = null;

    function adjustSensitivity(step){
      var slider = document.getElementById('sensitivitySlider');
      var v = parseFloat(slider.value) + step;
      v = Math.min(50, Math.max(0, v));
      v = Math.round(v*10)/10;
      slider.value = v;
      slider.dispatchEvent(new Event('input'));
    }

    function startSensHold(direction){
      adjustSensitivity(direction*1.0);
      sensHoldTimer = setTimeout(function(){
        sensHoldInterval = setInterval(function(){
          adjustSensitivity(direction*5.0);
        }, 60);
      }, 400);
    }

    function stopSensHold(){
      if(sensHoldTimer){ clearTimeout(sensHoldTimer); sensHoldTimer = null; }
      if(sensHoldInterval){ clearInterval(sensHoldInterval); sensHoldInterval = null; }
    }

    function adjustShakeTolerance(step){
      var slider = document.getElementById('shakeToleranceSlider');
      var v = parseInt(slider.value, 10) + step;
      v = Math.min(4, Math.max(0, v));
      slider.value = v;
      slider.dispatchEvent(new Event('input'));
    }

    // 这款蓝牙小键盘 NumLock 关闭时，数字键会变成 Home/End/方向键等导航键而不是数字，
    // 这里做一层归一化：不管 NumLock 开关状态如何，都能正确识别出用户按的是"逻辑上的哪个数字键"。
    var NAV_KEY_TO_DIGIT = {
      'Insert':'0', 'End':'1', 'ArrowDown':'2', 'PageDown':'3',
      'ArrowLeft':'4', 'Clear':'5', 'ArrowRight':'6',
      'Home':'7', 'ArrowUp':'8', 'PageUp':'9', 'Delete':'.'
    };
    function resolveNumpadDigit(e){
      if(e.key >= '0' && e.key <= '9'){ return e.key; }
      if(e.key === '.'){ return '.'; }
      if(NAV_KEY_TO_DIGIT.hasOwnProperty(e.key)){ return NAV_KEY_TO_DIGIT[e.key]; }
      return null;
    }

    // 数字键1-4：蓝牙键盘微调ROI取景框(宽度/高度/左右/上下)，触屏拖拽不受影响仍可用手精细调；5-8/小数点/等号仍空闲留给以后用
    var ROI_KEY_STEP_PCT = 1;
    var ROI_PARAM_KEYMAP = {
      '1': 'width',
      '2': 'height',
      '3': 'left',
      '4': 'top'
    };
    var quickTuneKeyHeld = null;
    var quickTuneKeyUsedForCombo = false;

    function adjustROIParam(digit, dir){
      var key = ROI_PARAM_KEYMAP[digit];
      if(!key){ return; }
      roiState[key] = roiState[key] + dir * ROI_KEY_STEP_PCT;
      clampROI();
      applyROIStyle();
      saveROI();
      resetDetectionBaseline();
    }

    // 硬件变焦(数字9)：复用同一套"点一下=+一步,按住再点减号=-一步"手感(v3.7起软件预览放大功能已彻底移除，硬件变焦为唯一缩放手段)
    function adjustHwZoom(dir){
      var row = document.getElementById('hwZoomRow');
      var slider = document.getElementById('hwZoomSlider');
      if(!row || !slider || row.style.display === 'none'){
        showCamToast('该设备不支持硬件变焦', 2000);
        return;
      }
      var min = parseFloat(slider.min), max = parseFloat(slider.max);
      var stepSize = parseFloat(slider.step) || 0.1;
      var v = parseFloat(slider.value) + dir * stepSize;
      v = Math.min(max, Math.max(min, Math.round(v / stepSize) * stepSize));
      slider.value = v;
      if(slider.oninput){ slider.oninput(); }
    }

    function quickTuneIsTarget(token){
      return token === '9' || !!ROI_PARAM_KEYMAP[token];
    }

    function quickTuneApply(token, dir){
      if(token === '9'){ adjustHwZoom(dir); return; }
      if(ROI_PARAM_KEYMAP[token]){ adjustROIParam(token, dir); return; }
    }

    document.addEventListener('keydown', function(e){
      if(currentScreen !== 'camera'){ return; }
      var tag = (e.target && e.target.tagName) || '';
      var inputType = (e.target && e.target.type) || '';
      if(!isBtGhostTarget(e.target) && ((tag === 'INPUT' && inputType !== 'range') || tag === 'TEXTAREA')){ return; }

      if(e.code === 'Enter' || e.code === 'NumpadEnter'){
        e.preventDefault();
        if(!e.repeat){ toggleCameraArm(); }
        return;
      }
      if(e.code === 'Backspace'){
        e.preventDefault();
        if(!e.repeat){ requestUndoLastCameraCapture(); }
        return;
      }
      var quickTuneToken = resolveNumpadDigit(e);
      if(quickTuneToken && quickTuneIsTarget(quickTuneToken)){
        e.preventDefault();
        if(!e.repeat){
          quickTuneKeyHeld = quickTuneToken;
          quickTuneKeyUsedForCombo = false;
        }
        return;
      }
      if(e.code === 'NumpadAdd' || e.key === '+'){
        e.preventDefault();
        if(!e.repeat && !sensHoldTimer && !sensHoldInterval){ startSensHold(1); }
        return;
      }
      if(e.code === 'NumpadSubtract' || e.key === '-'){
        e.preventDefault();
        if(quickTuneKeyHeld && quickTuneIsTarget(quickTuneKeyHeld)){
          quickTuneApply(quickTuneKeyHeld, -1);
          quickTuneKeyUsedForCombo = true;
          return;
        }
        if(!e.repeat && !sensHoldTimer && !sensHoldInterval){ startSensHold(-1); }
        return;
      }
      if(e.code === 'NumpadMultiply' || e.key === '*'){
        e.preventDefault();
        if(!e.repeat){ adjustShakeTolerance(1); }
        return;
      }
      if(e.code === 'NumpadDivide' || e.key === '/'){
        e.preventDefault();
        if(!e.repeat){ adjustShakeTolerance(-1); }
        return;
      }
      if(resolveNumpadDigit(e) === '0'){
        e.preventDefault();
        if(!e.repeat){ onCameraDetected(nowCorrected(), 'camera-manual'); }
        return;
      }
      if(e.code === 'Escape'){
        e.preventDefault();
        showScreen('capture');
        return;
      }
    });

    document.addEventListener('keyup', function(e){
      if(e.code === 'NumpadAdd' || e.key === '+' || e.code === 'NumpadSubtract' || e.key === '-'){
        stopSensHold();
      }
      if(quickTuneKeyHeld){
        var upToken = resolveNumpadDigit(e);
        if(upToken === quickTuneKeyHeld){
          if(!quickTuneKeyUsedForCombo){
            quickTuneApply(quickTuneKeyHeld, 1);
          }
          quickTuneKeyHeld = null;
          quickTuneKeyUsedForCombo = false;
        }
      }
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
