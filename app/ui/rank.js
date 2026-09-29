/* ===================== 排行榜数据层 =====================
   源（全部免费、无需 key，均已实测）：
     动漫·Bangumi  POST api.bgm.tv/v0/search/subjects  （tag 多选，sort=rank+rank:[">0"] 出真实名次；单请求上限 20 条）
     动漫·豆瓣     movie.douban.com/j/chart/top_list   （type=25 动画，区间 100:90/90:80/80:70，单区间一次可拉全量）
     小说·Bangumi  POST api.bgm.tv/v0/search/subjects  （type=1 书籍）
     小说·豆瓣图书  m.douban.com/rexxar .../book/recommend 与 subject_collection/book_top250|book_hot
     游戏·Bangumi  POST api.bgm.tv/v0/search/subjects  （type=4 游戏）
     游戏·方舟游戏  lib/games.json（本地离线库，条目自带夸克链接）
     电影/剧集     豆瓣 m.douban.com/rexxar subject_collection（固定榜单）
   缓存：lib/rank-cache.json
   ======================================================== */
const https = require('https');
const http = require('http');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'lib', 'rank-cache.json');
const PROXY_HOST = process.env.RANK_PROXY_HOST || '127.0.0.1';
const PROXY_PORT = parseInt(process.env.RANK_PROXY_PORT || '7897', 10);

const BGM_UA = 'codex-quark-search/1.0 (https://github.com/Yaozhil)';
const DB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TTL_BGM = 12 * 3600e3;
const TTL_DB = 6 * 3600e3;
const TTL_POOL = 12 * 3600e3;

/* ============ 统一筛选器定义：每个分类下多个来源，每个来源有自己的产地/题材 ============ */
const MOVIE_DB_R = ['中国大陆', '美国', '日本', '韩国', '中国香港', '中国台湾', '英国', '法国', '德国', '意大利', '西班牙', '印度', '泰国'];
const MOVIE_DB_G = ['剧情', '喜剧', '动作', '爱情', '科幻', '动画', '悬疑', '惊悚', '恐怖', '犯罪', '奇幻', '冒险', '战争', '历史', '传记', '家庭', '儿童', '音乐', '歌舞', '运动', '武侠', '灾难', '西部', '纪录片', '短片'];
const TV_DB_R = ['国产剧', '美剧', '英剧', '日剧', '韩剧', '港剧', '台剧', '泰剧'];
const TV_DB_G = ['剧情', '喜剧', '爱情', '悬疑', '犯罪', '科幻', '奇幻', '古装', '动作', '战争', '历史', '家庭', '青春', '武侠', '惊悚', '恐怖', '传记', '灾难', '冒险', '音乐', '歌舞', '纪录片', '真人秀'];
const MOVIE_BGM_R = ['日本', '美国', '中国', '韩国', '英国', '法国', '德国'];
const MOVIE_BGM_G = ['剧情', '科幻', '悬疑', '动作', '喜剧', '爱情', '犯罪', '奇幻', '冒险', '战争', '历史', '动画', '恐怖', '惊悚', '音乐', '家庭'];
const TV_BGM_R = ['日本', '美国', '中国', '韩国', '英国'];
const TV_BGM_G = ['剧情', '科幻', '悬疑', '动作', '喜剧', '爱情', '犯罪', '奇幻', '历史', '战争', '家庭', '古装'];

const BGM_TIP = '名次为 Bangumi 全站排名；题材多选为「同时满足」';
const DB_TIP = '按豆瓣评分排序；题材多选为「同时满足」';
/* 网文：豆瓣图书「网络小说」系标签 + Bangumi 书籍 */
const WEB_G = ['网络小说', '玄幻', '仙侠', '言情', '都市', '武侠', '轻小说', '奇幻', '科幻'];
const WEB_BGM_G = ['轻小说', '奇幻', '恋爱', '小说'];
const WEB_TIP = '按豆瓣评分排序；题材多选为「同时满足」';
/* 传统文学 */
const LIT_R = ['中国文学', '日本文学', '欧美文学', '外国文学', '美国文学', '英国文学', '法国文学', '俄国文学'];
const LIT_G = ['小说', '经典', '中国文学', '日本文学', '欧美文学', '外国文学', '散文', '诗歌', '传记', '推理', '社会', '哲学', '历史', '纪实', '随笔', '科幻'];
const LIT_BGM_G = ['小说', '文学', '推理', '科幻', '奇幻'];
const LIT_TIP = '按豆瓣评分排序；题材多选为「同时满足」';
/* 漫画：豆瓣图书「漫画/绘本/画集」+ Bangumi 书籍 */
const COMIC_R = ['日本漫画', '欧美漫画'];
const COMIC_G = ['漫画', '绘本', '画集', '日本漫画'];
const COMIC_BGM_G = ['漫画', '画集', '绘本'];
const COMIC_TIP = '按豆瓣评分排序；题材多选为「同时满足」';
/* 音乐：Bangumi 音乐（type=3，全站排名）+ 豆瓣热门音乐榜 */
const MUSIC_G = ['动画歌曲', 'J-Pop', '摇滚', '原声', '游戏音乐', '电子', '古典', '爵士'];
const MUSIC_TIP = '名次为 Bangumi 全站排名；题材多选为「同时满足」';

