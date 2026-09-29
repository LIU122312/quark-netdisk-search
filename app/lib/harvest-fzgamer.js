#!/usr/bin/env node
/**
 * harvest-fzgamer.js —— 抓「方舟游戏 fzgamer.com」的夸克通道，生成 lib/games.json
 *
 *   node harvest-fzgamer.js --limit 300 [--cat 1,726] [--conc 5]
 *
 * 每个游戏页：解析 pay-download 的 key → 试 down_id=0..3，取 302 到 pan.quark.cn 的那个。
 * 断点续跑：已处理过的文章记在 lib/games-cache.json，重跑会跳过（--refresh 可强制）。
 */
const https = require('https'), zlib = require('zlib'), fs = require('fs'), path = require('path');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const HOST = 'www.fzgamer.com';
const DIR = __dirname;
const OUT = path.join(DIR, 'games.json');
const CACHE = path.join(DIR, 'games-cache.json');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('limit', '300'), 10);
const CONC = parseInt(arg('conc', '5'), 10);
const DELAY = parseInt(arg('delay', '300'), 10);
const CATS = arg('cat', '1,726');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getRetry(url, ms, raw, tries) {
  let last = null;
  for (let i = 0; i < (tries || 3); i++) {
    const r = await get(url, ms, raw);
    if (r.status === 200 || (raw && r.status >= 300 && r.status < 400)) return r;
    last = r; await sleep(900 + i * 1200);
  }
  return last || { status: 0, err: 'unknown' };
}
function get(url, ms, raw) {
  return new Promise((res) => {
    const u = new URL(url);
    const r = https.get({ host: u.host, path: u.pathname + u.search, headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, timeout: ms || 25000 }, (x) => {
      let buf = []; const enc = x.headers['content-encoding'] || '';
      x.on('data', (d) => buf.push(d));
      x.on('end', () => {
        if (raw) { res({ status: x.statusCode, loc: x.headers.location }); return; }
        let b = Buffer.concat(buf);
        try { if (enc === 'gzip') b = zlib.gunzipSync(b); else if (enc === 'br') b = zlib.brotliDecompressSync(b); } catch (e) { }
        res({ status: x.statusCode, body: b.toString('utf8'), h: x.headers });
      });
    });
    r.on('error', (e) => res({ status: 0, err: e.message }));
    r.on('timeout', () => { r.destroy(); res({ status: 0, err: 'TIMEOUT' }); });
  });
}
const decode = (s) => String(s || '').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
function searchKey(s) {
  return String(s || '').toLowerCase().replace(/[_\-·・:：,，、.。!！?？'"“”‘’()（）\[\]【】&＆+/\\]/g, ' ').replace(/20\d{2}/g, ' ').replace(/\s+/g, ' ').trim();
}
const safeDec = (x) => { try { return decodeURIComponent(x); } catch (e) { return x; } };
function coverOf(b) { const m = b.match(/property="og:image"[^>]*content="([^"]+)"/) || b.match(/<img[^>]+src="(https:\/\/img\.fzyx\.top[^"]+)"/); return m ? m[1] : ''; }
function metaOf(b) {
  const g = (re) => { const m = b.match(re); return m ? decode(m[1]) : ''; };
  const kw = g(/<meta name="keywords" content="([^"]*)"/);
  const desc = g(/<meta property="og:description" content="([^"]*)"/) || g(/<meta name="description" content="([^"]*)"/);
  const tags = [...new Set((b.match(/\/tag\/[^"'#?]+/g) || []).map((x) => safeDec(x.replace(/^\/tag\//, ''))))].slice(0, 12);
  const cats = [...new Set((b.match(/\/category\/[^"'#?]+/g) || []).map((x) => safeDec(x.replace(/^\/category\//, ''))))].slice(0, 6);
  const kwList = kw ? kw.split(/[,\uff0c]/).map((x) => x.trim()).filter(Boolean) : [];
  const ver = (b.match(/Build\.\d+/) || b.match(/\bv\d[\d.]{2,}(?=\||<|\s)/) || [])[0] || g(/(?:游戏版本|版本)[：:]\s*(v?\d[\d.]{1,12})/);
  return {
    version: ver,
    size: (b.match(/容量\s*([\d.]+\s*(?:TB|GB|MB|G|M))/i) || b.match(/容量\s*([\d.]+\s*(?:TB|GB|MB|G|M))/i) || b.match(/(?:游戏大小|安装大小)[：:]\s*([\d.]+\s*(?:TB|GB|MB|G|M))/i) || [])[1] || '',
    released: (b.match(/发行日期[:：]\s*(\d{4})年?/) || [])[1] || '',
    tags: tags.length ? tags : kwList.slice(0, 12),
    cats: cats.length ? cats : kwList.slice(-3),
    genres: kwList,
  };
}
async function resolveQuark(postId, key) {
  for (const id of [0, 1, 2, 3]) {
    const r = await getRetry('https://' + HOST + '/pay-download/' + postId + '?key=' + key + '&down_id=' + id, 15000, true, 2);
    const loc = r.loc || '';
    if (/pan\.quark\.cn\/s\//i.test(loc)) return { quark: loc.replace(/&amp;/g, '&'), id };
  }
  return null;
}
function loadJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }

(async () => {
  const cache = loadJson(CACHE, { done: {}, items: [] });
  const t0 = Date.now();
  const posts = [];
  const per = 100;
  for (let page = 1; posts.length < LIMIT; page++) {
    const r = await getRetry('https://' + HOST + '/wp-json/wp/v2/posts?per_page=' + per + '&page=' + page + '&categories=' + encodeURIComponent(CATS) + '&orderby=modified&order=desc&_fields=id,link,title,date,modified,categories', 25000, false, 4);
    if (r.status !== 200) { console.log('列表页 ' + page + ' 返回 ' + r.status + ' ' + (r.err || '') + '，停止'); break; }
    let arr; try { arr = JSON.parse(r.body); } catch (e) { break; }
    if (!arr.length) break;
    for (const p of arr) posts.push(p);
    console.log('  列表 page ' + page + ' 累计 ' + posts.length + ' 篇（站内共 ' + (r.h['x-wp-total'] || '?') + '）');
  }
  const todo = posts.slice(0, LIMIT).filter((p) => !cache.done[p.id]);
  console.log('待处理 ' + todo.length + ' 篇（已缓存 ' + Object.keys(cache.done).length + '）');

  let i = 0, ok = 0, fail = 0;
  async function worker(n) {
    while (i < todo.length) {
      const p = todo[i++];
      try {
        const page = await getRetry(p.link, 30000, false, 3);
        if (page.status !== 200) { fail++; cache.done[p.id] = 1; console.log('  [页面 ' + page.status + ' ' + (page.err || '') + '] ' + p.link); continue; }
        const m = page.body.match(/pay-download\/(\d+)\?key=([a-f0-9]+)/);
        if (!m) { fail++; cache.done[p.id] = 1; console.log('  [无下载入口] ' + p.link); continue; }
        const q = await resolveQuark(m[1], m[2]);
        await sleep(DELAY);
        const meta = metaOf(page.body);
        const title = decode((p.title && p.title.rendered) || '');
        if (q) {
          cache.items.push({
            n: title, k: searchKey(title), u: q.quark, c: '方舟游戏', p: 'quark',
            d: String(p.date || '').replace('T', ' ').slice(0, 16), t: '游戏', sd: 0, ar: 0,
            page: p.link, cover: coverOf(page.body), ver: meta.version, size: meta.size,
            tags: meta.tags, genres: meta.cats, down_id: q.id, mod: String(p.modified || '').slice(0, 10),
          });
          ok++;
        } else { fail++; console.log('  [无夸克通道] ' + title); }
        cache.done[p.id] = 1;
      } catch (e) { fail++; console.log('  [异常] ' + (e && e.stack ? e.stack.split('\n').slice(0,2).join(' | ') : e)); }
      if ((ok + fail) % 25 === 0) {
        const el = (Date.now() - t0) / 1000;
        console.log('  进度 ' + (ok + fail) + '/' + todo.length + '  成功 ' + ok + '  失败 ' + fail + '  ' + el.toFixed(0) + 's  预计剩余 ' + (((todo.length - ok - fail) * el / Math.max(1, ok + fail))).toFixed(0) + 's');
        fs.writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
        fs.writeFileSync(OUT, JSON.stringify({ meta: { source: 'fzgamer.com', built: new Date().toISOString(), total: cache.items.length, partial: true }, items: cache.items }), 'utf8');
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, (_, k) => worker(k)));
  fs.writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
  fs.writeFileSync(OUT, JSON.stringify({ meta: { source: 'fzgamer.com', built: new Date().toISOString(), total: cache.items.length }, items: cache.items }, null, 0), 'utf8');
  console.log('\n完成：成功 ' + ok + '，失败 ' + fail + '，games.json 现有 ' + cache.items.length + ' 条，用时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  console.log('样例：' + JSON.stringify(cache.items.slice(-2), null, 1).slice(0, 500));
})();