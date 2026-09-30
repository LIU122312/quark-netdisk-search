/* ===================== 内置播放器：mpv + 命名管道 IPC ===================== */
/* 播放器由随包分发的 mpv（Yaozhi 构建）承担，通过 --input-ipc-server 命名管道遥控：
   起播 / 暂停 / 跳转 / 音量 / 关窗全在这里，前端只跟本模块打交道。
   注意：mpv 的 ffmpeg 不带 CA 库，HTTPS 直播源必须显式给 --tls-ca-file，否则报 tls error:0A000086。 */
const net = require('net');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = __dirname;
const EXE_DIR = path.dirname(process.execPath || '');
const APP_DIR = path.resolve(ROOT, '..', '..');

const CANDIDATE_MPV = [
  process.env.MPV_EXE,
  path.join(APP_DIR, 'player', 'mpv.exe'),
  path.join(APP_DIR, 'player', 'Yaoplayer.exe'),
  path.join(APP_DIR, 'player', 'mpv', 'mpv.exe'),
  path.join(EXE_DIR, 'player', 'mpv.exe'),
  'C:\\YIN_YONG\\mpv-Yaozhi-1.0.6-2\\Yaoplayer.exe',
].filter(Boolean);

const CANDIDATE_CA = [
  process.env.MPV_CA,
  path.join(APP_DIR, 'player', 'cacert.pem'),
  /* 随包完整播放器里自带的那份根证书（portable_config 里的 certifi） */
  path.join(APP_DIR, 'player', 'portable_config', 'online-media', 'runtime', 'pkgs', 'certifi', 'cacert.pem'),
  path.join(EXE_DIR, 'player', 'cacert.pem'),
  'C:\\YIN_YONG\\mpv-Yaozhi-1.0.6-2\\portable_config\\online-media\\runtime\\pkgs\\certifi\\cacert.pem',
].filter(Boolean);

function firstFile(list) { for (const p of list) { try { if (fs.statSync(p).isFile()) return p; } catch (e) {} } return null; }

const MPV = firstFile(CANDIDATE_MPV);
const CA = firstFile(CANDIDATE_CA);

const state = {
  proc: null, sock: null, pipe: null, buf: '',
  ready: false, seq: 0, pending: new Map(),
  wid: null, mode: 'window', url: '', title: '', err: '',
  time: 0, duration: 0, paused: true, volume: 100, mute: false,
  idle: true, eof: false, cache: 0, vfmt: '', w: 0, h: 0, fs: false,
  lastPlayAt: 0, lastErr: '',
};

function pickPipeName() { return 'zyjh_mpv_' + process.pid + '_' + Date.now().toString(36); }
function pipePath(name) { return '\\\\.\\pipe\\' + name; }

function send(command, timeout) {
  return new Promise((resolve) => {
    if (!state.sock || state.sock.destroyed) return resolve({ error: 'no-ipc' });
    const id = ++state.seq;
    const to = setTimeout(() => { state.pending.delete(id); resolve({ error: 'timeout' }); }, timeout || 6000);
    state.pending.set(id, (msg) => { clearTimeout(to); resolve(msg); });
    try { state.sock.write(JSON.stringify({ command, request_id: id }) + '\n'); }
    catch (e) { clearTimeout(to); state.pending.delete(id); resolve({ error: 'write-fail' }); }
  });
}

async function setProp(name, value) { const r = await send(['set_property', name, value]); return !r.error || r.error === 'success'; }
async function getProp(name) { const r = await send(['get_property', name]); return r && r.error === 'success' ? r.data : undefined; }

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.request_id && state.pending.has(msg.request_id)) {
    const fn = state.pending.get(msg.request_id);
    state.pending.delete(msg.request_id);
    fn(msg);
    return;
  }
  if (msg.event === 'property-change') {
    switch (msg.name) {
      case 'time-pos': if (typeof msg.data === 'number') state.time = msg.data; break;
      case 'duration': if (typeof msg.data === 'number') state.duration = msg.data; break;
      case 'pause': state.paused = !!msg.data; break;
      case 'volume': if (typeof msg.data === 'number') state.volume = Math.round(msg.data); break;
      case 'mute': state.mute = !!msg.data; break;
      case 'core-idle': state.idle = !!msg.data; break;
      case 'eof-reached': state.eof = !!msg.data; break;
      case 'video-format': state.vfmt = msg.data || ''; break;
      case 'width': if (typeof msg.data === 'number') state.w = msg.data; break;
      case 'height': if (typeof msg.data === 'number') state.h = msg.data; break;
      case 'demuxer-cache-time': if (typeof msg.data === 'number') state.cache = msg.data; break;
      /* 画面里按 ESC / ENTER（自带 yao 配置就是这两个键）会改这个属性，界面靠它对齐全屏 */
      case 'fullscreen': state.fs = !!msg.data; break;
      default: break;
    }
    return;
  }
  if (msg.event === 'end-file') { state.eof = true; }
  if (msg.event === 'start-file') { state.eof = false; state.err = ''; }
}