/* 游戏：Bangumi 游戏（平台 + 类型）；方舟游戏为本地离线库，条目自带夸克链接 */
const GAME_BGM_G = ['PC', 'Switch', 'PS4', 'PS5', 'Galgame', '独立游戏', '角色扮演', '动作', '冒险', '射击', '模拟', '策略', '体育', '解谜'];
const LOCAL_GAME_TIP = '本地离线库：方舟游戏整站种子表，条目直接带夸克链接，点封面即搜';
const WEB_DEFAULT_TAGS = ['网络小说', '玄幻', '仙侠', '言情', '都市', '轻小说', '武侠', '科幻'];
const LIT_DEFAULT_TAGS = ['小说', '经典', '中国文学', '外国文学', '推理', '散文', '历史', '社会'];
const COMIC_DEFAULT_TAGS = ['漫画', '绘本', '画集', '日本漫画'];
const SRC_DEF = {
  anime: [
    { id: 'bgm', name: 'Bangumi', tip: BGM_TIP, regions: [{ n: '国漫', t: '中国' }, { n: '日漫', t: '日本' }, { n: '欧美', t: '美国' }], genres: ['热血', '科幻', '奇幻', '恋爱', '日常', '搞笑', '治愈', '悬疑', '校园', '机战', '运动', '音乐', '历史'], kind: 'bgmAnime' },
    { id: 'db', name: '豆瓣', tip: '按豆瓣评分排序；取自豆瓣 7 分以上动画库', regions: ['中国大陆', '日本', '美国', '欧美', '韩国'], genres: ['剧情', '冒险', '奇幻', '喜剧', '动作', '科幻', '家庭', '爱情', '悬疑', '音乐', '歌舞', '惊悚', '犯罪', '战争', '儿童', '历史'], kind: 'dbAnime' },
  ],
  movie: [
    { id: 'db', name: '豆瓣', tip: DB_TIP, regions: MOVIE_DB_R, genres: MOVIE_DB_G, kind: 'dbRec', type: 'movie' },
    { id: 'bgm', name: 'Bangumi', tip: BGM_TIP, regions: MOVIE_BGM_R, genres: MOVIE_BGM_G, kind: 'bgmReal', base: '电影' },
    { id: 'board', name: '固定榜单', tip: 'Top250 / 口碑榜 / 院线', kind: 'board' },
  ],
  tv: [
    { id: 'db', name: '豆瓣', tip: DB_TIP, regions: TV_DB_R, genres: TV_DB_G, kind: 'dbRec', type: 'tv' },
    { id: 'bgm', name: 'Bangumi', tip: BGM_TIP, regions: TV_BGM_R, genres: TV_BGM_G, kind: 'bgmReal', base: '电视剧' },
    { id: 'board', name: '固定榜单', tip: '口碑榜 / 分类榜', kind: 'board' },
  ],
  /* ---- 网文 ---- */
  webfiction: [
    { id: 'db', name: '豆瓣图书', tip: WEB_TIP, regions: [], genres: WEB_G, kind: 'dbBook', defaultTags: WEB_DEFAULT_TAGS },
    { id: 'bgm', name: 'Bangumi', tip: BGM_TIP, regions: [], genres: WEB_BGM_G, kind: 'bgmType', typeId: 1, baseTags: ['轻小说'] },
    { id: 'board', name: '固定榜单', tip: '图书Top250 / 热门图书', kind: 'board' },
  ],
  /* ---- 传统文学 ---- */
  litfic: [
    { id: 'db', name: '豆瓣图书', tip: LIT_TIP, regions: LIT_R, genres: LIT_G, kind: 'dbBook', defaultTags: LIT_DEFAULT_TAGS },
    { id: 'bgm', name: 'Bangumi', tip: BGM_TIP, regions: [], genres: LIT_BGM_G, kind: 'bgmType', typeId: 1, baseTags: ['小说'] },
    { id: 'board', name: '固定榜单', tip: '图书Top250 / 热门图书', kind: 'board' },
  ],
  /* ---- 漫画 ---- */
  comic: [
    { id: 'db', name: '豆瓣图书', tip: COMIC_TIP, regions: COMIC_R, genres: COMIC_G, kind: 'dbBook', defaultTags: COMIC_DEFAULT_TAGS },
    { id: 'bgm', name: 'Bangumi', tip: BGM_TIP, regions: [], genres: COMIC_BGM_G, kind: 'bgmType', typeId: 1, baseTags: ['漫画'] },
    { id: 'board', name: '固定榜单', tip: '图书Top250 / 热门图书', kind: 'board' },
  ],
  /* ---- 音乐 ---- */
  music: [
    { id: 'bgm', name: 'Bangumi', tip: MUSIC_TIP, regions: [], genres: MUSIC_G, kind: 'bgmType', typeId: 3 },
    { id: 'board', name: '固定榜单', tip: '豆瓣热门音乐', kind: 'board' },
  ],
  /* ---- 游戏 ---- */
  game: [
    { id: 'local', name: '方舟游戏', tip: LOCAL_GAME_TIP, regions: [], genres: [], kind: 'localGame', maxPages: 300, local: true },
    { id: 'bgm', name: 'Bangumi', tip: BGM_TIP, regions: [], genres: GAME_BGM_G, kind: 'bgmType', typeId: 4 },
  ],
};
const CAT_SRC = { anime: 'bgm', movie: 'db', tv: 'db', webfiction: 'db', litfic: 'db', comic: 'db', music: 'bgm', game: 'local' };
const WEST = ['美国', '英国', '法国', '德国', '意大利', '西班牙', '加拿大', '澳大利亚', '新西兰', '爱尔兰', '瑞典', '丹麦', '挪威', '芬兰', '荷兰', '比利时', '奥地利', '瑞士', '俄罗斯', '波兰', '捷克', '冰岛', '墨西哥', '巴西', '阿根廷', '南非'];

