const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const UI_PORT = 8899;
const API_HOST = '127.0.0.1';
const API_PORT = 8888;
const ROOT = __dirname;
const rank = require('./rank');

/* ===================== 在线增强：近似词补搜 + 额外在线源 ===================== */
/* EXTRA_SOURCES 形如 name|https://host/api/search|query ，多个用逗号分隔；留空即关闭 */
const EXTRA_SOURCES = (process.env.EXTRA_SOURCES == null
  ? 'pansou.de|https://pansou.de/api/search|query'
  : process.env.EXTRA_SOURCES).split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const parts = x.split('|');
    return { name: parts[0] || parts[1], url: parts[1], field: parts[2] || 'query' };
  }).filter((x) => x.url);

function postJson(u, body, timeout) {
  return new Promise((resolve) => {
    let t;
    try { t = new URL(u); } catch (e) { return resolve(null); }
    const mod = t.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = mod.request({
      host: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80),
      path: t.pathname + t.search,
      method: 'POST', timeout,
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'user-agent': 'quark-search-ui', accept: 'application/json' },
    }, (r) => {
      let out = '';
      r.on('data', (c) => out += c);
      r.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

/* 片名近似写法：原名 -> 首个空格/波浪号前的部分 -> 再去掉「剧场版 / 第N季」这类后缀 */
function queryVariants(kw) {
  const out = [kw];
  const base = String(kw).split(/[\s〜～]+/)[0].trim();
  if (base.length >= 2 && out.indexOf(base) < 0) out.push(base);
  const trimmed = base.replace(/(剧场版|电影版|特别篇|番外篇|OVA|OAD|TV版|第[一二三四五六七八九十0-9]+[季部])$/i, '').trim();
  if (trimmed.length >= 2 && out.indexOf(trimmed) < 0) out.push(trimmed);
  return out.slice(0, 3);
}

function pansouSearch(kw, extra) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams(Object.assign({ kw }, extra || {}));
    const req = http.request({ host: API_HOST, port: API_PORT, path: '/api/search?' + qs.toString(), method: 'GET', timeout: 180000 }, (r) => {
      let out = '';
      r.on('data', (c) => out += c);
      r.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function handleSearchEnhanced(res, u) {
  const kw = (u.searchParams.get('kw') || '').trim();
  const pass = {};
  for (const kv of u.searchParams.entries()) if (kv[0] !== 'kw') pass[kv[0]] = kv[1];
  const plain = pass.plain === '1';
  delete pass.plain;
  const t0 = Date.now();

  const primary = await pansouSearch(kw, pass);
  const payload = primary || { code: 0, message: 'ok', data: {} };
  const data = (payload.data = payload.data || {});
  const merged = (data.merged_by_type = data.merged_by_type || {});
  merged.quark = Array.isArray(merged.quark) ? merged.quark.slice() : [];
  const seen = new Set(merged.quark.map((x) => x.url));

  const variants = queryVariants(kw);
  const used = [];
  if (!plain && merged.quark.length < 5 && variants.length > 1) {
    for (const v of variants.slice(1)) {
      const r = await pansouSearch(v, pass);
      const list = (r && r.data && r.data.merged_by_type && r.data.merged_by_type.quark) || [];
      used.push(v);
      for (const x of list) if (x.url && !seen.has(x.url)) { seen.add(x.url); x.variant = v; merged.quark.push(x); }
    }
  }

  const ext = [];
  if (!plain && EXTRA_SOURCES.length) {
    const rs = await Promise.all(EXTRA_SOURCES.map((s) => postJson(s.url, { [s.field]: kw }, 20000)));
    EXTRA_SOURCES.forEach((s, i) => {
      const r = rs[i];
      const list = (r && Array.isArray(r.results)) ? r.results : [];
      let added = 0;
      for (const x of list) {
        if (!x || !x.url || !/quark\.cn/i.test(x.url) || seen.has(x.url)) continue;
        seen.add(x.url);
        merged.quark.push({ url: x.url, password: x.password || '', note: x.title || '', datetime: x.datetime || '', source: s.name + ':' + (x.source || '在线'), images: [] });
        added++;
      }
      if (added) ext.push(s.name + '+' + added);
    });
  }

  data.total = merged.quark.length;
  data.enhanced = { variants: used, extras: ext, ms: Date.now() - t0 };
  sendJson(res, payload);
}


/* ===================== 本地精选库索引 ===================== */
const LIB_DIR = path.join(ROOT, '..', 'lib');
const LIB_INDEX = path.join(LIB_DIR, 'index.json');
const CACHE_FILE = path.join(LIB_DIR, 'check-cache.json');
let libCache = null;

const GAMES_INDEX = path.join(LIB_DIR, 'games.json');

function loadLib() {
  if (libCache) return libCache;
  try {
    const j = JSON.parse(fs.readFileSync(LIB_INDEX, 'utf8'));
    const items = Array.isArray(j.items) ? j.items : [];
    const meta = Object.assign({}, j.meta || {});
    /* 并入本地游戏库（方舟游戏整站种子表）：搜游戏名也能直接出夸克链接 */
    try {
      const g = JSON.parse(fs.readFileSync(GAMES_INDEX, 'utf8'));
      const gi = Array.isArray(g.items) ? g.items : [];
      if (gi.length) {
        items.push(...gi);
        meta.games = gi.length;
        meta.total = (meta.total || 0) + gi.length;
      }
    } catch (e) { /* 没有 games.json 就只用原库 */ }
    libCache = { meta, items };
  } catch (e) {
    libCache = { meta: { error: String(e.message) }, items: [] };
  }
  return libCache;
}

/* 与 build-index.js 的 searchKey 保持一致：小写、标点转空格、去 20xx 年份 */
function searchKey(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/[_\-·・:：,，、.。!！?？'"“”‘’()（）\[\]【】&＆+]/g, ' ')
    .replace(/20\d{2}/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function catBonus(c) {
  if (!c) return 0;
  if (/今日更新|今日新增/.test(c)) return 130;
  if (/最近热播/.test(c)) return 100;
  if (/经典合集|经典华语剧集|华语电影|经典电影|高分电影|周星驰|宫崎骏|林正英|漫威|奥斯卡/.test(c)) return 80;
  if (/^历史归档/.test(c)) return 0;
  return 50;
}

/* 相关性：完全相等 > 前缀 > 后缀 > 包含 > 多词命中；短剧/归档降权 */
function scoreOf(it, q, toks) {
  const K = it.k || searchKey(it.n);
  for (let i = 0; i < toks.length; i++) if (K.indexOf(toks[i]) < 0) return -1;
  let s;
  if (K === q) s = 1200;
  else if (K.indexOf(q) === 0) s = 820;
  else if (K.endsWith(q)) s = 650;
  else if (K.indexOf(q) >= 0) s = 480;
  else s = 200;
  s -= Math.min(Math.max(K.length - q.length, 0), 14) * 6;
  if (it.sd) s -= 600;
  if (it.ar) s -= 70;
  return s + catBonus(it.c);
}

function searchLib(kw, limit, opt) {
  const lib = loadLib();
  const q = searchKey(kw);
  const toks = q.split(' ').filter(Boolean);
  const hits = [];
  let hidSd = 0, hidAr = 0, hidProv = 0;
  if (toks.length) {
    for (const it of lib.items) {
      const s = scoreOf(it, q, toks);
      if (s < 0) continue;
      if (it.sd && !opt.sc) { hidSd++; continue; }
      if (it.ar && !opt.ar) { hidAr++; continue; }
      if (it.p !== 'quark' && !opt.all) { hidProv++; continue; }
      hits.push({ it, s });
    }
  }
  hits.sort((a, b) => (b.s - a.s) || String(b.it.d).localeCompare(String(a.it.d)));
  const items = hits.slice(0, limit).map(({ it, s }) => ({
    n: it.n, u: it.u, p: it.p, c: it.c, d: it.d, t: it.t, sd: it.sd, ar: it.ar, s: Math.round(s),
  }));
  return {
    total: hits.length, items, indexed: lib.items.length, meta: lib.meta,
    hidden: { sd: hidSd, ar: hidAr, prov: hidProv },
  };
}

/* ===================== 夸克分享链接判活（两步校验，逻辑同开源 PanCheck） =====================
   1) POST https://drive-h.quark.cn/1/clouddrive/share/sharepage/token   -> 拿 stoken
   2) GET  https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail -> 看文件列表 / share.status
   返回 1=有效  0=已失效或不存在  -1=无法判定(需提取码/网络异常)  -2=非夸克                          */
const TTL_OK = 12 * 3600 * 1000;
const TTL_BAD = 3 * 3600 * 1000;
const DEAD_CODES = { 41006: 1, 41009: 1, 41010: 1, 41011: 1, 41012: 1, 41031: 1 };
const PWD_CODES = { 41004: 1, 41008: 1 };   // 只有码错 41004 和需要提取码 41008 留作未判定

let checkStore = {};
try { checkStore = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch (e) { checkStore = {}; }
let saveTimer = null;
function saveCacheSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(checkStore)); } catch (e) {}
  }, 1500);
}

function quarkId(u) {
  const m = String(u).match(/pan\.quark\.cn\/s\/([0-9a-zA-Z_-]+)/i);
  return m ? m[1] : null;
}
function quarkPwd(u) {
  const m = String(u).match(/[?&#]pwd=([0-9a-zA-Z]{1,12})/i);
  return m ? m[1] : '';
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const COMMON_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9',
  'origin': 'https://pan.quark.cn',
  'referer': 'https://pan.quark.cn/',
  'user-agent': UA,
};

function httpJson(opts, body) {
  return new Promise((resolve) => {
    const req = https.request(opts, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => {
        // 注意：夸克对失效链接会返回 HTTP 404 + JSON 体，必须解析 body 才能拿到 41011
        let o = null;
        try { o = JSON.parse(d); } catch (e) {}
        if (!o) return resolve({ err: 'http ' + r.statusCode + ' / 非 JSON' });
        resolve({ o, http: r.statusCode });
      });
    });
    req.on('error', (e) => resolve({ err: e.message }));
    req.setTimeout(9000, () => { req.destroy(); resolve({ err: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

async function quarkTwoStep(id, passcode) {
  const body = JSON.stringify({ pwd_id: id, passcode: passcode || '', support_visit_limit_private_share: true });
  const t = await httpJson({
    host: 'drive-h.quark.cn',
    path: '/1/clouddrive/share/sharepage/token',
    method: 'POST',
    headers: { ...COMMON_HEADERS, 'content-type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  if (t.err) return -1;
  const o = t.o || {};
  if (o.code !== 0) {
    if (PWD_CODES[o.code]) return -1;
    if (DEAD_CODES[o.code]) return 0;
    return -1;
  }
  const stoken = (o.data || {}).stoken;
  if (!stoken) return 0;

  const p = '/1/clouddrive/share/sharepage/detail?pwd_id=' + encodeURIComponent(id) +
            '&stoken=' + encodeURIComponent(stoken) + '&ver=2&pr=ucpro';
  const d = await httpJson({ host: 'drive-pc.quark.cn', path: p, method: 'GET', headers: COMMON_HEADERS });
  if (d.err) return -1;
  const dd = (d.o || {}).data || {};
  const list = Array.isArray(dd.list) ? dd.list : [];
  const sh = dd.share || {};
  const st = sh.status;
  if (list.length === 0) return (st > 1) ? 0 : 0;
  if (st > 1 && st !== 3) return 0;
  if (st === 3 && sh.partial_violation) return 0;
  return 1;
}

async function checkUrl(url) {
  const id = quarkId(url);
  if (!id) return -2;
  const now = Date.now();
  const rec = checkStore[id];
  if (rec) {
    const ttl = rec.s === 1 ? TTL_OK : TTL_BAD;
    if (now - rec.t < ttl) return rec.s;
  }
  const s = await quarkTwoStep(id, quarkPwd(url));
  if (s !== -1) { checkStore[id] = { s, t: now }; saveCacheSoon(); }
  return s;
}

async function checkBatch(urls, conc) {
  const uniq = [...new Set(urls.map(String))].slice(0, 400);
  const out = {};
  let i = 0;
  const workers = Math.max(1, Math.min(conc, uniq.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (i < uniq.length) {
      const u = uniq[i++];
      out[u] = await checkUrl(u);
    }
  }));
  return out;
}

/* ===================== 打开链接：唤起夸克客户端 / 默认浏览器 ===================== */
const { spawn } = require('child_process');
const QUARK_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Quark', 'quark.exe');
const OPEN_HOSTS = /(^|\.)(quark\.cn|alipan\.com|aliyundrive\.com|baidu\.com|115\.com|189\.cn|123pan\.com|mypikpak\.com)$/i;

function openUrl(rawUrl, mode) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (e) { return { ok: false, error: '链接格式不对' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '只支持 http/https' };
  if (!OPEN_HOSTS.test(u.hostname)) return { ok: false, error: '不支持的网盘域名: ' + u.hostname };
  const target = u.toString();
  const isQuark = /(^|\.)quark\.cn$/i.test(u.hostname);
  if (mode !== 'browser' && isQuark && fs.existsSync(QUARK_EXE)) {
    try {
      const c = spawn(QUARK_EXE, [target], { detached: true, stdio: 'ignore' });
      c.unref();
      return { ok: true, via: 'quark' };
    } catch (e) { /* 失败则回落到浏览器 */ }
  }
  try {
    const c = spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true });
    c.unref();
    const why = !isQuark ? '该网盘不是夸克，已用默认浏览器打开'
      : (mode !== 'browser' ? '未找到夸克客户端，已用默认浏览器打开' : '');
    return { ok: true, via: 'browser', note: why };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
}

/* ===================== HTTP ===================== */
function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function proxy(req, res) {
  const options = { host: API_HOST, port: API_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: API_HOST + ':' + API_PORT } };
  const p = http.request(options, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  p.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ code: 1, message: 'PanSou API unreachable: ' + e.message })); });
  req.pipe(p);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/library/reload') {
    libCache = null;
    const l = loadLib();
    return sendJson(res, { code: 0, reloaded: true, indexed: l.items.length, meta: l.meta });
  }

  if (u.pathname === '/api/library') {
    const kw = (u.searchParams.get('kw') || '').trim();
    const limit = Math.max(1, Math.min(parseInt(u.searchParams.get('limit') || '300', 10) || 300, 2000));
    const opt = {
      sc: u.searchParams.get('sc') === '1',
      ar: u.searchParams.get('ar') !== '0',
      all: u.searchParams.get('all') === '1',
    };
    const r = searchLib(kw, limit, opt);
    return sendJson(res, { code: 0, total: r.total, indexed: r.indexed, meta: r.meta, hidden: r.hidden, items: r.items });
  }

  if (u.pathname === '/api/check/stats') {
    return sendJson(res, { code: 0, cache: Object.keys(checkStore).length });
  }

  if (u.pathname === '/api/check') {
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
      req.on('end', async () => {
        let urls = [];
        try { const b = JSON.parse(raw); urls = Array.isArray(b) ? b : (b.urls || []); } catch (e) {}
        const results = await checkBatch(urls, 6);
        sendJson(res, { code: 0, results, cache: Object.keys(checkStore).length });
      });
      return;
    }
    const urls = (u.searchParams.get('urls') || '').split(',').filter(Boolean);
    checkBatch(urls, 6).then((results) => sendJson(res, { code: 0, results }));
    return;
  }

  if (u.pathname === '/api/open') {
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on('end', () => {
        let b = {};
        try { b = JSON.parse(raw); } catch (e) {}
        const r = openUrl(b.url, b.mode);
        sendJson(res, Object.assign({ code: 0 }, r));
      });
      return;
    }
    const r = openUrl(u.searchParams.get('url'), u.searchParams.get('mode'));
    return sendJson(res, Object.assign({ code: 0 }, r));
  }

  /* ===================== 排行榜（Bangumi + 豆瓣，服务端抓取+缓存） ===================== */
  if (u.pathname === '/api/rank/cats') {
    return sendJson(res, { code: 0, cats: rank.cats() });
  }

  if (u.pathname === '/api/rank') {
    const cat = u.searchParams.get('cat') || 'anime';
    const src = u.searchParams.get('src') || '';
    const board = u.searchParams.get('board') || '';
    const page = u.searchParams.get('page') || '1';
    const limit = u.searchParams.get('limit') || '24';
    const refresh = u.searchParams.get('refresh') === '1';
    const split = (k) => (u.searchParams.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
    /* 统一入口：分类 + 来源（Bangumi/豆瓣/固定榜单）+ 产地/题材多选 */
    let job;
    if (!src && board) {
      job = rank.getRank(cat, board, page, limit, refresh);
    } else {
      const regions = rank.resolveRegions(cat, src, split('regions'));
      job = rank.getFiltered(cat, src, regions, split('genres'), page, limit, refresh, board);
    }
    job.then((r) => sendJson(res, Object.assign({ code: 0 }, r)))
       .catch((e) => sendJson(res, { code: 1, error: String((e && e.message) || e) }));
    return;
  }

  if (u.pathname === '/api/cover') {
    const src = u.searchParams.get('u') || '';
    rank.getCover(src).then((buf) => {
      let type = 'image/jpeg';
      if (buf[0] === 0x89 && buf[1] === 0x50) type = 'image/png';
      else if (buf[0] === 0x47 && buf[1] === 0x49) type = 'image/gif';
      else if (buf.slice(8, 12).toString('latin1') === 'WEBP') type = 'image/webp';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    }).catch((e) => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('cover fail: ' + String((e && e.message) || e));
    });
    return;
  }

  if (u.pathname === '/api/search' && req.method === 'GET') { handleSearchEnhanced(res, u); return; }

  if (req.url.startsWith('/api/')) return proxy(req, res);

  const file = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '');
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(full).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
});

server.listen(UI_PORT, '127.0.0.1', () => {
  console.log('Quark search UI: http://127.0.0.1:' + UI_PORT + '  cache=' + Object.keys(checkStore).length);
  /* 榜单预热：Bangumi 首次经 Clash 代理建连要十几秒，开机后台先拉一次，用户点开即热 */
  const warmDelay = (label, delay, fn) => setTimeout(() => {
    fn().then((r) => console.log('[rank warm] ' + label + ' ok ' + ((r.items || []).length) + ' 条 via=' + r.via))
        .catch((e) => console.log('[rank warm] ' + label + ' 失败: ' + e.message));
  }, delay);
  warmDelay('movie/豆瓣 不限', 800, () => rank.getFiltered('movie', 'db', [], [], 1, 24, false));
  warmDelay('anime/Bangumi 不限', 1500, () => rank.getFiltered('anime', 'bgm', [], [], 1, 24, false));
  warmDelay('tv/豆瓣 不限', 3000, () => rank.getFiltered('tv', 'db', [], [], 1, 24, false));
  warmDelay('movie/Top250', 6000, () => rank.getRank('movie', 'db_top250', 1, 24, false));
  warmDelay('anime/豆瓣池', 9000, () => rank.getFiltered('anime', 'db', [], [], 1, 24, false));
  warmDelay('tv/Bangumi 不限', 12000, () => rank.getFiltered('tv', 'bgm', [], [], 1, 24, false));
  warmDelay('movie/Bangumi 不限', 15000, () => rank.getFiltered('movie', 'bgm', [], [], 1, 24, false));
  warmDelay('comic/豆瓣 不限', 18000, () => rank.getFiltered('comic', 'db', [], [], 1, 24, false));
  warmDelay('webfiction/豆瓣 不限', 21000, () => rank.getFiltered('webfiction', 'db', [], [], 1, 24, false));
  warmDelay('litfic/豆瓣 不限', 24000, () => rank.getFiltered('litfic', 'db', [], [], 1, 24, false));
  warmDelay('music/Bangumi 不限', 27000, () => rank.getFiltered('music', 'bgm', [], [], 1, 24, false));
});
