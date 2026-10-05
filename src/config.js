// ============================================================================
// config.js —— 配置读写 + 路径解析
// ============================================================================
// 三层：
//   ① assets/config.json        包内默认（只读）
//   ② <数据目录>/config.json     用户覆盖（可写；右键菜单「打开配置文件夹」）
//   ③ 运行时内存                重载后生效
// 合并口径：**逐层深合并**（对象递归合并，数组整段替换）。
//
// 数据目录（便携优先）：
//   打包后 → <exe 所在目录>\data\      ← 便携语义：整个文件夹拷走就能用
//   开发中 → <项目根>\data\
//   两者都不可写时 → Electron 的 userData
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export const APP_ROOT = app.getAppPath();
export const DEFAULT_CONFIG_FILE = path.join(APP_ROOT, 'assets', 'config.json');

/** 运行时定位到的数据目录（首次调用时确定，之后复用）。 */
let dataDirCache = null;

export function dataDir() {
  if (dataDirCache) return dataDirCache;
  const base = app.isPackaged ? path.dirname(app.getPath('exe')) : APP_ROOT;
  const portable = path.join(base, 'data');
  try {
    fs.mkdirSync(portable, { recursive: true });
    fs.accessSync(portable, fs.constants.W_OK);
    dataDirCache = portable;
  } catch {
    const fallback = app.getPath('userData');
    fs.mkdirSync(fallback, { recursive: true });
    dataDirCache = fallback;
  }
  return dataDirCache;
}

export function userConfigFile() {
  return path.join(dataDir(), 'config.json');
}

/** 素材目录（webm 就在这里）。 */
export function assetsDir() {
  return path.join(APP_ROOT, 'assets');
}

export function webmDir() {
  return path.join(assetsDir(), 'webm');
}

/** 读 JSON，失败返回 null（不抛）。 */
function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(stripJsonc(raw));
  } catch {
    return null;
  }
}

/** 容错：允许 JSONC（行注释与块注释），因为用户手改配置时难免写注释。 */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

/** 深合并：b 覆盖 a。数组整段替换（不拼接），符合"配置就是整段覆盖"的直觉。 */
export function deepMerge(a, b) {
  if (Array.isArray(b)) return b.slice();
  if (b === null || typeof b !== 'object') return b === undefined ? a : b;
  const out = (a && typeof a === 'object' && !Array.isArray(a)) ? { ...a } : {};
  for (const [k, v] of Object.entries(b)) {
    if (k.startsWith('_comment')) continue; // 注释键不参与合并
    out[k] = deepMerge(out[k], v);
  }
  return out;
}

/** 加载生效配置：默认 ← 用户覆盖。 */
export function loadConfig() {
  const def = readJson(DEFAULT_CONFIG_FILE) ?? {};
  const user = readJson(userConfigFile());
  const cfg = deepMerge(def, user ?? {});
  return { cfg, userExists: user !== null, userFile: userConfigFile(), defaultFile: DEFAULT_CONFIG_FILE };
}

/** 首次运行：把默认配置写一份到数据目录，方便用户改。 */
export function ensureUserConfig() {
  const f = userConfigFile();
  if (fs.existsSync(f)) return false;
  try {
    fs.copyFileSync(DEFAULT_CONFIG_FILE, f);
    return true;
  } catch {
    return false;
  }
}

/** 列出素材目录里实际存在的动画名（不含扩展名）。 */
export function listAnimations() {
  try {
    return fs.readdirSync(webmDir())
      .filter((f) => f.toLowerCase().endsWith('.webm'))
      .map((f) => f.replace(/\.webm$/i, ''))
      .sort();
  } catch {
    return [];
  }
}
