/* ===================== 首页 v3：hero + 箭头翻页海报行 + 更多 → 分类页 ===================== */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var HOME = $('home');
  if (!HOME) return;

  var CATS = null, curCat = 'anime', curInfo = null, rowDefs = [], rows = [], heroItems = [], heroIdx = 0, heroTimer = null;
  var view = 'rows', curRow = -1, catItems = [], catPage = 1, catLoading = false, rowIO = null;

  function cover(u) { return u ? '/api/cover?u=' + encodeURIComponent(u) : ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function getCats() {
    if (CATS) return Promise.resolve(CATS);
    return fetch('/api/rank/cats').then(function (x) { return x.json(); }).then(function (r) { CATS = r.cats || {}; return CATS; });
  }

  function fetchRank(cat, srcId, genre, board, page, limit) {
    var qs = new URLSearchParams();
    qs.set('cat', cat); qs.set('page', String(page || 1)); qs.set('limit', String(limit || 24));
    if (board) qs.set('board', board);
    else { if (srcId) qs.set('src', srcId); if (genre) qs.set('genres', genre); }
    return fetch('/api/rank?' + qs.toString()).then(function (x) { return x.json(); }).then(function (r) {
      if (r.code !== 0) throw new Error(r.error || 'load fail');
      return r.items || [];
    });
  }

  function rowDefsFor(info) {
    var out = [], srcs = info.srcs || [], boards = info.boards || [], p = srcs[0];
    if (p) out.push({ title: '热门' + (info.name || ''), src: p.id, genre: '', board: '' });
    var gs = (p && p.genres) || [];
    if (gs.length >= 5) gs.slice(0, 6).forEach(function (g) { out.push({ title: g, src: p.id, genre: g, board: '' }); });
    else if (boards.length >= 3) boards.slice(0, 6).forEach(function (b) { out.push({ title: b.name, src: '', genre: '', board: b.id }); });
    else srcs.slice(1, 6).forEach(function (s) { out.push({ title: s.name, src: s.id, genre: '', board: '' }); });
    return out.slice(0, 7);
  }

  function poster(it) {
    var c = cover(it.cover || it.coverFallback || '');
    var b = it.score ? '<span class="pbadge">' + esc(it.score) + '</span>' : (it.rank ? '<span class="pno">#' + esc(it.rank) + '</span>' : '');
    return '<div class="pcard" role="button" tabindex="0" data-q="' + esc(it.title) + '" aria-label="' + esc(it.title) + '，点击搜索资源">' +
      '<div class="pimg">' + (c ? '<img loading="lazy" alt="" src="' + c + '">' : '') + b + '</div>' +
      '<div class="pname">' + esc(it.title) + '</div></div>';
  }

  function skRow(n) { var h = ''; for (var i = 0; i < (n || 12); i++) h += '<div class="sk"></div>'; return h; }

  var ARL = '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>';
  var ARR = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

  function rowHTML(i, title) {
    return '<section class="sec" data-i="' + i + '">' +
      '<div class="sec-head"><h2>' + esc(title) + '</h2>' +
      '<span class="more" data-row="' + i + '" role="button" tabindex="0">更多 &#8594;</span></div>' +
      '<div class="rowwrap">' +
      '<button class="arnav l" type="button" data-ar="-1" data-target="' + i + '" aria-label="上一屏">' + ARL + '</button>' +
      '<div class="rowtrack" data-track="' + i + '">' + skRow(8) + '</div>' +
      '<button class="arnav r" type="button" data-ar="1" data-target="' + i + '" aria-label="下一屏">' + ARR + '</button>' +
      '</div></section>';
  }

  function updateArrows(i) {
    var sec = HOME.querySelector('.sec[data-i="' + i + '"]');
    if (!sec) return;
    var wrap = sec.querySelector('.rowwrap'), tr = sec.querySelector('.rowtrack');
    if (!wrap || !tr) return;
    var can = tr.scrollWidth > tr.clientWidth + 4;
    wrap.classList.toggle('scrollable', can);
    var l = wrap.querySelector('.arnav.l'), r = wrap.querySelector('.arnav.r');
    var atL = tr.scrollLeft <= 2, atR = tr.scrollLeft + tr.clientWidth >= tr.scrollWidth - 2;
    if (l) { l.disabled = atL; l.classList.toggle('off', atL); }
    if (r) { r.disabled = atR; r.classList.toggle('off', atR); }
  }

  function renderRow(i) {
    var sec = HOME.querySelector('.sec[data-i="' + i + '"]');
    if (!sec) return;
    var tr = sec.querySelector('.rowtrack');
    var items = rows[i] || [];
    if (!items.length) { tr.innerHTML = '<div class="empty">这个榜单暂时没有数据</div>'; return; }
    tr.innerHTML = items.map(poster).join('');
    tr.scrollLeft = 0;
    setTimeout(function () { updateArrows(i); }, 40);
  }

  function heroHTML(items) {
    heroItems = items.slice(0, 5);
    if (!heroItems.length) return '';
    var dots, slides = heroItems.map(function (it, i) {
      var c = cover(it.cover || '');
      return '<div class="hslide' + (i === 0 ? ' on' : '') + '">' +
        '<div class="hbg"' + (c ? ' style="background-image:url(' + c.replace(/"/g, '%22') + ')"' : '') + '></div>' +
        '<div class="hbody"><span class="hchip">' + esc((curInfo && curInfo.name) || '') + ' 排行榜</span>' +
        '<div class="htitle">' + esc(it.title) + '</div>' +
        '<div class="hmeta">' + (it.score ? '<b>' + esc(it.score) + '</b>' : '') + (it.rank ? '<span>第 ' + esc(it.rank) + ' 名</span>' : '') + '</div>' +
        '<div class="hbtns"><button class="btn-red" data-q="' + esc(it.title) + '">搜资源</button>' +
        '<button class="btn-ghost" data-row="0">看同类榜单</button></div></div></div>';
    }).join('');
    dots = heroItems.map(function (it, i) { return '<i class="' + (i === 0 ? 'on' : '') + '" data-hi="' + i + '" role="button" tabindex="0" aria-label="第' + (i + 1) + '个"></i>'; }).join('');
    return '<div class="hero">' + slides + '<div class="hdots">' + dots + '</div></div>';
  }

  function setHero(i) {
    heroIdx = i;
    var hs = HOME.querySelectorAll('.hslide'), ds = HOME.querySelectorAll('.hdots i'), k;
    for (k = 0; k < hs.length; k++) hs[k].className = 'hslide' + (k === i ? ' on' : '');
    for (k = 0; k < ds.length; k++) ds[k].className = (k === i ? 'on' : '');
  }
  function startHero() {
    if (heroTimer) clearInterval(heroTimer);
    if (heroItems.length < 2) return;
    heroTimer = setInterval(function () { setHero((heroIdx + 1) % heroItems.length); }, 6000);
  }

  function loadRowData(i) {
    var d = rowDefs[i];
    return fetchRank(curCat, d.src, d.genre, d.board, 1, 24).then(function (items) {
      rows[i] = items; renderRow(i); return items;
    }).catch(function () { rows[i] = []; renderRow(i); return []; });
  }

  function renderRows() {
    view = 'rows';
    HOME.innerHTML = '<div id="heroBox"></div>' + rowDefs.map(function (d, i) { return rowHTML(i, d.title); }).join('');
    if (rowIO) rowIO.disconnect();
    loadRowData(0).then(function (items) {
      var hb = $('heroBox');
      if (hb) hb.innerHTML = heroHTML(items);
      startHero();
    });
    var secs = HOME.querySelectorAll('.sec');
    rowIO = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (!en.isIntersecting) return;
        var i = parseInt(en.target.getAttribute('data-i'), 10);
        if (isNaN(i) || rows[i]) return;
        rowIO.unobserve(en.target);
        loadRowData(i);
      });
    }, { rootMargin: '320px 0px' });
    for (var i = 1; i < secs.length; i++) rowIO.observe(secs[i]);
  }

  function renderHome(cat) {
    curCat = cat;
    document.body.classList.toggle('cat-music', cat === 'music');
    rows = [];
    HOME.hidden = false;
    document.body.classList.add('home-on');
    HOME.innerHTML = '<div class="hero"><div class="hbg"></div><div class="hbody"><div class="htitle">加载中…</div></div></div>' +
      '<section class="sec"><div class="sec-head"><h2>正在加载榜单</h2></div><div class="rowwrap"><div class="rowtrack">' + skRow(6) + '</div></div></section>';
    return getCats().then(function (cats) {
      curInfo = cats[cat] || {};
      rowDefs = rowDefsFor(curInfo);
      if (!rowDefs.length) { HOME.innerHTML = '<div class="empty">这个分类暂时没有榜单数据</div>'; return; }
      renderRows();
    }).catch(function (e) {
      HOME.innerHTML = '<div class="empty">榜单加载失败：' + esc(e.message) + '</div>';
    });
  }

  function renderCatPage(i) {
    var d = rowDefs[i];
    view = 'cat'; curRow = i; catItems = rows[i] ? rows[i].slice() : []; catPage = 1;
    HOME.hidden = false;
    window.scrollTo({ top: 0, behavior: 'auto' });
    HOME.innerHTML = '<div class="catbar"><h2>' + esc(d.title) + '</h2>' +
      '<span class="catcount">共 ' + catItems.length + ' 条已加载</span>' +
      '<button class="small" id="catBack">&#8592; 返回</button></div>' +
      '<div class="catgrid" id="catGrid">' + (catItems.map(poster).join('') || '<div class="empty">没有数据</div>') + '</div>' +
      '<div class="catmorewrap"><button id="catMore">加载更多</button></div>';
    var b = $('catBack'); if (b) b.onclick = function () { renderRows(); window.scrollTo({ top: 0, behavior: 'auto' }); };
    var m = $('catMore'); if (m) m.onclick = function () { loadMoreCat(); };
  }

  function loadMoreCat() {
    if (catLoading) return;
    catLoading = true;
    var m = $('catMore'); if (m) { m.disabled = true; m.textContent = '加载中…'; }
    var d = rowDefs[curRow];
    catPage++;
    fetchRank(curCat, d.src, d.genre, d.board, catPage, 24).then(function (items) {
      var g = $('catGrid');
      if (!items.length) { if (m) { m.disabled = true; m.textContent = '没有更多了'; } }
      else {
        catItems = catItems.concat(items);
        if (g) g.innerHTML += items.map(poster).join('');
        var c = HOME.querySelector('.catcount'); if (c) c.textContent = '共 ' + catItems.length + ' 条已加载';
        if (m) { m.disabled = false; m.textContent = '加载更多'; }
      }
    }).catch(function () { if (m) { m.disabled = false; m.textContent = '加载失败，点我重试'; } })
      .then(function () { catLoading = false; });
  }

  function openRank() {
    var rb = $('rankBtn'); if (rb) rb.click();
    setTimeout(function () {
      var chip = document.querySelector('#rankCats button[data-rcat="' + curCat + '"]');
      if (chip) chip.click();
    }, 80);
  }

  function selectCat(cat) {
    var nav = document.querySelectorAll('#snav a'), k;
    for (k = 0; k < nav.length; k++) nav[k].className = (nav[k].getAttribute('data-nav') === cat ? 'on' : '');
    var list = $('list'); if (list) list.innerHTML = '';
    if (cat === 'home') cat = 'anime';
    renderHome(cat);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var nav = t.closest('.snav a');
    if (nav) { e.preventDefault(); selectCat(nav.getAttribute('data-nav')); return; }
    var ar = t.closest('.arnav');
    if (ar) {
      e.preventDefault();
      var i = parseInt(ar.getAttribute('data-target'), 10);
      var sec = HOME.querySelector('.sec[data-i="' + i + '"]');
      var tr = sec && sec.querySelector('.rowtrack');
      if (tr) {
        var dir = parseInt(ar.getAttribute('data-ar'), 10);
        tr.scrollBy({ left: dir * Math.max(240, tr.clientWidth - 120), behavior: 'smooth' });
        setTimeout(function () { updateArrows(i); }, 420);
      }
      return;
    }
    var dot = t.closest('[data-hi]');
    if (dot) { setHero(parseInt(dot.getAttribute('data-hi'), 10) || 0); startHero(); return; }
    var row = t.closest('[data-row]');
    if (row) { var j = parseInt(row.getAttribute('data-row'), 10); if (!isNaN(j)) renderCatPage(j); return; }
  });

  document.addEventListener('scroll', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('rowtrack')) updateArrows(parseInt(t.getAttribute('data-track'), 10));
  }, true);

  var rs = $('rankBtnSide'), ss = $('setBtnSide');
  if (rs) rs.onclick = function () { openRank(); };
  if (ss) ss.onclick = function () { var b = $('setBtn'); if (b) b.click(); };

  var list = $('list');
  function sync() {
    if (!list) return;
    var hasWelcome = !!list.querySelector('.welcome');
    var hasContent = !!list.querySelector('.card, .empty');
    var showHome = !hasContent || hasWelcome;
    HOME.hidden = !showHome;
    document.body.classList.toggle('home-on', showHome);
  }
  if (list) new MutationObserver(sync).observe(list, { childList: true });
  sync();

  var rt = null;
  window.addEventListener('resize', function () {
    if (view !== 'rows') return;
    clearTimeout(rt);
    rt = setTimeout(function () { for (var i = 0; i < rowDefs.length; i++) if (rows[i]) updateArrows(i); }, 180);
  });

  var cat0 = new URLSearchParams(location.search).get('cat');
  if (cat0) selectCat(cat0); else renderHome('anime');
})();
