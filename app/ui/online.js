/* ===================== 在线影视：搜索 → 选源 → 内置 mpv 播放 ===================== */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var SEC = $('online');
  if (!SEC) return;

  var st = {
    kw: '', items: [], item: null, detail: null, srcIdx: 0, epIdx: 0,
    srcList: null, srcId: '',
    groups: [], playing: null, probe: [], timer: null, hwnd: 0, stageRect: '', busy: false,
    minP: 1.4e6, playingUrl: '', dur: 0, fs: false, fsAt: 0,
  };
  /* 画质下限按「像素量」分档：1920×1080≈2.1M 才算 1080P 档，1080×608≈0.66M 只算 720P 档 */
  try { var mp = parseInt(localStorage.getItem('qs4_olMinP'), 10); if (!isNaN(mp)) st.minP = mp; } catch (e) { }
  function qlabel(res) {
    if (!res || !res[0]) return '';
    var p = res[0] * (res[1] || 0);
    if (p >= 6e6) return '4K';
    if (p >= 3.2e6) return '2K';
    if (p >= 1.4e6) return '1080P';
    if (p >= 5e5) return '720P';
    return '低清';
  }
  function qtext(res) { return res && res[0] ? (res[0] + '×' + (res[1] || 0)) : ''; }
  function floorName(p) { return p >= 6e6 ? '4K 档' : (p >= 1.4e6 ? '1080P 档' : (p >= 5e5 ? '720P 档' : '不限')); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cover(u) { return u ? '/api/cover?u=' + encodeURIComponent(u) : ''; }
  function fmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    var mm = (h ? (m < 10 ? '0' : '') + m : m) + ':' + (s < 10 ? '0' : '') + s;
    return (h ? h + ':' : '') + mm;
  }
  function jget(u) { return fetch(u).then(function (r) { return r.json(); }); }
  function jpost(u, b) {
    return fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
      .then(function (r) { return r.json(); });
  }

  /* ---------- 桌面外壳桥：把播放区域交给 mpv 渲染（浏览器打开时自动退化为独立播放窗口） ---------- */
  var shell = !!(window.chrome && window.chrome.webview);
  function shellPost(m) { if (shell) { try { window.chrome.webview.postMessage(m); } catch (e) { } } }
  if (shell) {
    window.chrome.webview.addEventListener('message', function (e) {
      var m = e && e.data;
      if (m && typeof m === 'object' && m.t === 'hwnd') { st.hwnd = m.v | 0; }
    });
  }
  /* 桌面壳：画面要画在窗口内的一块原生子窗口上，先把它的句柄拿回来再起播 */
  function ensureHwnd(cb) {
    if (!shell || st.hwnd) { cb(); return; }
    syncStage();
    var tries = 0;
    (function wait() {
      if (st.hwnd || tries++ > 12) { cb(); return; }
      setTimeout(wait, 40);
    })();
  }

  function syncStage() {
    var el = $('olStage');
    if (!el || SEC.hidden || $('olPlay').hidden) { shellPost('videohide'); st.stageRect = ''; return; }
    var r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;
    var key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',');
    if (key === st.stageRect) return;
    st.stageRect = key;
    shellPost('video:' + key + ',' + (window.devicePixelRatio || 1));
  }

  /* 滚动 / 布局变化时立刻跟一格（每帧最多一次），画面才不会跟页面脱节 */
  var rafId = 0;
  function syncSoon() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () { rafId = 0; syncStage(); });
  }

  /* ---------- 全屏播放 ----------
     画面是播放器自己画在窗口里的原生子窗口，HTML 盖不上去，所以全屏 = 把外围 UI 全收起来，
     只留上面标题带（40px）+ 下面控制带（56px），中间整块给画面；窗口本身最大化铺满屏幕。 */
  function setFs(on) {
    on = !!on;
    st.fs = on;
    st.fsAt = Date.now();
    document.body.classList.toggle('olfs', on);
    /* 全屏时锁掉页面滚动条，不然画面右边会空出一条 14px 的黑边 */
    try { document.documentElement.style.overflow = on ? 'hidden' : ''; } catch (e) { }
    var fb = $('olFs');
    if (fb) fb.textContent = on ? '退出全屏' : '全屏';
    st.stageRect = '';
    syncStage();
    setTimeout(syncStage, 60);
    if (shell) shellPost('videofull:' + (on ? 1 : 0));
    jpost('/api/player/ctl', { cmd: 'fullscreen', value: on });
  }

  /* ---------- 搜索 ---------- */
  function search(kw, wait) {
    kw = (kw || '').trim();
    if (!kw) return;
    st.kw = kw;
    $('olDetail').hidden = true;
    $('olGrid').hidden = false;
    var who = st.srcId ? ('来源「' + (findSrc(st.srcId) || st.srcId) + '」') : '全部采集源';
    $('olGrid').innerHTML = '<div class="olempty">正在向 ' + who + ' 并发搜索…（先到先显示，慢的会自动补上）</div>';
    $('olMeta').textContent = '搜索中…';
    jget('/api/online/search?kw=' + encodeURIComponent(kw) + (st.srcId ? '&sources=' + st.srcId : '') + (wait ? '&wait=1' : '')).then(function (r) {
      if (r.code !== 0) { $('olGrid').innerHTML = '<div class="olempty">搜索失败：' + esc(r.error) + '</div>'; return; }
      st.items = r.items || [];
      renderGrid(r);
      if (r.partial) setTimeout(function () { if (st.kw === kw) search(kw, true); }, 2200);
    }).catch(function (e) {
      $('olGrid').innerHTML = '<div class="olempty">搜索出错：' + esc(e.message) + '</div>';
    });
  }

  /* ---------- 来源芯片：默认「全部」聚合；点某个源就只查那一个源 ---------- */
  function loadSources() {
    if (st.srcList) { renderSrcBar(); return; }
    jget('/api/online/list').then(function (r) {
      st.srcList = (r && r.sources) || [];
      renderSrcBar();
    }).catch(function () { st.srcList = []; renderSrcBar(); });
  }

  function findSrc(id) {
    var l = st.srcList || [];
    for (var i = 0; i < l.length; i++) { if (l[i].id === id) return l[i].name; }
    return '';
  }

  function renderSrcBar() {
    var box = $('olSrcBar');
    if (!box) return;
    if (!st.srcList) { box.innerHTML = '<span class="lb">来源</span><span class="osrcb">读取中…</span>'; return; }
    var h = '<span class="lb">来源</span><button class="osrcb' + (st.srcId ? '' : ' on') + '" data-olsrc="">全部<i> ·聚合</i></button>';
    h += st.srcList.map(function (s) {
      return '<button class="osrcb' + (st.srcId === s.id ? ' on' : '') + '" data-olsrc="' + s.id + '">' + esc(s.name) + '</button>';
    }).join('');
    box.innerHTML = h;
  }

  function renderGrid(r) {
    var g = $('olGrid');
    if (!st.items.length) { g.innerHTML = '<div class="olempty">没有搜到可播放的资源，换个片名试试</div>'; return; }
    g.innerHTML = st.items.map(function (it, i) {
      var c = cover(it.pic);
      return '<div class="ocard" role="button" tabindex="0" data-i="' + i + '">' +
        '<div class="oimg">' + (c ? '<img loading="lazy" alt="" src="' + c + '">' : '<span class="onoimg">无海报</span>') +
        (it.ep > 1 ? '<span class="oep">' + it.ep + ' 集</span>' : '') + '</div>' +
        '<div class="oname">' + esc(it.title) + '</div>' +
        '<div class="osub">' + esc([it.year, it.remarks].filter(Boolean).join(' · ')).slice(0, 34) + '</div>' +
        '<div class="osrc">' + it.sources.length + ' 个来源</div></div>';
    }).join('');
    var stats = (r.stats || []);
    var okN = stats.filter(function (s) { return s.ok; }).length;
    $('olMeta').textContent = '共 ' + r.total + ' 部' + (r.partial ? '（还在补）' : '') + ' · ' + okN + '/' + stats.length + ' 个源有响应' +
      (r.ms ? ' · ' + (r.ms / 1000).toFixed(1) + 's' : '');
  }

  /* ---------- 详情 / 选源 / 选集 ---------- */
  function openItem(i) {
    var it = st.items[i];
    if (!it) return;
    st.item = it; st.srcIdx = 0; st.epIdx = 0; st.groups = []; st.gi = 0; st.detail = null;
    $('olGrid').hidden = true;
    var d = $('olDetail');
    d.hidden = false;
    d.innerHTML = '<div class="oldhead"><button class="small" id="olBack">&#8592; 返回结果</button>' +
      '<span class="oldhint">点「来源线路」换源；点剧集开始播放</span></div>' +
      '<div class="oldwrap"><div class="oldpic">' + (cover(it.pic) ? '<img alt="" src="' + cover(it.pic) + '">' : '<span class="onoimg">无海报</span>') + '</div>' +
      '<div class="oldinfo"><h2>' + esc(it.title) + '</h2>' +
      '<div class="oldmeta">' + esc([it.year, it.remarks].filter(Boolean).join(' · ')) + '</div>' +
      '<p class="oldintro">' + esc(it.intro || '（该来源没有提供简介）') + '</p>' +
      '<div class="olsrcline" id="olSrcLine"></div>' +
      '<div class="oleps" id="olEps"><div class="olempty">正在读取剧集…</div></div>' +
      '</div></div>';
    $('olBack').onclick = function () { $('olDetail').hidden = true; $('olGrid').hidden = false; };
    renderSrcLine();
    loadSource(0);
  }

  function renderSrcLine() {
    var it = st.item;
    if (!it) return;
    $('olSrcLine').innerHTML = '<span class="olsl">来源线路</span>' + it.sources.map(function (s, i) {
      return '<button class="ochip' + (i === st.srcIdx ? ' on' : '') + '" data-src="' + i + '">' + esc(s.name) +
        (s.direct ? '<i class="odirect">直链</i>' : '<i class="oweb">网页</i>') + '</button>';
    }).join('');
  }

  function loadSource(i) {
    var it = st.item;
    if (!it) return;
    st.srcIdx = i; st.epIdx = 0;
    renderSrcLine();
    var s = it.sources[i];
    $('olEps').innerHTML = '<div class="olempty">正在读取 ' + esc(s.name) + ' 的剧集…</div>';
    jget('/api/online/detail?sid=' + encodeURIComponent(s.sid) + '&id=' + encodeURIComponent(s.id)).then(function (r) {
      if (st.item !== it) return;
      if (r.code !== 0) { $('olEps').innerHTML = '<div class="olempty">读取失败：' + esc(r.error) + '</div>'; return; }
      st.detail = r;
      st.groups = (r.groups || []).filter(function (g) { return g.episodes && g.episodes.length; });
      var gi = 0;
      for (var k = 0; k < st.groups.length; k++) { if (st.groups[k].direct) { gi = k; break; } }
      st.gi = gi;
      renderEps();
    });
  }

  function renderEps() {
    var g = st.groups[st.gi];
    if (!g) { $('olEps').innerHTML = '<div class="olempty">这个来源没有可用剧集</div>'; return; }
    var head = '<div class="olephead"><b>' + esc(g.from) + '</b> · ' + g.episodes.length + ' 集' +
      (g.direct ? ' · 直链可播' : ' · <b class="warn">网页分享，多半播不了</b>') + '</div>';
    var body = g.episodes.map(function (e, i) {
      return '<button class="oepb' + (i === st.epIdx ? ' on' : '') + '" data-ep="' + i + '" title="' + esc(e.name) + '">' + esc(e.name) + '</button>';
    }).join('');
    $('olEps').innerHTML = head + '<div class="olepgrid">' + body + '</div>';
  }

  /* ---------- 播放：交给本机 mpv，多线路自动挑能播的 ---------- */
  function playEp(i) {
    var g = st.groups[st.gi];
    if (!g) return;
    st.epIdx = i;
    renderEps();
    $('olPlay').hidden = false;
    document.body.classList.add('olplay-on');
    $('olpTitle').textContent = (st.item ? st.item.title : '') + ' · ' + g.episodes[i].name;
    $('olpSrc').textContent = '正在并发检测线路…';
    $('olStageHint').textContent = '正在起播…';
    syncStage();
    var cur = st.item.sources[st.srcIdx];
    var targets = [{ sid: cur.sid, id: cur.id }];
    st.item.sources.slice(0, 12).forEach(function (s) {
      if (s.sid !== cur.sid || s.id !== cur.id) targets.push({ sid: s.sid, id: s.id });
    });
    var floor = st.minP;
    if (floor > 0) { $('olpSrc').textContent = '正在并发检测线路（画质下限 ' + floorName(floor) + '）…'; }
    ensureHwnd(function () {
    jpost('/api/online/play', {
      title: st.item.title + ' ' + g.episodes[i].name,
      ep: i, targets: targets, hwnd: st.hwnd || 0, minP: floor,
    }).then(function (r) {
      st.probe = r.probe || [];
      st.playingUrl = (r.playing && r.playing.url) || '';
      var okN = st.probe.filter(function (p) { return p.ok; }).length;
      if (r.code !== 0) {
        $('olpSrc').textContent = '播放失败：' + (r.error || '');
        $('olStageHint').textContent = '这些线路都没通过检测，换个来源或换一集试试';
        return;
      }
      st.playing = r.playing || null;
      renderProbe();
      fillPending();
      $('olpSrc').textContent = '播放中 · ' + (r.playing ? r.playing.name : '')
        + (r.quality ? ' · ' + (r.qualityText ? r.qualityText + '（' + r.quality + '档）' : r.quality) : '')
        + (r.speedFallback ? '　达标的 ' + floorName(floor) + ' 线路带宽都不够，已自动退到能流畅播的一条' : '')
        + (r.belowFloor ? '　全网最高只有这档，没找到 ' + floorName(floor) + ' 的线路' : '')
        + (r.slow && !r.speedFallback ? '　这条带宽偏紧，可能要缓冲' : '')
        + '（实测 ' + okN + ' 条可用）';
      $('olStageHint').textContent = st.hwnd ? '' : (shell
        ? '正在把播放器画面接进这块区域…（若一直黑屏，点一下线路芯片换个源）'
        : '浏览器里没法内嵌播放器，画面在独立窗口；用桌面版会直接画在这块区域里');
      startPoll();
    }).catch(function (e) { $('olpSrc').textContent = '播放出错：' + e.message; });
    });
  }

  function renderProbe() {
    var el = $('olProbe');
    if (!el) return;
    if (!st.probe.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<span class="lb">线路实测</span>' + st.probe.map(function (p, i) {
      var rt = p.rt || qtext(p.res);
      var tag = p.q || qlabel(p.res);
      var pend = p.ok === null;
      var cls = pend ? 'wait' : (p.ok ? (p.slow ? 'slow' : 'ok') : 'bad');
      /* 没通过检测的线路也给点：检测只是「按实测带宽评估」，用户想试就让他试 */
      var tail = pend ? ' · 检测中'
        : (p.ok ? (p.slow ? ' · 带宽偏紧' : '')
          : (p.need && p.kbs && p.kbs < p.need ? ' · 带宽不够 · 可试播' : ' · 未通过检测 · 可试播'));
      var tip = esc(p.name + (rt ? ' ' + rt + (tag && tag !== rt ? '（' + tag + '档）' : '') : '') + '　' + (p.why || ''));
      return '<button class="opb ' + cls + '" data-line="' + i + '" title="' + tip + '">' + esc(p.name) +
        (rt ? ' <i>' + esc(rt) + '</i>' : '') + tail + '</button>';
    }).join('');
  }

  /* 起播时有些线路还没量完（界面显示「检测中」），在后台补量，回来一条更新一条 */
  function fillPending() {
    st.probe.forEach(function (p) {
      if (p.ok !== null || !p.url) return;
      fetch('/api/online/probe?url=' + encodeURIComponent(p.url)).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || typeof d.ok !== 'boolean') return;
        p.ok = d.ok; p.res = d.res || null; p.why = d.why || '';
        p.kbs = d.kbs || 0; p.need = d.need || 0; p.slow = !!d.slow;
        p.rt = qtext(p.res); p.q = qlabel(p.res);
        renderProbe();
      }).catch(function () { });
    });
  }

  function playLine(p) {
    if (!p || !p.url) return;
    if (!p.ok) { $('olpSrc').textContent = '这条没通过检测，仍按你点的试播：' + p.name + (p.why ? '（' + p.why + '）' : ''); }
    $('olpSrc').textContent = '切换线路：' + p.name + (p.res ? ' · ' + qtext(p.res) + '（' + qlabel(p.res) + '档）' : '');
    jpost('/api/online/play', { url: p.url, name: p.name, sid: p.sid, title: $('olpTitle').textContent, hwnd: st.hwnd || 0 })
      .then(function (r) {
        if (r.code !== 0) { $('olpSrc').textContent = '切换失败：' + (r.error || ''); return; }
        st.playingUrl = p.url;
        $('olpSrc').textContent = '播放中 · ' + p.name + (p.res ? ' · ' + qtext(p.res) + '（' + qlabel(p.res) + '档）' : '');
        startPoll();
      });
  }

  function startPoll() { stopPoll(); st.timer = setInterval(tick, 800); tick(); }
  function stopPoll() { if (st.timer) { clearInterval(st.timer); st.timer = null; } }

  function tick() {
    if (SEC.hidden) { return; }
    jget('/api/player/status').then(function (s) {
      var dur = s.duration || 0, t = s.time || 0;
      st.dur = dur;
      $('olSeek').value = dur ? Math.round((t / dur) * 1000) : 0;
      $('olTime').textContent = fmt(t) + ' / ' + fmt(dur);
      $('olToggle').textContent = s.paused ? '继续' : '暂停';
      $('olVol').value = s.volume;
      $('olMute').textContent = s.mute ? '取消静音' : '静音';
      if (!s.alive && st.playing) { $('olStageHint').textContent = '播放已结束或被关闭'; }
      /* 画面里按 ESC / ENTER（播放器自带配置的两个键）会让 mpv 翻这个属性，界面跟着对齐 */
      if (shell && typeof s.fs === 'boolean' && s.fs !== st.fs && Date.now() - st.fsAt > 1500) setFs(s.fs);
      syncStage();
    }).catch(function () { });
  }

  /* ---------- 事件绑定 ---------- */
  SEC.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var card = t.closest('.ocard');
    if (card) { openItem(parseInt(card.getAttribute('data-i'), 10)); return; }
    var lineBtn = t.closest('[data-line]');
    if (lineBtn) { playLine(st.probe[parseInt(lineBtn.getAttribute('data-line'), 10)]); return; }
    var srcBtn = t.closest('[data-olsrc]');
    if (srcBtn) {
      st.srcId = srcBtn.getAttribute('data-olsrc') || '';
      renderSrcBar();
      if (st.kw) search(st.kw);
      return;
    }
    var sb = t.closest('[data-src]');
    if (sb) { loadSource(parseInt(sb.getAttribute('data-src'), 10)); return; }
    var eb = t.closest('[data-ep]');
    if (eb) { playEp(parseInt(eb.getAttribute('data-ep'), 10)); return; }
  });

  $('olpClose').onclick = function () {
    $('olPlay').hidden = true;
    document.body.classList.remove('olplay-on');
    if (st.fs) setFs(false);
    st.stageRect = '';
    shellPost('videohide');
    stopPoll();
    jpost('/api/player/stop', {});
  };
  $('olToggle').onclick = function () { jpost('/api/player/ctl', { cmd: 'toggle' }).then(tick); };
  $('olMute').onclick = function () {
    jget('/api/player/status').then(function (s) { return jpost('/api/player/ctl', { cmd: 'mute', value: !s.mute }); }).then(tick);
  };
  $('olVol').oninput = function () { jpost('/api/player/ctl', { cmd: 'volume', value: Number(this.value) }); };
  $('olSeek').onchange = function () {
    if (!st.dur) return;
    jpost('/api/player/ctl', { cmd: 'seek', value: (Number(this.value) / 1000) * st.dur }).then(tick);
  };
  $('olFs').onclick = function () {
    if (shell) { setFs(!st.fs); return; }
    jpost('/api/player/ctl', { cmd: 'fullscreen', value: true });
  };
  $('olPrev').onclick = function () { jumpEp(-1); };
  $('olNext').onclick = function () { jumpEp(1); };

  function jumpEp(dir) {
    var g = st.groups[st.gi];
    if (!g) return;
    var i = st.epIdx + dir;
    if (i >= 0 && i < g.episodes.length) { playEp(i); return; }
    var ni = st.srcIdx + dir;
    if (ni >= 0 && ni < st.item.sources.length) {
      var it = st.item, target = dir > 0 ? 0 : -1;
      st.srcIdx = ni;
      loadSource(ni);
      setTimeout(function () {
        if (st.item !== it) return;
        var gg = st.groups[st.gi];
        if (gg) playEp(target < 0 ? gg.episodes.length - 1 : 0);
      }, 900);
    }
  }

  /* ---------- 显隐 ---------- */
  function show() {
    SEC.hidden = false;
    document.body.classList.add('online-on');
    if (window.QS_MODE !== 'online' && window.qsSetMode) window.qsSetMode('online', false);
    var h = $('home'); if (h) h.hidden = true;
    var l = $('list'); if (l) l.innerHTML = '';
    var rk = $('rank'); if (rk) rk.hidden = true;
    markNav('online');
    if (st.item) { $('olGrid').hidden = true; $('olDetail').hidden = false; }
    loadSources();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  function hide() {
    SEC.hidden = true;
    if (st.fs) setFs(false);
    document.body.classList.remove('online-on');
    document.body.classList.remove('olplay-on');
    markNav('');
    stopPoll();
  }
  /* 左侧栏高亮跟着走（home.js 里同一套写法） */
  function markNav(cat) {
    var nav = document.querySelectorAll('.snav a[data-nav]');
    for (var k = 0; k < nav.length; k++) nav[k].className = (nav[k].getAttribute('data-nav') === cat ? 'on' : '');
  }

  window.addEventListener('resize', function () { st.stageRect = ''; syncStage(); });
  window.addEventListener('scroll', syncSoon, { passive: true });
  document.addEventListener('scroll', syncSoon, { passive: true, capture: true });
  /* 光标不在画面里时（页面还有焦点）Esc / F 也能退出全屏 */
  document.addEventListener('keydown', function (e) {
    if (!st.fs) return;
    var k = e.key;
    if (k === 'Escape' || k === 'Esc' || k === 'f' || k === 'F') { e.preventDefault(); setFs(false); }
  });
  /* 深链：#?nav=online[&q=片名] 直接进在线模式（也方便截图自测） */
  try {
    var q = new URLSearchParams(location.search);
    var qh = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    if (q.get('nav') === 'online') {
      if (window.qsSetMode) window.qsSetMode('online', false);
      show();
      var kw0 = q.get('q') || q.get('kw') || qh.get('q');
      var kwEl = $('kw');
      if (kw0 && kwEl) kwEl.value = kw0;
      if (kw0) search(kw0);
    }
  } catch (e) { }

  var mwSel = $('olMinW');
  if (mwSel) {
    mwSel.value = String(st.minP);
    mwSel.addEventListener('change', function () {
      st.minP = parseInt(mwSel.value, 10) || 0;
      try { localStorage.setItem('qs4_olMinP', String(st.minP)); } catch (e) { }
      if (st.playing) $('olpSrc').textContent = '画质下限已设为 ' + floorName(st.minP) + '，换集 / 点线路会按新下限重新选源';
    });
  }

  window.Online = { show: show, hide: hide, search: search, setFs: setFs };
})();
