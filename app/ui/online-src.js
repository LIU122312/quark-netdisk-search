/* ===================== 在线影视：ApiCMS 采集源聚合 ===================== */
/* 采集源均为公开的 ApiCMS/MacCMS JSON 接口（ac=detail），返回 vod_play_url 直链 m3u8。
   清单经实测筛选：只保留「接口可用 + 直链可播」的源，健康检查在设置 → 信息源状态里可复核。 */
const http = require('http');
const https = require('https');

const SOURCES = [
  { id: 'jyzy',  name: '金鹰',     api: 'https://jyzyapi.com',                    tag: '直链' },
  { id: 'p2100', name: '飘零',     api: 'https://p2100.net',                       tag: '直链' },
  { id: 'gsub',  name: '光速',     api: 'https://api.guangsuapi.com',              tag: '直链' },
  { id: 'dytt',  name: '电影天堂', api: 'https://caiji.dyttzyapi.com',             tag: '直链' },
  { id: 'zuid',  name: '最大',     api: 'https://api.zuidapi.com',                 tag: '直链' },
  { id: 'lzi',   name: '量子',     api: 'https://cj.lziapi.com',                   tag: '直链' },
  { id: 'modu',  name: '魔都',     api: 'https://www.mdzyapi.com',                 tag: '直链' },
  { id: '360',   name: '360',      api: 'https://360zy.com',                       tag: '直链' },
  { id: 'bdzy',  name: '百度云',   api: 'https://api.apibdzy.com',                 tag: '直链' },
  { id: 'ffzy',  name: '非凡',     api: 'https://ffzy5.tv',                        tag: '直链' },
  { id: 'subo',  name: '速播',     api: 'https://subocaiji.com',                   tag: '直链' },
  { id: 'jisu',  name: '极速',     api: 'https://jszyapi.com',                     tag: '直链' },
  { id: 'huya',  name: '虎牙',     api: 'https://www.huyaapi.com',                 tag: '直链' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function get(url, timeout) {
  return new Promise((resolve) => {
    let t;
    try { t = new URL(url); } catch (e) { return resolve(null); }
    const mod = t.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80),
      path: t.pathname + t.search, method: 'GET', timeout,
      headers: { 'user-agent': UA, accept: 'application/json,text/plain,*/*', 'accept-encoding': 'identity' },
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return resolve(get(new URL(r.headers.location, url).toString(), timeout));
      }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'] || '', body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function getJson(url, timeout) {
  const r = await get(url, timeout);
  if (!r) return null;
  try { return JSON.parse(r.body.toString('utf8')); } catch (e) { return null; }
}

function apiUrl(src, params) {
  const qs = new URLSearchParams(params).toString();
  return src.api + '/api.php/provide/vod/?' + qs;
}

/* vod_play_from = "a$$$b"，vod_play_url = "第1集$url#第2集$url$$$另一组..." */
function parsePlay(srcFrom, srcUrl) {
  const froms = String(srcFrom || '').split('$$$');
  const groups = String(srcUrl || '').split('$$$');
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const eps = [];
    for (const piece of groups[i].split('#')) {
      const s = piece.trim();
      if (!s) continue;
      const cut = s.lastIndexOf('$');
      const name = cut > 0 ? s.slice(0, cut) : '第' + (eps.length + 1) + '集';
      const url = (cut > 0 ? s.slice(cut + 1) : s).trim();
      if (!/^https?:\/\//i.test(url)) continue;
      eps.push({ name: name.replace(/^https?:\/\/.*/, '正片'), url });
    }
    if (eps.length) out.push({ from: froms[i] || ('线路' + (i + 1)), episodes: eps, direct: isDirect(eps[0].url) });
  }
  return out;
}

function isDirect(u) { return /\.m3u8(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u); }

function pickDirect(groups) {
  return groups.find((g) => g.direct) || null;
}

function cleanText(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[\s·・:：\-—_.,，。!！?？'"“”‘’()（）\[\]【】]/g, '');
}

/* ===================== 搜索：多源并发 + 同名合并 ===================== */
const searchCache = new Map();
const SEARCH_TTL = 10 * 60e3;

async function searchSource(src, kw, timeout) {
  const t0 = Date.now();
  const j = await getJson(apiUrl(src, { ac: 'detail', wd: kw }), timeout || 9000);
  if (!j || !Array.isArray(j.list)) return { src, ok: false, ms: Date.now() - t0, list: [] };
  return { src, ok: true, ms: Date.now() - t0, list: j.list };
}

function brief(it, src) {
  const groups = parsePlay(it.vod_play_from, it.vod_play_url);
  const direct = pickDirect(groups);
  const eps = direct ? direct.episodes.length : (groups[0] ? groups[0].episodes.length : 0);
  return {
    sid: src.id, name: src.name, id: String(it.vod_id == null ? '' : it.vod_id),
    remarks: cleanText(it.vod_remarks), froms: groups.map((g) => g.from),
    direct: !!direct, ep: eps,
  };
}

/* 把某个采集源的结果并进累加器；每来一个源就重排一次，于是 deadline 一到能立刻给出部分结果 */
function absorb(acc, r) {
  let used = 0;
  for (const it of r.list) {
    const title = cleanText(it.vod_name);
    if (!title) continue;
    const k = normTitle(title);
    let e = acc.byKey.get(k);
    if (!e) {
      e = { key: k, title, year: it.vod_year || '', pic: it.vod_pic || '', remarks: '', cat: '', intro: cleanText(it.vod_content).slice(0, 300), sources: [] };
      acc.byKey.set(k, e);
    }
    if (!e.pic || !/^https?:\/\//i.test(e.pic)) { if (it.vod_pic) e.pic = it.vod_pic; }
    if (!e.year && it.vod_year) e.year = it.vod_year;
    const b = brief(it, r.src);
    if (b.id) { e.sources.push(b); used++; }
    const rm = cleanText(it.vod_remarks);
    if (rm && e.remarks.indexOf(rm) < 0) e.remarks = e.remarks ? e.remarks + ' / ' + rm : rm;
  }
  acc.stats.push({ id: r.src.id, name: r.src.name, ok: r.ok, hits: r.list.length, ms: r.ms, used });
  rebuild(acc);
  return used;
}

function rebuild(acc) {
  acc.items = Array.from(acc.byKey.values()).map((e) => {
    const withEp = e.sources.slice().sort((a, b) => (b.direct ? 1 : 0) - (a.direct ? 1 : 0) || b.ep - a.ep);
    return Object.assign({}, e, {
      sources: withEp, direct: withEp.some((x) => x.direct), best: withEp[0],
      ep: Math.max.apply(null, withEp.map((x) => x.ep || 0).concat([0])),
    });
  }).filter((e) => e.sources.length)
    .map((e) => { e.rel = relevance(e, acc.kw); return e; })
    .sort((a, b) => (b.rel - a.rel) || (b.direct ? 1 : 0) - (a.direct ? 1 : 0) || (b.ep - a.ep) || a.title.localeCompare(b.title, 'zh'));
  acc.total = acc.items.length;
  acc.directCount = acc.items.filter((x) => x.direct).length;
  acc.top = acc.items.slice(0, acc.limit || 120);
  return acc;
}

/* 相关性：完全同名 > 前缀 > 包含 > 其它；解说 / 预告类降权，多源命中升权 */
const BADWORD = /解说|预告|花絮|片段|混剪|赏析|盘点|幕后|彩蛋|精彩看|cut|合集/i;
function relevance(e, kw) {
  const t = normTitle(e.title), k = normTitle(kw);
  let sc;
  if (t === k) sc = 1000;
  else if (t.indexOf(k) === 0) sc = 700 - Math.min(220, (t.length - k.length) * 8);
  else if (t.indexOf(k) >= 0) sc = 420 - Math.min(220, (t.length - k.length) * 6);
  else sc = 100;
  sc += Math.min(60, e.sources.length * 6);
  if (BADWORD.test(e.title)) sc -= 520;
  if (e.sources.some((x) => x.direct)) sc += 40;
  return sc;
}

const inflight = new Map();

function newAcc(kw, o) {
  return { kw, at: Date.now(), ms: 0, stats: [], items: [], top: [], total: 0, directCount: 0, partial: true, limit: o.limit || 120, byKey: new Map() };
}

function runSearch(acc, o) {
  const picked = o.sources && o.sources.length ? SOURCES.filter((x) => o.sources.indexOf(x.id) >= 0) : SOURCES;
  const t0 = Date.now();
  return Promise.all(picked.map((src) => searchSource(src, acc.kw, o.timeout || 9000)
    .then((r) => absorb(acc, r))
    .catch(() => absorb(acc, { src, ok: false, ms: 0, list: [] }))))
    .then(() => { acc.partial = false; acc.ms = Date.now() - t0; return acc; });
}

/* 先给部分结果：deadline（默认 4.5s）内谁先回来先显示，剩下的在后台继续补，补完写进缓存 */
async function searchAll(kw, opts) {
  const o = opts || {};
  const key = 'v4|' + kw + '|' + (o.limit || 120) + '|' + ((o.sources || []).slice().sort().join('.'));
  const hit = searchCache.get(key);
  if (!o.refresh && hit && Date.now() - hit.at < SEARCH_TTL) return hit.data;
  let entry = inflight.get(key);
  if (!entry || o.refresh) {
    const acc = newAcc(kw, o);
    const promise = runSearch(acc, o).then((d) => {
      searchCache.set(key, { at: Date.now(), data: d });
      inflight.delete(key);
      return d;
    }, (e) => { inflight.delete(key); throw e; });
    entry = { acc, promise };
    inflight.set(key, entry);
  }
  const wait = o.wait ? 30000 : (o.deadline == null ? 4500 : o.deadline);
  const done = await Promise.race([entry.promise, new Promise((r) => setTimeout(() => r(null), wait))]);
  return done || entry.acc;
}

/* ===================== 详情：取某源某片的完整播放链 ===================== */
async function detail(sid, id) {
  const src = SOURCES.find((s) => s.id === sid);
  if (!src) throw new Error('unknown source: ' + sid);
  const j = await getJson(apiUrl(src, { ac: 'detail', ids: id }), 15000);
  const it = j && Array.isArray(j.list) ? j.list[0] : null;
  if (!it) throw new Error('源 ' + src.name + ' 没有返回详情（片源可能已下线）');
  const groups = parsePlay(it.vod_play_from, it.vod_play_url);
  return {
    sid, sidName: src.name, id: String(it.vod_id),
    title: cleanText(it.vod_name), year: it.vod_year || '', pic: it.vod_pic || '',
    remarks: cleanText(it.vod_remarks), area: it.vod_area || '', lang: it.vod_lang || '',
    actors: cleanText(it.vod_actor), director: cleanText(it.vod_director),
    intro: cleanText(it.vod_content),
    groups,
  };
}

/* ===================== 健康检查（设置 → 信息源状态 用） ===================== */
const healthCache = { at: 0, kw: '', data: null };
const HEALTH_TTL = 5 * 60e3;

async function checkOne(src, kw) {
  const t0 = Date.now();
  const r = await searchSource(src, kw, 12000);
  const o = { id: src.id, name: src.name, tag: src.tag, api: src.api, ms: Date.now() - t0, ok: false, hits: 0, direct: 0, playable: false, note: '' };
  if (!r.ok) { o.note = '接口不可用（超时 / 非 JSON）'; return o; }
  o.hits = r.list.length;
  let sample = null;
  for (const it of r.list) {
    const g = pickDirect(parsePlay(it.vod_play_from, it.vod_play_url));
    if (g) { sample = g.episodes[0].url; break; }
  }
  o.direct = r.list.filter((it) => pickDirect(parsePlay(it.vod_play_from, it.vod_play_url))).length;
  o.ok = o.hits > 0;
  if (!o.ok) { o.note = '接口正常但没有匹配结果'; return o; }
  if (!sample) { o.note = '只返回网页分享链（需二次解析）'; return o; }
  const p = await probeStream(sample, 10000);
  o.playable = !!p.ok;
  o.res = p.res || null;
  o.note = o.playable ? ('可播 ' + (p.res ? p.res.join('x') : '未知清晰度') + ' ' + sample.slice(0, 40)) : '直链打不开 ' + sample.slice(0, 40);
  return o;
}

async function health(kw, refresh) {
  const w = kw || '庆余年';
  if (!refresh && healthCache.data && healthCache.kw === w && Date.now() - healthCache.at < HEALTH_TTL) return healthCache.data;
  const rs = await Promise.all(SOURCES.map((s) => checkOne(s, w)));
  rs.sort((a, b) => (b.playable ? 1 : 0) - (a.playable ? 1 : 0) || b.hits - a.hits);
  const data = { kw: w, at: Date.now(), sources: rs, live: rs.filter((x) => x.playable).length, total: rs.length };
  healthCache.at = Date.now(); healthCache.kw = w; healthCache.data = data;
  return data;
}

/* ===================== 直链预检：起播前先确认「主播放列表 → 分片」真的能拿到数据 ===================== */
/* 采集站经常出现「接口活着、CDN 分片已死」（实测某线路 .ts 直接挂起），盲喂 mpv 会卡在缓冲。
   预检只取第一个分片的前 4KB，1~2 秒判定，失败立刻换线路。 */
function getRange(url, timeout, bytes) {
  return new Promise((resolve) => {
    let t;
    try { t = new URL(url); } catch (e) { return resolve(null); }
    const mod = t.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: t.hostname, port: t.port || (t.protocol === 'https:' ? 443 : 80),
      path: t.pathname + t.search, method: 'GET', timeout,
      headers: { 'user-agent': UA, range: 'bytes=0-' + (bytes - 1), accept: '*/*', 'accept-encoding': 'identity' },
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && !/^https?:/i.test(r.headers.location)) {
        r.resume();
        return resolve(getRange(new URL(r.headers.location, url).toString(), timeout, bytes));
      }
      const chunks = [];
      let n = 0;
      r.on('data', (c) => { n += c.length; chunks.push(c); if (n >= bytes) { req.destroy(); resolve({ status: r.statusCode, body: Buffer.concat(chunks) }); } });
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function firstUrl(text, url) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.charAt(0) === '#') continue;
    try { return new URL(line, url).toString(); } catch (e) { return null; }
  }
  return null;
}

/* 画质按「像素量」判定（宽 × 高），理由是实测过的坑：
   · 1920x808 / 1920x1080 才是真 1080P（宽银幕裁切不该被算成低清）；
   · 1080x608（≈0.66M 像素）只是 1080 宽的半分辨率片源，像素量跟 1280x538 一个水平，算 720P 档；
   · 竖屏资源（高 > 宽，多是手机录制 / 剪辑残次品）打五折，避免被误选成画质最好的一条。 */
function resPix(res) { return res && res[0] ? res[0] * (res[1] || 0) : 0; }
function resScore(res) {
  const p = resPix(res);
  if (!p) return 0;
  return (res[1] || 0) > res[0] ? Math.round(p * 0.5) : p;
}
function resLabel(res) {
  const p = resPix(res);
  if (!p) return '';
  if (p >= 6e6) return '4K';
  if (p >= 3.2e6) return '2K';
  if (p >= 1.4e6) return '1080P';
  if (p >= 5e5) return '720P';
  return '低清';
}
function resText(res) { return res && res[0] ? res[0] + '×' + (res[1] || 0) : ''; }

/* 主播放列表里通常有多个清晰度分支；很多源把最低码率排在第一条，所以必须自己挑最高的 */
function parseMaster(text, base) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXT-X-STREAM-INF/i.test(line)) {
      const bw = /BANDWIDTH=(\d+)/i.exec(line);
      const rs = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
      cur = { bw: bw ? parseInt(bw[1], 10) : 0, w: rs ? parseInt(rs[1], 10) : 0, h: rs ? parseInt(rs[2], 10) : 0, url: '' };
      continue;
    }
    if (line.charAt(0) === '#') continue;
    if (cur) {
      try { cur.url = new URL(line, base).toString(); } catch (e) { cur = null; continue; }
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

/* 主列表没给 BANDWIDTH 时按像素量估码率（KB/s）：1080P 级 0.66M 像素 ≈ 400 KB/s，
   像素越多给得越少（码率与像素是次线性关系），4K（6.2M 像素）约 1500 KB/s。 */
function resNeed(res) {
  const p = resPix(res);
  if (!p) return 0;
  return Math.round(400 * Math.pow(p / 657000, 0.6));
}
const PROBE_BYTES = 320 * 1024;

async function probeStream(url, timeout) {
  const to = timeout || 8000;
  const t0 = Date.now();
  const r = await get(url, to);
  if (!r || r.status !== 200) return { ok: false, ms: Date.now() - t0, why: 'm3u8 打不开' };
  let text = r.body.toString('utf8');
  if (!/#EXTM3U/.test(text)) return { ok: false, ms: Date.now() - t0, why: '不是播放列表' };
  let base = url, res = null, bw = 0;
  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const vs = parseMaster(text, base);
    if (!vs.length) return { ok: false, ms: Date.now() - t0, why: '主列表没有清晰度分支' };
    const top = vs.slice().sort((a, b) => (resScore(b) - resScore(a)) || (b.bw - a.bw))[0];
    const r2 = await get(top.url, to);
    if (!r2 || r2.status !== 200) return { ok: false, ms: Date.now() - t0, why: '清晰度列表打不开' };
    text = r2.body.toString('utf8');
    base = top.url;
    res = top.w ? [top.w, top.h] : null;
    bw = top.bw;
  }
  const seg = firstUrl(text, base);
  if (!seg) return { ok: false, ms: Date.now() - t0, why: '列表里没有分片' };
  /* 光「拿得到分片」不够：还要量一把真实下载速度。4K 分片动辄 15~25 Mbps，
     线路带宽不够时选到 4K 只会一直转圈，必须提前拦掉。 */
  const t1 = Date.now();
  const head = await getRange(seg, Math.min(to, 9000), PROBE_BYTES);
  const dms = Math.max(1, Date.now() - t1);
  const got = head && head.body ? head.body.length : 0;
  const okHead = !!(head && head.status >= 200 && head.status < 300 && got > 0);
  const kbs = got > 2000 ? Math.round(got / (dms / 1000) / 1024) : 0;
  const need = bw ? Math.round(bw / 8000) : resNeed(res);
  let ok = okHead, slow = false, why = okHead ? '正常' : '分片拿不到数据';
  if (okHead && need && kbs && kbs < need * 0.5) {
    ok = false;
    why = '带宽不够（实测 ' + kbs + ' KB/s，需要约 ' + need + ' KB/s）';
  } else if (okHead && need && kbs && kbs < need * 1.15) {
    slow = true;
    why = '带宽偏紧（' + kbs + ' KB/s，需要约 ' + need + ' KB/s）';
  }
  return { ok, ms: Date.now() - t0, why, res, bw, kbs, need, slow, seg: seg.slice(0, 90) };
}

/* 多条线路里挑画质最好的：分辨率 > 码率 > 响应快 */
function pickBest(oks) {
  return oks.slice().sort((a, b) => ((a.slow ? 1 : 0) - (b.slow ? 1 : 0))
    || (resScore(b.res) - resScore(a.res)) || ((b.bw || 0) - (a.bw || 0)) || ((a.ms || 0) - (b.ms || 0)))[0];
}

/* 候选线路并发预检：并发探一遍所有候选线路，挑像素量最高的那条。
   minP = 画质下限（像素量）：有线路达标就算达标；一条都没有时降级取最高的一条并标 belowFloor。
   等待策略：4K 档最多等 8s（4K 源回得慢，值得等）；普通下限 3.5s；不限画质就 1.5s 收工。 */
async function pickPlayable(cands, opts) {
  const opt = opts || {};
  const minP = Number(opt.minP != null ? opt.minP : (opt.minW != null ? opt.minW : opt.minH)) || 0;
  const capMs = minP >= 6e6 ? 8000 : (minP > 0 ? 3500 : 1500);
  const list = (cands || []).filter((c) => c && c.url);
  if (!list.length) return { ok: false, error: '没有可用线路', cands: [] };
  const reports = list.map((c) => ({ name: c.name, sid: c.sid, url: c.url, ok: null, ms: 0, why: '检测中', res: null }));
  const results = [];
  const proms = list.map((c, i) => probeStream(c.url, 8000).then((p) => {
    const item = Object.assign({}, c, p);
    results.push(item);
    reports[i] = { name: c.name, sid: c.sid, url: c.url, ok: !!p.ok, ms: p.ms, why: p.why, res: p.res || null, kbs: p.kbs || 0, need: p.need || 0, slow: !!p.slow };
    return item;
  }).catch(() => {
    const item = Object.assign({}, c, { ok: false });
    results.push(item);
    reports[i] = { name: c.name, sid: c.sid, url: c.url, ok: false, ms: 0, why: '预检异常', res: null, kbs: 0, need: 0, slow: false };
    return item;
  }));
  const best = await new Promise((resolve) => {
    let settled = 0, t0 = 0, timer = null;
    const finish = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const oks = results.filter((x) => x && x.ok);
      if (!oks.length) return resolve(null);
      let pool = oks;
      if (minP > 0) {
        const hi = oks.filter((x) => resPix(x.res) >= minP);
        if (hi.length) pool = hi;
      }
      /* 达标线路清一色带宽偏紧 → 与其选个一直转圈的 4K，不如退一档给个能流畅播的 */
      let speedFallback = false;
      if (!pool.some((x) => !x.slow)) {
        const smooth = oks.filter((x) => !x.slow);
        if (smooth.length) { pool = smooth; speedFallback = true; }
      }
      const b = pickBest(pool);
      b.belowFloor = !!(minP > 0 && resPix(b.res) < minP);
      b.floor = minP;
      b.speedFallback = speedFallback;
      return resolve(b);
    };
    /* 没有画质下限：第一条通过后多等 1.5s 收集其它线路即可。
       有画质下限：先等 2.4s；若没有一条达到下限就继续等，直到 capMs，
       避免「高清线路回得慢 → 提前收工选到低清」这种坑。 */
    const check = () => {
      timer = null;
      const oks = results.filter((x) => x && x.ok);
      if (!oks.length) {
        if (settled === proms.length) return finish();
        timer = setTimeout(check, 500);
        return;
      }
      if (minP > 0 && settled < proms.length && Date.now() - t0 < capMs
        && !oks.some((x) => resPix(x.res) >= minP)) {
        timer = setTimeout(check, 600);
        return;
      }
      finish();
    };
    proms.forEach((p) => p.then(() => {
      settled++;
      if (!t0) t0 = Date.now();
      if (settled === proms.length) { if (timer) { clearTimeout(timer); timer = null; } return finish(); }
      if (!timer) timer = setTimeout(check, minP > 0 ? 2400 : 1500);
    }));
  });
  return { ok: !!best, best, cands: reports, error: best ? '' : '这些线路都没通过预检（采集站分片失效，换一部或换一集）' };
}
module.exports = { SOURCES, searchAll, detail, health, parsePlay, pickDirect, isDirect, probeStream, pickPlayable, pickBest, resScore, resPix, resLabel, resText, get, getRange };