/* ============ 电影/剧集：豆瓣固定榜单 ============ */
const BOARDS = {
  movie: [
    { group: '榜单', id: 'db_top250', name: 'Top250', kind: 'douban', slug: 'movie_top250', ttl: 24 * 3600e3 },
    { group: '榜单', id: 'db_weekly', name: '一周口碑榜', kind: 'douban', slug: 'movie_weekly_best', ttl: 3 * 3600e3 },
    { group: '院线', id: 'db_showing', name: '正在热映', kind: 'douban', slug: 'movie_showing', ttl: 3 * 3600e3 },
    { group: '院线', id: 'db_soon', name: '即将上映', kind: 'douban', slug: 'movie_soon', ttl: 3 * 3600e3 },
  ],
  tv: [
    { group: '口碑榜', id: 'db_tv_global', name: '全球口碑', kind: 'douban', slug: 'tv_global_best_weekly', ttl: 3 * 3600e3 },
    { group: '口碑榜', id: 'db_tv_cn', name: '华语口碑', kind: 'douban', slug: 'tv_chinese_best_weekly', ttl: 3 * 3600e3 },
    { group: '分类', id: 'db_tv_domestic', name: '国产剧', kind: 'douban', slug: 'tv_domestic', ttl: TTL_DB },
    { group: '分类', id: 'db_tv_american', name: '美剧', kind: 'douban', slug: 'tv_american', ttl: TTL_DB },
    { group: '分类', id: 'db_tv_japanese', name: '日剧', kind: 'douban', slug: 'tv_japanese', ttl: TTL_DB },
    { group: '分类', id: 'db_tv_korean', name: '韩剧', kind: 'douban', slug: 'tv_korean', ttl: TTL_DB },
    { group: '分类', id: 'db_tv_documentary', name: '纪录片', kind: 'douban', slug: 'tv_documentary', ttl: TTL_DB },
    { group: '分类', id: 'db_tv_variety', name: '综艺', kind: 'douban', slug: 'tv_variety_show', ttl: TTL_DB },
  ],
  webfiction: [
    { group: '榜单', id: 'db_book_top250', name: '图书 Top250', kind: 'doubanBook', slug: 'book_top250', ttl: 24 * 3600e3 },
    { group: '榜单', id: 'db_book_hot', name: '热门图书', kind: 'doubanBook', slug: 'book_hot', ttl: TTL_DB },
  ],
  litfic: [
    { group: '榜单', id: 'db_book_top250', name: '图书 Top250', kind: 'doubanBook', slug: 'book_top250', ttl: 24 * 3600e3 },
    { group: '榜单', id: 'db_book_hot', name: '热门图书', kind: 'doubanBook', slug: 'book_hot', ttl: TTL_DB },
  ],
  comic: [
    { group: '榜单', id: 'db_book_top250', name: '图书 Top250', kind: 'doubanBook', slug: 'book_top250', ttl: 24 * 3600e3 },
    { group: '榜单', id: 'db_book_hot', name: '热门图书', kind: 'doubanBook', slug: 'book_hot', ttl: TTL_DB },
  ],
  music: [
    { group: '榜单', id: 'db_music_hot', name: '热门音乐', kind: 'doubanMusic', slug: 'music_hot', ttl: TTL_DB },
  ],
  game: [],
};

const CAT_NAME = { anime: '动漫', movie: '电影', tv: '剧集', webfiction: '网文', litfic: '传统文学', comic: '漫画', music: '音乐', game: '游戏' };

/* ---------- HTTP：直连优先，失败回退 Clash HTTP CONNECT 代理 ---------- */
function reqDirect(url, headers, timeoutMs, asBuffer, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = Object.assign({}, headers);
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ host: u.hostname, port: 443, path: u.pathname + u.search, method: body ? 'POST' : 'GET', headers: h, agent: false }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode));
        resolve(asBuffer ? buf : buf.toString('utf8'));
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function connectViaProxy(host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: PROXY_HOST, port: PROXY_PORT, method: 'CONNECT', path: host + ':' + port,
      headers: { 'Proxy-Connection': 'keep-alive' }, agent: false,
    });
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('proxy ' + res.statusCode)); }
      socket.setTimeout(0);
      if (head && head.length) socket.unshift(head);
      resolve(socket);
    });
    req.once('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('proxy connect timeout')));
    req.end();
  });
}

