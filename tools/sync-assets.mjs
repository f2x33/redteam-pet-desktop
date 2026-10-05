// ============================================================================
// sync-assets.mjs —— 从别处同步 webm 素材进来
// ============================================================================
// 素材的唯一真相在 dsh-redpet 插件那边（用 tools/gen-api.mjs + keyscreen.mjs
// 生成、抠像、装包）。这个脚本把那边**已经生效**的那 10 段拷到本应用，
// 保证桌面版和插件版看到的角色完全一致。
//
// 用法：
//   node tools/sync-assets.mjs                      # 从默认位置同步
//   node tools/sync-assets.mjs "D:\别的\webm目录"    # 从指定目录同步
//   node tools/sync-assets.mjs --check              # 只对比，不写
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DST = path.join(ROOT, 'assets', 'webm');
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';

const DEFAULT_SRC = path.join(HOME, '.dsh', 'dsh-redpet', 'main-animation', 'webm');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const CHECK = process.argv.includes('--check');
const src = args[0] ?? DEFAULT_SRC;

if (!fs.existsSync(src)) {
  console.error(`\n源目录不存在：${src}`);
  console.error('用法：node tools/sync-assets.mjs [源目录] [--check]\n');
  process.exit(1);
}

fs.mkdirSync(DST, { recursive: true });
const srcFiles = fs.readdirSync(src).filter((f) => f.toLowerCase().endsWith('.webm')).sort();
const dstFiles = fs.readdirSync(DST).filter((f) => f.toLowerCase().endsWith('.webm')).sort();

let copied = 0, same = 0, stale = 0;
console.log(`\n源：${src}\n目标：${DST}\n`);
console.log('  动作名'.padEnd(26) + '源'.padEnd(12) + '目标'.padEnd(12) + '动作');
console.log('  ' + '─'.repeat(66));

for (const f of srcFiles) {
  const s = path.join(src, f);
  const d = path.join(DST, f);
  const ss = fs.statSync(s).size;
  const exists = fs.existsSync(d);
  const ds = exists ? fs.statSync(d).size : 0;
  let act;
  if (exists && ss === ds) { act = '一致'; same++; }
  else if (CHECK) { act = exists ? '不一致（--check 未写）' : '缺失（--check 未写）'; stale++; }
  else { fs.copyFileSync(s, d); act = exists ? '已更新' : '已新增'; copied++; }
  console.log('  ' + f.replace(/\.webm$/i, '').padEnd(24) + String(ss).padEnd(12) + String(ds || '-').padEnd(12) + act);
}

const extra = dstFiles.filter((f) => !srcFiles.includes(f));
if (extra.length) {
  console.log('\n  目标里多出来的（源里没有，可能是旧素材）：');
  for (const f of extra) console.log('    ' + f);
}

console.log(`\n  合计：源 ${srcFiles.length} 段 · 一致 ${same} · 写入 ${copied} · 待处理 ${stale}`);
if (CHECK && stale > 0) console.log('  （去掉 --check 即真正同步）');
console.log('');