const OBSERVE = ['time-pos', 'duration', 'pause', 'volume', 'mute', 'core-idle', 'eof-reached', 'video-format', 'width', 'height', 'demuxer-cache-time', 'fullscreen'];

let connectTimer = null;

function connectPipe(name, tries) {
  return new Promise((resolve) => {
    const sock = net.connect(pipePath(name));
    const give = setTimeout(() => { try { sock.destroy(); } catch (e) {} resolve(false); }, 1500);
    sock.on('connect', () => { clearTimeout(give); resolve(sock); });
    sock.on('error', () => { clearTimeout(give); try { sock.destroy(); } catch (e) {} resolve(null); });
  }).then((sock) => {
    if (sock) return sock;
    if (tries <= 0) return null;
    return new Promise((r) => setTimeout(r, 350)).then(() => connectPipe(name, tries - 1));
  });
}

function wire(sock) {
  state.sock = sock;
  state.ready = true;
  sock.on('data', (d) => {
    state.buf += d.toString('utf8');
    let i;
    while ((i = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, i).trim();
      state.buf = state.buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  sock.on('error', () => { state.ready = false; });
  sock.on('close', () => { state.ready = false; });
  return Promise.all(OBSERVE.map((p) => send(['observe_property', p.length, p], 4000)));
}

/* 随包分发的是完整版播放器（自带 portable_config：脚本 / 着色器 / 字体 / OSD / 直播解析）。
   检测到便携配置就不加 --no-config，播放器原有的功能一个不少；
   只有拿系统 mpv 兜底时才用 --no-config，免得被未知配置带偏。
   想强制干净启动：设环境变量 MPV_FULL=0。 */
const BUNDLED_CONF = MPV ? firstFile([path.join(path.dirname(MPV), 'portable_config', 'mpv.conf')]) : null;
const FULL_PLAYER = !!BUNDLED_CONF && process.env.MPV_FULL !== '0';

function mpvArgs(opts) {
  const a = [];
  if (FULL_PLAYER) a.push('--config-dir=' + path.dirname(BUNDLED_CONF));
  else {
    a.push('--no-config');
    a.push('--osc=no');
    a.push('--input-default-bindings=no');
  }
  a.push(
    '--idle=yes',
    '--keep-open=no',
    '--hr-seek=yes',
    '--volume-max=200',
    '--cache=yes',
    '--hls-bitrate=max',
    '--cache-pause=no',
    '--demuxer-readahead-secs=2',
    '--demuxer-max-bytes=64MiB',
    '--network-timeout=20',
    '--msg-level=all=warn',
    '--input-ipc-server=' + pipePath(opts.pipe),
    '--user-agent=' + UA,
    '--title=' + (opts.title || '资源聚合 · 在线播放'));
  if (CA) a.push('--tls-ca-file=' + CA);
  if (opts.hwnd) {
    /* 嵌进软件窗口：只往这块子窗口里画，绝不自己开窗口 */
    a.push('--wid=' + opts.hwnd);
    a.push('--force-window=no');
  } else {
    a.push('--force-window=yes');
    a.push('--geometry=1180x680');
  }
  return a;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ===================== 对外接口 ===================== */
function info() {
  return { mpv: MPV, ca: CA, mode: state.mode, running: !!(state.proc && state.ready),
    full: FULL_PLAYER, conf: FULL_PLAYER ? path.dirname(BUNDLED_CONF) : '' };
}

async function play(opts) {
  const o = opts || {};
  if (!MPV) return { ok: false, error: '没找到内置播放器 mpv.exe（应位于 app 同级 player/ 目录）' };
  if (!o.url) return { ok: false, error: '缺少播放地址' };
  const wantWid = o.hwnd ? String(o.hwnd) : null;
  const reuse = !!(state.proc && state.ready && state.wid === wantWid && !state.eof);

  if (!reuse) {
    await stop();
    const pipe = pickPipeName();
    let proc;
    try { proc = spawn(MPV, mpvArgs({ pipe, hwnd: wantWid, title: o.title }), { stdio: 'ignore', windowsHide: true }); }
    catch (e) { state.err = '播放器启动失败：' + e.message; return { ok: false, error: state.err }; }
    state.proc = proc;
    state.pipe = pipe;
    state.wid = wantWid;
    state.mode = wantWid ? 'embedded' : 'window';
    state.ready = false;
    proc.on('exit', () => { state.proc = null; state.ready = false; state.idle = true; state.err = ''; });
    const sock = await connectPipe(pipe, 24);
    if (!sock) {
      try { proc.kill(); } catch (e) {}
      state.proc = null;
      state.err = '播放器没起来（IPC 管道连接超时）';
      return { ok: false, error: state.err };
    }
    await wire(sock);
  }

  state.url = o.url;
  state.title = o.title || '';
  state.time = 0; state.duration = 0; state.eof = false; state.paused = false; state.err = '';
  state.lastPlayAt = Date.now();

  await setProp('start', Number(o.start) || 0);
  if (o.headers && o.headers.referer) await setProp('http-header-fields', 'Referer: ' + o.headers.referer);
  else await setProp('http-header-fields', '');
  const r = await send(['loadfile', state.url]);
  const okLoad = !r.error || r.error === 'success';
  if (!okLoad) { state.err = 'loadfile 失败：' + r.error; return { ok: false, error: state.err, mode: state.mode }; }
  return { ok: true, mode: state.mode, pid: state.proc ? state.proc.pid : 0, reused: reuse };
}

async function ctl(c) {
  const o = c || {};
  switch (o.cmd) {
    case 'toggle': await send(['cycle', 'pause']); return { ok: true, paused: state.paused };
    case 'pause': await setProp('pause', o.value === undefined ? true : !!o.value); return { ok: true, paused: !!o.value };
    case 'seek': await send(['seek', Number(o.value) || 0, o.mode === 'relative' ? 'relative' : 'absolute']); return { ok: true };
    case 'volume': await setProp('volume', Math.max(0, Math.min(200, Number(o.value) || 0))); return { ok: true };
    case 'mute': await setProp('mute', o.value === undefined ? true : !!o.value); return { ok: true };
    case 'speed': await setProp('speed', Math.max(0.25, Math.min(4, Number(o.value) || 1))); return { ok: true };
    case 'fullscreen': await setProp('fullscreen', o.value === undefined ? true : !!o.value); return { ok: true };
    case 'wid': {
      if (!o.value) return { ok: false };
      const r = await send(['set_property', 'wid', Number(o.value)]);
      return { ok: !r.error || r.error === 'success' };
    }
    case 'stop': await send(['stop']); return { ok: true };
    default: return { ok: false, error: 'unknown cmd: ' + o.cmd };
  }
}

async function status() {
  const alive = !!(state.proc && state.ready);
  return {
    alive, mode: state.mode, pid: state.proc ? state.proc.pid : 0,
    url: state.url, title: state.title,
    time: state.time, duration: state.duration, paused: state.paused,
    volume: state.volume, mute: state.mute, idle: state.idle, eof: state.eof,
    cache: state.cache, vfmt: state.vfmt, w: state.w, h: state.h, fs: state.fs,
    since: state.lastPlayAt, error: state.err,
  };
}

async function stop() {
  if (!state.proc) { state.ready = false; return { ok: true }; }
  try { await send(['quit'], 1500); } catch (e) {}
  const p = state.proc;
  state.proc = null;
  state.ready = false;
  try { if (state.sock) state.sock.destroy(); } catch (e) {}
  state.sock = null;
  await new Promise((r) => setTimeout(r, 120));
  try { if (p && !p.killed) p.kill(); } catch (e) {}
  state.idle = true; state.time = 0; state.duration = 0; state.paused = true;
  return { ok: true };
}

module.exports = { play, ctl, status, stop, info, MPV, CA };