async function reqViaProxy(url, headers, timeoutMs, asBuffer, body) {
  const u = new URL(url);
  const raw = await connectViaProxy(u.hostname, 443);
  const tlsSock = tls.connect({ socket: raw, servername: u.hostname });
  await new Promise((res, rej) => {
    tlsSock.once('secureConnect', res);
    tlsSock.once('error', rej);
    tlsSock.setTimeout(10000, () => rej(new Error('tls timeout')));
  });
  tlsSock.setTimeout(0);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = () => tlsSock;   // agent:false 会忽略 createConnection，必须挂在 agent 上
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ host: u.hostname, port: 443, path: u.pathname + u.search, method: body ? 'POST' : 'GET', headers: h, agent }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(asBuffer ? c : Buffer.from(c, 'utf8')));
      r.on('end', () => {
        tlsSock.destroy();
        if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode));
        const buf = Buffer.concat(chunks);
        resolve(asBuffer ? buf : buf.toString('utf8'));
      });
    });
    req.setTimeout(timeoutMs, () => { tlsSock.destroy(); req.destroy(new Error('timeout')); });
    req.once('error', (e) => { tlsSock.destroy(); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

const proxySticky = new Set();
const domOf = (h) => h.split('.').slice(-2).join('.');
async function getText(url, headers, timeoutMs, body) {
  const t = timeoutMs || 15000;
  const dom = domOf(new URL(url).hostname);
  if (proxySticky.has(dom)) {
    return { body: await reqViaProxy(url, headers, t, false, body), via: 'proxy' };
  }
  try {
    return { body: await reqDirect(url, headers, Math.min(t, 4000), false, body), via: 'direct' };
  } catch (e1) {
    try {
      const b = await reqViaProxy(url, headers, t, false, body);
      proxySticky.add(dom);
      return { body: b, via: 'proxy' };
    } catch (e2) {
      throw new Error('direct(' + e1.message + ') / proxy(' + e2.message + ')');
    }
  }
}

async function getJson(url, headers, timeoutMs, body) {
  const r = await getText(url, headers, timeoutMs, body);
  let o;
  try { o = JSON.parse(r.body); } catch (e) { throw new Error('非 JSON 响应'); }
  return { o, via: r.via };
}

/* ---------- 工具 ---------- */
function yearOf(s) {
  if (s.date) return String(s.date).slice(0, 4);
  const ib = Array.isArray(s.infobox) ? s.infobox : [];
  for (const k of ['放送开始', '上映年度', '上映时间', '发售日', '开始']) {
    const f = ib.find((x) => x && x.key === k);
    if (!f) continue;
    const raw = Array.isArray(f.value) ? (f.value[0] && (f.value[0].v || f.value[0])) : f.value;
    const m = String(raw == null ? '' : raw).match(/(\d{4})/);
    if (m) return m[1];
  }
  return '';
}

function bgmItem(s, i, off) {
  const cn = (s.name_cn && s.name_cn.trim()) || '';
  return {
    rank: (s.rating && s.rating.rank) || 0,
    title: cn || s.name || '',
    alt: cn ? (s.name || '') : '',
    year: yearOf(s),
    score: (s.rating && s.rating.score) || 0,
    votes: (s.rating && s.rating.total) || 0,
    cover: (s.images && (s.images.medium || s.images.large || s.images.common)) || s.image || '',
    url: 'https://bgm.tv/subject/' + s.id,
    src: 'Bangumi',
    extra: s.platform ? String(s.platform) : '',
    id: 'bgm' + s.id,
  };
}

/* ---------- 抓取：Bangumi 搜索（tag 任意组合，单请求上限 20） ---------- */
const BGM_PAGE = 20;
async function fetchBgmSearch(tags, offset, typeId) {
  const url = 'https://api.bgm.tv/v0/search/subjects?limit=' + BGM_PAGE + '&offset=' + offset;
  const filter = { type: [typeId || 2], rank: ['>0'], nsfw: false };
  if (tags.length) filter.tag = tags;
  const payload = JSON.stringify({ keyword: '', sort: 'rank', filter });
  const { o, via } = await getJson(url, { 'User-Agent': BGM_UA, 'Accept': 'application/json', 'Content-Type': 'application/json' }, 20000, payload);
  const arr = Array.isArray(o.data) ? o.data : [];
  return { items: arr.map((s, i) => bgmItem(s, i, offset)), total: Math.min(o.total || 0, 1000), via };
}

/* ---------- 抓取：豆瓣 chart 池（动画 3 个评分区间，各一次拉全量） ---------- */
async function fetchDbChart(typeId, interval) {
  const url = 'https://movie.douban.com/j/chart/top_list?type=' + typeId + '&interval_id=' + encodeURIComponent(interval) + '&action=&start=0&limit=300';
  const { o, via } = await getJson(url, { 'User-Agent': DB_UA, 'Referer': 'https://movie.douban.com/', 'Accept': 'application/json' }, 25000);
  const arr = Array.isArray(o) ? o : [];
  return {
    via,
    items: arr.map((s) => ({
      id: 'db' + s.id,
      rank: 0,
      title: s.title || '',
      alt: '',
      year: String(s.release_date || '').slice(0, 4),
      score: parseFloat(s.score) || 0,
      votes: s.vote_count || 0,
      cover: s.cover_url || '',
      url: 'https://movie.douban.com/subject/' + s.id + '/',
      src: '豆瓣',
      extra: (s.regions || []).join('/'),
      types: s.types || [],
      regions: s.regions || [],
    })),
  };
}

async function buildDbAnimePool() {
  const ranges = ['100:90', '90:80', '80:70'];
  const res = await Promise.all(ranges.map((r) => fetchDbChart(25, r).catch(() => null)));
  const map = new Map();
  let via = 'direct';
  res.forEach((r) => { if (r) { via = r.via || via; r.items.forEach((it) => { if (!map.has(it.id)) map.set(it.id, it); }); } });
  const items = [...map.values()];
  if (!items.length) throw new Error('豆瓣 chart 未返回数据');
  return { items, via };
}

/* ---------- 抓取：豆瓣 recommend（tags 组合筛选，count 上限 100） ---------- */
async function fetchDbRecommend(type, tags, count, start) {
  const url = 'https://m.douban.com/rexxar/api/v2/' + type + '/recommend?tags=' + encodeURIComponent(tags.join(',')) + '&start=' + (start || 0) + '&count=' + count;
  const { o, via } = await getJson(url, { 'User-Agent': DB_UA, 'Referer': 'https://m.douban.com/', 'Accept': 'application/json' }, 25000);
  const arr = Array.isArray(o.items) ? o.items : [];
  return {
    via,
    items: arr.map((s) => {
      const parts = String(s.card || s.card_subtitle || '').split('/').map((x) => x.trim()).filter(Boolean);
      return {
        id: 'db' + s.id,
        rank: 0,
        title: s.title || '',
        alt: '',
        year: (s.year && String(s.year).slice(0, 4)) || (parts[0] || '').slice(0, 4),
        score: (s.rating && s.rating.value) || 0,
        votes: (s.rating && s.rating.count) || 0,
        cover: (s.pic && (s.pic.large || s.pic.normal)) || '',
        url: 'https://movie.douban.com/subject/' + s.id + '/',
        src: '豆瓣',
        extra: parts[1] || '',
      };
    }),
  };
}

/* ---------- 抓取：豆瓣 subject_collection（电影/剧集固定榜单） ---------- */
async function fetchDouban(board, start, limit) {
  const url = 'https://m.douban.com/rexxar/api/v2/subject_collection/' + board.slug + '/items?start=' + start + '&count=' + limit;
  const { o, via } = await getJson(url, { 'User-Agent': DB_UA, 'Referer': 'https://m.douban.com/', 'Accept': 'application/json' }, 20000);
  const arr = Array.isArray(o.subject_collection_items) ? o.subject_collection_items : [];
  const items = arr.map((s, i) => {
    const parts = String(s.card_subtitle || '').split('/').map((x) => x.trim()).filter(Boolean);
    return {
    rank: start + i + 1,
    title: s.title || '',
    alt: '',
    year: (s.year && String(s.year).slice(0, 4)) || (parts[0] || '').slice(0, 4),
    score: (s.rating && s.rating.value) || 0,
    votes: (s.rating && s.rating.count) || 0,
    cover: (s.pic && (s.pic.large || s.pic.normal)) || '',
    url: 'https://movie.douban.com/subject/' + s.id + '/',
    src: '豆瓣',
    extra: parts[1] || '',
    id: 'db' + s.id,
  }; });
  const total = o.total || items.length;
  return { items, total, via, hasMore: start + arr.length < total };
}

/* ---------- 抓取：Bangumi 按 subject type 拉排行（书籍=1，游戏=4） ----------
   注：书籍/游戏不像动画有「日本/美国」这类产地 meta，按类型拉时多翻几页攒池子 */
const BGM_PAGES_TYPE = 14;
async function buildBgmTypePool(typeId, regions, genres, baseTags) {
  const routes = regions.length ? regions : [''];
  const pages = regions.length ? BGM_PAGES : BGM_PAGES_TYPE;
  const jobs = [];
  for (const rt of routes) {
    for (let p = 0; p < pages; p++) {
      jobs.push(fetchBgmSearch((rt ? [rt] : []).concat(genres.length ? genres : (baseTags || [])), p * BGM_PAGE, typeId).catch(() => null));
    }
  }
  const res = await Promise.all(jobs);
  const map = new Map();
  let via = 'direct', total = 0;
  res.forEach((r) => {
    if (!r) return;
    via = r.via || via;
    total = Math.max(total, r.total || 0);
    r.items.forEach((it) => { if (it.rank > 0) map.set(it.id, it); });
  });
  const items = [...map.values()].sort((a, b) => a.rank - b.rank);
  if (!items.length) throw new Error('Bangumi 没有匹配结果（试试减少筛选条件）');
  return { items, via, total: total || items.length };
}

/* ---------- 抓取：豆瓣图书（recommend 筛选 + subject_collection 榜单） ---------- */
function bookMap(s, rank) {
  const raw = String(s.card_subtitle || '').split('/').map((x) => x.trim()).filter(Boolean);
  const yi = raw.findIndex((p) => /^(?:19|20)\d{2}/.test(p));
  const author = yi > 0 ? raw.slice(0, yi).join(' / ') : (yi === 0 ? '' : (raw[0] || ''));
  const pub = yi >= 0 ? raw.slice(yi + 1).join(' / ') : raw.slice(1).join(' / ');
  const r = s.rating || {};
  const score = r.value != null ? r.value : (r.score != null ? r.score : 0);
  return {
    rank: rank || 0,
    title: s.title || '',
    alt: '',
    year: yi >= 0 ? (String(raw[yi]).match(/(\d{4})/) || ['', ''])[1] : String(s.year || '').slice(0, 4),
    score: parseFloat(score) || 0,
    votes: r.count || r.total || 0,
    cover: (s.pic && (s.pic.large || s.pic.normal || s.pic)) || s.cover_url || '',
    url: 'https://book.douban.com/subject/' + s.id + '/',
    src: '豆瓣图书',
    extra: pub || author,
    author,
    id: 'dbb' + s.id,
  };
}

async function fetchDbMusicCollection(slug, start, limit) {
  const url = 'https://m.douban.com/rexxar/api/v2/subject_collection/' + slug + '/items?start=' + start + '&count=' + limit;
  const { o, via } = await getJson(url, { 'User-Agent': DB_UA, 'Referer': 'https://m.douban.com/', 'Accept': 'application/json' }, 20000);
  const arr = Array.isArray(o.subject_collection_items) ? o.subject_collection_items : [];
  const items = arr.map((s, i) => {
    const parts = String(s.card_subtitle || '').split('/').map((x) => x.trim()).filter(Boolean);
    return {
      rank: start + i + 1,
      title: s.title || '',
      alt: '',
      year: (s.year && String(s.year).slice(0, 4)) || '',
      score: (s.rating && s.rating.value) || 0,
      votes: (s.rating && s.rating.count) || 0,
      cover: (s.pic && (s.pic.large || s.pic.normal)) || '',
      url: 'https://music.douban.com/subject/' + s.id + '/',
      src: '豆瓣音乐',
      extra: parts[1] || '',
      id: 'dbm' + s.id,
    };
  });
  const total = o.total || items.length;
  return { items, total, via, hasMore: start + arr.length < total };
}
async function fetchDbBookRecommend(tags, count, start) {
  const url = 'https://m.douban.com/rexxar/api/v2/book/recommend?tags=' + encodeURIComponent(tags.join(',')) + '&start=' + (start || 0) + '&count=' + count;
  const { o, via } = await getJson(url, { 'User-Agent': DB_UA, 'Referer': 'https://m.douban.com/', 'Accept': 'application/json' }, 25000);
  const arr = Array.isArray(o.items) ? o.items : [];
  return { via, items: arr.map((s) => bookMap(s, 0)) };
}

async function fetchDbBookCollection(slug, start, limit) {
  const url = 'https://m.douban.com/rexxar/api/v2/subject_collection/' + slug + '/items?start=' + start + '&count=' + limit;
  const { o, via } = await getJson(url, { 'User-Agent': DB_UA, 'Referer': 'https://m.douban.com/', 'Accept': 'application/json' }, 20000);
  const arr = Array.isArray(o.subject_collection_items) ? o.subject_collection_items : [];
  const items = arr.map((s, i) => bookMap(s, start + i + 1));
  const total = o.total || items.length;
  return { items, total, via, hasMore: start + arr.length < total };
}

const BOOK_DEFAULT_TAGS = ['小说', '中国文学', '外国文学', '推理', '科幻', '武侠', '言情', '奇幻', '悬疑', '青春', '经典', '历史'];
const BOOK_PAGES = 4;


async function buildDbBookPool(regions, genres, defaultTags) {
  const bare = !regions.length && !genres.length;
  const routes = bare ? ((defaultTags && defaultTags.length) ? defaultTags : BOOK_DEFAULT_TAGS) : (regions.length ? regions : ['']);
  const jobs = [];
  for (const r of routes) {
    const tags = (r ? [r] : []).concat(bare ? [] : genres);
    const pages = bare ? 1 : BOOK_PAGES;
    for (let p = 0; p < pages; p++) jobs.push(fetchDbBookRecommend(tags, ROUTE_LIMIT, p * ROUTE_LIMIT).catch(() => null));
  }
  const res = await Promise.all(jobs);
  const map = new Map();
  let via = 'direct';
  res.forEach((r) => { if (r) { via = r.via || via; r.items.forEach((it) => { if (!map.has(it.id)) map.set(it.id, it); }); } });
  const items = [...map.values()];
  if (!items.length) throw new Error('豆瓣图书没有匹配结果（试试减少筛选条件）');
  items.sort((a, b) => (b.score - a.score) || (b.votes - a.votes));
  items.forEach((it, i) => { it.rank = i + 1; });
  return { items, via, total: items.length };
}

/* ---------- 游戏：本地离线库（方舟游戏） ---------- */
const GAMES_FILE = path.join(__dirname, '..', 'lib', 'games.json');
let gamesMem = null, gamesMemT = 0;
function loadGames() {
  const now = Date.now();
  if (gamesMem && (now - gamesMemT) < 60000) return gamesMem;
  let items = [];
  try {
    const j = JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8'));
    items = Array.isArray(j.items) ? j.items : [];
  } catch (e) { items = []; }
  gamesMem = items; gamesMemT = now;
  return items;
}
const gameTagsOf = (it) => ((it.tags && it.tags.length ? it.tags : it.genres) || []).map((x) => String(x).trim()).filter(Boolean);
function localGenreTags() {
  const cnt = new Map();
  for (const it of loadGames()) {
    for (const t of gameTagsOf(it)) {
      if (!t || t.length > 8) continue;
      cnt.set(t, (cnt.get(t) || 0) + 1);
    }
  }
  return [...cnt.entries()].filter((x) => x[1] >= 5).sort((a, b) => b[1] - a[1]).slice(0, 36).map((x) => x[0]);
}
function localGameItem(it, rank) {
  const ver = it.ver ? (/^v/i.test(String(it.ver)) ? String(it.ver) : 'v' + it.ver) : '';
  const extra = [it.size, ver].filter(Boolean).join(' · ');
  return {
    rank: rank || 0,
    title: it.n,
    alt: '',
    year: String(it.d || '').slice(0, 4),
    score: 0,
    votes: 0,
    cover: it.cover || '',
    url: it.u,
    urlText: '夸克',
    src: '方舟游戏',
    extra,
    page: it.page || '',
    tags: gameTagsOf(it),
    id: 'fz' + (it.page || it.u),
  };
}
async function buildLocalGamePool(regions, genres) {
  const all = loadGames();
  if (!all.length) throw new Error('本地游戏库还没生成（先跑 lib/harvest-fzgamer.js）');
  let list = all;
  if (genres.length) list = list.filter((it) => { const g = gameTagsOf(it); return genres.every((x) => g.indexOf(x) >= 0); });
  if (regions.length) list = list.filter((it) => { const c = String(it.c || '') + ',' + (it.genres || []).join(','); return regions.every((x) => c.indexOf(x) >= 0); });
  list = list.slice().sort((a, b) => String(b.mod || b.d || '').localeCompare(String(a.mod || a.d || '')));
  return { items: list.map((it, i) => localGameItem(it, i + 1)), via: 'local', total: list.length };
}

/* ---------- 缓存 ---------- */
let disk = {};
try { disk = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; } catch (e) { disk = {}; }
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { fs.writeFileSync(CACHE_FILE, JSON.stringify(disk)); } catch (e) {} }, 1500);
}
function cacheGet(key, ttl) {
  const rec = disk[key];
  if (rec && (Date.now() - rec.t) < ttl) return rec;
  return null;
}

