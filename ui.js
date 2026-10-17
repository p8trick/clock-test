'use strict';
// 记录/数据包卡片渲染、回归统计、对比页、导出备份
// 注意：不再有 IIFE 包裹，各 JS 文件共享全局作用域；加载顺序见 index.html（help→data→camera→ui→app），不要调换。
  function renderCameraSessionList(){
    var wrap = document.getElementById('cameraSessionListWrap');
    if(!wrap){ return; }
    var visible = cameraSessionCaptures.slice(0, 3);
    if(visible.length === 0){
      wrap.style.display = 'none';
      wrap.innerHTML = '';
      return;
    }
    wrap.style.display = 'block';
    var html = '<div class="sessionListTitle">本次监测最近捕获</div>';
    visible.forEach(function(item){
      var d = new Date(item.t);
      var timeStr = formatDateStr(d) + ' ' + pad(d.getHours(),2) + ':' + pad(d.getMinutes(),2) + ':' + pad(d.getSeconds(),2) + '.' + pad(d.getMilliseconds(),3);
      var key = item.kind === 'burst' ? ('b:' + item.sessionId) : ('r:' + item.id);
      var isPending = (pendingSessionDeleteId === key);
      var label;
      // v4.17.0：抓拍后挂钟时间不再自动填，这里提示一下还没填、暂不进统计，
      // 跟下面删除按钮的"pending"(等待二次确认)是两回事，这里换个类名避免混淆。
      var clockNotFilled;
      if(item.kind === 'burst'){
        var filledCount = item.ids.filter(function(rid){
          var rr = records.filter(function(x){ return x.id === rid; })[0];
          return rr && !!rr.clockDisplay;
        }).length;
        clockNotFilled = filledCount < item.ids.length;
        label = '连拍×' + item.ids.length + ' · 最后一次 ' + timeStr;
        if(item.quality){
          var extraNote = item.qualityReason ? (' · ' + item.qualityReason)
            : ((item.missedMinutes && item.missedMinutes.length) ? (' · 漏拍 ' + item.missedMinutes.join('、')) : '');
          label += '<br><span class="continuitytag q-' + item.quality + '" style="margin-left:0;">' +
            item.qualityLabel + extraNote + '</span>';
        }
        if(clockNotFilled){
          label += '<br><span class="sessioncardclockpending">等待输入挂钟时间(已填' + filledCount + '/' + item.ids.length + ') · 暂不参与统计</span>';
          if(item.noiseHits && item.noiseHits.length){
            label += '<br><span class="sessioncardclockpending">已忽略噪声触发 ' + item.noiseHits.length + ' 次</span>';
          }
        }
      } else {
        var rr2 = records.filter(function(x){ return x.id === item.id; })[0];
        clockNotFilled = !(rr2 && rr2.clockDisplay);
        label = timeStr;
        if(clockNotFilled){
          label += '<br><span class="sessioncardclockpending">等待输入挂钟时间 · 暂不参与统计</span>';
        }
      }
      var delText = isPending ? '确认删除？' : (item.kind === 'burst' ? '删除整组' : '×');
      html += '<div class="sessionCard"><span>' + label + '</span>' +
        '<button class="sessionCardDel' + (isPending ? ' pending' : '') + '" data-key="' + key + '">' + delText + '</button></div>';
    });
    wrap.innerHTML = html;
    var delBtns = wrap.querySelectorAll('.sessionCardDel');
    for(var i=0;i<delBtns.length;i++){
      delBtns[i].addEventListener('click', function(e){
        handleSessionCardDelete(e.currentTarget.getAttribute('data-key'));
      });
    }
  }

  function handleSessionCardDelete(key){
    if(pendingSessionDeleteId === key){
      if(pendingSessionDeleteTimer){ clearTimeout(pendingSessionDeleteTimer); pendingSessionDeleteTimer = null; }
      pendingSessionDeleteId = null;
      if(key.indexOf('b:') === 0){
        deleteSessionGroup(key.slice(2)); // 整组删除，内部会顺带清理这条摘要卡片
      } else {
        deleteRecord(key.slice(2));
      }
    } else {
      pendingSessionDeleteId = key;
      if(pendingSessionDeleteTimer){ clearTimeout(pendingSessionDeleteTimer); }
      pendingSessionDeleteTimer = setTimeout(function(){
        pendingSessionDeleteId = null;
        renderCameraSessionList();
      }, 3000);
      renderCameraSessionList();
    }
  }

  var pendingDeleteId = null;
  var pendingDeleteTimer = null;

  function requestDelete(id){
    if(pendingDeleteId === id){
      if(pendingDeleteTimer){ clearTimeout(pendingDeleteTimer); pendingDeleteTimer = null; }
      pendingDeleteId = null;
      deleteRecord(id);
    } else {
      pendingDeleteId = id;
      if(pendingDeleteTimer){ clearTimeout(pendingDeleteTimer); }
      pendingDeleteTimer = setTimeout(function(){
        pendingDeleteId = null;
        pendingDeleteTimer = null;
        renderLog();
      }, 3000);
      renderLog();
    }
  }

  function requestDeleteGroup(sessionId){
    var confirmKey = 'group:' + sessionId;
    if(pendingDeleteId === confirmKey){
      if(pendingDeleteTimer){ clearTimeout(pendingDeleteTimer); pendingDeleteTimer = null; }
      pendingDeleteId = null;
      deleteSessionGroup(sessionId);
    } else {
      pendingDeleteId = confirmKey;
      if(pendingDeleteTimer){ clearTimeout(pendingDeleteTimer); }
      pendingDeleteTimer = setTimeout(function(){
        pendingDeleteId = null;
        pendingDeleteTimer = null;
        renderLog();
      }, 3000);
      renderLog();
    }
  }

  function updateNote(id, val){
    for(var i=0;i<records.length;i++){
      if(records[i].id === id){ records[i].note = val; break; }
    }
    saveRecords();
  }

  function setSingleCalibration(id){
    for(var i=0;i<records.length;i++){
      records[i].isCalibration = (records[i].id === id);
    }
  }

  // v4.1.6 如果新校准点落在"最新那一个"数据包里，说明用户正在展开它重新选边界——
  // 按讨论过的设计，这一步会把整个包解散（不是裁剪），成员重新变回散装数据。
  // 如果落在更早、已经被锁定的包里，直接拒绝（正常 UI 下不会走到这里，这里只是保底）。
  function dissolveMostRecentPackageIfContains(recordId){
    if(!dataPackages.length){ return true; }
    var lastPkg = dataPackages[dataPackages.length - 1];
    if(lastPkg.recordIds.indexOf(recordId) !== -1){
      dataPackages.pop();
      savePackages();
      return true;
    }
    for(var i=0;i<dataPackages.length-1;i++){
      if(dataPackages[i].recordIds.indexOf(recordId) !== -1){ return false; }
    }
    return true;
  }

  // v4.1.5 校准点不再允许"原地点掉"——已经是当前校准点时点击不做任何事。
  // 要更换校准点，必须去点另一条记录的"设为校准点"，这样系统永远保证：
  // 只要 records 不为空，就一定有且只有一条处于校准点状态，不会退回"没有校准点=
  // 整个历史全部参与回归"这种在数据量很大时代价惊人的状态。
  function toggleCalibration(id){
    var target = null;
    for(var i=0;i<records.length;i++){ if(records[i].id === id){ target = records[i]; break; } }
    if(!target || target.isCalibration){ return; }
    if(!dissolveMostRecentPackageIfContains(id)){ return; }
    // v4.6.0 防护：这条即将成为校准点的记录，如果正好是当前被"临时排除统计"标记的那条
    // (单条按id匹配，连拍按sessionId匹配)，必须先解除标记再设校准点——否则 getActiveRecords()
    // 会把校准点自己也一起过滤掉，lastCalIdx 找不到校准点会退化成"全部历史都算活跃区间"，
    // 校准边界形同虚设。校准点的权重天然高于临时观察，这里直接顺手解除，不需要用户自己先取消。
    if(tempHeldOut && (tempHeldOut.type === 'record' ? tempHeldOut.id === id : tempHeldOut.sessionId === target.sessionId)){
      tempHeldOut = null;
      saveTempHeldOut();
    }
    calibrationSwitchLog.push({ recordId:id, t: target.t });
    saveCalSwitchLog();
    setSingleCalibration(id);
    saveRecords();
    renderLog();
    renderStats();
  }

  // v4.1.1 连拍会话设为校准点：标在组内时间最早的一条成员上，
  // 这样 getActiveRecords() 按时间切割时，整组三条都会保留在有效集合里，
  // 后续 collapseSessionsForRegression() 会把这组自动合并成一条去抖动的平均锚点参与统计——
  // 校准点本身不需要单独实现"平均值"逻辑，通用合并机制已经覆盖了这个场景。
  function setSessionCalibration(sessionId){
    var members = records.filter(function(r){ return r.sessionId === sessionId; }).sort(function(a,b){ return a.t - b.t; });
    if(!members.length){ return; }
    var earliestId = members[0].id;
    for(var i=0;i<records.length;i++){
      records[i].isCalibration = (records[i].id === earliestId);
    }
  }

  function toggleSessionCalibration(sessionId){
    var members = records.filter(function(r){ return r.sessionId === sessionId; });
    if(!members.length){ return; }
    var isCurrentlyCal = members.some(function(r){ return r.isCalibration; });
    if(isCurrentlyCal){ return; }
    var earliest = members.slice().sort(function(a,b){ return a.t - b.t; })[0];
    if(!dissolveMostRecentPackageIfContains(earliest.id)){ return; }
    // v4.6.0 防护：同 toggleCalibration，整组设为校准点前先解除可能存在的临时排除标记
    if(tempHeldOut && tempHeldOut.type === 'session' && tempHeldOut.sessionId === sessionId){
      tempHeldOut = null;
      saveTempHeldOut();
    }
    calibrationSwitchLog.push({ recordId: earliest.id, t: earliest.t });
    saveCalSwitchLog();
    setSessionCalibration(sessionId);
    saveRecords();
    renderLog();
    renderStats();
  }


  function renderSingleLogRow(r, locked, isLatestRecord){
    var held = isLatestRecord && isTempHeldOut({ type:'record', id: r.id });
    var row = document.createElement('div');
    row.className = 'logrow' + (r.isCalibration ? ' calmarked' : '') + (held ? ' tempheldout' : '');
    var left = document.createElement('div');
    left.style.flex = '1';
    var lt = document.createElement('div');
    lt.className = 'lt';
    lt.textContent = r.display;
    var ld = document.createElement('div');
    ld.className = 'ld';
    var srcLabel = '本机';
    if(r.syncSource === 'manual'){ srcLabel = '手动补录'; }
    else if(r.syncSource === 'camera'){ srcLabel = '📷摄像头自动检测'; }
    else if(r.syncSource === 'camera-manual'){ srcLabel = '📷摄像头模式手动截取'; }
    else if(r.syncSource === 'network-agreed'){ srcLabel = '本机(已按网络核实修正)'; }
    else if(r.syncSource === 'device-conflict'){ srcLabel = '本机(网络来源不一致)'; }
    else if(r.syncSource === 'device-confirmed'){ srcLabel = '本机(已核实准确)'; }
    var latencyNote = (typeof r.detectionLatencyMs === 'number') ? (' · 统计时已扣除延迟' + Math.round(r.detectionLatencyMs) + 'ms') : '';
    ld.textContent = (r.deltaMs !== null ? ('距上次 ' + formatInterval(r.deltaMs) + ' · ') : '') + '来源 ' + srcLabel + latencyNote;
    var stag = document.createElement('span');
    stag.className = 'seasontag';
    stag.textContent = (r.season === 'winter') ? '❄️冬' : '☀️夏';
    ld.appendChild(stag);
    if(held){
      var heldTag = document.createElement('span');
      heldTag.className = 'tempheldouttag';
      heldTag.textContent = '⏸ 临时排除·不计入统计';
      ld.appendChild(heldTag);
    }

    var clockRow = document.createElement('div');
    clockRow.className = 'clockrow';
    var clockLabel = document.createElement('span');
    clockLabel.className = 'clocklabel';
    clockLabel.textContent = '挂钟显示';
    var clockInput = document.createElement('input');
    clockInput.type = 'time';
    clockInput.id = 'clockinput-' + r.id;
    clockInput.className = 'clockinput ' + clockInputStateClass(r);
    clockInput.value = r.clockDisplay || '';
    clockInput.disabled = !!locked;
    clockInput.addEventListener('change', function(){ setClockDisplay(r.id, clockInput.value); });
    var driftSpan = document.createElement('span');
    driftSpan.className = 'driftresult';
    driftSpan.id = 'drift-' + r.id;
    if(r.explicitDriftMs !== null && r.explicitDriftMs !== undefined){
      var dsec = r.explicitDriftMs / 1000;
      var latAdj = (typeof r.detectionLatencyMs === 'number') ? r.detectionLatencyMs : 0;
      var correctedSec = ((r.explicitDriftMs - latAdj) / 1000).toFixed(3);
      driftSpan.textContent = dsec >= 0
        ? ('已漂移 ' + dsec.toFixed(3) + '秒(落后) 减延迟=' + correctedSec + '秒')
        : ('已领先 ' + Math.abs(dsec).toFixed(3) + '秒 减延迟=' + correctedSec + '秒');
    } else {
      driftSpan.className = 'driftresult pending';
      driftSpan.textContent = '等待输入挂钟时间 · 暂不参与统计';
    }
    clockRow.appendChild(clockLabel);
    clockRow.appendChild(clockInput);
    clockRow.appendChild(driftSpan);

    var note = document.createElement('input');
    note.className = 'noteinput';
    note.placeholder = '备注';
    note.value = r.note || '';
    note.disabled = !!locked;
    note.addEventListener('change', function(){ updateNote(r.id, note.value); });
    var btnrow = document.createElement('div');
    btnrow.className = 'logbtnrow';
    var calBtn = document.createElement('button');
    if(locked){
      calBtn.className = 'calbtn calbtn-locked';
      calBtn.textContent = '🔒 已锁定期次，不可更改';
      calBtn.disabled = true;
    } else {
      calBtn.className = 'calbtn' + (r.isCalibration ? ' calactive calmarked-locked' : '');
      calBtn.textContent = r.isCalibration ? '\u2605 当前校准点' : '设为校准点';
      calBtn.addEventListener('click', function(){ toggleCalibration(r.id); });
    }
    btnrow.appendChild(calBtn);
    calBtn.style.display = held ? 'none' : '';
    if(isLatestRecord && !locked && !r.isCalibration){
      var tempBtn = document.createElement('button');
      tempBtn.className = 'calbtn' + (held ? ' tempheldoutbtn-active' : '');
      tempBtn.textContent = held ? '↩ 已排除·点击并入统计' : '⏸ 临时排除(不计入统计)';
      tempBtn.addEventListener('click', function(){ toggleTempHeldOut({ type:'record', id: r.id }); });
      btnrow.appendChild(tempBtn);
    }
    left.appendChild(lt); left.appendChild(ld); left.appendChild(clockRow); left.appendChild(note); left.appendChild(btnrow);
    // v4.17.3：校准点自己的挂钟时间被清空/还没填时，星标还留在这条上，但它已经不
    // 贡献数据了(getActiveRecords会把它筛掉，活跃区间实际从后面第一条有效数据算起)。
    // 这行提示一直挂在DOM里(平时是空文字)，好让setClockDisplay之后能原地patch它，
    // 不用为了刷新这一行提示又去整行重渲染。
    var calPendingWarn = document.createElement('div');
    calPendingWarn.id = 'calpendingwarn-' + r.id;
    calPendingWarn.className = 'calpendingwarn';
    calPendingWarn.textContent = (r.isCalibration && !r.clockDisplay)
      ? '⚠ 校准点挂钟时间还没填，暂不参与统计，请尽快填好让校准点回归统计' : '';
    left.appendChild(calPendingWarn);
    var del = document.createElement('button');
    if(locked){
      del.className = 'lx lx-locked';
      del.disabled = true;
    } else if(r.isCalibration){
      // v4.1.8：校准点本来就在 deleteRecord() 里被拦，但那是"点了才发现不行"。
      // 直接不渲染删除按钮，用户一眼就知道这条动不了，不需要先点再看提示。
      del = null;
    } else {
      del.className = 'lx' + (pendingDeleteId === r.id ? ' lxconfirm' : '');
      del.textContent = (pendingDeleteId === r.id) ? '确认删除' : '\u00d7';
      del.addEventListener('click', function(){ requestDelete(r.id); });
    }
    row.appendChild(left); if(del){ row.appendChild(del); }
    return row;
  }

  // v4.1.1 折叠头"参与统计"状态行——直接读 computeStats() 顺手缓存的结果，
  // 保证展示的数值和真正参与回归拟合的是同一次计算产物
  function formatSessionStatsLine(sessionId, memberCount){
    if(isTempHeldOut({ type:'session', sessionId: sessionId })){
      return { cls:'st-excluded', text:'参与统计: 已临时排除，不计入拟合/星级/图表' };
    }
    var st = lastCollapsedBySession[sessionId];
    if(!st){ return { cls:'st-pending', text:'参与统计: 尚未计算' }; }
    if(st.status === 'anchor'){
      var sec = (st.avgY / 1000).toFixed(3);
      return { cls:'st-anchor', text:'参与统计: 已合并为锚点 · 锚点时间 ' + shortDT(st.meanT) + ' · 相位值 ' + sec + '秒(已扣除检测延迟)' };
    }
    if(st.status === 'raw'){
      return { cls:'st-raw', text:'参与统计: 当前总样本不足，本组未合并，' + memberCount + '条按原始记录分别参与' };
    }
    if(st.status === 'not_enough_data'){
      return { cls:'st-excluded', text:'参与统计: 当前总数据不足3条，尚未计算' };
    }
    if(st.status === 'excluded_before_calibration'){
      return { cls:'st-excluded', text:'参与统计: 排在校准点之前，已被排除' };
    }
    return { cls:'st-pending', text:'参与统计: 尚未计算' };
  }

  // v4.17.0：连拍组"1组"必须全部填完挂钟时间才正式计入统计，这里给折叠头一句更明确的话，
  // 区分"完全没填"和"填了一部分"，跟formatSessionStatsLine那套"已经在算了"的状态分开说。
  function burstClockFillInfo(members){
    var filled = members.filter(function(m){ return !!m.clockDisplay; }).length;
    return { filled: filled, total: members.length, allFilled: filled === members.length };
  }

  // v4.17.0：连拍设计上每张之间挂钟应该正好跳1分钟(如00:15→00:16→00:17)，
  // 检查相邻两张都已填的情况下间隔是不是恰好1分钟(支持跨小时/跨天翻转)，
  // 揪出"挂钟看错/敲错分钟数"这种人工录入失误，跟漏拍连续性检测(computeSessionContinuity，
  // 基于实际抓拍时间戳)是两回事——那个查的是"抓拍本身连不连续"，这个查的是"人填的挂钟数字对不对"。
  function burstSpacingIssues(members){
    var issues = [];
    for(var i=1;i<members.length;i++){
      var prev = members[i-1], cur = members[i];
      if(!prev.clockDisplay || !cur.clockDisplay){ continue; }
      var pParts = prev.clockDisplay.split(':');
      var cParts = cur.clockDisplay.split(':');
      var pMin = parseInt(pParts[0],10)*60 + parseInt(pParts[1],10);
      var cMin = parseInt(cParts[0],10)*60 + parseInt(cParts[1],10);
      var diff = ((cMin - pMin) % 1440 + 1440) % 1440;
      if(diff !== 1){
        issues.push('第' + i + '→' + (i+1) + '张 ' + prev.clockDisplay + '→' + cur.clockDisplay + '(相差' + diff + '分钟，应为1)');
      }
    }
    return issues;
  }

  // v4.17.1：原地更新连拍组的"参与统计"状态行 + 间隔警告行，不重建整张卡片的DOM。
  // 之前改一个挂钟输入框就renderLog()整体重渲染，iOS原生时间选择器还在滚动中时
  // 锚定的输入框节点被换掉，表现成"一松手就被强制关闭、直接提交当前值"——这里改成
  // 只找这两个id对应的元素改textContent/className，输入框本身的DOM节点全程不动。
  // v4.19.0：噪声触发说明——只在本组挂钟时间还没填完时显示；全部填完(整组进入统计)后丢弃。
  function bundleNoiseNoteText(sessionId, allFilled){
    var meta = sessionMeta[sessionId];
    if(!meta || !meta.noiseHits || !meta.noiseHits.length){ return ''; }
    if(allFilled){
      delete meta.noiseHits;
      saveSessionMeta();
      return '';
    }
    return '已忽略噪声触发 ' + meta.noiseHits.length + ' 次(距上次抓拍 ' +
      meta.noiseHits.map(function(h){ return Math.round(h.afterMs/1000) + 's'; }).join('、') +
      ')，填完挂钟时间后自动清除';
  }

  function refreshBundleStatusInPlace(sessionId){
    var members = records.filter(function(r){ return r.sessionId === sessionId; }).sort(function(a,b){ return a.t - b.t; });
    if(!members.length){ return; }
    var statLineEl = document.getElementById('statline-' + sessionId);
    if(statLineEl){
      var fillInfo = burstClockFillInfo(members);
      if(fillInfo.allFilled){
        var statInfo = formatSessionStatsLine(sessionId, members.length);
        statLineEl.className = 'statline ' + statInfo.cls;
        statLineEl.textContent = statInfo.text;
      } else {
        statLineEl.className = 'statline st-clockpending';
        statLineEl.textContent = '等待输入挂钟时间 · 本组暂不参与统计(已填' + fillInfo.filled + '/' + fillInfo.total + ')';
      }
    }
    var noiseEl = document.getElementById('noisenote-' + sessionId);
    if(noiseEl){ noiseEl.textContent = bundleNoiseNoteText(sessionId, burstClockFillInfo(members).allFilled); }
    var warnEl = document.getElementById('spacingwarn-' + sessionId);
    if(warnEl){
      var spacingIssues = burstSpacingIssues(members);
      warnEl.textContent = spacingIssues.length ? ('⚠ 挂钟间隔异常：' + spacingIssues.join('；')) : '';
    }
    var calWarnEl = document.getElementById('calpendingwarn-session-' + sessionId);
    if(calWarnEl){
      var sessionIsCalNow = members.some(function(r){ return r.isCalibration; });
      var fillInfoNow = burstClockFillInfo(members);
      calWarnEl.textContent = (sessionIsCalNow && !fillInfoNow.allFilled)
        ? '⚠ 校准点挂钟时间还没填完，本组暂不参与统计，请尽快填好让校准点回归统计' : '';
    }
  }

  function renderBundleCard(sessionId, members, locked, isLatestSession){
    var meta = sessionMeta[sessionId];
    var expanded = !!expandedSessionIds[sessionId];
    var sessionIsCal = members.some(function(r){ return r.isCalibration; });
    var held = isLatestSession && isTempHeldOut({ type:'session', sessionId: sessionId });
    var card = document.createElement('div');
    card.className = 'bundlecard' + (sessionIsCal ? ' calmarked' : '') + (held ? ' tempheldout' : '');

    var head = document.createElement('div');
    head.className = 'bundlehead';
    var left = document.createElement('div');
    left.style.flex = '1';
    var lt = document.createElement('div');
    lt.className = 'lt';
    lt.textContent = '🔗连拍会话 · ' + members[members.length-1].display + ' · 共' + members.length + '次';
    var ld = document.createElement('div');
    ld.className = 'ld';
    var deltaText = (members[0].deltaMs !== null && members[0].deltaMs !== undefined) ? ('距上次 ' + formatInterval(members[0].deltaMs) + ' · ') : '';
    if(meta){
      var avgLatText = (typeof meta.avgLatencyMs === 'number') ? (Math.round(meta.avgLatencyMs) + 'ms') : '--';
      ld.textContent = deltaText + '平均延迟 ' + avgLatText + ' · 平均间隔 ' + formatInterval(meta.avgDeltaMs) + ' · 补偿后平均周期 ' + formatInterval(meta.compensatedAvgCycleMs);
    } else {
      ld.textContent = deltaText + '会话数据不完整(可能是旧版本记录)';
    }
    var tag = document.createElement('span');
    if(meta && meta.quality){
      tag.className = 'continuitytag q-' + meta.quality;
      if(meta.qualityReason){
        tag.textContent = meta.qualityLabel + ' · ' + meta.qualityReason;
      } else {
        var missNote = (meta.missedMinutes && meta.missedMinutes.length) ? (' · 漏拍 ' + meta.missedMinutes.join('、')) : '';
        tag.textContent = meta.qualityLabel + missNote;
      }
    } else if(meta && !meta.isContinuous){
      tag.className = 'continuitytag warn';
      tag.textContent = '跨越' + formatInterval(meta.actualSpanMs) + ' · 疑似漏抓' + meta.missedCount + '次';
    } else {
      tag.className = 'continuitytag';
      tag.textContent = '连续';
    }
    ld.appendChild(tag);
    if(held){
      var heldTagB = document.createElement('span');
      heldTagB.className = 'tempheldouttag';
      heldTagB.textContent = '⏸ 临时排除·不计入统计';
      ld.appendChild(heldTagB);
    }

    var fillInfo = burstClockFillInfo(members);
    var statLine = document.createElement('div');
    statLine.id = 'statline-' + sessionId;
    if(fillInfo.allFilled){
      var statInfo = formatSessionStatsLine(sessionId, members.length);
      statLine.className = 'statline ' + statInfo.cls;
      statLine.textContent = statInfo.text;
    } else {
      statLine.className = 'statline st-clockpending';
      statLine.textContent = '等待输入挂钟时间 · 本组暂不参与统计(已填' + fillInfo.filled + '/' + fillInfo.total + ')';
    }
    // v4.17.1：这个警告条一直挂在DOM里(哪怕暂时没问题、内容是空的)，不再用"有问题才创建
    // 节点"的写法——这样后面setClockDisplay要更新它时可以直接原地改textContent，
    // 不需要把整张卡片destroy掉重建，避免打断正在操作中的iOS原生时间选择器。
    var spacingIssues = burstSpacingIssues(members);
    var spacingWarnEl = document.createElement('div');
    spacingWarnEl.id = 'spacingwarn-' + sessionId;
    spacingWarnEl.className = 'burstspacingwarn';
    spacingWarnEl.textContent = spacingIssues.length ? ('⚠ 挂钟间隔异常：' + spacingIssues.join('；')) : '';

    var noiseNoteEl = document.createElement('div');
    noiseNoteEl.id = 'noisenote-' + sessionId;
    noiseNoteEl.className = 'noisenote';
    noiseNoteEl.textContent = bundleNoiseNoteText(sessionId, fillInfo.allFilled);

    var note = document.createElement('input');
    note.className = 'noteinput';
    note.placeholder = '整组备注';
    note.value = (meta && meta.note) || '';
    note.disabled = !!locked;
    note.addEventListener('click', function(e){ e.stopPropagation(); });
    note.addEventListener('change', function(){ updateSessionNote(sessionId, note.value); });

    var calRow = document.createElement('div');
    calRow.className = 'bundleheadcalrow';
    var calBtn = document.createElement('button');
    if(locked){
      calBtn.className = 'calbtn calbtn-locked';
      calBtn.textContent = '🔒 已锁定期次，不可更改';
      calBtn.disabled = true;
    } else {
      calBtn.className = 'calbtn' + (sessionIsCal ? ' calactive calmarked-locked' : '');
      calBtn.textContent = sessionIsCal ? '\u2605 当前校准点' : '设为校准点';
      calBtn.addEventListener('click', function(e){ e.stopPropagation(); toggleSessionCalibration(sessionId); });
    }
    calRow.appendChild(calBtn);
    calBtn.style.display = held ? 'none' : '';
    if(isLatestSession && !locked && !sessionIsCal){
      var tempBtnS = document.createElement('button');
      tempBtnS.className = 'calbtn' + (held ? ' tempheldoutbtn-active' : '');
      tempBtnS.textContent = held ? '↩ 已排除·点击并入统计' : '⏸ 临时排除整组(不计入统计)';
      tempBtnS.addEventListener('click', function(e){ e.stopPropagation(); toggleTempHeldOut({ type:'session', sessionId: sessionId }); });
      calRow.appendChild(tempBtnS);
    }

    left.appendChild(lt); left.appendChild(ld); left.appendChild(statLine);
    left.appendChild(spacingWarnEl);
    left.appendChild(noiseNoteEl);
    left.appendChild(note); left.appendChild(calRow);
    var calPendingWarnS = document.createElement('div');
    calPendingWarnS.id = 'calpendingwarn-session-' + sessionId;
    calPendingWarnS.className = 'calpendingwarn';
    calPendingWarnS.textContent = (sessionIsCal && !fillInfo.allFilled)
      ? '⚠ 校准点挂钟时间还没填完，本组暂不参与统计，请尽快填好让校准点回归统计' : '';
    left.appendChild(calPendingWarnS);

    var expandBtn = document.createElement('button');
    expandBtn.className = 'bundleExpandBtn';
    expandBtn.innerHTML = '<span>' + (expanded ? '▲' : '▼') + '</span>';
    var toggleExpand = function(){
      expandedSessionIds[sessionId] = !expandedSessionIds[sessionId];
      renderLog();
    };
    // v4.12.4：改为只有圆圈按钮本身响应展开/折叠，不再是整行都能点——
    // 整行可点时太容易在点其他按钮/输入框(校准点/临时排除/删除等)时误触发，
    // 之前得靠那些按钮各自stopPropagation来补救，现在从根上只留一个点击入口。
    expandBtn.addEventListener('click', toggleExpand);
    head.appendChild(left); head.appendChild(expandBtn);
    card.appendChild(head);

    if(expanded){
      var body = document.createElement('div');
      body.className = 'bundlebody burstbody';
      members.forEach(function(m, i){
        var item = document.createElement('div');
        var gapMs = i > 0 ? (m.t - members[i-1].t) : null;
        var missedGap = gapMs !== null && gapMs > SESSION_CONTINUITY_LIMIT_MS;
        item.className = 'bundleitem' + (missedGap ? ' missedgap' : '');
        var ilt = document.createElement('div');
        ilt.className = 'lt';
        ilt.textContent = (i+1) + '/' + members.length + ' · ' + m.display;
        var ild = document.createElement('div');
        ild.className = 'ld';
        var latText = (typeof m.detectionLatencyMs === 'number') ? ('延迟' + Math.round(m.detectionLatencyMs) + 'ms · ') : '';
        var gapText = gapMs !== null ? ('间隔' + formatInterval(gapMs) + (missedGap ? '(疑似漏抓)' : '') + ' · ') : '';
        ild.textContent = gapText + latText + '来源 📷摄像头自动检测';
        item.appendChild(ilt); item.appendChild(ild);

        var mClockRow = document.createElement('div');
        mClockRow.className = 'clockrow';
        var mLabel = document.createElement('span');
        mLabel.className = 'clocklabel';
        mLabel.textContent = '挂钟显示';
        var mInput = document.createElement('input');
        mInput.type = 'time';
        mInput.id = 'clockinput-' + m.id;
        mInput.className = 'clockinput ' + clockInputStateClass(m);
        mInput.value = m.clockDisplay || '';
        mInput.disabled = !!locked;
        mInput.addEventListener('click', function(e){ e.stopPropagation(); });
        mInput.addEventListener('change', function(){ setClockDisplay(m.id, mInput.value); });
        var mDrift = document.createElement('span');
        mDrift.className = 'driftresult';
        mDrift.id = 'drift-' + m.id;
        if(m.explicitDriftMs !== null && m.explicitDriftMs !== undefined){
          var mds = m.explicitDriftMs / 1000;
          var mLatAdj = (typeof m.detectionLatencyMs === 'number') ? m.detectionLatencyMs : 0;
          var mCorrectedSec = ((m.explicitDriftMs - mLatAdj) / 1000).toFixed(3);
          mDrift.textContent = mds >= 0
            ? ('已漂移 ' + mds.toFixed(3) + '秒(落后) 减延迟=' + mCorrectedSec + '秒')
            : ('已领先 ' + Math.abs(mds).toFixed(3) + '秒 减延迟=' + mCorrectedSec + '秒');
        } else {
          mDrift.className = 'driftresult pending';
          mDrift.textContent = '等待输入';
        }
        mClockRow.appendChild(mLabel); mClockRow.appendChild(mInput); mClockRow.appendChild(mDrift);
        item.appendChild(mClockRow);

        body.appendChild(item);
      });
      var btnrow = document.createElement('div');
      btnrow.className = 'bundlebtnrow';
      var delBtn = document.createElement('button');
      var showBtnRow = true;
      if(locked){
        delBtn.className = 'lx lx-locked';
        delBtn.textContent = '🔒 已锁定期次';
        delBtn.disabled = true;
        btnrow.appendChild(delBtn);
      } else if(sessionIsCal){
        // v4.1.8：整组含当前校准点时同样直接不渲染，理由同单条记录；
        // 连按钮外层的行都不加，避免留一条空白margin
        showBtnRow = false;
      } else {
        delBtn.className = 'lx' + (pendingDeleteId === ('group:' + sessionId) ? ' lxconfirm' : '');
        delBtn.textContent = (pendingDeleteId === ('group:' + sessionId)) ? '确认删除整组' : '删除整组';
        delBtn.addEventListener('click', function(e){ e.stopPropagation(); requestDeleteGroup(sessionId); });
        btnrow.appendChild(delBtn);
      }
      if(showBtnRow){ body.appendChild(btnrow); }
      card.appendChild(body);
    }
    return card;
  }

  // v4.1.1 renderLog() 不一定总跟在 renderStats() 后面调用（比如连拍刚完成时），
  // 这里保底跑一遍两季的 computeStats() 只为刷新 lastCollapsedBySession 缓存，
  // 保证折叠头显示的"参与统计"状态不会用到上一次数据变更前的旧值。
  function refreshSessionCollapseCache(){
    computeStats('summer');
    computeStats('winter');
  }

  // v4.13.3：从4个不同函数里各自重复实现的"按recordIds找出对应records并排序"
  // 逻辑里提炼出来的共享helper——之前renderPackageCard/openPackageDeleteModal/
  // getComparablePackages/buildAnalysisReport各写了一遍(写法还不完全一样)，
  // 统一成这一个之后，以后想调整成员筛选规则或优化查找效率只需要改一处。
  function getPackageMembers(pkg){
    return pkg.recordIds
      .map(function(id){ for(var i=0;i<records.length;i++){ if(records[i].id === id){ return records[i]; } } return null; })
      .filter(Boolean)
      .sort(function(a,b){ return a.t - b.t; });
  }

  // 同上，"每天变慢X秒 · 拟合优度Y% · 星级"这行摘要文字，renderPackageCard和
  // 多期对比页的行渲染里逐字重复了一遍，一并提出来共用。
  function packageDriftSummaryHtml(drift){
    return drift.ok
      ? ('每天变慢 ' + drift.driftSecPerDay.toFixed(3) + '秒 · 拟合优度' + (drift.r2*100).toFixed(2) + '% · ' + starHtml(drift.stars, drift.starsPrecise))
      : (drift.noDrift ? '未测得正向漂移' : '样本不足，无法计算漂移率');
  }

  // v4.1.3 手动折叠校准点之前的历史数据——纯粹为了收起列表长度，不做任何自动触发，
  // 也不在摘要里放漂移率(漂移率的对比分析交给多期数据包对比页，两者是分开的两件事)
  var packageExpandedIds = {};

  // v4.1.6 数据包卡片——最新的那个包(isLatest)允许展开后点成员的"设为校准点"来解散重选，
  // 更早的包展开只是纯浏览，calBtn/备注/挂钟输入/删除按钮全部禁用，做到真正锁定。
  function renderPackageCard(pkg, isLatest){
    var members = getPackageMembers(pkg);
    if(!members.length){
      // 包里的成员全被删除了，这个包本身也没有意义了，静默跳过不渲染
      return document.createDocumentFragment();
    }
    var expanded = !!packageExpandedIds[pkg.id];
    var drift = computePackageDrift(members);

    var card = document.createElement('div');
    card.className = 'bundlecard';
    var head = document.createElement('div');
    head.className = 'bundlehead';
    var left = document.createElement('div');
    left.style.flex = '1';
    var lt = document.createElement('div');
    lt.className = 'lt';
    lt.textContent = '📦 数据包 · ' + shortDT(members[0].t) + ' ~ ' + shortDT(members[members.length-1].t) + ' · 共' + members.length + '条';
    var ld = document.createElement('div');
    ld.className = 'ld';
    ld.innerHTML = packageDriftSummaryHtml(drift);
    var lockTag = document.createElement('span');
    lockTag.className = 'continuitytag';
    lockTag.textContent = isLatest ? '可重新选择校准点' : '\u{1F512}已锁定';
    ld.appendChild(lockTag);
    left.appendChild(lt); left.appendChild(ld);

    var expandBtn = document.createElement('button');
    expandBtn.className = 'bundleExpandBtn';
    expandBtn.innerHTML = '<span>' + (expanded ? '▲' : '▼') + '</span>';
    expandBtn.addEventListener('click', function(){
      packageExpandedIds[pkg.id] = !expanded;
      renderLog();
    });
    head.appendChild(left); head.appendChild(expandBtn);
    card.appendChild(head);

    if(expanded){
      var body = document.createElement('div');
      body.className = 'bundlebody pkgbody';
      var renderedInPkg = {};
      // v4.1.9：包内成员原来按 members(升序，最旧在前) 直接 forEach，导致展开后最上面是
      // 最旧的数据，跟主列表"最新在顶部"的惯例反着来，容易造成误操作(比如误以为最下面
      // 那条是最新数据从而点错)。这里改成倒序渲染，跟主列表保持一致；header 摘要行和
      // 漂移计算仍然用升序的 members，不受影响。
      members.slice().reverse().forEach(function(m){
        if(m.sessionId){
          if(renderedInPkg[m.sessionId]){ return; }
          renderedInPkg[m.sessionId] = true;
          var sessMembers = members.filter(function(x){ return x.sessionId === m.sessionId; });
          body.appendChild(renderBundleCard(m.sessionId, sessMembers, !isLatest));
        } else {
          body.appendChild(renderSingleLogRow(m, !isLatest));
        }
      });
      card.appendChild(body);
    }
    return card;
  }

  function renderPendingSegmentRow(segment, canPackage){
    var row = document.createElement('div');
    row.className = 'precaldivider';
    var text = document.createElement('span');
    text.textContent = '——— 待打包 ' + segment.length + ' 条(' + shortDT(segment[0].t) + ' ~ ' + shortDT(segment[segment.length-1].t) + ') ———';
    row.appendChild(text);
    if(canPackage){
      var btn = document.createElement('button');
      btn.className = 'precalToggleBtn';
      btn.textContent = '打包';
      btn.addEventListener('click', function(){ packageNextSegment(); });
      row.appendChild(btn);
    } else {
      var note = document.createElement('span');
      note.style.fontSize = '10px';
      note.style.color = 'var(--ink-dim)';
      note.textContent = '(需先打包更早的一段)';
      row.appendChild(note);
    }
    return row;
  }

  // v4.3.1 数据包真删除——唯一入口，跟旧逻辑"只管往dataPackages里push、从来没有
  // 真正删除路径"彻底不同。删完立刻同步刷新统计表(renderLog)和对比页自己
  // (renderComparePage)，不管调用时当前停留在哪个页面，两边永远读同一份数组，
  // 不会有"这边删了那边还留着旧数据"的窗口期。
  //
  // 删除范围连带包内全部原始记录(records)一并清除，不是只摘掉"包"这层壳——
  // 弹窗文案写的是"永久删除，物理上无法恢复"，行为必须跟文案兑现，不能删完包后
  // 记录本体还在、退回成"待打包"状态，那样用户看到"包没了"但实际数据都还在，
  // 是两件事，容易造成误解。
  //
  // 保险检查：按 v4.1.7 定下的规矩，当前校准点所在记录理论上不可能被封存进任何
  // 已完成的包(dissolveMostRecentPackageIfContains 在设新校准点时会保证这一点)，
  // 但这里还是做一次防御性检查——万一真出现这种异常状态，直接拒绝整体删除，
  // 避免退化成"没有任何校准点、全部历史一起参与回归"这种 v4.1.7 想彻底消灭的危险状态。
  function deletePackageById(pkgId){
    var idx = -1;
    for(var i=0;i<dataPackages.length;i++){ if(dataPackages[i].id === pkgId){ idx = i; break; } }
    if(idx === -1){ return; }
    var pkg = dataPackages[idx];

    var hasCalibration = pkg.recordIds.some(function(id){
      for(var i=0;i<records.length;i++){ if(records[i].id === id && records[i].isCalibration){ return true; } }
      return false;
    });
    if(hasCalibration){
      alert('这个数据包里包含当前校准点，理论上不应该发生，已阻止删除以避免数据异常。');
      return;
    }

    dataPackages.splice(idx, 1);
    var deletedIds = pkg.recordIds.slice();
    records = records.filter(function(r){ return deletedIds.indexOf(r.id) === -1; });
    recomputeAllDeltas();
    savePackages();
    saveRecords();
    renderLog();
    renderStats();
    renderComparePage();
    // 已封存的包按理不该出现在当前相机会话的实时拍摄列表里，这里仍然按
    // deleteRecord() 的卫生标准做一次防御性清理，避免任何边缘情况下的残留。
    deletedIds.forEach(function(id){ removeFromCameraSessionCaptures(id); });
  }

  var pkgDeleteCountdownTimer = null;
  var pkgPendingDeleteId = null;
  var PKG_DELETE_COUNTDOWN_SEC = 3;

  function openPackageDeleteModal(pkgId){
    var pkg = null;
    for(var i=0;i<dataPackages.length;i++){ if(dataPackages[i].id === pkgId){ pkg = dataPackages[i]; break; } }
    if(!pkg){ return; }
    var members = getPackageMembers(pkg);
    if(!members.length){ return; }
    var drift = computePackageDrift(members);
    pkgPendingDeleteId = pkgId;

    var summary = document.getElementById('pkgDeleteSummary');
    var html =
      '本次操作将永久删除，物理上无法恢复：<br>' +
      '· 时间跨度：' + fmtFullDT(members[0].t) + ' ~ ' + fmtFullDT(members[members.length-1].t) + '<br>' +
      '· 共 <b>' + members.length + '</b> 条记录<br>' +
      '· 漂移率：' + (drift.ok ? ('每天变慢 ' + drift.driftSecPerDay.toFixed(3) + '秒 · ' + starsDisplayText(drift.stars, drift.starsPrecise) + '★') : '样本不足，未计算出漂移率');
    if(drift.ok && drift.stars >= 3){
      html += '<br><br><span class="pkgdelwarn">⚠️ 该期次置信度较高(≥3★)，删除前请再次确认确实不再需要这期数据。</span>';
    }
    summary.innerHTML = html;

    document.getElementById('pkgDeleteModal').style.display = 'flex';
    var btn = document.getElementById('pkgDeleteConfirmBtn');
    var remain = PKG_DELETE_COUNTDOWN_SEC;
    btn.disabled = true;
    btn.textContent = '永久删除（' + remain + '）';
    if(pkgDeleteCountdownTimer){ clearInterval(pkgDeleteCountdownTimer); }
    pkgDeleteCountdownTimer = setInterval(function(){
      remain--;
      if(remain <= 0){
        clearInterval(pkgDeleteCountdownTimer);
        pkgDeleteCountdownTimer = null;
        btn.disabled = false;
        btn.textContent = '永久删除';
      } else {
        btn.textContent = '永久删除（' + remain + '）';
      }
    }, 1000);
  }

  function closePackageDeleteModal(){
    document.getElementById('pkgDeleteModal').style.display = 'none';
    if(pkgDeleteCountdownTimer){ clearInterval(pkgDeleteCountdownTimer); pkgDeleteCountdownTimer = null; }
    pkgPendingDeleteId = null;
  }

  function confirmPackageDelete(){
    var btn = document.getElementById('pkgDeleteConfirmBtn');
    if(btn.disabled || !pkgPendingDeleteId){ return; }
    var id = pkgPendingDeleteId;
    closePackageDeleteModal();
    deletePackageById(id);
  }

  // v4.3.0 对比页——直接读全局 dataPackages，不维护自己的副本。孤儿包(成员被单条
  // 删除清空)静默跳过，跟统计表页 renderPackageCard 的处理方式保持一致。
  function getComparablePackages(){
    return dataPackages.map(function(pkg){
      var members = getPackageMembers(pkg);
      if(!members.length){ return null; }
      return { pkg: pkg, members: members, drift: computePackageDrift(members) };
    }).filter(Boolean);
  }

  function renderComparePage(){
    var entries = getComparablePackages();
    var listEl = document.getElementById('comparePkgList');

    if(!entries.length){
      listEl.innerHTML = '<div class="logempty">尚无已封存的数据包</div>';
      drawCompareChart([]);
      return;
    }

    // 列表倒序(最新在上)，跟统计表页数据包卡片的排列习惯保持一致
    listEl.innerHTML = '';
    entries.slice().reverse().forEach(function(entry){
      var members = entry.members, drift = entry.drift, pkg = entry.pkg;
      var row = document.createElement('div');
      row.className = 'pkgcomparerow';

      var info = document.createElement('div');
      info.className = 'info';
      var lt = document.createElement('div');
      lt.className = 'lt';
      lt.textContent = shortDT(members[0].t) + ' ~ ' + shortDT(members[members.length-1].t) + ' · 共' + members.length + '条';
      var ld = document.createElement('div');
      ld.className = 'ld';
      ld.innerHTML = packageDriftSummaryHtml(drift);
      info.appendChild(lt); info.appendChild(ld);

      var delBtn = document.createElement('button');
      delBtn.className = 'pkgdelbtn';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', function(){ openPackageDeleteModal(pkg.id); });

      row.appendChild(info); row.appendChild(delBtn);
      listEl.appendChild(row);
    });

    // 走势图只用算得出漂移率的期次，按时间正序连线；样本不足的期次不参与连线，
    // 已经在上面的列表里如实标注，不需要在图上用另一套符号语言重复表达。
    var chartPoints = entries
      .filter(function(e){ return e.drift.ok; })
      .map(function(e){ return { t: e.members[e.members.length-1].t, drift: e.drift.driftSecPerDay, stars: e.drift.stars }; })
      .sort(function(a,b){ return a.t - b.t; });
    drawCompareChart(chartPoints);
  }

  function drawCompareChart(points){
    var canvas = document.getElementById('compareChart');
    var wrap = canvas.parentElement;
    var cssWidth = wrap.clientWidth - 16; // 减去 .comparechartwrap 的左右padding
    var cssHeight = 180;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if(points.length < 2){
      ctx.fillStyle = '#7c8593';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(points.length === 0 ? '暂无可绘制的期次' : '至少需要2个期次才能画走势', cssWidth/2, cssHeight/2);
      return;
    }

    var padL = 40, padR = 14, padT = 16, padB = 24;
    var plotW = cssWidth - padL - padR;
    var plotH = cssHeight - padT - padB;

    var tMin = points[0].t, tMax = points[points.length-1].t;
    var tSpan = Math.max(1, tMax - tMin);
    var driftVals = points.map(function(p){ return p.drift; });
    var vMin = Math.min.apply(null, driftVals);
    var vMax = Math.max.apply(null, driftVals);
    if(vMax === vMin){ vMax += 1; vMin -= 1; }
    var vPad = (vMax - vMin) * 0.15;
    vMax += vPad; vMin -= vPad;

    function xOf(t){ return padL + (t - tMin) / tSpan * plotW; }
    function yOf(v){ return padT + plotH - (v - vMin) / (vMax - vMin) * plotH; }

    // 网格 + Y轴刻度(取3条：min/mid/max)
    ctx.strokeStyle = '#1d2128';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#7c8593';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    [vMin + vPad, (vMin+vMax)/2, vMax - vPad].forEach(function(v){
      var y = yOf(v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(v.toFixed(2), padL - 6, y + 3);
    });

    // X轴时间刻度：首尾各一个
    ctx.textAlign = 'center';
    ctx.fillText(shortDT(tMin), xOf(tMin) + 20, cssHeight - 6);
    ctx.fillText(shortDT(tMax), xOf(tMax) - 20, cssHeight - 6);

    // 连线
    ctx.strokeStyle = '#ff8a3d';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    points.forEach(function(p, i){
      var x = xOf(p.t), y = yOf(p.drift);
      if(i === 0){ ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
    });
    ctx.stroke();

    // 数据点 + 数值标注
    points.forEach(function(p){
      var x = xOf(p.t), y = yOf(p.drift);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI*2);
      ctx.fillStyle = '#ff8a3d';
      ctx.fill();
      ctx.fillStyle = '#e9edf2';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.drift.toFixed(2), x, y - 8);
    });
  }

  function renderLog(){
    refreshSessionCollapseCache();
    var log = document.getElementById('log');
    if(!records.length){
      log.innerHTML = '<div class="logempty">尚无记录</div>';
      return;
    }
    log.innerHTML = '';

    var calRecord = null;
    for(var ci=0; ci<records.length; ci++){
      if(records[ci].isCalibration){ calRecord = records[ci]; break; }
    }
    var liveBoundary = calRecord ? calRecord.t : null;

    // 1. 活跃区间(校准点当天起)，跟以前一样倒序展示
    var latestKey = getLatestEntryKey();
    var renderedSessions = {};
    for(var i = records.length - 1; i >= 0; i--){
      var r = records[i];
      if(liveBoundary !== null && r.t < liveBoundary){ continue; }
      if(r.sessionId){
        if(renderedSessions[r.sessionId]){ continue; }
        renderedSessions[r.sessionId] = true;
        var members = records.filter(function(x){ return x.sessionId === r.sessionId; }).sort(function(a,b){ return a.t - b.t; });
        var isLatestSession = !!(latestKey && latestKey.type === 'session' && latestKey.sessionId === r.sessionId);
        log.appendChild(renderBundleCard(r.sessionId, members, false, isLatestSession));
      } else {
        var isLatestRecord = !!(latestKey && latestKey.type === 'record' && latestKey.id === r.id);
        log.appendChild(renderSingleLogRow(r, false, isLatestRecord));
      }
    }

    if(liveBoundary === null){ return; }

    // 2. 已打包的数据包，从最新到最旧
    for(var pi = dataPackages.length - 1; pi >= 0; pi--){
      log.appendChild(renderPackageCard(dataPackages[pi], pi === dataPackages.length - 1));
    }

    // 3. 还没打包的散装区间，按真实校准切换边界切好，只有最早一段能点"打包"
    var pending = findAllPendingSegments();
    pending.forEach(function(seg, idx){
      log.appendChild(renderPendingSegmentRow(seg, idx === 0));
    });
  }

  // v4.17.0：挂钟时间还没手动填好的记录，暂不参与统计(不进回归/不算收敛/不进锚点)。
  // 单条捕获：自己没填就是自己pending。连拍组："1组"要么全进要么全不进——组内哪怕
  // 只有1张没填，整组3张都算pending，不会出现"组内2张已经在拉回归线、1张还没填"这种
  // 半吊子状态混进统计表。
  function recordAwaitingClockEntry(r){
    if(r.sessionId){
      return records.some(function(x){ return x.sessionId === r.sessionId && !x.clockDisplay; });
    }
    return !r.clockDisplay;
  }

  function getActiveRecords(season){
    var sorted = records.slice().sort(function(a,b){ return a.t - b.t; });
    if(tempHeldOut){
      // 结构性兜底：无论上层是否已经处理了"设为校准点时顺手解除临时排除"这个防护，
      // 这里永远不允许把 isCalibration===true 的记录/所在会话过滤掉——校准边界的完整性
      // 优先级高于临时排除功能，避免 lastCalIdx 找不到校准点而退化成"全部历史都算活跃区间"。
      sorted = sorted.filter(function(r){
        if(r.isCalibration){ return true; }
        if(tempHeldOut.type === 'session'){
          if(r.sessionId !== tempHeldOut.sessionId){ return true; }
          // 若该会话内任一成员恰好是校准点，整组保留、不拆散——不能只护住那一条成员
          var sessionHasCal = records.some(function(x){ return x.sessionId === tempHeldOut.sessionId && x.isCalibration; });
          return sessionHasCal;
        }
        return r.id !== tempHeldOut.id;
      });
    }
    var lastCalIdx = -1;
    for(var i=0;i<sorted.length;i++){
      if(sorted[i].isCalibration){ lastCalIdx = i; }
    }
    var afterCal = lastCalIdx >= 0 ? sorted.slice(lastCalIdx) : sorted;
    afterCal = afterCal.filter(function(r){ return !recordAwaitingClockEntry(r); });
    if(!season){ return afterCal; }
    return afterCal.filter(function(r){ return (r.season || 'summer') === season; });
  }

  function computeLagSeries(active){
    var out = [];
    var prevKnown = null;
    for(var i=0;i<active.length;i++){
      var r = active[i];
      var latencyAdj = (typeof r.detectionLatencyMs === 'number') ? r.detectionLatencyMs : 0;
      var y;
      if(r.explicitDriftMs !== null && r.explicitDriftMs !== undefined){
        y = r.explicitDriftMs - latencyAdj;
      } else {
        var raw = (r.t - latencyAdj) % 60000;
        if(raw < 0){ raw += 60000; }
        if(prevKnown === null){
          y = raw;
        } else {
          var k = Math.round((prevKnown - raw) / 60000);
          if(k < 0){ k = 0; }
          y = raw + 60000*k;
        }
      }
      out.push(y);
      prevKnown = y;
    }
    return out;
  }

  var HALF_LIFE_DAYS = 35;
  // v4.10.4：不再用固定条数，改成"按实际周期长度凑够覆盖满365天以上"——
  // 固定12条在实测周期(如26.7天)下只能覆盖约320天，年末会有40+天的自动化空档。
  // COVERAGE_DAYS_MIN 是下限：只要列表跨度(首尾时间差)还没达到这个天数，就继续
  // 往后加一条，宁可多排1-2条，也不留全年裸奔期——Tuya那边是"每年某月某日"重复
  // 执行，条数多几条不构成额外负担，但少算容易在年末留出没人管的空窗期。
  var COVERAGE_DAYS_MIN = 365;
  var MAX_PREDICTION_COUNT = 40; // 防御性上限，避免异常数据(周期极短)导致死循环/列表爆炸
  var predListExpanded = { summer:false, winter:false };
  var trendExpanded = { summer:false, winter:false };

  function computeWeights(active){
    var lastT = active[active.length-1].t;
    return active.map(function(r){
      var ageDays = (lastT - r.t) / 86400000;
      return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    });
  }

  function weightedRegression(xs, ys, ws){
    var n = xs.length;
    var Sw=0, Swx=0, Swy=0, Swxx=0, Swxy=0;
    for(var i=0;i<n;i++){
      var w = ws[i];
      Sw += w; Swx += w*xs[i]; Swy += w*ys[i];
      Swxx += w*xs[i]*xs[i]; Swxy += w*xs[i]*ys[i];
    }
    var denom = (Sw*Swxx - Swx*Swx);
    var slope = denom !== 0 ? (Sw*Swxy - Swx*Swy)/denom : 0;
    var intercept = (Swy - slope*Swx)/Sw;
    var yMean = Swy/Sw;
    var ssTot=0, ssRes=0, sumW2=0;
    for(var j=0;j<n;j++){
      var pred = intercept + slope*xs[j];
      ssRes += ws[j]*Math.pow(ys[j]-pred,2);
      ssTot += ws[j]*Math.pow(ys[j]-yMean,2);
      sumW2 += ws[j]*ws[j];
    }
    var r2 = ssTot !== 0 ? 1 - ssRes/ssTot : 1;
    var effectiveN = sumW2 !== 0 ? (Sw*Sw)/sumW2 : n;
    return { slope: slope, intercept: intercept, r2: r2, effectiveN: effectiveN };
  }

  // 待议(v4.1.11 讨论后搁置，未实现)：同一天内分几次单独手动拍摄(不走连拍模式)，
  // 目前会被 effectiveN 当成好几份独立时间信息，跟真正跨天/跨周的数据同等对待，
  // 星级可能偏乐观。理想情况下应该按"时间分布稀疏度"再叠一层降权(同天<跨天<跨周<跨月)，
  // 但这会改动核心回归权重模型、历史星级重新算出来可能整体下修，影响面较大，
  // 暂不实现，先在帮助页(统计与季节模型一节)加了文字提示引导操作习惯。
  function computeConfidence(active, reg){
    var spanDays = (active[active.length-1].t - active[0].t) / 86400000;
    var countScore = Math.min(1, (reg.effectiveN - 2) / 10);
    var spanScore = Math.min(1, spanDays / 21);
    var r2Clamped = Math.max(0, Math.min(1, reg.r2));
    var combined = countScore*0.35 + spanScore*0.35 + r2Clamped*0.30;
    // v4.6.3 从0.5步进四舍五入改成0.1步进向下取整——底层combined本来就是连续分数，
    // 只是最后这一步显示取整太粗，看不出4.6/4.7/4.8这种细微差别。改floor而不是round，
    // 是延续星级"宁可低估不高估"的既有设计哲学，避免临界值被凑整抬高一档。
    var stars = Math.floor(combined*5*10) / 10;
    if(stars < 0.1){ stars = 0.1; }
    // v4.12.6：count/span两项分数在effectiveN=12、跨度21天就各自封顶=1，之后只有r²还能变，
    // 但0.9333~1.0这么大一段r²区间全部floor成同一个"4.9"，看不出到底是刚过门槛还是
    // 已经逼近满分——多留一个未取整的精确值，供UI在4.9档专门展开更多小数位显示。
    return { stars: stars, starsPrecise: combined*5 };
  }

  // v4.12.6：count/span两项分数很容易同时封顶=1，之后只剩r²这一项还能变，但floor取整
  // 会把0.9333~1.0这一大段r²全部砍成同一个"4.9"，看不出到底是刚过门槛还是逼近满分。
  // 达到4.9时改用未取整的精确值多展开几位小数，方便判断这批数据是不是已经到顶。
  function starsDisplayText(stars, starsPrecise){
    if(stars >= 4.9 && typeof starsPrecise === 'number'){
      return starsPrecise.toFixed(3);
    }
    return stars.toFixed(1);
  }

  function starHtml(stars, starsPrecise){
    // 图标渲染受限于星形字符的整字宽度裁切，实测只能稳定显示到半颗星精度，
    // 所以图标另算一个就近取整到0.5的展示值，跟旁边如实显示0.1精度的数字分开——
    // 数字才是准确值，图标只是给个大致直观感受，两者不需要完全一致(参考亚马逊评分的表现形式)。
    var iconStars = Math.round(stars*2) / 2;
    var pct = (iconStars/5)*100;
    return '<span class="starwrap"><span class="star-bg">\u2605\u2605\u2605\u2605\u2605</span>' +
      '<span class="star-fg" style="width:' + pct + '%">\u2605\u2605\u2605\u2605\u2605</span></span>' +
      ' <span style="font-size:11px;color:var(--ink-dim)">' + starsDisplayText(stars, starsPrecise) + '</span>';
  }

  function collapseSessionsForRegression(active, prelimSlope){
    var groups = {};
    var singles = [];
    active.forEach(function(r){
      if(r.sessionId){
        if(!groups[r.sessionId]){ groups[r.sessionId] = []; }
        groups[r.sessionId].push(r);
      } else {
        singles.push(r);
      }
    });

    var collapsed = singles.slice();
    Object.keys(groups).forEach(function(sid){
      var members = groups[sid].slice().sort(function(a,b){ return a.t - b.t; });
      if(members.length < 2){
        collapsed.push(members[0]);
        return;
      }
      var tSession0 = members[0].t;
      var correctedYs = [];
      members.forEach(function(m){
        var latencyAdj = (typeof m.detectionLatencyMs === 'number') ? m.detectionLatencyMs : 0;
        var rawY;
        if(m.explicitDriftMs !== null && m.explicitDriftMs !== undefined){
          rawY = m.explicitDriftMs - latencyAdj;
        } else {
          rawY = (m.t - latencyAdj) % 60000;
          if(rawY < 0){ rawY += 60000; }
        }
        var elapsedDays = (m.t - tSession0) / 86400000;
        var expectedExtra = prelimSlope > 0 ? prelimSlope * elapsedDays : 0;
        correctedYs.push(rawY - expectedExtra);
      });
      var avgY = correctedYs.reduce(function(a,b){ return a+b; }, 0) / correctedYs.length;
      var meanT = members.reduce(function(a,b){ return a+b.t; }, 0) / members.length;
      collapsed.push({
        t: meanT,
        explicitDriftMs: avgY,
        detectionLatencyMs: null,
        sessionId: sid,
        isSessionSynthetic: true,
        memberCount: members.length
      });
    });

    collapsed.sort(function(a,b){ return a.t - b.t; });
    return collapsed;
  }

  // v4.1.1 每次重算，先把这个季节所有已知会话的缓存状态重置一遍，
  // 再按实际结果覆盖——这样"排在校准点之前被切掉"的会话也能被正确标记，
  // 而不是停留在上一次计算时的旧状态。
  function resetSessionCollapseCache(season, activeSessionIds){
    records.forEach(function(r){
      if(r.sessionId && (r.season || 'summer') === season){
        if(!activeSessionIds[r.sessionId]){
          lastCollapsedBySession[r.sessionId] = { status:'excluded_before_calibration' };
        }
      }
    });
  }

  function computeStats(season){
    var active = getActiveRecords(season);
    var activeSessionIds = {};
    active.forEach(function(r){ if(r.sessionId){ activeSessionIds[r.sessionId] = true; } });
    resetSessionCollapseCache(season, activeSessionIds);

    if(active.length < 3){
      Object.keys(activeSessionIds).forEach(function(sid){
        lastCollapsedBySession[sid] = { status:'not_enough_data' };
      });
      return { ok:false, count: active.length, needed: 3 - active.length };
    }

    var t0Prelim = active[0].t;
    var xsPrelim = active.map(function(r){ return (r.t - t0Prelim) / 86400000; });
    var ysPrelim = computeLagSeries(active);
    var wsPrelim = computeWeights(active);
    var prelimReg = weightedRegression(xsPrelim, ysPrelim, wsPrelim);
    var prelimSlope = prelimReg.slope > 0 ? prelimReg.slope : 0;

    var collapsed = collapseSessionsForRegression(active, prelimSlope);
    var fellBackToRaw = collapsed.length < 3;
    if(fellBackToRaw){ collapsed = active; }

    Object.keys(activeSessionIds).forEach(function(sid){
      if(fellBackToRaw){
        lastCollapsedBySession[sid] = { status:'raw' };
        return;
      }
      var synthetic = null;
      for(var ci=0; ci<collapsed.length; ci++){
        if(collapsed[ci].isSessionSynthetic && collapsed[ci].sessionId === sid){ synthetic = collapsed[ci]; break; }
      }
      lastCollapsedBySession[sid] = synthetic
        ? { status:'anchor', meanT: synthetic.t, avgY: synthetic.explicitDriftMs, memberCount: synthetic.memberCount }
        : { status:'raw' };
    });

    var t0 = collapsed[0].t;
    var xs = collapsed.map(function(r){ return (r.t - t0) / 86400000; });
    var ys = computeLagSeries(collapsed);
    var ws = computeWeights(collapsed);
    var reg = weightedRegression(xs, ys, ws);
    if(reg.slope <= 0){
      return { ok:false, count: collapsed.length, noDrift:true };
    }
    var lastY = ys[ys.length-1];
    var cycleDays = 60000 / reg.slope;
    var target1 = (Math.floor(lastY/60000) + 1) * 60000;
    var xTarget1 = (target1 - reg.intercept) / reg.slope;
    var basePredicted = t0 + xTarget1*86400000;
    // v4.1.2 建议触发时刻改成"永远盯着未来"的滚动列表：不再固定输出模型算出的头3个理论时刻，
    // 而是从 basePredicted 起按 cycleDays 的节奏往后数，只要已经落在 Date.now() 之前就跳过，
    // 按 cycleDays 的节奏往后数，只要已经落在 Date.now() 之前就跳过，
    // 凑够覆盖满 COVERAGE_DAYS_MIN 天为止（v4.10.4，见下方动态条数逻辑）。系统时间前跳测试、
    // 或者长期没有新记录时，列表也会自动往后滚，
    // 不会停留在一个早已过去的日期上。
    var cycleMs = cycleDays * 86400000;
    var elapsedSinceBase = Date.now() - basePredicted;
    var startIdx = elapsedSinceBase > 0 ? Math.ceil(elapsedSinceBase / cycleMs) : 0;
    var predictedTimes = [];
    // v4.10.4：条数不再固定，按"首尾跨度是否已达到 COVERAGE_DAYS_MIN 天"动态决定，
    // 宁可多排一条也不留年末空档。cycleMs 异常(<=0，理论上不会发生，防御性判断)时
    // 退化成固定12条，避免除零/死循环。
    if(cycleMs > 0){
      var coverageMs = COVERAGE_DAYS_MIN * 86400000;
      var pi = 0;
      while(pi < MAX_PREDICTION_COUNT){
        predictedTimes.push(basePredicted + (startIdx + pi) * cycleMs);
        pi++;
        var spanMs = predictedTimes[predictedTimes.length-1] - predictedTimes[0];
        if(spanMs >= coverageMs){ break; }
      }
    } else {
      for(var piFallback=0; piFallback<12; piFallback++){
        predictedTimes.push(basePredicted + (startIdx + piFallback) * cycleMs);
      }
    }
    var conf = computeConfidence(collapsed, reg);
    var stars = conf.stars;
    var starsPrecise = conf.starsPrecise;
    var xNow = (Date.now() - t0) / 86400000;
    var projectedNowY = reg.intercept + reg.slope*xNow;
    // v4.1.2 progressPct 不再在这里就地取模封顶——改成保留真实累计值(可能>100%)，
    // 只在渲染层把"跑表宽度"和"第几圈决定颜色"分开算，标签上仍然显示未清零的真实百分比
    var rawProgressPct = Math.max(0, (projectedNowY / 60000) * 100);
    var progressTier = Math.floor(rawProgressPct / 100);
    var progressDisplayPct = rawProgressPct % 100;
    if(progressDisplayPct === 0 && rawProgressPct > 0){ progressDisplayPct = 100; }
    return {
      ok:true,
      count: collapsed.length,
      effectiveN: reg.effectiveN,
      baselineT: t0,
      intercept: reg.intercept,
      driftSecPerDay: reg.slope / 1000,
      r2: reg.r2,
      cycleDays: cycleDays,
      stars: stars,
      starsPrecise: starsPrecise,
      progressPct: rawProgressPct,
      progressDisplayPct: progressDisplayPct,
      progressTier: progressTier,
      projectedNowMs: projectedNowY,
      predictedTimes: predictedTimes,
      daysFromNow: (predictedTimes[0] - Date.now()) / 86400000,
      // v4.11.0：用active(未经会话捏合)的首尾真实时间戳算跨度，
      // 而不是collapsed后的t0——collapsed会把一组连拍捏合成一个点，
      // 用它算跨度会让"这批数据实际覆盖了多久"失真变小。
      spanDays: (active[active.length-1].t - active[0].t) / 86400000
    };
  }

  // v4.10.4：找到当前全局校准点的记录id——用于给每条收敛快照打上"当时是哪个
  // 校准边界"的标记，而不是在设新校准点那一刻就把历史快照整个清空。
  function getCurrentCalibrationRecordId(){
    for(var i=0;i<records.length;i++){ if(records[i].isCalibration){ return records[i].id; } }
    return null;
  }

  function trackHistory(rec){
    var s = computeStats(seasonMode);
    if(!s.ok){ return; }
    var arr = driftHistory[seasonMode];
    // v4.10.4：连拍每一张都会各自触发一次trackHistory，如果每次都push一条新快照，
    // 一组3连拍会在收敛记录里留下3条互相独立的"噪声"——它们的差异纯粹是"这组
    // 连拍捏合到第几张了"造成的(collapseSessionsForRegression对<2成员的组不做
    // 平均，2/3成员才开始平均)，不是真实漂移率在几秒内变了3次。
    // 改成用 groupKey(连拍用sessionId，单次捕获用自己的id)去重——同一个groupKey
    // 再次触发时，直接覆盖更新已有的那一条，而不是再push一条新的。这样一组连拍
    // 无论拍了几张，最终收敛记录里只会留下一条、且是用全部成员数据算出来的最终值。
    var groupKey = (rec && rec.sessionId) || (rec && rec.id) || null;
    var existing = groupKey ? arr.filter(function(h){ return h.groupKey === groupKey; })[0] : null;
    if(existing){
      existing.at = Date.now();
      existing.driftSecPerDay = s.driftSecPerDay;
      existing.stars = s.stars;
      existing.count = s.count;
      existing.calBoundaryId = getCurrentCalibrationRecordId();
    } else {
      arr.push({ at: Date.now(), driftSecPerDay: s.driftSecPerDay, stars: s.stars, count: s.count, groupKey: groupKey, calBoundaryId: getCurrentCalibrationRecordId() });
      if(arr.length > 10){ arr = arr.slice(arr.length - 10); driftHistory[seasonMode] = arr; }
    }
    saveHistory();
  }

  function shortDT(ms){
    var d = new Date(ms);
    return (d.getMonth()+1) + '/' + d.getDate() + ' ' + pad(d.getHours(),2) + ':' + pad(d.getMinutes(),2);
  }

  function relDays(ms){
    var d = (ms - Date.now()) / 86400000;
    if(d < 0){ return '已过期'; }
    if(d < 1){ return '今天内'; }
    return '还有' + Math.round(d) + '天';
  }

  function renderModelBlock(season, isCurrent){
    var label = season === 'summer' ? '☀️ 夏季模型' : '❄️ 冬季模型';
    var s = computeStats(season);
    var html = '<div class="modelblock"><div class="modelhead"><span class="modelname' + (isCurrent ? ' iscurrent' : '') + '">' + label + (isCurrent ? '(当前生效)' : '') + '</span></div>';
    if(!s.ok){
      if(s.noDrift){
        html += '<div class="statsline">暂无变慢趋势</div>';
      } else {
        html += '<div class="statsline">还需 ' + s.needed + ' 条记录(共需≥3条)，当前 ' + s.count + ' 条</div>';
      }
      html += '</div>';
      return html;
    }
    var spanLabel = s.spanDays < 1 ? '不足1天' : s.spanDays.toFixed(1) + '天';
    html += '<div class="statsline" style="margin-bottom:6px;">' + starHtml(s.stars, s.starsPrecise) + ' <span style="font-size:11px;color:var(--ink-dim);">· 参与计算' + s.count + '条 · 跨度' + spanLabel + '</span></div>';
    html += '<div class="statsline">每天变慢 ' + s.driftSecPerDay.toFixed(3) + ' 秒 · 拟合优度 ' + (s.r2*100).toFixed(2) + '% · 周期约 ' + s.cycleDays.toFixed(1) + ' 天</div>';

    var tierClass = s.progressTier <= 0 ? '' : (s.progressTier === 1 ? ' over1' : ' over2');
    // v4.10.4 未维护提醒：本周期累计漂移(projectedNowMs)超过设置里的分钟阈值，
    // 说明这一期已经持续很久没有新校准点介入，大概率是忘了回来维护。
    // 只对"当前生效模型"这一块判断——另一个季节模型本来就长期不采集数据，
    // 不是"忘了维护"，如果两块都判断会常年误报非当前季节那块。
    // 严重程度按超过阈值的倍数分三档递增，跟progressTier(按圈数分档、200%以上
    // 永远同一个红)是两条独立的轴——这里是"多久没人管"，那边是"漂移了几圈"，
    // 意义不同，不合并成一套颜色，各自按自己的节奏继续升级。
    var staleMs = staleThresholdMin * 60000;
    var staleRatio = isCurrent ? (s.projectedNowMs / staleMs) : 0;
    var staleLevel = staleRatio >= 4 ? 3 : (staleRatio >= 2 ? 2 : (staleRatio >= 1 ? 1 : 0));
    var isStale = staleLevel > 0;
    var durationText = formatDriftDuration(s.projectedNowMs);
    var progressLabelHtml = '本周期已漂移进度 ' + Math.round(s.progressPct) + '%（累计漂移 ' + durationText + '）';
    html += '<div class="progresswrap"><div class="progresslabel' + (isStale ? ' stalewarn' : '') + '">' + progressLabelHtml + '</div>';
    html += '<div class="progressbar"><div class="progressfill' + tierClass + '" style="width:' + s.progressDisplayPct.toFixed(1) + '%"></div></div>';
    if(staleLevel === 1){
      html += '<div class="statsline stalewarn" style="margin-top:4px;">⚠ 已超过' + staleThresholdMin + '分钟未维护，请回来查看/校准</div>';
    } else if(staleLevel === 2){
      html += '<div class="statsline stalewarn-lvl2" style="margin-top:4px;">⚠⚠ 已严重超期（超阈值' + staleRatio.toFixed(1) + '倍），建议尽快校准</div>';
    } else if(staleLevel === 3){
      html += '<div class="statsline stalewarn-lvl3" style="margin-top:4px;">🛑 已长期失联（超阈值' + staleRatio.toFixed(1) + '倍），数据可能已严重偏离实际，请尽快校准</div>';
    }
    html += '</div>';

    // v4.1.2 预测列表：已装继电器时显示"扣除执行延迟后的实际触发时刻"，
    // 观察模式下继电器不会真的动作，扣延迟没有意义，改显示未扣延迟的理论完成时刻，
    // 单纯作为"这时候已经该攒够多少偏差了"的参考。列表本身已经是永远面向未来的滚动结果，
    // 默认只展开前3个，其余9个可以点开一次性看完整年份，方便照着抄进Tuya自动化。
    var delayMs = delaySec * 1000;
    var predTimes = s.predictedTimes.map(function(t){ return relayInstalled ? (t - delayMs) : t; });
    var expanded = !!predListExpanded[season];
    var visibleCount = expanded ? predTimes.length : Math.min(3, predTimes.length);
    // v4.10.4：动态条数上来后，原本硬编码到⑫的数组在第13条起就退化成"13."样式，
    // 跟前面①②③风格不统一——扩到⑳(Unicode标准圆圈数字最多到20，够覆盖
    // 实际会出现的13~15条左右)，超过20的极端情况(MAX_PREDICTION_COUNT=40防御上限
    // 触发时)才回退到"N."样式，这种情况理论上不会在正常数据下发生。
    var circled = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'];
    html += '<div class="predlist">';
    html += '<div style="font-size:10px;color:var(--ink-dim);margin-bottom:2px;">' +
      (relayInstalled
        ? ('继电器建议触发时刻(已扣除执行延迟' + delaySec + '秒)')
        : ('参考时刻(观察模式·继电器未安装，不会自动触发，未扣执行延迟)')) +
      '</div>';
    var predLines = [];
    for(var pl=0; pl<visibleCount; pl++){
      var mark = circled[pl] || (pl+1) + '.';
      predLines.push(mark + ' ' + shortDT(predTimes[pl]) + ' <span class="predrel">(' + relDays(predTimes[pl]) + ')</span>');
    }
    html += predLines.join('<br>');
    if(predTimes.length > 3){
      html += '<br><button class="predExpandBtn" id="predExpandBtn-' + season + '">' +
        (expanded ? '收起' : ('展开全部' + predTimes.length + '个(全年Tuya模板参考)')) + '</button>';
    }
    html += '</div>';

    var hist = driftHistory[season];
    // v4.11.1：hist.length===1(常见于刚清空收敛趋势记录后的第一次新测量)时，
    // 原来整个区块完全不显示，跟"清空后没生效"看起来一模一样，容易引起误会。
    // 补一条提示，呼应上面主模型区块"还需N条记录"的提示风格。
    if(hist && hist.length === 1){
      html += '<div class="trendline" style="color:var(--ink-dim);">收敛趋势：已记录1次，再打1次才会开始显示趋势</div>';
    } else if(hist && hist.length >= 2){
      // v4.9.5：默认只显示最近4次(原有行为)，超过4条时给一个展开按钮看完整最多10条，
      // 复用跟Tuya预测列表完全相同的折叠/展开交互模式(同款按钮样式、同款状态管理方式)。
      var trendIsExpanded = !!trendExpanded[season];
      var recent = trendIsExpanded ? hist.slice(-10) : hist.slice(-4);
      // v4.17.5：改成最新的排最前面，不用展开也能第一眼看到最新那次——
      // hist本身还是按写入顺序(旧→新)存的，只在这里显示前把要渲染的这一段倒过来。
      var recentDesc = recent.slice().reverse();
      // v4.10.4：不再靠清空数据来区分"校准点切换前后"，改成按每条快照自带的
      // calBoundaryId分组渲染，组间插入一道分割线(⋯校准点切换⋯)，两侧数据都
      // 完整保留、都能看到，只是视觉上标出"这里发生过一次校准点变更"，不代表
      // 数据被抹掉。旧数据(没有calBoundaryId字段，v4.10.4之前写入的)按undefined
      // 处理，只要连续几条的calBoundaryId相同就不插分割线，缺字段时天然归成一组。
      var segments = [];
      recentDesc.forEach(function(h){
        var last = segments.length ? segments[segments.length-1] : null;
        if(last && last.boundaryId === h.calBoundaryId){
          last.items.push(h);
        } else {
          segments.push({ boundaryId: h.calBoundaryId, items: [h] });
        }
      });
      // 组内也是新→旧，箭头方向跟着换成"←"，避免"→"暗示时间正向前进造成误读
      var trendHtml = segments.map(function(seg){
        return seg.items.map(function(h){ return h.driftSecPerDay.toFixed(3); }).join(' \u2190 ');
      }).join(' <span class="trendsep">⋯校准点切换⋯</span> ');
      html += '<div class="trendline">收敛趋势(近' + recent.length + '次测量，最新→最旧): ' + trendHtml + ' 秒/天</div>';
      if(hist.length > 4){
        html += '<button class="predExpandBtn" id="trendExpandBtn-' + season + '">' +
          (trendIsExpanded ? '收起' : ('展开全部' + hist.length + '次(最多10次)')) + '</button>';
      }
    }
    html += '</div>';
    return html;
  }

  function renderSummaryLine(){
    var el = document.getElementById('summaryLine');
    if(!el){ return; }
    var s = computeStats(seasonMode);
    var seasonIcon = seasonMode === 'winter' ? '\u2744\ufe0f冬' : '\u2600\ufe0f夏';
    if(!s.ok){
      el.textContent = seasonIcon + ' · 还需更多记录才能预测(设置里补录/查看)';
      return;
    }
    var pd = new Date(relayInstalled ? (s.predictedTimes[0] - delaySec*1000) : s.predictedTimes[0]);
    el.textContent = seasonIcon + ' · ' + starsDisplayText(s.stars, s.starsPrecise) + '\u2605 · 下次校正约 ' +
      (pd.getMonth()+1) + '/' + pd.getDate() + ' ' + pad(pd.getHours(),2) + ':' + pad(pd.getMinutes(),2);
  }

  function togglePredList(season){
    predListExpanded[season] = !predListExpanded[season];
    renderStats();
  }

  function toggleTrendExpanded(season){
    trendExpanded[season] = !trendExpanded[season];
    renderStats();
  }

  // v4.19.2：统计页顶部"距上次抓拍多久"——进统计页一眼看出多久没记录。
  // 格式规则：<1分钟→不到1分钟；<1小时→x分钟；<1天→x小时y分钟；<1个月→x天y小时；
  // ≥1个月→x个月y天(不再显示小时)；≥1年→x年y个月(不再显示天)。月份按日历月算，不是固定30天。
  function addMonthsClamped(d, n){
    var y = d.getFullYear(), m = d.getMonth() + n;
    var lastDay = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(d.getDate(), lastDay), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  }

  function formatElapsedSince(t, now){
    var MIN = 60000, HOUR = 3600000, DAY = 86400000;
    var ms = now - t;
    if(ms < MIN){ return '不到1分钟'; }
    var a = new Date(t), b = new Date(now);
    var months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    while(months > 0 && addMonthsClamped(a, months).getTime() > now){ months--; }
    if(months >= 12){
      var yrs = Math.floor(months / 12), restM = months % 12;
      return yrs + '年' + (restM ? (restM + '个月') : '');
    }
    if(months >= 1){
      var restD = Math.floor((now - addMonthsClamped(a, months).getTime()) / DAY);
      return months + '个月' + (restD ? (restD + '天') : '');
    }
    var days = Math.floor(ms / DAY);
    if(days >= 1){
      var hrs = Math.floor((ms % DAY) / HOUR);
      return days + '天' + (hrs ? (hrs + '小时') : '');
    }
    var h = Math.floor(ms / HOUR);
    var mi = Math.floor((ms % HOUR) / MIN);
    if(h >= 1){ return h + '小时' + (mi ? (mi + '分钟') : ''); }
    return mi + '分钟';
  }

  function renderSinceLastLine(){
    var el = document.getElementById('sinceLastLine');
    if(!el){ return; }
    if(!records.length){ el.textContent = '⏱ 还没有抓拍记录'; return; }
    var lastT = records.reduce(function(mx, r){ return r.t > mx ? r.t : mx; }, records[0].t);
    el.innerHTML = '⏱ 距上次抓拍 <b>' + formatElapsedSince(lastT, nowCorrected()) + '</b>';
  }

  function renderStats(){
    renderSinceLastLine();
    var el = document.getElementById('statsPanel');
    var html = renderModelBlock(seasonMode, true);
    var otherSeason = seasonMode === 'summer' ? 'winter' : 'summer';
    html += renderModelBlock(otherSeason, false);
    el.innerHTML = html;
    renderSummaryLine();
    ['summer','winter'].forEach(function(ssn){
      var btn = document.getElementById('predExpandBtn-' + ssn);
      if(btn){ btn.addEventListener('click', function(){ togglePredList(ssn); }); }
      var trendBtn = document.getElementById('trendExpandBtn-' + ssn);
      if(trendBtn){ trendBtn.addEventListener('click', function(){ toggleTrendExpanded(ssn); }); }
    });
  }

  // v4.1.15: 导出方式统一改成Web Share API——iOS上会弹出系统原生的底部半屏"分享"菜单，
  // 菜单里直接有"存储到文件"选项，不再需要"先跳转到文件预览页，再点右上角箭头按钮"这一步。
  // 参考PlantSteward后期加入的同款处理。不支持的环境(navigator.share/canShare缺失，
  // 或者File构造/canShare判断为false)一律退回原来的<a download>方案兜底，行为不变。
  function shareOrDownloadBlob(blob, filename, mimeType){
    var file = null;
    try{ file = new File([blob], filename, { type: mimeType }); }catch(e){ file = null; }
    if(file && navigator.canShare && navigator.canShare({ files: [file] })){
      navigator.share({ files: [file] }).catch(function(err){
        // AbortError＝用户自己点了取消，是正常操作，不当失败处理，不再退回下载兜底，
        // 避免"取消分享"却又弹出一次下载的诡异体验；其他原因(权限/异常)才退回兜底
        if(err && err.name === 'AbortError'){ return; }
        legacyDownloadBlob(blob, filename);
      });
      return;
    }
    legacyDownloadBlob(blob, filename);
  }

  function legacyDownloadBlob(blob, filename){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
  }

  function exportData(){
    if(!records.length){ return; }
    var lines = ['id,timestamp_ms,display,delta_ms,sync_source,season,clock_display,explicit_drift_ms,detection_latency_ms,session_id,is_calibration,note'];
    records.forEach(function(r){
      var note = (r.note||'').replace(/,/g,'，').replace(/\n/g,' ');
      lines.push([
        r.id, r.t, r.display, r.deltaMs===null?'':r.deltaMs, r.syncSource, r.season||'',
        r.clockDisplay||'', (r.explicitDriftMs===null||r.explicitDriftMs===undefined)?'':r.explicitDriftMs,
        (typeof r.detectionLatencyMs === 'number')?r.detectionLatencyMs:'',
        r.sessionId||'',
        r.isCalibration?1:0, note
      ].join(','));
    });
    var csv = lines.join('\n');
    var blob = new Blob([csv], {type:'text/csv'});
    shareOrDownloadBlob(blob, 'clock-calibration-' + Date.now() + '.csv', 'text/csv');
  }

  // v4.13.0：AI分析导出——把"多期数据包的汇总参数+当前活跃统计表(含星级)"一次性
  // 打包，供丢给AI做趋势分析/论证年度算法用。汇总参数用现有的computePackageDrift/
  // computeStats重新算(数据包本身只存recordIds，不存算好的结果，这里跟界面显示
  // 用的是同一套计算逻辑，保证给AI看的数字和你自己在app里看到的完全一致)。
  function buildAnalysisReport(){
    var seasons = ['summer', 'winter'];
    var activeSeasonStats = {};
    seasons.forEach(function(season){
      var s = computeStats(season);
      var activeMembers = getActiveRecords(season).map(function(r){
        return {
          id: r.id, t: r.t, season: r.season || null,
          explicitDriftMs: (r.explicitDriftMs===null||r.explicitDriftMs===undefined) ? null : r.explicitDriftMs,
          detectionLatencyMs: (typeof r.detectionLatencyMs === 'number') ? r.detectionLatencyMs : null,
          sessionId: r.sessionId || null, isCalibration: !!r.isCalibration
        };
      });
      if(s.ok){
        activeSeasonStats[season] = {
          ok: true, count: s.count, effectiveN: s.effectiveN, spanDays: s.spanDays,
          driftSecPerDay: s.driftSecPerDay, r2: s.r2, stars: s.stars, starsPrecise: s.starsPrecise,
          cycleDays: s.cycleDays, baselineTime: s.baselineT, rawRecords: activeMembers
        };
      } else {
        activeSeasonStats[season] = {
          ok:false, count: s.count||0,
          reason: s.noDrift ? '未测得正向漂移' : '样本不足(需至少3条同季节记录)',
          rawRecords: activeMembers
        };
      }
    });

    var sealedPackages = dataPackages.map(function(pkg){
      var members = getPackageMembers(pkg);
      var drift = computePackageDrift(members);
      var seasonsInPkg = {};
      members.forEach(function(r){ seasonsInPkg[r.season || 'summer'] = true; });
      return {
        id: pkg.id,
        packagedAt: pkg.packagedAt,
        startTime: members.length ? members[0].t : null,
        endTime: members.length ? members[members.length-1].t : null,
        spanDays: members.length>1 ? (members[members.length-1].t - members[0].t)/86400000 : 0,
        seasons: Object.keys(seasonsInPkg),
        memberCount: members.length,
        drift: drift.ok
          ? { ok:true, driftSecPerDay: drift.driftSecPerDay, r2: drift.r2, stars: drift.stars, starsPrecise: drift.starsPrecise }
          : { ok:false, reason: drift.noDrift ? '未测得正向漂移' : '样本不足(不足3条)' },
        rawRecords: members.map(function(r){
          return {
            id: r.id, t: r.t, season: r.season || null,
            explicitDriftMs: (r.explicitDriftMs===null||r.explicitDriftMs===undefined) ? null : r.explicitDriftMs,
            detectionLatencyMs: (typeof r.detectionLatencyMs === 'number') ? r.detectionLatencyMs : null,
            sessionId: r.sessionId || null, isCalibration: !!r.isCalibration
          };
        })
      };
    });

    return {
      generatedAt: Date.now(),
      activeSeasonMode: seasonMode,
      executionDelaySec: delaySec,
      relayInstalled: relayInstalled,
      activeSeasonStats: activeSeasonStats,
      sealedPackages: sealedPackages,
      calibrationSwitchLog: calibrationSwitchLog
    };
  }

  function exportAnalysisMarkdown(){
    var report = buildAnalysisReport();
    var lines = [];
    lines.push('# 校准计时器 · AI分析数据导出');
    lines.push('');
    lines.push('生成时间：' + new Date(report.generatedAt).toLocaleString('zh-CN'));
    lines.push('当前使用季节模型：' + (report.activeSeasonMode === 'summer' ? '夏季' : '冬季'));
    lines.push('继电器执行延迟补偿：' + report.executionDelaySec + '秒，继电器已安装：' + (report.relayInstalled ? '是' : '否'));
    lines.push('');
    lines.push('## 当前活跃统计段(尚未封包)');
    ['summer','winter'].forEach(function(season){
      var s = report.activeSeasonStats[season];
      lines.push('');
      lines.push('### ' + (season === 'summer' ? '夏季' : '冬季') + '模型');
      if(!s.ok){
        lines.push('- 状态：' + s.reason + '(现有' + s.count + '条)');
      } else {
        lines.push('- 参与计算：' + s.count + '条(有效样本' + s.effectiveN.toFixed(2) + ') · 跨度' + s.spanDays.toFixed(1) + '天');
        lines.push('- 漂移速率：每天变慢' + s.driftSecPerDay.toFixed(3) + '秒 · 拟合优度r²=' + (s.r2*100).toFixed(2) + '%');
        lines.push('- **置信星级：' + s.stars.toFixed(1) + '★(精确值' + s.starsPrecise.toFixed(3) + ')**');
        lines.push('- 周期约' + s.cycleDays.toFixed(1) + '天 · 起算时间' + new Date(s.baselineTime).toLocaleString('zh-CN'));
      }
      lines.push('- 该段原始记录' + s.rawRecords.length + '条(逐条明细见文末JSON区)');
    });
    lines.push('');
    lines.push('## 历史已封存数据包(共' + report.sealedPackages.length + '个，按时间顺序)');
    report.sealedPackages.forEach(function(pkg, idx){
      lines.push('');
      lines.push('### 数据包 #' + (idx+1) + '(' + pkg.id + ')');
      lines.push('- 时间范围：' + (pkg.startTime ? new Date(pkg.startTime).toLocaleString('zh-CN') : '--') +
        ' ~ ' + (pkg.endTime ? new Date(pkg.endTime).toLocaleString('zh-CN') : '--') +
        ' · 跨度' + pkg.spanDays.toFixed(1) + '天 · 涉及季节：' + pkg.seasons.join('/'));
      lines.push('- 成员条数：' + pkg.memberCount + ' · 封包时间：' + new Date(pkg.packagedAt).toLocaleString('zh-CN'));
      if(pkg.drift.ok){
        lines.push('- 漂移速率：每天变慢' + pkg.drift.driftSecPerDay.toFixed(3) + '秒 · 拟合优度r²=' + (pkg.drift.r2*100).toFixed(2) + '%');
        lines.push('- **置信星级：' + pkg.drift.stars.toFixed(1) + '★(精确值' + pkg.drift.starsPrecise.toFixed(3) + ')**');
      } else {
        lines.push('- 漂移速率：' + pkg.drift.reason);
      }
    });
    lines.push('');
    lines.push('## 校准切换日志(共' + report.calibrationSwitchLog.length + '条)');
    report.calibrationSwitchLog.forEach(function(log){
      lines.push('- ' + new Date(log.t || log.at || 0).toLocaleString('zh-CN') + '：' + JSON.stringify(log));
    });
    lines.push('');
    lines.push('## 完整结构化数据(逐条原始记录，供需要时深挖细节)');
    lines.push('```json');
    lines.push(JSON.stringify(report, null, 2));
    lines.push('```');
    var md = lines.join('\n');
    var blob = new Blob([md], {type:'text/markdown'});
    shareOrDownloadBlob(blob, 'clock-analysis-' + Date.now() + '.md', 'text/markdown');
  }

  function exportFullBackup(){
    // v4.1.13: backupVersion 2 —— 补上 v1 遗漏的 dataPackages(已封存数据包)和
    // calibrationSwitchLog(校准切换日志)，否则在Safari标签页/PWA之间搬迁数据时，
    // 已经打包的期次会在新环境里变回散装记录，包边界信息永久丢失。
    var payload = {
      backupVersion: 2,
      exportedAt: Date.now(),
      recordCount: records.length,
      records: records,
      dataPackages: dataPackages,
      calibrationSwitchLog: calibrationSwitchLog
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
    shareOrDownloadBlob(blob, 'clock-full-backup-' + Date.now() + '.json', 'application/json');
  }

  function importFullBackup(file){
    if(!file){ return; }
    var reader = new FileReader();
    reader.onload = function(e){
      var data;
      try{
        data = JSON.parse(e.target.result);
      }catch(err){
        alert('导入失败：不是有效的JSON文件');
        return;
      }
      if(!data || !Array.isArray(data.records)){
        alert('导入失败：文件里找不到records数组，请确认选的是"导出完整备份"生成的文件');
        return;
      }
      var existingIds = {};
      records.forEach(function(r){ existingIds[r.id] = true; });
      var added = 0, skipped = 0;
      data.records.forEach(function(r){
        if(r && r.id && typeof r.t === 'number' && !existingIds[r.id]){
          records.push(r);
          existingIds[r.id] = true;
          added++;
        } else {
          skipped++;
        }
      });
      records.sort(function(a,b){ return a.t - b.t; });
      saveRecords();

      // v4.1.13: v1备份没有这两个字段，Array.isArray检查天然兼容旧文件，跳过即可，
      // 不当成错误处理。数据包按id去重合并，切换日志没有独立id，用recordId+t组合去重。
      var pkgAdded = 0, pkgSkipped = 0;
      if(Array.isArray(data.dataPackages)){
        var existingPkgIds = {};
        dataPackages.forEach(function(p){ existingPkgIds[p.id] = true; });
        data.dataPackages.forEach(function(p){
          if(p && p.id && Array.isArray(p.recordIds) && !existingPkgIds[p.id]){
            dataPackages.push(p);
            existingPkgIds[p.id] = true;
            pkgAdded++;
          } else {
            pkgSkipped++;
          }
        });
        savePackages();
      }

      var logAdded = 0;
      if(Array.isArray(data.calibrationSwitchLog)){
        var existingLogKeys = {};
        calibrationSwitchLog.forEach(function(l){ existingLogKeys[l.recordId + '_' + l.t] = true; });
        data.calibrationSwitchLog.forEach(function(l){
          if(l && l.recordId && typeof l.t === 'number'){
            var key = l.recordId + '_' + l.t;
            if(!existingLogKeys[key]){
              calibrationSwitchLog.push(l);
              existingLogKeys[key] = true;
              logAdded++;
            }
          }
        });
        saveCalSwitchLog();
      }

      renderLog();
      renderStats();
      var msg = '导入完成：新增 ' + added + ' 条记录，跳过 ' + skipped + ' 条重复/无效记录。';
      if(Array.isArray(data.dataPackages)){
        msg += ' 数据包新增 ' + pkgAdded + ' 期，跳过 ' + pkgSkipped + ' 期重复。';
      }
      if(Array.isArray(data.calibrationSwitchLog)){
        msg += ' 校准切换日志新增 ' + logAdded + ' 条。';
      }
      msg += ' 设置(季节/延迟补偿/收敛趋势等)不受导入影响。';
      alert(msg);
    };
    reader.readAsText(file);
  }

  function clearDriftHistory(){
    var total = (driftHistory.summer ? driftHistory.summer.length : 0) + (driftHistory.winter ? driftHistory.winter.length : 0);
    if(total === 0){ alert('收敛趋势记录本来就是空的'); return; }
    if(confirm('确定清空收敛趋势记录吗？(共' + total + '条快照，含误触发留下的异常数据)。不影响漂移统计本身和历史记录，只清空这个辅助展示用的小日志，之后会从当前状态重新开始累积。')){
      driftHistory = { summer: [], winter: [] };
      saveHistory();
      renderStats();
      alert('已清空');
    }
  }

  // v4.1.13: 终极清空强提示强化。原来clearLog()自己弹native confirm()，只提示条数，
  // 也只清records一项——但dataPackages/calibrationSwitchLog不会跟着清，留下指向不存在
  // 记录的孤儿包(renderPackageCard里静默跳过不渲染，不会崩，但localStorage里一直占着)。
  // 现在拆成两层：clearLog()改成真正执行清空的函数(三者一起清)，前面套一层自定义弹窗
  // openClearAllModal()，列出完整影响范围+一键备份入口，确认键还做3秒延迟启用防手滑。
  function clearLog(){
    records = [];
    dataPackages = [];
    calibrationSwitchLog = [];
    // v4.10.4：清空全部数据是比设新校准点更彻底的"完全重来"，理应连收敛趋势
    // 一起清掉——不这么做的话，旧模型遗留的收敛快照会跟清空后第一次新拍的数字
    // 拼在同一条趋势线里，看起来像一次没来由的突兀跳变，其实只是两个完全不
    // 相干的模型被硬凑在一起显示。这里跟校准点重置不一样：校准点重置保留旧数据
    // 用分割线区分(因为旧数据仍有参考价值)，但"清空全部"本身就是要不留痕迹，
    // 两者语义不同，不该套用同一套处理方式。
    driftHistory = { summer: [], winter: [] };
    saveRecords();
    savePackages();
    saveCalSwitchLog();
    saveHistory();
    renderLog();
    renderStats();
  }

  function fmtFullDT(ms){
    var d = new Date(ms);
    return d.getFullYear() + '/' + pad(d.getMonth()+1,2) + '/' + pad(d.getDate(),2) + ' ' + pad(d.getHours(),2) + ':' + pad(d.getMinutes(),2);
  }

  var CLEAR_ALL_COUNTDOWN_SEC = 3;
  var clearAllCountdownTimer = null;

  function openClearAllModal(){
    if(!records.length){ return; }
    var sorted = records.slice().sort(function(a,b){ return a.t - b.t; });
    var span = fmtFullDT(sorted[0].t) + ' ~ ' + fmtFullDT(sorted[sorted.length-1].t);
    var hasCalib = records.some(function(r){ return r.isCalibration; });
    var summary = document.getElementById('clearAllSummary');
    summary.innerHTML =
      '本次操作将永久删除，物理上无法恢复：<br>' +
      '· 全部原始记录 <b>' + records.length + '</b> 条<br>' +
      '· 时间跨度：' + span + '<br>' +
      '· 已封存数据包 <b>' + dataPackages.length + '</b> 期<br>' +
      '· 当前校准点：' + (hasCalib ? '<b>有</b>，将一并清除' : '无') + '<br><br>' +
      '强烈建议先导出完整备份，再确认清空。';
    document.getElementById('clearAllModal').style.display = 'flex';
    var btn = document.getElementById('clearAllConfirmBtn');
    var remain = CLEAR_ALL_COUNTDOWN_SEC;
    btn.disabled = true;
    btn.textContent = '永久清空（' + remain + '）';
    if(clearAllCountdownTimer){ clearInterval(clearAllCountdownTimer); }
    clearAllCountdownTimer = setInterval(function(){
      remain--;
      if(remain <= 0){
        clearInterval(clearAllCountdownTimer);
        clearAllCountdownTimer = null;
        btn.disabled = false;
        btn.textContent = '永久清空';
      } else {
        btn.textContent = '永久清空（' + remain + '）';
      }
    }, 1000);
  }

  function closeClearAllModal(){
    document.getElementById('clearAllModal').style.display = 'none';
    if(clearAllCountdownTimer){ clearInterval(clearAllCountdownTimer); clearAllCountdownTimer = null; }
  }

  function confirmClearAll(){
    var btn = document.getElementById('clearAllConfirmBtn');
    if(btn.disabled){ return; }
    clearLog();
    closeClearAllModal();
  }

