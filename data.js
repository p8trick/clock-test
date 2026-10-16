'use strict';
// 数据与存储、时间同步、记录增删、时钟输入、ROI
// 注意：不再有 IIFE 包裹，各 JS 文件共享全局作用域；加载顺序见 index.html（help→data→camera→ui→app），不要调换。

  var STORAGE_KEY = 'cc_records_v1';
  var SEASON_KEY = 'cc_season_v1';
  var HISTORY_KEY = 'cc_history_v1';
  var DELAY_KEY = 'cc_delay_v1';
  var RELAY_INSTALLED_KEY = 'cc_relay_installed_v1';
  var offsetMs = 0;
  var lastSyncInfo = null;
  var records = [];
  var seasonMode = 'summer';
  var driftHistory = { summer: [], winter: [] };
  var delaySec = 8;
  // v4.1.2 观察模式/继电器已装模式的显式开关——纯状态标记，不参与任何漂移计算，
  // 只影响建议时刻的文案措辞，以及导出JSON里附带的数据来源背景。默认观察模式，
  // 因为现在外置继电器确实还没装好，也不打算手动纠正时钟。
  var relayInstalled = false;
  // v4.10.4 观察模式下的"未维护提醒"阈值——本周期累计漂移超过这个分钟数，
  // 且期间没有新校准点介入，说明大概率已经忘记回来维护PWA了，统计页需要
  // 用醒目的警示样式提示，而不是让漂移进度和累计时长安静地无限爬升。
  var STALE_THRESHOLD_KEY = 'cc_stale_threshold_v1';
  var staleThresholdMin = 3;
  // v4.12.1 加上持久化(此前从未保存，每次都回到硬编码的8.5)。
  // v4.12.2 方向性修正：此前滑条数字是"灵敏度"，跟实际阈值是反着的(数字越大阈值越小)，
  // 导致这个数字和电平表上白线的实际位置方向相反，看着容易搞反。现在改成滑条数字
  // 直接就是sensitivityThreshold本身——数字越小，白线越靠左，越容易被触发，越灵敏；
  // 数字越大，白线越靠右，越迟钝——跟电平表的方向完全一致。默认值也从(旧刻度)40
  // 换算成(新刻度)10，实际触发松紧程度不变。
  var SENSITIVITY_KEY = 'cc_sensitivity_v1';
  var sensitivitySliderVal = 10;

  function loadSensitivity(){
    try{
      var v = parseFloat(localStorage.getItem(SENSITIVITY_KEY));
      sensitivitySliderVal = (isNaN(v) || v < 0 || v > SENSITIVITY_MAX) ? 10 : v;
    }catch(e){ sensitivitySliderVal = 10; }
    sensitivityThreshold = sensitivitySliderVal;
  }

  function saveSensitivity(){
    try{ localStorage.setItem(SENSITIVITY_KEY, String(sensitivitySliderVal)); }catch(e){}
  }

  function loadStaleThreshold(){
    try{
      var v = parseFloat(localStorage.getItem(STALE_THRESHOLD_KEY));
      staleThresholdMin = (isNaN(v) || v <= 0) ? 3 : v;
    }catch(e){ staleThresholdMin = 3; }
  }

  function saveStaleThreshold(){
    try{ localStorage.setItem(STALE_THRESHOLD_KEY, String(staleThresholdMin)); }catch(e){}
  }

  // 把毫秒级累计漂移量格式化成"xx分xx秒"，超过60分钟自动进位成"xx时xx分xx秒"，
  // 不封顶。只用于人读的大致展示，故意舍弃毫秒位。
  function formatDriftDuration(ms){
    var totalSec = Math.floor(Math.max(0, ms) / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    if(h > 0){
      return h + '时' + m + '分' + s + '秒';
    }
    return m + '分' + s + '秒';
  }

  function loadRelayInstalled(){
    try{
      relayInstalled = localStorage.getItem(RELAY_INSTALLED_KEY) === '1';
    }catch(e){ relayInstalled = false; }
  }

  function saveRelayInstalled(){
    try{ localStorage.setItem(RELAY_INSTALLED_KEY, relayInstalled ? '1' : '0'); }catch(e){}
  }

  function loadDelay(){
    try{
      var v = parseFloat(localStorage.getItem(DELAY_KEY));
      delaySec = isNaN(v) ? 8 : v;
    }catch(e){ delaySec = 8; }
  }

  function saveDelay(){
    try{ localStorage.setItem(DELAY_KEY, String(delaySec)); }catch(e){}
  }

  function loadSeason(){
    try{
      var v = localStorage.getItem(SEASON_KEY);
      seasonMode = (v === 'winter') ? 'winter' : 'summer';
    }catch(e){ seasonMode = 'summer'; }
  }

  function saveSeason(){
    try{ localStorage.setItem(SEASON_KEY, seasonMode); }catch(e){}
  }

  function loadHistory(){
    try{
      var raw = localStorage.getItem(HISTORY_KEY);
      driftHistory = raw ? JSON.parse(raw) : { summer: [], winter: [] };
      if(!driftHistory.summer){ driftHistory.summer = []; }
      if(!driftHistory.winter){ driftHistory.winter = []; }
    }catch(e){ driftHistory = { summer: [], winter: [] }; }
  }

  function saveHistory(){
    try{ localStorage.setItem(HISTORY_KEY, JSON.stringify(driftHistory)); }catch(e){}
  }

  // v4.3.0 删除了 v4.1.3 时期的"历史校准分期"(driftPeriods)旧设计及其对应的
  // localStorage key(cc_periods_v1，一次性清理逻辑内联在 init() 里，直接 removeItem)。
  // 早在 v4.1.6 就已经被下面的数据包(dataPackages)系统功能性替代，但代码一直没跟着删，
  // 导致设置页留着一个不再被维护的旧UI(比如 clearLog() 清空全部数据时都没捎带清它)。
  // 现在多期数据包对比页(对比走势+删除)已经完整覆盖了原来"历史校准分期"想做的事，
  // 彻底删掉，不再维护两套并行的历史分期概念。

  // v4.1.6 数据包(打包)系统——替代 v4.1.3 那种"校准点之前全部合并成一坨"的旧设计。
  // 每个包是显式记录的成员id列表，边界一旦确定就不会因为以后数据增长而自动变化，
  // 也不会因为任何重算逻辑而被悄悄合并。
  var PACKAGES_KEY = 'cc_packages_v1';
  var dataPackages = [];

  function loadPackages(){
    try{
      var raw = localStorage.getItem(PACKAGES_KEY);
      dataPackages = raw ? JSON.parse(raw) : [];
    }catch(e){ dataPackages = []; }
  }

  function savePackages(){
    try{ localStorage.setItem(PACKAGES_KEY, JSON.stringify(dataPackages)); }catch(e){}
  }

  // 校准切换时间线——每次真正切换校准点都记一笔，不管当时算不算得出漂移率。
  // (原先这里对比的是已在v4.3.0删除的"历史校准分期"driftPeriods——那套按季节分开算，
  // 数据不够时不会留下记录，不可靠。)打包边界必须依赖这份独立、始终完整的记录，
  // 否则可能把两次真实切换之间的数据混进同一个包，包自己的漂移率就会因为中间那次
  // "相位跳变"算出垃圾数字。
  var CAL_SWITCH_LOG_KEY = 'cc_calswitchlog_v1';
  var calibrationSwitchLog = [];

  function loadCalSwitchLog(){
    try{
      var raw = localStorage.getItem(CAL_SWITCH_LOG_KEY);
      calibrationSwitchLog = raw ? JSON.parse(raw) : [];
    }catch(e){ calibrationSwitchLog = []; }
  }

  function saveCalSwitchLog(){
    try{ localStorage.setItem(CAL_SWITCH_LOG_KEY, JSON.stringify(calibrationSwitchLog)); }catch(e){}
  }

  // v4.5.4 "最新一条临时排除统计"——用单个指针而不是给每条record加字段：
  // 天然保证"永远只有一条能被标记"，不需要额外代码去检查/清理旧标记；
  // 新数据一旦写入(insertRecordSorted是唯一入口)就顺手清空，自动并回统计，
  // 不存在"忘记取消标记"这种状态。type='record'对应快捷模式单条，
  // type='session'对应连拍整组(按sessionId一起摘除，不拆散会话)。
  var TEMP_HELDOUT_KEY = 'cc_tempheldout_v1';
  var tempHeldOut = null;

  function loadTempHeldOut(){
    try{
      var raw = localStorage.getItem(TEMP_HELDOUT_KEY);
      tempHeldOut = raw ? JSON.parse(raw) : null;
    }catch(e){ tempHeldOut = null; }
  }

  function saveTempHeldOut(){
    try{
      if(tempHeldOut){ localStorage.setItem(TEMP_HELDOUT_KEY, JSON.stringify(tempHeldOut)); }
      else{ localStorage.removeItem(TEMP_HELDOUT_KEY); }
    }catch(e){}
  }

  // 全局唯一的"当前最新一条记录/会话"判定，供渲染时决定谁能显示临时排除按钮，
  // 也供toggle函数判定点击的是不是真的最新——避免出现"标记了一条，又手动补录了
  // 一条更早时间的记录，导致误判谁是最新"的边界情况。
  function getLatestEntryKey(){
    if(!records.length){ return null; }
    var latest = records[0];
    for(var i=1;i<records.length;i++){
      if(records[i].t > latest.t){ latest = records[i]; }
    }
    return latest.sessionId ? { type:'session', sessionId: latest.sessionId } : { type:'record', id: latest.id };
  }

  function isTempHeldOut(key){
    if(!tempHeldOut || !key){ return false; }
    if(tempHeldOut.type !== key.type){ return false; }
    return tempHeldOut.type === 'session' ? tempHeldOut.sessionId === key.sessionId : tempHeldOut.id === key.id;
  }

  function toggleTempHeldOut(key){
    if(isTempHeldOut(key)){ tempHeldOut = null; }
    else { tempHeldOut = key; }
    saveTempHeldOut();
    renderLog();
    renderStats();
  }

  // 包内成员自己单独跑一遍轻量回归，只用来给这个包一个"大概每天变慢多少"的参考数字，
  // 不区分季节(原始列表本来就是混季节的)，也不接入 collapseSessionsForRegression 那套
  // 面向"正式预测"的复杂锚点合并——这里只是历史记录层面的摘要，要求没有那么高。
  // v4.1.11：补齐跟 renderStats 一致的连拍折叠预处理——之前 computePackageDrift 直接把
  // 连拍会话里每一张照片当独立点喂进回归，跟实时统计页"先折叠成一个去噪合成点再回归"的
  // 做法不一致，会导致连拍张数被当成时间跨度覆盖，effectiveN 虚高、星级置信度失真，
  // 换不同子集时数值也更容易跳(2.23→2.24那种)。现在两阶段跟 renderStats 完全对齐：
  // 先用原始点粗略回归拿 prelimSlope，用它修正连拍内部的漂移增量后取均值折叠成一个点，
  // 再用折叠后的数据做正式回归。折叠后不足3条则退回原始点(理由同 renderStats)。
  function computePackageDrift(members){
    if(members.length < 3){ return { ok:false, count: members.length }; }
    var sorted = members.slice().sort(function(a,b){ return a.t - b.t; });

    var t0Prelim = sorted[0].t;
    var xsPrelim = sorted.map(function(r){ return (r.t - t0Prelim) / 86400000; });
    var ysPrelim = computeLagSeries(sorted);
    var wsPrelim = computeWeights(sorted);
    var prelimReg = weightedRegression(xsPrelim, ysPrelim, wsPrelim);
    var prelimSlope = prelimReg.slope > 0 ? prelimReg.slope : 0;

    var collapsed = collapseSessionsForRegression(sorted, prelimSlope);
    if(collapsed.length < 3){ collapsed = sorted; }
    collapsed = collapsed.slice().sort(function(a,b){ return a.t - b.t; });

    var t0 = collapsed[0].t;
    var xs = collapsed.map(function(r){ return (r.t - t0) / 86400000; });
    var ys = computeLagSeries(collapsed);
    var ws = computeWeights(collapsed);
    var reg = weightedRegression(xs, ys, ws);
    if(!reg || !(reg.slope > 0)){ return { ok:false, count: sorted.length, noDrift:true }; }
    var conf = computeConfidence(collapsed, reg);
    return { ok:true, count: sorted.length, driftSecPerDay: reg.slope / 1000, r2: reg.r2, stars: conf.stars, starsPrecise: conf.starsPrecise };
  }

  // 找出"还没被任何包认领、且早于当前生效校准点"的散装数据。
  // v4.1.9 之前的版本会额外按 calibrationSwitchLog 里的历史切换时间点把这批数据拆成
  // 好几段，每段都要单独打包——这是错误设计：切换记录只是"活跃区间从哪条记录起算"的
  // 操作历史，不代表数据边界，漂移计算(computeLagSeries)本身跟切换历史无关。
  // 多轮反复切换校准点后，散装数据被拆得越来越碎，最终退化成一条条独立的单条"打包"，
  // 样本量不足、漂移率算不出来。现在改成：不管中途切换过几次，只要还没被打包、且早于
  // 当前生效校准点，一律算同一批，合并成一个 segment 一起打包。
  function findAllPendingSegments(){
    var calRecord = null;
    for(var ci=0; ci<records.length; ci++){ if(records[ci].isCalibration){ calRecord = records[ci]; break; } }
    if(!calRecord){ return []; }
    var liveBoundary = calRecord.t;

    var packagedIds = {};
    dataPackages.forEach(function(pkg){ pkg.recordIds.forEach(function(id){ packagedIds[id] = true; }); });
    var loose = records.filter(function(r){ return r.t < liveBoundary && !packagedIds[r.id]; }).sort(function(a,b){ return a.t - b.t; });
    if(!loose.length){ return []; }

    return [ loose ];
  }

  function packageNextSegment(){
    var pending = findAllPendingSegments();
    if(!pending.length){ return; }
    var segment = pending[0];
    dataPackages.push({
      id: 'pkg_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      recordIds: segment.map(function(r){ return r.id; }),
      packagedAt: Date.now()
    });
    savePackages();
    renderLog();
  }


  function loadRecords(){
    try{
      var raw = localStorage.getItem(STORAGE_KEY);
      records = raw ? JSON.parse(raw) : [];
    }catch(e){ records = []; }
  }

  function saveRecords(){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); }catch(e){}
  }

  var SESSION_META_KEY = 'cc_sessionmeta_v1';
  var sessionMeta = {};
  var expandedSessionIds = {};
  // v4.1.1 每次 computeStats() 重算后，缓存每个连拍会话最终以什么形式参与了统计
  // （合并锚点 / 因样本不足按原始3条参与 / 排在校准点之前被排除），供折叠头展示用
  var lastCollapsedBySession = {};

  function loadSessionMeta(){
    try{
      var raw = localStorage.getItem(SESSION_META_KEY);
      sessionMeta = raw ? JSON.parse(raw) : {};
    }catch(e){ sessionMeta = {}; }
  }

  function saveSessionMeta(){
    try{ localStorage.setItem(SESSION_META_KEY, JSON.stringify(sessionMeta)); }catch(e){}
  }

  // v3.8.0 3次触发打包(Session Bundle)：3次连拍完成后，算跨度是否连续、漏抓了几次、
  // 平均系统延迟、平均相邻间隔、以及按漏抓次数补偿后的平均变化周期
  var SESSION_BASELINE_CYCLE_MS = 60000;
  var SESSION_CONTINUITY_LIMIT_MS = 90000;

  // v3.9.8 连拍质量分级：只看两个相邻间隔各自的偏差，不看漏拍总数——
  // 因为漏拍集中在一个间隔(连续漏)比分散在两个间隔(隔次漏)更能说明系统性问题。
  var QUALITY_TIGHT_MIN_MS = 59000;
  var QUALITY_TIGHT_MAX_MS = 61000;
  var QUALITY_JUNK_GAP_MS = 50000; // 间隔明显短于1分钟，基本不可能是真实分钟跳变，判定为疑似误触发

  // v4.12.0：捕获率已接近100%，隔次漏拍/连续漏拍这些细分档位不再有实际参考意义，
  // 简化成二元制——只有两次间隔都精准落在59-61秒才算"优秀"，其余(漏拍≥1分钟、
  // 间隔异常疑似误触发等)一律归为"不合格"。间隔异常的情况额外带一句reason提示
  // 建议删除整组，其余不合格情况用漏拍分钟数说明原因。
  // v4.19.0：连拍噪声窗口——上一次真实抓拍之后这么久以内再次触发，一律当噪声(背景漂移累计造成的
  // 二次误触发)，不计入记录；窗口过后的触发才算真实的下一次抓拍。
  var BURST_NOISE_WINDOW_MS = 50000;
  // 单个间隔是否"精准"(59-61秒)：质量分级和连拍第2张不合格即停都用这一个判据。
  function burstGapIsTight(dt){ return dt >= QUALITY_TIGHT_MIN_MS && dt <= QUALITY_TIGHT_MAX_MS; }

  function classifySessionQuality(gaps){
    var allTight = gaps.every(burstGapIsTight);
    if(allTight){
      return { tier:'excellent', label:'优秀' };
    }
    if(gaps.some(function(dt){ return dt < QUALITY_JUNK_GAP_MS; })){
      return { tier:'fail', label:'不合格', reason:'间隔异常，疑似误触发，建议删除整组' };
    }
    return { tier:'fail', label:'不合格' };
  }

  function computeSessionContinuity(sessionId){
    var members = records.filter(function(r){ return r.sessionId === sessionId; }).sort(function(a,b){ return a.t - b.t; });
    if(members.length < 2){ return; }
    var gaps = [];
    var missedTotal = 0;
    var isContinuous = true;
    var missedMinutes = [];
    for(var i=1;i<members.length;i++){
      var dt = members[i].t - members[i-1].t;
      gaps.push(dt);
      if(dt > SESSION_CONTINUITY_LIMIT_MS){
        isContinuous = false;
        var expectedCycles = Math.round(dt / SESSION_BASELINE_CYCLE_MS);
        var gapMissCount = Math.max(0, expectedCycles - 1);
        missedTotal += gapMissCount;
        for(var k=1;k<=gapMissCount;k++){
          var md = new Date(members[i-1].t + SESSION_BASELINE_CYCLE_MS * k);
          missedMinutes.push(pad(md.getHours(),2) + ':' + pad(md.getMinutes(),2));
        }
      }
    }
    var actualSpanMs = members[members.length-1].t - members[0].t;
    var avgDeltaMs = gaps.reduce(function(a,b){ return a+b; }, 0) / gaps.length;
    var latencies = members.filter(function(r){ return typeof r.detectionLatencyMs === 'number'; }).map(function(r){ return r.detectionLatencyMs; });
    var avgLatencyMs = latencies.length ? (latencies.reduce(function(a,b){ return a+b; }, 0) / latencies.length) : null;
    var totalCycles = gaps.length + missedTotal;
    var compensatedAvgCycleMs = totalCycles > 0 ? (actualSpanMs / totalCycles) : avgDeltaMs;
    var quality = classifySessionQuality(gaps);
    // v4.1.1 保留用户已填写的整组备注，避免被重算覆盖
    var existingNote = (sessionMeta[sessionId] && sessionMeta[sessionId].note) || '';
    // v4.19.0：噪声触发记录(捕获时先挂在meta上)同样要保留，填完挂钟时间后才丢弃
    var existingNoise = (sessionMeta[sessionId] && sessionMeta[sessionId].noiseHits) || null;
    sessionMeta[sessionId] = {
      count: members.length,
      isContinuous: isContinuous,
      actualSpanMs: actualSpanMs,
      missedCount: missedTotal,
      missedMinutes: missedMinutes,
      avgLatencyMs: avgLatencyMs,
      avgDeltaMs: avgDeltaMs,
      compensatedAvgCycleMs: compensatedAvgCycleMs,
      quality: quality.tier,
      qualityLabel: quality.label,
      qualityReason: quality.reason || null,
      completedAt: Date.now(),
      note: existingNote,
      noiseHits: existingNoise
    };
    saveSessionMeta();
  }

  function updateSessionNote(sessionId, val){
    if(!sessionMeta[sessionId]){ sessionMeta[sessionId] = {}; }
    sessionMeta[sessionId].note = val;
    saveSessionMeta();
  }

  function pad(n, len){
    n = String(Math.floor(n));
    while(n.length < len){ n = '0' + n; }
    return n;
  }

  function nowCorrected(){
    return Date.now() + offsetMs;
  }

  function formatDateStr(d){
    var weekday = ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()];
    return d.getFullYear() + '年' + pad(d.getMonth()+1,2) + '月' + pad(d.getDate(),2) + '日 ' + weekday;
  }

  function renderClock(){
    var t = nowCorrected();
    var d = new Date(t);
    document.getElementById('datestr').textContent = formatDateStr(d);
    document.getElementById('timestr').firstChild.textContent =
      pad(d.getHours(),2) + ':' + pad(d.getMinutes(),2) + ':' + pad(d.getSeconds(),2);
    document.getElementById('msstr').textContent = '.' + pad(d.getMilliseconds(),3);
    var camTimeEl = document.getElementById('cameraTimeOverlay');
    if(camTimeEl){
      camTimeEl.firstChild.textContent = pad(d.getHours(),2) + ':' + pad(d.getMinutes(),2) + ':' + pad(d.getSeconds(),2);
      document.getElementById('cameraMsOverlay').textContent = '.' + pad(d.getMilliseconds(),3);
    }
    requestAnimationFrame(renderClock);
  }

  function setSyncStatus(state, text){
    var dot = document.getElementById('syncdot');
    dot.className = 'syncdot ' + (state === 'ok' ? 'sync-ok' : state === 'bad' ? 'sync-bad' : 'sync-wait');
    document.getElementById('syncstatus').textContent = text;
  }

  var GARBAGE_OFFSET_MS = 10*60000;
  var AGREEMENT_TOLERANCE_MS = 1500;
  var TRUST_DEVICE_THRESHOLD_MS = 1500;
  var SOURCES_KEY = 'cc_sources_v1';
  var BURST_KEY = 'cc_burstmode_v1';
  var burstModeEnabled = false;
  var burstSessionId = null;
  var burstCaptureIndex = 0;
  var BURST_TARGET_COUNT = 3;
  var burstLastCaptureT = null; // v4.19.0：本组上一次真实抓拍的时间戳，噪声窗口从它算起
  var burstNoiseHits = [];      // v4.19.0：本组被判为噪声的触发 [{t, afterMs}]，组结束时挂到sessionMeta
  var burstBaselineTimer = null; // v4.19.1：窗口结束时静默刷新基线的定时器
  function clearBurstState(){
    if(burstBaselineTimer){ clearTimeout(burstBaselineTimer); burstBaselineTimer = null; }
    burstSessionId = null;
    burstCaptureIndex = 0;
    burstLastCaptureT = null;
    burstNoiseHits = [];
  }

  function loadBurstMode(){
    try{ burstModeEnabled = localStorage.getItem(BURST_KEY) === '1'; }catch(e){ burstModeEnabled = false; }
  }

  function saveBurstMode(){
    try{ localStorage.setItem(BURST_KEY, burstModeEnabled ? '1' : '0'); }catch(e){}
  }

  function renderBurstModeButtons(){
    document.getElementById('quickModeBtn').classList.toggle('active', !burstModeEnabled);
    document.getElementById('burstModeBtn').classList.toggle('active', burstModeEnabled);
    updateCameraParamsSummary();
  }

  function cfTraceParse(text){
    var m = text && text.match(/ts=(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) * 1000 : null;
  }

  var SOURCE_DEFS = [
    { id:'cf-www', label:'Cloudflare (cloudflare.com)', url:'https://www.cloudflare.com/cdn-cgi/trace', type:'text', parse: cfTraceParse },
    { id:'cf-1111', label:'Cloudflare (1.1.1.1)', url:'https://1.1.1.1/cdn-cgi/trace', type:'text', parse: cfTraceParse },
    { id:'cf-1001', label:'Cloudflare (1.0.0.1)', url:'https://1.0.0.1/cdn-cgi/trace', type:'text', parse: cfTraceParse },
    { id:'timeapi', label:'timeapi.io', url:'https://timeapi.io/api/Time/current/zone?timeZone=UTC', type:'json', parse: function(j){ return j && j.dateTime ? Date.parse(j.dateTime + 'Z') : null; } },
    { id:'worldtimeapi', label:'worldtimeapi.org', url:'https://worldtimeapi.org/api/timezone/Etc/UTC', type:'json', parse: function(j){ return j && j.unixtime ? j.unixtime*1000 : null; } }
  ];

  var enabledSourceIds = SOURCE_DEFS.map(function(s){ return s.id; });
  var lastSyncDiagnostics = [];

  function loadEnabledSources(){
    try{
      var raw = localStorage.getItem(SOURCES_KEY);
      var arr = raw ? JSON.parse(raw) : null;
      if(Array.isArray(arr) && arr.length){ enabledSourceIds = arr; }
    }catch(e){}
  }

  function saveEnabledSources(){
    try{ localStorage.setItem(SOURCES_KEY, JSON.stringify(enabledSourceIds)); }catch(e){}
  }

  function toggleSourceEnabled(id){
    var idx = enabledSourceIds.indexOf(id);
    if(idx >= 0){ enabledSourceIds.splice(idx, 1); }
    else { enabledSourceIds.push(id); }
    saveEnabledSources();
  }

  function trySyncSource(def, timeoutMs){
    return new Promise(function(resolve, reject){
      var timer = setTimeout(function(){ reject(new Error('timeout')); }, timeoutMs);
      var t0 = performance.now();
      fetch(def.url, {cache:'no-store'}).then(function(res){
        return def.type === 'text' ? res.text() : res.json();
      }).then(function(body){
        clearTimeout(timer);
        var t1 = performance.now();
        var serverMs = def.parse(body);
        if(!serverMs || isNaN(serverMs)){ reject(new Error('parse fail')); return; }
        var rtt = t1 - t0;
        var estimatedServerNow = serverMs + rtt/2;
        var localNow = Date.now();
        var offset = estimatedServerNow - localNow;
        if(Math.abs(offset) > GARBAGE_OFFSET_MS){
          reject(new Error('garbage offset ' + Math.round(offset) + 'ms'));
          return;
        }
        resolve({ offset: offset, rttMs: Math.round(rtt) });
      }).catch(function(err){ clearTimeout(timer); reject(err); });
    });
  }

  function syncTime(){
    setSyncStatus('wait', '正在同步...');
    var activeDefs = SOURCE_DEFS.filter(function(d){ return enabledSourceIds.indexOf(d.id) >= 0; });
    if(activeDefs.length === 0){
      offsetMs = 0;
      setSyncStatus('bad', '未启用任何时间源 · 使用本机时间');
      lastSyncInfo = { offset:0, rttMs:null, source:'device', at:Date.now() };
      lastSyncDiagnostics = [];
      renderSourceDiagnostics();
      return;
    }
    var jobs = activeDefs.map(function(def){ return trySyncSource(def, 4000); });
    Promise.allSettled(jobs).then(function(results){
      var offsets = [];
      lastSyncDiagnostics = [];
      results.forEach(function(r, idx){
        var def = activeDefs[idx];
        if(r.status === 'fulfilled'){
          offsets.push(r.value.offset);
          lastSyncDiagnostics.push({ label: def.label, ok:true, offset: Math.round(r.value.offset), rtt: r.value.rttMs });
        } else {
          lastSyncDiagnostics.push({ label: def.label, ok:false, error: (r.reason && r.reason.message) || '失败' });
        }
      });
      evaluateSyncResults(offsets);
      renderSourceDiagnostics();
    });
  }

  function renderSourceDiagnostics(){
    var el = document.getElementById('sourceDiagList');
    if(!el){ return; }
    if(!lastSyncDiagnostics.length){
      el.innerHTML = '<div class="diagempty">尚未同步</div>';
      return;
    }
    el.innerHTML = lastSyncDiagnostics.map(function(d){
      if(d.ok){
        var sign = d.offset >= 0 ? '+' : '';
        return '<div class="diagrow diag-ok">\u2713 ' + d.label + ' · ' + sign + d.offset + 'ms · 往返' + d.rtt + 'ms</div>';
      }
      return '<div class="diagrow diag-bad">\u2717 ' + d.label + ' · ' + d.error + '</div>';
    }).join('');
  }

  function evaluateSyncResults(offsets){
    if(offsets.length === 0){
      offsetMs = 0;
      setSyncStatus('bad', '网络时间源均不可用 · 使用本机时间');
      lastSyncInfo = { offset:0, rttMs:null, source:'device', at:Date.now() };
      return;
    }
    if(offsets.length === 1){
      offsetMs = 0;
      var single = Math.round(offsets[0]);
      setSyncStatus('ok', '仅1个来源响应(' + (single>=0?'+':'') + single + 'ms) · 无法交叉验证 · 使用本机时间');
      lastSyncInfo = { offset:0, rttMs:null, source:'device', at:Date.now() };
      return;
    }
    var maxV = Math.max.apply(null, offsets);
    var minV = Math.min.apply(null, offsets);
    var spread = maxV - minV;
    if(spread > AGREEMENT_TOLERANCE_MS){
      offsetMs = 0;
      setSyncStatus('bad', offsets.length + '个来源结果不一致(差' + Math.round(spread) + 'ms) · 使用本机时间');
      lastSyncInfo = { offset:0, rttMs:null, source:'device-conflict', at:Date.now() };
      return;
    }
    var avg = offsets.reduce(function(a,b){ return a+b; }, 0) / offsets.length;
    if(Math.abs(avg) <= TRUST_DEVICE_THRESHOLD_MS){
      offsetMs = 0;
      setSyncStatus('ok', offsets.length + '个来源一致确认本机时间准确 · 未做修正');
      lastSyncInfo = { offset:0, rttMs:null, source:'device-confirmed', at:Date.now() };
    } else {
      offsetMs = avg;
      var sign = avg >= 0 ? '+' : '';
      setSyncStatus('ok', offsets.length + '个来源一致 · 已修正本机偏差 ' + sign + Math.round(avg) + 'ms');
      lastSyncInfo = { offset: avg, rttMs:null, source:'network-agreed', at:Date.now() };
    }
  }

  function formatInterval(ms){
    if(ms === null || ms === undefined){ return ''; }
    var sign = ms < 0 ? '-' : '';
    ms = Math.abs(ms);
    var totalSec = Math.floor(ms/1000);
    var days = Math.floor(totalSec/86400);
    var hours = Math.floor((totalSec%86400)/3600);
    var mins = Math.floor((totalSec%3600)/60);
    var secs = totalSec%60;
    var parts = [];
    if(days > 0){ parts.push(days + '天'); }
    if(days > 0 || hours > 0){ parts.push(hours + '小时'); }
    if(days > 0 || hours > 0 || mins > 0){ parts.push(mins + '分'); }
    if(days === 0 && hours === 0){ parts.push(secs + '秒'); }
    return sign + parts.join('');
  }

  function nearestDisplayedTimestamp(trueT, hh, mm){
    var d = new Date(trueT);
    var candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime();
    var diff = trueT - candidate;
    if(diff > 12*3600000){ candidate += 86400000; }
    else if(diff < -12*3600000){ candidate -= 86400000; }
    return candidate;
  }

  // v4.10.4：手动填入/修改挂钟显示时间后，这条记录的漂移量从"自动估算(可能因超过
  // 60秒周期而失真)"变成"手动指定，精确可靠"——它当初插入时在收敛记录里留下的那条
  // 快照，是用修正前的错误数值算出来的，需要同步更新成修正后的正确值，而不是留着
  // 一条已知错误的死数字。只更新这条记录自己触发的那一条快照，不去级联重算它之后
  // 插入的其它记录对应的快照——如果修正的是很久以前的一条记录、期间又有新记录插入，
  // 中间那些快照理论上也会因为这次修正而略有变化，但这里不做级联重算，属于已知的
  // 简化处理（实际使用中，修正动作通常紧跟在拍摄之后，中间很少会插入别的新记录）。
  // v4.10.4：groupKey取代triggerRecordId后，如果这条记录属于某个连拍组，
  // 应该按sessionId去匹配那条"整组共享"的快照，而不是按这条记录自己的id去找
  // (自己的id现在通常不会作为groupKey出现，因为连拍统一用sessionId去重了)。
  // 这样修正连拍中任意一张的挂钟时间，都会正确更新到那一条共享快照上；
  // 修正完3张之后，这条快照最终反映的就是3张全部修正后的真实平均值。
  function updateDriftHistoryForRecord(id){
    var rec = null;
    for(var i=0;i<records.length;i++){ if(records[i].id === id){ rec = records[i]; break; } }
    if(!rec){ return; }
    var s = computeStats(rec.season);
    if(!s.ok){ return; }
    var arr = driftHistory[rec.season];
    if(!arr || !arr.length){ return; }
    var groupKey = rec.sessionId || rec.id;
    var changed = false;
    arr.forEach(function(h){
      var key = (h.groupKey !== undefined && h.groupKey !== null) ? h.groupKey : h.triggerRecordId;
      if(key === groupKey){
        h.driftSecPerDay = s.driftSecPerDay;
        h.stars = s.stars;
        h.count = s.count;
        changed = true;
      }
    });
    if(changed){ saveHistory(); }
  }

  // v4.15.0：根据记录当前状态决定挂钟输入框该显示哪种颜色——
  // 空值不特殊上色；系统自动猜的显示橙色(autofilled)；用户确认/手动改过的显示绿色(confirmed)，
  // 老数据(v4.15.0之前录入、没有这个字段)默认按"用户手动填的"处理，因为原本就是手动输入。
  function clockInputStateClass(r){
    if(!r.clockDisplay){ return ''; }
    return r.clockDisplayAutoFilled ? 'autofilled' : 'confirmed';
  }

  function setClockDisplay(id, hhmm){
    var rec = null;
    for(var i=0;i<records.length;i++){
      if(records[i].id === id){
        rec = records[i];
        rec.clockDisplayAutoFilled = false; // 用户手动动过这个字段(不管是清空还是改值)，不再算"系统自动猜的"
        if(!hhmm){
          rec.clockDisplay = '';
          rec.explicitDriftMs = null;
        } else {
          var parts = hhmm.split(':');
          var hh = parseInt(parts[0], 10);
          var mm = parseInt(parts[1], 10);
          if(!isNaN(hh) && !isNaN(mm)){
            var displayedT = nearestDisplayedTimestamp(rec.t, hh, mm);
            rec.clockDisplay = hhmm;
            rec.explicitDriftMs = rec.t - displayedT;
          }
        }
        break;
      }
    }
    saveRecords();
    // v4.17.1修复：v4.17.0这里对连拍组走的是renderLog()整体重渲染，但iOS原生时间选择器
    // 每拨一格就会触发一次change(不是等你两格都调完才触发)，重渲染会把用户正在操作的
    // 那个输入框DOM节点整个换掉，表现成"一松手就被强制关闭、直接提交当前滚到的值"。
    // 改成跟单条记录一样的原地patch(输入框/漂移文字用id直接找到、改className和文字)，
    // 连拍组额外多一步：单独原地刷新组头的"参与统计"状态行和间隔警告行，不碰输入框本身。
    var inputEl = document.getElementById('clockinput-' + id);
    if(inputEl && rec){ inputEl.className = 'clockinput ' + clockInputStateClass(rec); }
    var driftEl = document.getElementById('drift-' + id);
    if(driftEl && rec){
      if(rec.explicitDriftMs !== null && rec.explicitDriftMs !== undefined){
        var dsec = rec.explicitDriftMs / 1000;
        var latAdj = (typeof rec.detectionLatencyMs === 'number') ? rec.detectionLatencyMs : 0;
        var correctedSec = ((rec.explicitDriftMs - latAdj) / 1000).toFixed(3);
        driftEl.className = 'driftresult';
        driftEl.textContent = dsec >= 0
          ? ('已漂移 ' + dsec.toFixed(3) + '秒(落后) 减延迟=' + correctedSec + '秒')
          : ('已领先 ' + Math.abs(dsec).toFixed(3) + '秒 减延迟=' + correctedSec + '秒');
      } else {
        driftEl.className = 'driftresult pending';
        driftEl.textContent = rec.sessionId ? '等待输入' : '等待输入挂钟时间 · 暂不参与统计';
      }
    }
    if(rec && rec.sessionId){
      refreshBundleStatusInPlace(rec.sessionId);
    } else if(rec){
      var calWarnElSingle = document.getElementById('calpendingwarn-' + id);
      if(calWarnElSingle){
        calWarnElSingle.textContent = (rec.isCalibration && !rec.clockDisplay)
          ? '⚠ 校准点挂钟时间还没填，暂不参与统计，请尽快填好让校准点回归统计' : '';
      }
    }
    renderStats();
    updateDriftHistoryForRecord(id);
    renderCameraSessionList();
  }

  var SEG_IDS = ['segY','segMo','segD','segH','segMi','segS','segMs'];
  var SEG_MAXLEN = { segY:4, segMo:2, segD:2, segH:2, segMi:2, segS:2, segMs:3 };

  function fillSegmentsFromTime(t){
    var d = new Date(t);
    document.getElementById('segY').value = String(d.getFullYear());
    document.getElementById('segMo').value = pad(d.getMonth()+1, 2);
    document.getElementById('segD').value = pad(d.getDate(), 2);
    document.getElementById('segH').value = pad(d.getHours(), 2);
    document.getElementById('segMi').value = pad(d.getMinutes(), 2);
    document.getElementById('segS').value = pad(d.getSeconds(), 2);
    document.getElementById('segMs').value = pad(d.getMilliseconds(), 3);
  }

  function setupSegmentedInputs(){
    SEG_IDS.forEach(function(id, idx){
      var el = document.getElementById(id);
      el.addEventListener('input', function(){
        el.value = el.value.replace(/[^0-9]/g, '').slice(0, SEG_MAXLEN[id]);
        if(el.value.length >= SEG_MAXLEN[id] && idx < SEG_IDS.length - 1){
          document.getElementById(SEG_IDS[idx+1]).focus();
        }
      });
      el.addEventListener('keydown', function(e){
        if(e.key === 'Backspace' && el.value.length === 0 && idx > 0){
          e.preventDefault();
          var prev = document.getElementById(SEG_IDS[idx-1]);
          prev.value = prev.value.slice(0, -1);
          prev.focus();
        }
      });
    });
  }

  function parseSegmentsToTimestamp(){
    var y = parseInt(document.getElementById('segY').value, 10);
    var mo = parseInt(document.getElementById('segMo').value, 10);
    var d = parseInt(document.getElementById('segD').value, 10);
    var h = parseInt(document.getElementById('segH').value, 10);
    var mi = parseInt(document.getElementById('segMi').value, 10);
    var s = parseInt(document.getElementById('segS').value, 10);
    var msRaw = document.getElementById('segMs').value;
    var ms = msRaw.length ? parseInt((msRaw + '00').slice(0,3), 10) : 0;
    if(isNaN(y) || isNaN(mo) || isNaN(d) || isNaN(h) || isNaN(mi) || isNaN(s)){ return NaN; }
    if(mo<1 || mo>12 || d<1 || d>31 || h<0 || h>23 || mi<0 || mi>59 || s<0 || s>59){ return NaN; }
    return new Date(y, mo-1, d, h, mi, s, ms).getTime();
  }

  // v4.5.2 "推算任意时间点"计算器——复用手动补录表单的分段输入交互模式(自动跳格/退格合并)，
  // 但用独立的一套 ID(projSeg*)，避免跟 manualForm 的 segY/segMo 等共用同一份状态。
  // 只到分钟精度(不需要秒/毫秒)，因为这本来就是给"人到点了随手抓拍验证"用的，不追求逐秒对表。
  var PROJ_SEG_IDS = ['projSegY','projSegMo','projSegD','projSegH','projSegMi'];
  var PROJ_SEG_MAXLEN = { projSegY:4, projSegMo:2, projSegD:2, projSegH:2, projSegMi:2 };

  function setupProjSegInputs(){
    PROJ_SEG_IDS.forEach(function(id, idx){
      var el = document.getElementById(id);
      if(!el){ return; }
      el.addEventListener('input', function(){
        el.value = el.value.replace(/[^0-9]/g, '').slice(0, PROJ_SEG_MAXLEN[id]);
        if(el.value.length >= PROJ_SEG_MAXLEN[id] && idx < PROJ_SEG_IDS.length - 1){
          document.getElementById(PROJ_SEG_IDS[idx+1]).focus();
        }
      });
      el.addEventListener('keydown', function(e){
        if(e.key === 'Backspace' && el.value.length === 0 && idx > 0){
          e.preventDefault();
          var prev = document.getElementById(PROJ_SEG_IDS[idx-1]);
          prev.value = prev.value.slice(0, -1);
          prev.focus();
        }
      });
    });
  }

  function fillProjSegmentsFromTime(t){
    var d = new Date(t);
    document.getElementById('projSegY').value = String(d.getFullYear());
    document.getElementById('projSegMo').value = pad(d.getMonth()+1, 2);
    document.getElementById('projSegD').value = pad(d.getDate(), 2);
    document.getElementById('projSegH').value = pad(d.getHours(), 2);
    document.getElementById('projSegMi').value = pad(d.getMinutes(), 2);
  }

  function parseProjSegmentsToTimestamp(){
    var y = parseInt(document.getElementById('projSegY').value, 10);
    var mo = parseInt(document.getElementById('projSegMo').value, 10);
    var d = parseInt(document.getElementById('projSegD').value, 10);
    var h = parseInt(document.getElementById('projSegH').value, 10);
    var mi = parseInt(document.getElementById('projSegMi').value, 10);
    if(isNaN(y) || isNaN(mo) || isNaN(d) || isNaN(h) || isNaN(mi)){ return NaN; }
    if(mo<1 || mo>12 || d<1 || d>31 || h<0 || h>23 || mi<0 || mi>59){ return NaN; }
    return new Date(y, mo-1, d, h, mi, 0, 0).getTime();
  }

  // 复用 computeStats() 已经算好的回归线(intercept/driftSecPerDay/baselineT)，代入任意目标时刻，
  // 跟 computeStats 内部算 basePredicted/projectedNowY 用的是完全同一条公式，只是 x 换成任意时间，
  // 不重新拟合、不改变任何现有预测逻辑——纯只读的"如果套用当前这条线，这一刻该是多少"。
  function computeProjectionAt(season, targetMs){
    var s = computeStats(season);
    if(!s.ok){ return { ok:false, reason: s.noDrift ? 'noDrift' : 'notEnough' }; }
    var xT = (targetMs - s.baselineT) / 86400000;
    var slopeMsPerDay = s.driftSecPerDay * 1000;
    var projectedYms = s.intercept + slopeMsPerDay * xT;
    return { ok:true, s:s, projectedYms: projectedYms };
  }

  function runProjectionCalc(){
    var resultEl = document.getElementById('projResult');
    var t = parseProjSegmentsToTimestamp();
    if(isNaN(t)){
      resultEl.innerHTML = '<span style="color:var(--bad);">时间格式不完整或不合法，请检查</span>';
      return;
    }
    var r = computeProjectionAt(seasonMode, t);
    if(!r.ok){
      resultEl.innerHTML = r.reason === 'noDrift' ? '暂无变慢趋势，无法推算' : '样本不足，无法推算';
      return;
    }
    var yms = r.projectedYms;
    var tier = Math.floor(yms / 60000);
    var remainderMs = yms - tier * 60000;
    var remainderSec = remainderMs / 1000;
    var toNextMinuteSec = (60000 - remainderMs) / 1000;
    var deltaDays = (t - Date.now()) / 86400000;
    var absHrs = Math.abs(deltaDays) * 24;
    var whenLabel = (deltaDays >= 0 ? '距现在还有 ' : '已过去 ') +
      (Math.abs(deltaDays) < 1 ? (Math.round(absHrs*10)/10 + ' 小时') : (Math.round(Math.abs(deltaDays)*10)/10 + ' 天'));

    resultEl.innerHTML =
      '<div>' + whenLabel + '</div>' +
      '<div style="margin-top:4px;">预计累计漂移总量：<b>' + (yms/1000).toFixed(3) + ' 秒</b></div>' +
      '<div>第 ' + (tier+1) + ' 圈 · 圈内已过 ' + remainderSec.toFixed(3) + ' 秒 · 距下次整分钟还差 ' + toNextMinuteSec.toFixed(3) + ' 秒</div>' +
      '<div style="font-size:11px; color:var(--ink-dim); margin-top:6px;">依据：' + (seasonMode==='summer'?'夏季':'冬季') + '模型 · 样本' + r.s.count + '条 · 拟合优度' + (r.s.r2*100).toFixed(2) + '% · ' + starsDisplayText(r.s.stars, r.s.starsPrecise) + '★ —— 这条线本身会随新数据变化，此结果仅反映计算这一刻的拟合状态</div>';
  }

  function recomputeAllDeltas(){
    records.sort(function(a,b){ return a.t - b.t; });
    for(var i=0;i<records.length;i++){
      records[i].deltaMs = i > 0 ? (records[i].t - records[i-1].t) : null;
    }
  }

  // v4.1.5 全新起点(此前一条记录都没有)时，不管是手动补录、单次拍摄还是连拍的第一枪，
  // 只要是历史上第一条落进 records 的数据，自动标为校准点。这样"没有任何有效校准点"这个状态
  // 只存在于 records 完全为空的那一瞬间，一旦有数据，永远有且只有一条是当前校准点——
  // 避免今后数据量很大时，不小心把校准点清空导致整个历史全部一起参与回归计算。
  function insertRecordSorted(rec){
    var isFirstRecordEver = (records.length === 0);
    records.push(rec);
    if(isFirstRecordEver){
      rec.isCalibration = true;
    }
    if(tempHeldOut){
      tempHeldOut = null;
      saveTempHeldOut();
    }
    recomputeAllDeltas();
  }

  function manualAddRecord(t, latencyMs){
    if(isNaN(t)){ alert('时间不完整或无效，请检查每一格数字'); return false; }
    var d = new Date(t);
    var rec = {
      id: 'r' + t + '_' + Math.floor(Math.random()*1000) + '_m',
      t: t,
      display: formatDateStr(d) + ' ' + pad(d.getHours(),2) + ':' + pad(d.getMinutes(),2) + ':' + pad(d.getSeconds(),2) + '.' + pad(d.getMilliseconds(),3),
      deltaMs: null,
      syncSource: 'manual',
      note: '手动补录',
      isCalibration: false,
      season: seasonMode,
      clockDisplay: '',
      explicitDriftMs: null,
      detectionLatencyMs: (typeof latencyMs === 'number' && latencyMs >= 0) ? latencyMs : null,
      sessionId: null
    };
    insertRecordSorted(rec);
    saveRecords();
    renderLog();
    renderStats();
    return true;
  }

  function addRecordAtTime(t, sourceTag, detectionLatencyMs, sessionId){
    var d = new Date(t);
    var rec = {
      id: 'r' + t + '_' + Math.floor(Math.random()*1000),
      t: t,
      display: formatDateStr(d) + ' ' + pad(d.getHours(),2) + ':' + pad(d.getMinutes(),2) + ':' + pad(d.getSeconds(),2) + '.' + pad(d.getMilliseconds(),3),
      deltaMs: null,
      syncSource: sourceTag || (lastSyncInfo ? lastSyncInfo.source : 'device'),
      note: '',
      isCalibration: false,
      season: seasonMode,
      clockDisplay: '',
      explicitDriftMs: null,
      detectionLatencyMs: (typeof detectionLatencyMs === 'number' && detectionLatencyMs > 0) ? detectionLatencyMs : null,
      sessionId: sessionId || null,
      clockDisplayAutoFilled: false
    };
    // v4.17.0：移除挂钟时间自动填入。v4.15.0~v4.16.1这套"用回归模型反推挂钟显示"的
    // 方案，即便v4.15.1修完了取整分钟的算法bug，仍然会因为回归模型本身的预测误差
    // (不是代码问题，是拟合残差)偶尔猜错整整1分钟——多次实机验证下来时准时不准，没法信。
    // 改回纯手动：clockDisplay/explicitDriftMs保持空值，等用户在下面手动填入HH:MM，
    // 具体走nearestDisplayedTimestamp()那条唯一路径(见setClockDisplay)，不会再有
    // "自动填的值"和"手动改的值"两条算法各算各的、互相对不上的问题。
    insertRecordSorted(rec);
    saveRecords();
    renderLog();
    renderStats();
    trackHistory(rec);
    return rec;
  }

  var ROI_KEY = 'cc_roi_v1';
  var ROI_DEFAULT = { left:15, top:35, width:70, height:20 };
  var roiState = { left:15, top:35, width:70, height:20 };