const inflight = new Map();
/* 同一个 key 的并发请求合并成一次 */
function once(key, fn) {
  let job = inflight.get(key);
  if (!job) {
    job = fn();
    job.finally(() => inflight.delete(key)).catch(() => {});
    inflight.set(key, job);
  }
  return job;
}

function cats() {
  const out = {};
  for (const c in BOARDS) {
    out[c] = { name: CAT_NAME[c] || c, boards: BOARDS[c].map((b) => ({ id: b.id, name: b.name, group: b.group || '', desc: b.desc || '' })) };
  }
  for (const c of ['anime', 'movie', 'tv', 'webfiction', 'litfic', 'comic', 'music', 'game']) {
    out[c] = {
      name: CAT_NAME[c] || c,
      filter: true,
      defaultSrc: CAT_SRC[c],
      srcs: SRC_DEF[c].map((x) => ({ id: x.id, name: x.name, tip: x.tip || '', regions: x.regions || [], genres: x.kind === 'localGame' ? localGenreTags() : (x.genres || []), board: x.kind === 'board' })),
      boards: (BOARDS[c] || []).map((b) => ({ id: b.id, name: b.name, group: b.group || '', desc: b.desc || '' })),
    };
  }
  return out;
}

/* ===================== 动漫：源切换 + 多选筛选 ===================== */
const BGM_PAGES = 5;   // 每个产地拉 5 页 × 20 条 = 100 条（Bangumi 单请求上限 20）

