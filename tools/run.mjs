// ============================================================================
// run.mjs —— 用本机已有的 Electron 运行时启动（不需要 npm install）
// ============================================================================
// 为什么不用 `npx electron .`：那要联网下 100MB。本机 $DSH_HOME\electron 里
// 已经有一份（dsh-pet 桌面模式下载的），直接复用它启动即可。
//
// 用法：node tools/run.mjs
//   $env:ELECTRON_EXE 可指定别的 electron.exe
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';

const CANDIDATES = [
  process.env.ELECTRON_EXE,
  path.join(HOME, '.dsh', 'electron', 'electron.exe'),                       // ← 本机已有
  path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),        // npm 装的
  path.join(ROOT, 'dist', 'redteam-pet', 'redteam-pet.exe'),                  // 已打包的
  'C:\\Program Files\\Electron\\electron.exe',
].filter(Boolean);

const exe = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });

if (!exe) {
  console.error('\n找不到 Electron 运行时。试过这些位置：');
  for (const c of CANDIDATES) console.error('  ' + c);
  console.error('\n解决办法二选一：');
  console.error('  ① 指定已有运行时：$env:ELECTRON_EXE="D:\\path\\to\\electron.exe"; node tools/run.mjs');
  console.error('  ② 装一个：npm i -D electron\n');
  process.exit(1);
}

console.log(`[run] Electron: ${exe}`);
console.log(`[run] 应用目录: ${ROOT}\n`);

const child = spawn(exe, [ROOT, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) console.log(`\n[run] 被信号结束：${signal}`);
  process.exit(code ?? 0);
});
child.on('error', (e) => {
  console.error(`[run] 启动失败：${e.message}`);
  process.exit(1);
});
