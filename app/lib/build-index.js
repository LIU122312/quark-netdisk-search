// build-index.js —— 扫描 lib/aliyunpanshare 下的 markdown，生成 index.json
// 用法：node build-index.js        （git pull 之后再跑一次即可刷新）
//
// 索引字段：
//   n  显示标题（已去掉排序字母前缀 / 短剧编号前缀）
//   k  检索键（小写、去标点、去年份，用于匹配）
//   u  分享链接   p  网盘类型   d  日期   t  资源类型   c  分类
//   sd 1=疑似短剧合集    ar 1=来自“更新历史”归档
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'aliyunpanshare');
const OUT  = path.join(__dirname, 'index.json');

const URL_RE  = /https?:\/\/[^\s|)\]"'<>]+/g;
const SITE_RE = /(pan\.quark\.cn|alipan\.com|aliyundrive\.com|pan\.baidu\.com|115\.com|cloud\.189\.cn|123pan\.com|mypikpak\.com)/i;
const SPAM_RE = /免费观看|在线观看|网盘资源|无删减|高清完整版|点击下载/;
// 短剧识别：只有“集数 >= 50”且不是有声书/纪录片/课程类的才算短剧
const NOT_DRAMA_RE = /有声小说|有声书|广播剧|听书|评书|相声|纪录片|公开课|讲座|课程|动画片|动漫|儿歌|绘本/;
const EP_RE = /[（(]\s*(?:全|共)?\s*(\d{2,4})\s*集/;
function isShortDrama(rawTitle) {
  if (/短剧/.test(rawTitle)) return 1;
  if (NOT_DRAMA_RE.test(rawTitle)) return 0;
  const m = rawTitle.match(EP_RE);
  if (!m) return 0;
  return (+m[1] >= 50) ? 1 : 0;
}

function provider(u) {
  if (/pan\.quark\.cn/i.test(u))               return 'quark';
  if (/alipan\.com|aliyundrive\.com/i.test(u)) return 'ali';
  if (/pan\.baidu\.com/i.test(u))              return 'baidu';
  if (/(^|\.)115\.com/i.test(u))               return '115';
  if (/cloud\.189\.cn/i.test(u))               return 'tianyi';
  if (/123pan\.com/i.test(u))                  return '123';
  if (/mypikpak\.com/i.test(u))                return 'pikpak';
  return 'other';
}

// F繁花2023 -> 繁花2023 ；Z周星驰电影合集2026 -> 周星驰电影合集2026
function cleanTitle(s) {
  return String(s || '').trim().replace(/^[A-Za-z](?=[\u4e00-\u9fa5])/, '').trim();
}
// 短剧条目形如 "43.开局暴打村霸，狂飙1988（80集）孙钰哲＆郭佑2026"
function cleanDrama(s) {
  return String(s || '').replace(/^\d+[.、]\s*/, '').trim();
}
function searchKey(s) {
  return String(s || '').toLowerCase()
    .replace(/[_\-·・:：,，、.。!！?？'"“”‘’()（）\[\]【】&＆+]/g, ' ')
    .replace(/20\d{2}/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const CAT_PRI = {
  '今日更新合集': 0, '今日新增合集': 0,
  '最近热播电影': 1, '最近热播电视剧': 1, '最近热播综艺': 1,
  '最新美剧合集': 2,
  '经典合集': 3,
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

function parseFile(text, rel, cat, pri, ar) {
  const items = [];
  let cols = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    let cells = line.split('|');
    if (cells.length && cells[0].trim() === '') cells.shift();
    if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
    cells = cells.map(c => c.trim());
    if (!cells.length) continue;
    if (cells.every(c => c === '' || /^[-:]+$/.test(c))) continue;

    const urls = (cells.join('|').match(URL_RE) || []).map(u => u.replace(/[.,;，。]+$/, ''));
    const url = urls.find(u => SITE_RE.test(u));
    if (!url) {
      if (cells.some(c => /资源名称|分享链接/.test(c))) {
        cols = {
          title: cells.findIndex(c => /资源名称|名称|标题/.test(c)),
          date:  cells.findIndex(c => /发布时间|更新时间|日期/.test(c)),
          type:  cells.findIndex(c => /资源类型|类型/.test(c)),
        };
      }
      continue;
    }
    const pick = (i) => (cols && i >= 0 && i < cells.length) ? cells[i] : '';
    let rawTitle = pick(cols ? cols.title : 0) || cells.filter(c => !SITE_RE.test(c))[0] || '';
    if (SPAM_RE.test(rawTitle)) continue;

    const sd = isShortDrama(rawTitle);
    let name = cleanTitle(rawTitle);
    if (sd) name = cleanDrama(name);
    if (!name) continue;

    items.push({
      n: name,
      k: searchKey(name),
      u: url,
      c: cat,
      t: pick(cols ? cols.type : -1),
      d: pick(cols ? cols.date : -1),
      p: provider(url),
      sd, ar, pri,
    });
  }
  return items;
}

function main() {
  if (!fs.existsSync(ROOT)) { console.error('找不到目录: ' + ROOT); process.exit(1); }
  const files = walk(ROOT, []);
  let all = [];
  for (const full of files) {
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    const base = path.basename(full, '.md');
    let cat, pri, ar = 0;
    const m = rel.match(/^更新历史\/(\d{6})\//);
    if (m) { cat = '历史归档·' + m[1]; pri = 5; ar = 1; }
    else { cat = base; pri = (CAT_PRI[base] === undefined ? 4 : CAT_PRI[base]); }
    all = all.concat(parseFile(fs.readFileSync(full, 'utf8'), rel, cat, pri, ar));
  }

  const byUrl = new Map();
  for (const it of all) {
    const prev = byUrl.get(it.u);
    if (!prev) { byUrl.set(it.u, it); continue; }
    const better = (it.sd < prev.sd) || (it.sd === prev.sd && it.ar < prev.ar) ||
                   (it.sd === prev.sd && it.ar === prev.ar && it.pri < prev.pri);
    if (better) byUrl.set(it.u, it);
  }
  const list = [...byUrl.values()];
  list.sort((a, b) => (a.sd - b.sd) || (a.ar - b.ar) || (a.pri - b.pri) || String(b.d).localeCompare(String(a.d)));

  const idx = list.map(({ n, k, u, c, p, d, t, sd, ar }) => ({ n, k, u, c, p, d, t, sd, ar }));
  const meta = { built: new Date().toISOString(), total: idx.length, files: files.length };
  fs.writeFileSync(OUT, JSON.stringify({ meta, items: idx }), 'utf8');

  const q = idx.filter(x => x.p === 'quark').length;
  const sd = idx.filter(x => x.sd).length;
  const ar = idx.filter(x => x.ar).length;
  const clean = idx.filter(x => !x.sd && !x.ar && x.p === 'quark').length;
  console.log('files        : ' + files.length);
  console.log('raw links    : ' + all.length);
  console.log('unique       : ' + idx.length + '   (quark ' + q + ')');
  console.log('short-drama  : ' + sd);
  console.log('from archive : ' + ar);
  console.log('CLEAN quark  : ' + clean + '   <- 主力集合：非短剧 + 非归档 + 夸克');
  console.log('index.json   : ' + (fs.statSync(OUT).size / 1048576).toFixed(2) + ' MB');
}
main();