async function buildBgmPool(regions, genres) {
  const routes = regions.length ? regions.map((r) => r.t) : [''];
  const jobs = [];
  for (const rt of routes) {
    for (let p = 0; p < BGM_PAGES; p++) {
      jobs.push(fetchBgmSearch(rt ? [rt].concat(genres) : genres.slice(), p * BGM_PAGE).catch(() => null));
    }
  }
  const res = await Promise.all(jobs);
  const map = new Map();
  let via = 'direct', total = 0;
  res.forEach((r) => {
    if (!r) return;
    via = r.via || via;
    total = Math.max(total, r.total || 0);
    r.items.forEach((it) => { if (it.rank > 0) map.set(it.id, it); });
  });
  const items = [...map.values()].sort((a, b) => a.rank - b.rank);
  if (!items.length) throw new Error('Bangumi 没有匹配结果（试试减少筛选条件）');
  return { items, via, total };
}

/* 豆瓣原始池（不带筛选）单独缓存，任意筛选组合都只拉一次 */
async function getDbPool() {
  const rec = cacheGet('dbpool:anime', TTL_POOL);
  if (rec) return rec.v;
  return once('dbpool:anime', async () => {
    const built = await buildDbAnimePool();
    disk['dbpool:anime'] = { t: Date.now(), v: built };
    saveSoon();
    return built;
  });
}

