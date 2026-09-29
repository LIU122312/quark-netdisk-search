#!/usr/bin/env node
/**
 * 一键组装 Windows 便携包：
 *   node package/build.js --pansou <pansou.exe> [--node <node.exe>] [--out <dir>]
 * 产出 <out>/quark-netdisk-search-<ver>/ 与同名 zip（含 Node 运行时，解压即用）。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = path.join(__dirname, '..');
const VER = require(path.join(ROOT, 'package.json')).version;
const NAME = '夸克资源检索-' + VER;
const OUT = path.resolve(arg('out', path.join(ROOT, 'dist')));
const PKG = path.join(OUT, NAME);
const PANSOU = arg('pansou', '');
const NODEEXE = arg('node', process.execPath);

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
['server.js', 'rank.js', 'index.html'].forEach((f) => copy(path.join(ROOT, 'app', 'ui', f), path.join(PKG, 'app', 'ui', f)));
['index.json', 'build-index.js'].forEach((f) => {
  const s = path.join(ROOT, 'app', 'lib', f);
  if (fs.existsSync(s)) copy(s, path.join(PKG, 'app', 'lib', f));
});
mk(path.join(PKG, 'app', 'cache'));
mk(path.join(PKG, 'logs'));
copy(NODEEXE, path.join(PKG, 'runtime', 'node.exe'));
['夸克资源检索.cmd', '停止服务.cmd', '更新精选库.cmd', 'config.cmd'].forEach((f) => copy(path.join(ROOT, 'package', 'launcher', f), path.join(PKG, f)));
copy(path.join(ROOT, 'README.md'), path.join(PKG, 'README.md'));
copy(path.join(ROOT, 'THIRD-PARTY.md'), path.join(PKG, '第三方说明.md'));

const zip = path.join(OUT, NAME + '-win64.zip');
if (fs.existsSync(zip)) fs.unlinkSync(zip);
cp.execFileSync('powershell', ['-NoProfile', '-Command',
  'Compress-Archive -Path "' + PKG + '" -DestinationPath "' + zip + '" -CompressionLevel Optimal -Force'], { stdio: 'inherit' });
console.log('\n完成：' + zip);
