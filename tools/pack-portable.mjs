// ============================================================================
// pack-portable.mjs —— 打包成 .exe 免安装版
// ============================================================================
// 产物结构（整个文件夹拷到哪都能跑，不写注册表、不装东西）：
//
//   dist/redteam-pet/
//   ├─ redteam-pet.exe        ← 双击这个（就是改了名的 electron.exe）
//   ├─ *.dll / *.pak / *.bin / locales/ ...   （Electron 运行时，原样搬过来）
//   ├─ data/                  ← 首次运行自动生成：用户配置 + 窗口位置
//   └─ resources/app/         ← 我们的源码与素材，**改这里就能改行为，不用重打包**
//       ├─ package.json
//       ├─ src/
//       └─ assets/
//
// 为什么不做成单文件 exe：Electron 应用的单文件要自解压到临时目录，启动慢、
// 杀软误报多，而且你说了"保留源码、后续还要改" —— 现在这个结构随时能改。
//
// 用法：
//   node tools/pack-portable.mjs                 # 全量打包
//   node tools/pack-portable.mjs --no-electron   # 只刷新 resources/app（改代码后用，快）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';
const OUT = path.join(ROOT, 'dist', 'redteam-pet');
const APP_OUT = path.join(OUT, 'resources', 'app');
const ONLY_APP = process.argv.includes('--no-electron');

const ELECTRON_DIR_CANDIDATES = [
  process.env.ELECTRON_DIR,
  path.join(HOME, '.dsh', 'electron'),
  path.join(ROOT, 'node_modules', 'electron', 'dist'),
].filter(Boolean);

// 只拷这些进 resources/app（源码 + 素材 + 清单），data/ 与 dist/ 绝不打包
const APP_INCLUDE = ['package.json', 'src', 'assets', 'docs', 'README.md'];

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (filter && !filter(s, ent)) continue;
    if (ent.isDirectory()) copyDir(s, d, filter);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function dirSizeMB(dir) {
  let total = 0;
  const walk = (p) => {
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, ent.name);
      if (ent.isDirectory()) walk(f);
      else if (ent.isFile()) { try { total += fs.statSync(f).size; } catch { /* ignore */ } }
    }
  };
  try { walk(dir); } catch { /* ignore */ }
  return total / 1024 / 1024;
}

// ---- 1. 找 Electron 运行时 --------------------------------------------------
function findElectronDir() {
  for (const d of ELECTRON_DIR_CANDIDATES) {
    try {
      if (fs.existsSync(path.join(d, 'electron.exe'))) return d;
    } catch { /* ignore */ }
  }
  return null;
}

// ---- 2. 搬 Electron ---------------------------------------------------------
if (!ONLY_APP) {
  const src = findElectronDir();
  if (!src) {
    console.error('\n找不到 Electron 运行时目录（里面要有 electron.exe）。试过：');
    for (const d of ELECTRON_DIR_CANDIDATES) console.error('  ' + d);
    console.error('\n用 $env:ELECTRON_DIR 指定，例如：');
    console.error('  $env:ELECTRON_DIR="C:\\Users\\你\\.dsh\\electron"; node tools/pack-portable.mjs\n');
    process.exit(1);
  }
  console.log(`[pack] Electron 运行时: ${src}`);
  console.log('[pack] 清空旧产物 …');
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  console.log('[pack] 拷贝运行时（约 350 MB，稍等）…');
  // 不搬 default_app.asar：我们自己提供了 resources/app，用不到它
  copyDir(src, OUT, (s) => path.basename(s) !== 'default_app.asar' && path.basename(s) !== 'data');

  const exeSrc = path.join(OUT, 'electron.exe');
  const exeDst = path.join(OUT, 'redteam-pet.exe');
  if (fs.existsSync(exeSrc)) {
    fs.renameSync(exeSrc, exeDst);
    console.log(`[pack] electron.exe → redteam-pet.exe`);
  } else {
    console.error('[pack] 警告：没找到 electron.exe，改名跳过');
  }
} else {
  console.log('[pack] --no-electron：只刷新 resources/app');
  fs.mkdirSync(OUT, { recursive: true });
}

// ---- 3. 放应用 --------------------------------------------------------------
console.log('[pack] 拷贝源码与素材 → resources/app …');
rmrf(path.join(APP_OUT, 'src'));
rmrf(path.join(APP_OUT, 'assets'));
for (const name of APP_INCLUDE) {
  const s = path.join(ROOT, name);
  if (!fs.existsSync(s)) continue;
  const d = path.join(APP_OUT, name);
  if (fs.statSync(s).isDirectory()) copyDir(s, d);
  else { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
}

// ---- 4. 报告 ----------------------------------------------------------------
const webmCount = (() => { try { return fs.readdirSync(path.join(APP_OUT, 'assets', 'webm')).filter((f) => f.endsWith('.webm')).length; } catch { return 0; } })();
console.log('\n════════ 打包完成 ════════');
console.log(`  产物目录 : ${OUT}`);
console.log(`  启动文件 : ${path.join(OUT, 'redteam-pet.exe')}`);
console.log(`  素材     : ${webmCount} 段`);
console.log(`  总体积   : ${dirSizeMB(OUT).toFixed(0)} MB`);
console.log(`  用户数据 : ${path.join(OUT, 'data')}（首次运行自动生成）`);
console.log('\n  整个 dist\\redteam-pet 文件夹拷到任何 Windows 机器上，双击 redteam-pet.exe 即可运行。');
console.log('  想改行为：直接改 resources/app/src 里的文件，重启即可，不用重新打包。\n');