/* legacy shim: getAnime(srcId, regions, ...) => getFiltered(anime, ...) */
async function getAnime(srcId, regions, genres, page, limit, refresh) {
  return getFiltered('anime', srcId || 'bgm', regions || [], genres || [], page, limit, refresh);
}

/* ===================== 统一筛选器 ===================== */
const ROUTE_LIMIT = 100;   // 每条产地路线最多拉多少条

/* 不带任何筛选时豆瓣会返回「即将上映」这类冷门流，用一组热门题材兜底出高分库 */
const DB_REC_DEFAULT = {
  movie: ['剧情', '喜剧', '动作', '爱情', '科幻', '动画', '悬疑', '犯罪'],
  tv: ['剧情', '喜剧', '爱情', '悬疑', '犯罪', '古装'],
};
const DB_REC_PAGES = 3;      // 每条标签路线翻几页（豆瓣单页上限 100，单个标签上限约 500）

async function buildDbRecPool(type, regions, genres) {
  const bare = !regions.length && !genres.length;
  const routes = bare ? (DB_REC_DEFAULT[type] || ['剧情']) : (regions.length ? regions : ['']);
  const pages = bare ? 2 : DB_REC_PAGES;   // 兜底路线多，少翻页；用户已筛选时路线少，多翻页
  const jobs = [];
  for (const r of routes) {
    const tags = (r ? [r] : []).concat(bare ? [] : genres);
    for (let p = 0; p < pages; p++) jobs.push(fetchDbRecommend(type, tags, ROUTE_LIMIT, p * ROUTE_LIMIT).catch(() => null));
  }
  const res = await Promise.all(jobs);
  const map = new Map();
  let via = 'direct';
  res.forEach((r) => { if (r) { via = r.via || via; r.items.forEach((it) => { if (!map.has(it.id)) map.set(it.id, it); }); } });
  const items = [...map.values()];
  if (!items.length) throw new Error('豆瓣没有匹配结果（试试减少筛选条件）');
  items.sort((a, b) => (b.score - a.score) || (b.votes - a.votes));
  items.forEach((it, i) => { it.rank = i + 1; });
  return { items, via, total: items.length };
}

async function buildBgmRealPool(base, regions, genres) {
  const routes = regions.length ? regions : [''];
  const jobs = [];
  for (const rt of routes) {
    for (let p = 0; p < BGM_PAGES; p++) {
      jobs.push(fetchBgmSearch([base].concat(rt ? [rt] : []).concat(genres), p * BGM_PAGE, 6).catch(() => null));
    }
  }
  const res = await Promise.all(jobs);
  const map = new Map();
  let via = 'direct', total = 0;
  res.forEach((r) => {
    if (!r) return;
    via = r.via || via;
    total = Math.max(total, r.total || 0);
    r.items.forEach((it, i) => { if (it.rank > 0) map.set(it.id, it); });
  });
  const items = [...map.values()].sort((a, b) => a.rank - b.rank);
  if (!items.length) throw new Error('Bangumi 没有匹配结果（试试减少筛选条件）');
  return { items, via, total: total || items.length };
}

function srcOf(cat, id) {
  const list = SRC_DEF[cat] || SRC_DEF.anime;
  return list.find((x) => x.id === id) || list[0];
}

function resolveRegions(cat, srcId, names) {
  const src = srcOf(cat, srcId);
  const out = [];
  names.forEach((n) => {
    const hit = (src.regions || []).find((r) => (typeof r === 'string' ? r === n : r.n === n));
    if (hit) out.push(hit);
  });
  return out;
}

async function buildPool(src, regions, genres) {
  if (src.kind === 'bgmAnime') return buildBgmPool(regions, genres);
  if (src.kind === 'bgmReal') return buildBgmRealPool(src.base, regions, genres);
  if (src.kind === 'bgmType') return buildBgmTypePool(src.typeId, regions, genres, src.baseTags);
  if (src.kind === 'dbRec') return buildDbRecPool(src.type, regions, genres);
  if (src.kind === 'dbBook') return buildDbBookPool(regions, genres, src.defaultTags);
  if (src.kind === 'localGame') return buildLocalGamePool(regions, genres);
  /* dbAnime：豆瓣动画池（本地过滤） */
  const p = await getDbPool();
  const list = p.items.filter((it) => {
    if (regions.length) {
      const ok = regions.some((rg) => (rg === '欧美' ? it.regions.some((x) => WEST.indexOf(x) >= 0) : it.regions.indexOf(rg) >= 0));
      if (!ok) return false;
    }
    return genres.every((rg) => it.types.indexOf(rg) >= 0);
  }).map((it) => Object.assign({}, it));
  list.sort((a, b) => (b.score - a.score) || (b.votes - a.votes));
  list.forEach((it, i) => { it.rank = i + 1; });
  return { items: list, via: p.via, total: list.length };
}

