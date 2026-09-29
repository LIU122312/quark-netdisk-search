#!/usr/bin/env node
/**
 * 一键组装 Windows 便携包：
 *   node package/build.js --pansou <pansou.exe> [--node <node.exe>] [--out <dir>] [--games <games.json>]
 * 产出 <out>/quark-netdisk-search-<ver>/ 与同名 zip（含 Node 运行时，解压即用）。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.join(__dirname, '..');
const VER = require(path.join(ROOT, 'package.json')).version;
const NAME = '资源聚合-' + VER;
const OUT = path.resolve(arg('out', path.join(ROOT, 'dist')));
const PKG = path.join(OUT, NAME);
const PANSOU = arg('pansou', '');
const NODEEXE = arg('node', process.execPath);
const GAMES = path.resolve(arg('games', path.join(ROOT, 'app', 'lib', 'games.json')));

if (!PANSOU || !fs.existsSync(PANSOU)) {
  console.error('缺少 PanSou：node package/build.js --pansou <pansou.exe>');
  console.error('下载：https://github.com/fish2018/pansou/releases');
  process.exit(1);
}
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const copy = (a, b) => { mk(path.dirname(b)); fs.copyFileSync(a, b); console.log('  +', path.relative(PKG, b)); };

if (fs.existsSync(PKG)) fs.rmSync(PKG, { recursive: true, force: true });
mk(PKG);
copy(PANSOU, path.join(PKG, 'app', 'pansou.exe'));
['server.js', 'rank.js', 'index.html', 'home.js'].forEach((f) => copy(path.join(ROOT, 'app', 'ui', f), path.join(PKG, 'app', 'ui', f)));
['index.json', 'build-index.js', 'harvest-fzgamer.js'].forEach((f) => {
  const s = path.join(ROOT, 'app', 'lib', f);
  if (fs.existsSync(s)) copy(s, path.join(PKG, 'app', 'lib', f));
});
/* 游戏库是抓取产物，不一定在仓库里：用 --games <path> 指过来 */
if (fs.existsSync(GAMES)) copy(GAMES, path.join(PKG, 'app', 'lib', 'games.json'));
else console.warn('  ! 没找到 games.json（游戏栏目将只剩 Bangumi 源）：' + GAMES);
mk(path.join(PKG, 'app', 'cache'));
mk(path.join(PKG, 'logs'));
copy(NODEEXE, path.join(PKG, 'runtime', 'node.exe'));
/* ---- 桌面外壳：资源聚合.exe（WebView2 独立窗口，不用浏览器） ---- */
const DESK = path.join(ROOT, 'package', 'desktop');
const WV2 = path.join(DESK, 'webview2');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
let desktopOk = false;
if (fs.existsSync(DESK) && fs.existsSync(path.join(WV2, "Microsoft.Web.WebView2.WinForms.dll")) && fs.existsSync(CSC)) {
  const cargs = ["/nologo", "/target:winexe", "/platform:x64", "/codepage:65001",
    "/out:" + path.join(DESK, "资源聚合.exe"),
    "/win32icon:" + path.join(DESK, "app.ico"),
    "/win32manifest:" + path.join(DESK, "app.manifest"),
    "/reference:" + path.join(WV2, "Microsoft.Web.WebView2.Core.dll"),
    "/reference:" + path.join(WV2, "Microsoft.Web.WebView2.WinForms.dll"),
    "/reference:System.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
    path.join(DESK, "Launcher.cs"), path.join(DESK, "AssemblyInfo.cs")];
  try { cp.execFileSync(CSC, cargs, { stdio: "inherit" }); desktopOk = true; }
  catch (e) { console.warn("  ! 编译桌面外壳失败，本次包内不含 资源聚合.exe：" + e.message); }
} else { console.warn("  ! 缺 csc.exe 或 WebView2 SDK，跳过桌面外壳"); }
if (desktopOk) {
  copy(path.join(DESK, "资源聚合.exe"), path.join(PKG, "资源聚合.exe"));
  copy(path.join(WV2, "Microsoft.Web.WebView2.Core.dll"), path.join(PKG, "Microsoft.Web.WebView2.Core.dll"));
  copy(path.join(WV2, "Microsoft.Web.WebView2.WinForms.dll"), path.join(PKG, "Microsoft.Web.WebView2.WinForms.dll"));
  copy(path.join(WV2, "WebView2Loader.dll"), path.join(PKG, "WebView2Loader.dll"));
  copy(path.join(WV2, "LICENSE-WebView2.txt"), path.join(PKG, "WebView2-许可.txt"));
  mk(path.join(PKG, "data"));
}

['资源聚合（浏览器模式）.cmd', '停止服务.cmd', '更新精选库.cmd', 'config.cmd'].forEach((f) => copy(path.join(ROOT, 'package', 'launcher', f), path.join(PKG, f)));
copy(path.join(ROOT, 'README.md'), path.join(PKG, 'README.md'));
copy(path.join(ROOT, 'THIRD-PARTY.md'), path.join(PKG, '第三方说明.md'));

/* 压缩包用 ASCII 名（README 里写的、Releases 上的都是这个名），解压出来的目录保持中文 */
const ZIPNAME = 'quark-netdisk-search-' + VER + '-win64.zip';
const zip = path.join(OUT, ZIPNAME);
if (fs.existsSync(zip)) fs.unlinkSync(zip);
cp.execFileSync('powershell', ['-NoProfile', '-Command',
  'Compress-Archive -Path "' + PKG + '" -DestinationPath "' + zip + '" -CompressionLevel Optimal -Force'], { stdio: 'inherit' });
console.log('\n完成：' + zip);
