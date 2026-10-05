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
export const DEFAULT_LINES_FILE = path.join(APP_ROOT, 'assets', 'lines.json');

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

/** 读 JSON，失败返回 null（不抛），但**一定要出声**。 */
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`[pet] 读不了配置文件 ${file}：${e.message}`);
    return null;
  }
  try {
    return JSON.parse(stripJsonc(raw));
  } catch (e) {
    // 这里**故意不静默**：以前静默返回 null，结果用户改了配置却毫无反应，
    // 排查半天。最典型的坑是文件带 UTF-8 BOM（PowerShell 的
    // `Set-Content -Encoding UTF8`、记事本"UTF-8 带 BOM"都会写 BOM）。
    console.warn(`[pet] 配置文件解析失败，**这一份会被忽略、回落到默认值**：${file}`);
    console.warn(`[pet]   原因：${e.message}`);
    console.warn('[pet]   常见原因：文件开头有 UTF-8 BOM，或 JSON 语法有误（多余逗号、中文引号等）。');
    return null;
  }
}

/**
 * 容错：允许 JSONC（行注释与块注释），因为用户手改配置时难免写注释。
 * 同时剥掉开头的 UTF-8 BOM —— Node 的 readFileSync('utf8') **不会**自动去 BOM，
 * 留着它 JSON.parse 必炸（实测踩过：用户用 PowerShell 存了一次，整份配置被忽略）。
 */
export function stripJsonc(text) {
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // 去 BOM
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
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

// ============================================================================
// 台词表（lines.json）—— 不定时随机冒泡用的**纯本地预设台词**
// ============================================================================
// 与 config.json 同一套三层口径：assets/lines.json（默认） ← <数据目录>/lines.json（用户覆盖）。
// 刻意不接任何模型：台词是人手写的，所以零花费、零延迟、断网也能说话。

export function userLinesFile() {
  return path.join(dataDir(), 'lines.json');
}

/** 加载生效台词表。 */
export function loadLines() {
  const def = readJson(DEFAULT_LINES_FILE) ?? {};
  const user = readJson(userLinesFile());
  return deepMerge(def, user ?? {});
}

/** 首次运行：把默认台词表写一份到数据目录，方便用户加台词。 */
export function ensureUserLines() {
  const f = userLinesFile();
  if (fs.existsSync(f)) return false;
  try {
    fs.copyFileSync(DEFAULT_LINES_FILE, f);
    return true;
  } catch {
    return false;
  }
}