async function getFiltered(cat, srcId, regions, genres, page, limit, refresh, boardId) {
  const src = srcOf(cat, srcId);
  if (src.kind === 'board') return getRank(cat, boardId || '', page, limit, refresh);
  const lim = Math.max(1, Math.min(parseInt(limit || 24, 10), 60));
  const pg = Math.max(1, Math.min(parseInt(page || 1, 10), src.maxPages || 20));
  const rk = regions.map((r) => (typeof r === 'string' ? r : (r.n || r.t))).join(',');
  const gk = genres.join(',');
  const key = 'pool:' + cat + ':' + src.id + '|' + rk + '|' + gk;

  /* 本地游戏库还在增量抓取，用短 TTL 让它跟着涨 */
  const ttl = src.kind === 'localGame' ? 60000 : TTL_POOL;
  const rec = refresh ? null : cacheGet(key, ttl);
  let pool, cached = !!rec, stale = false, errMsg = '';
  if (rec) {
    pool = rec.v;
  } else {
    try {
      pool = await once(key, async () => {
        const built = await buildPool(src, regions, genres);
        disk[key] = { t: Date.now(), v: built };
        saveSoon();
        return built;
      });
    } catch (e) {
      const old = disk[key];
      if (old) { pool = old.v; cached = true; stale = true; errMsg = String(e.message); }
      else throw e;
    }
  }

  const from = (pg - 1) * lim;
  const slice = pool.items.slice(from, from + lim);
  return {
    cat, catName: CAT_NAME[cat] || cat, src: src.id, srcName: src.name, tip: src.tip,
    regions, genres, regionNames: regions.map((r) => (typeof r === 'string' ? r : r.n)),
    page: pg, hasMore: from + slice.length < pool.items.length,
    total: pool.items.length, filtered: pool.items.length, via: pool.via, items: slice,
    cached, stale, error: errMsg, ageMs: rec ? Date.now() - rec.t : 0, fetchedAt: Date.now(),
  };
}

/* ===================== 电影/剧集：固定榜单 ===================== */
function boardOf(cat, id) {
  const list = BOARDS[cat];
  if (!list) return null;
  return list.find((b) => b.id === id) || list[0];
}

async function getRank(cat, boardId, page, limit, refresh) {
  const board = boardOf(cat, boardId);
  if (!board) throw new Error('未知分类: ' + cat);
  const lim = Math.max(1, Math.min(parseInt(limit || 24, 10), 60));
  const pg = Math.max(1, Math.min(parseInt(page || 1, 10), 50));
  const fetchLim = Math.max(24, lim);
  const key = cat + '|' + board.id + '#' + pg + '#' + fetchLim;
  const now = Date.now();
  const rec = disk[key];
  const slice = (v) => Object.assign({}, v, { items: v.items.slice(0, lim) });
  if (!refresh && rec && (now - rec.t) < board.ttl) {
    return Object.assign(slice(rec.v), { cached: true, ageMs: now - rec.t });
  }
  try {
    const v = await once(key, async () => {
      const r = board.kind === 'doubanBook'
        ? await fetchDbBookCollection(board.slug, (pg - 1) * fetchLim, fetchLim)
        : (board.kind === 'doubanMusic'
          ? await fetchDbMusicCollection(board.slug, (pg - 1) * fetchLim, fetchLim)
          : await fetchDouban(board, (pg - 1) * fetchLim, fetchLim));
      const out = {
        cat, catName: CAT_NAME[cat] || cat, board: board.id, boardName: board.name,
        group: board.group || '', page: pg, hasMore: r.hasMore, total: r.total, via: r.via,
        items: r.items, fetchedAt: Date.now(),
      };
      disk[key] = { t: Date.now(), v: out };
      saveSoon();
      return out;
    });
    return Object.assign(slice(v), { cached: false, ageMs: 0 });
  } catch (e) {
    if (rec) return Object.assign(slice(rec.v), { cached: true, ageMs: now - rec.t, stale: true, error: String(e.message) });
    throw e;
  }
}

/* ---------- 封面代理 ---------- */
const COVER_HOSTS = /^(?:[a-z0-9-]+\.)?(bgm\.tv|doubanio\.com|fzyx\.top)$/i;
const coverReferer = (h) => (h.endsWith('bgm.tv') ? 'https://bgm.tv/' : (h.endsWith('fzyx.top') ? 'https://www.fzgamer.com/' : 'https://movie.douban.com/'));
const coverMem = new Map();
const COVER_CAP = 400;

async function getCover(url) {
  let u;
  try { u = new URL(url); } catch (e) { throw new Error('bad url'); }
  if (u.protocol !== 'https:') throw new Error('only https');
  if (!COVER_HOSTS.test(u.hostname)) throw new Error('host not allowed: ' + u.hostname);
  const hit = coverMem.get(url);
  if (hit) return hit;
  const headers = { 'User-Agent': DB_UA, 'Referer': coverReferer(u.hostname), 'Accept': 'image/*,*/*' };
  let buf;
  if (proxySticky.has(domOf(u.hostname))) {
    buf = await reqViaProxy(url, headers, 20000, true);
  } else {
    try {
      buf = await reqDirect(url, headers, 5000, true);
    } catch (e1) {
      buf = await reqViaProxy(url, headers, 20000, true);
      proxySticky.add(domOf(u.hostname));
    }
  }
  if (!buf || buf.length < 100) throw new Error('empty image');
  if (coverMem.size >= COVER_CAP) coverMem.delete(coverMem.keys().next().value);
  coverMem.set(url, buf);
  return buf;
}

module.exports = { cats, getRank, getAnime, getFiltered, getCover, resolveRegions, BOARDS, SRC_DEF, CAT_SRC, CAT_NAME, loadGames, localGenreTags };