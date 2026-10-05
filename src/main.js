// ============================================================================
// main.js —— 红队小队员 · 独立桌面宠物（Electron 主进程）
// ============================================================================
// 与 DSH **完全无关**：不连 DSH、不读 DSH 配置、不依赖任何模型 API。
// 它只做四件事：开一个透明置顶窗、喂它 10 段本地动画、把鼠标事件处理对、留一个接入口。
//
// 【三个 Windows 透明窗的关键点】
//   ① transparent + frame:false + backgroundColor '#00000000' 才有真透明；
//   ② 想让鼠标"穿过"透明区域，必须 setIgnoreMouseEvents(true, {forward:true})；
//      但 forward 只转发 mousemove —— 所以命中判定在渲染进程做（按 alpha 采样），
//      判定"压在角色身上"了再切回可交互，这样桌面上其他地方照常点得到；
//   ③ 拖拽不能用 -webkit-app-region（它和 ignoreMouseEvents 打架），
//      改成自己在主进程里按屏幕光标位置搬窗口。
//
// 【为什么用自定义协议 pet:// 而不是 file://】
//   file:// 是不透明源，把 <video> 画进 canvas 再 getImageData 会被判跨源而抛
//   SecurityError —— 而 alpha 命中测试恰恰需要读像素。注册一个 standard+secure
//   的自定义协议后，页面和视频同源，读像素就合法了（且不必关 webSecurity）。
// ============================================================================

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import {
  app, BrowserWindow, Menu, Tray, ipcMain, screen, protocol, shell, nativeImage,
} from 'electron';

import {
  APP_ROOT, dataDir, loadConfig, ensureUserConfig, listAnimations, webmDir, userConfigFile,
} from './config.js';
import { startBus } from './bus.js';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

// ---- 单实例：双击两次不要开出两只宠物 --------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// 必须在 ready 之前注册协议特权
protocol.registerSchemesAsPrivileged([{
  scheme: 'pet',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

// ---- 全局状态 ---------------------------------------------------------------
let win = null;
let tray = null;
let cfg = null;
let animations = [];
let interactive = false;
let busInfo = null;
let currentState = 'idle';
let currentAnim = null;
let dragTimer = null;
const dragOffset = { x: 0, y: 0 };
const positionFile = () => path.join(dataDir(), 'window.json');
let quitting = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

// ---- 自定义协议：把 APP_ROOT 下的文件按正确 MIME 提供，并支持 Range ----------
function registerPetProtocol() {
  protocol.handle('pet', async (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.normalize(path.join(APP_ROOT, rel));
      if (!file.startsWith(APP_ROOT)) return new Response('forbidden', { status: 403 });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('not found', { status: 404 });

      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      const size = fs.statSync(file).size;
      const range = request.headers.get('range');

      // <video> 会发 Range 请求（尤其循环/拖动时），不全支持会播不出来
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
          const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
          const end = m[2] === '' || m[1] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
          if (start <= end) {
            const stream = fs.createReadStream(file, { start, end });
            return new Response(Readable.toWeb(stream), {
              status: 206,
              headers: {
                'Content-Type': type,
                'Content-Length': String(end - start + 1),
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store',
              },
            });
          }
        }
      }
      return new Response(Readable.toWeb(fs.createReadStream(file)), {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' },
      });
    } catch (e) {
      return new Response(`pet:// 读取失败：${e.message}`, { status: 500 });
    }
  });
}

// ---- 位置：记住 + 贴边 -------------------------------------------------------
function loadSavedPosition() {
  try { return JSON.parse(fs.readFileSync(positionFile(), 'utf8')); } catch { return null; }
}

function savePosition() {
  if (!win || !cfg.pet.rememberPosition) return;
  try {
    const [x, y] = win.getPosition();
    fs.writeFileSync(positionFile(), JSON.stringify({ x, y }, null, 2), 'utf8');
  } catch { /* 存不下就算了，不影响使用 */ }
}

function initialPosition(w, h) {
  const saved = loadSavedPosition();
  const wa = screen.getPrimaryDisplay().workArea;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    // 屏幕改过就别把窗口丢到看不见的地方
    const x = Math.min(Math.max(saved.x, wa.x - w + 80), wa.x + wa.width - 80);
    const y = Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - 80);
    return { x, y };
  }
  const m = cfg.pet.position ?? { corner: 'bottom-right', marginX: 24, marginY: 48 };
  const corner = m.corner ?? 'bottom-right';
  const x = corner.includes('left') ? wa.x + (m.marginX ?? 24) : wa.x + wa.width - w - (m.marginX ?? 24);
  const y = corner.includes('top') ? wa.y + (m.marginY ?? 48) : wa.y + wa.height - h - (m.marginY ?? 48);
  return { x: Math.round(x), y: Math.round(y) };
}

// ---- 窗口 -------------------------------------------------------------------
function windowSize() {
  const w = Math.round(cfg.pet.size ?? 462);
  // 严格 16:9 —— 素材是 640×360，窗口同比才不会拉伸，
  // 也让渲染进程的 alpha 命中测试可以直接按比例映射，不用处理黑边。
  return { w, h: Math.round(w * 9 / 16) };
}

function createWindow() {
  const { w, h } = windowSize();
  const { x, y } = initialPosition(w, h);

  win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    show: false,
    title: cfg.pet.name ?? '红队小队员',
    icon: path.join(APP_ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(SRC_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 窗口失焦时别让动画掉帧
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  setInteractive(false); // 默认整窗鼠标穿透，只有压在角色身上才切回来

  win.once('ready-to-show', () => win.show());
  win.on('moved', savePosition);
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); setVisible(false); } });
  win.on('closed', () => { win = null; });

  win.loadURL('pet://app/src/renderer/index.html');
  return win;
}

/** 鼠标穿透开关。on=true 表示"窗口可交互"（压在角色上时）。 */
function setInteractive(on) {
  if (!win || win.isDestroyed()) return;
  if (on === interactive) return;
  interactive = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
}

function setVisible(v) {
  if (!win || win.isDestroyed()) return;
  if (v) { win.showInactive(); setInteractive(false); } else { win.hide(); }
  refreshTrayMenu();
}

function send(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('pet:cmd', msg);
}

// ---- 拖拽（自己搬窗口，不用 -webkit-app-region）-----------------------------
function dragStart(offset) {
  dragOffset.x = Math.round(offset?.x ?? 0);
  dragOffset.y = Math.round(offset?.y ?? 0);
  if (dragTimer) return;
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    win.setPosition(Math.round(pt.x - dragOffset.x), Math.round(pt.y - dragOffset.y));
  }, 16);
}

function dragEnd() {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
  savePosition();
}

// ---- 菜单 -------------------------------------------------------------------
function animSubmenu() {
  return animations.map((a) => ({
    label: a,
    click: () => { send({ type: 'play', anim: a, once: true }); },
  }));
}

function buildMenuTemplate() {
  const L = cfg.menu ?? {};
  return [
    { label: L.play ?? '点播动作', submenu: animSubmenu() },
    { type: 'separator' },
    { label: L.reload ?? '重载配置', click: () => reloadConfig(true) },
    { label: L.openConfig ?? '打开配置文件夹', click: () => shell.openPath(dataDir()) },
    { type: 'separator' },
    { label: L.hide ?? '隐藏', click: () => setVisible(false) },
    { label: L.quit ?? '退出', click: () => { quitting = true; app.quit(); } },
  ];
}

function refreshTrayMenu() {
  if (!tray) return;
  const L = cfg.menu ?? {};
  const visible = !!(win && !win.isDestroyed() && win.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? (L.hide ?? '隐藏') : '显示', click: () => setVisible(!visible) },
    { type: 'separator' },
    { label: L.play ?? '点播动作', submenu: animSubmenu() },
    { type: 'separator' },
    { label: L.reload ?? '重载配置', click: () => reloadConfig(true) },
    { label: L.openConfig ?? '打开配置文件夹', click: () => shell.openPath(dataDir()) },
    { type: 'separator' },
    { label: L.quit ?? '退出', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const iconPath = path.join(APP_ROOT, 'assets', 'icon.png');
  let img = nativeImage.createFromPath(iconPath);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(cfg.pet.name ?? '红队小队员');
  tray.on('click', () => setVisible(!(win && win.isVisible())));
  refreshTrayMenu();
}

// ---- 配置重载 ---------------------------------------------------------------
function reloadConfig(fromMenu = false) {
  const { cfg: next } = loadConfig();
  cfg = next;
  animations = listAnimations();
  screen.getAllDisplays(); // 让下面的初始位置用上最新屏幕信息
  if (!cfg.pet.rememberPosition) {
    const { w, h } = windowSize();
    const { x, y } = initialPosition(w, h);
    win?.setPosition(x, y);
  }
  send({ type: 'config', cfg, animations, fromMenu });
  if (tray) tray.setToolTip(cfg.pet.name ?? '红队小队员');
  refreshTrayMenu();
  if (fromMenu) console.log('[pet] 配置已重载');
}

// ---- IPC --------------------------------------------------------------------
function wireIpc() {
  ipcMain.on('pet:interactive', (_e, on) => setInteractive(!!on));
  ipcMain.on('pet:drag', (_e, msg) => {
    if (msg?.phase === 'start') dragStart(msg.offset);
    else dragEnd();
  });
  ipcMain.on('pet:menu', () => {
    if (!win) return;
    const L = cfg.menu ?? {};
    Menu.buildFromTemplate([
      { label: L.play ?? '点播动作', submenu: animSubmenu() },
      { type: 'separator' },
      { label: L.reload ?? '重载配置', click: () => reloadConfig(true) },
      { label: L.openConfig ?? '打开配置文件夹', click: () => shell.openPath(dataDir()) },
      { type: 'separator' },
      { label: L.hide ?? '隐藏', click: () => setVisible(false) },
      { label: L.quit ?? '退出', click: () => { quitting = true; app.quit(); } },
    ]).popup({ window: win });
  });
  ipcMain.on('pet:ready', () => {
    send({ type: 'config', cfg, animations });
  });
  ipcMain.on('pet:anim', (_e, msg) => {
    currentAnim = msg?.anim ?? null;
    if (msg?.state) currentState = msg.state;
  });
  ipcMain.on('pet:log', (_e, text) => console.log('[renderer]', text));
}

// ---- 接入口 -----------------------------------------------------------------
async function startIntegrationBus() {
  if (!cfg.bus?.enabled) return;
  try {
    busInfo = await startBus({
      host: cfg.bus.host ?? '127.0.0.1',
      port: cfg.bus.port ?? 8977,
      animations,
      getState: () => {
        const wa = screen.getPrimaryDisplay().workArea;
        return {
          state: currentState,
          animation: currentAnim,
          states: Object.keys(cfg.animations?.states ?? {}),
          animations,
          visible: !!(win && !win.isDestroyed() && win.isVisible()),
          interactive,
          busPort: busInfo?.port ?? null,
          // 下面几项是排查"窗口去哪儿了"用的：坐标、是否置顶、屏幕工作区
          bounds: win && !win.isDestroyed() ? win.getBounds() : null,
          alwaysOnTop: win && !win.isDestroyed() ? win.isAlwaysOnTop() : null,
          workArea: { x: wa.x, y: wa.y, width: wa.width, height: wa.height },
          displayScale: screen.getPrimaryDisplay().scaleFactor,
        };
      },
      onCapture: async (file) => {
        if (!win || win.isDestroyed()) return { ok: false, message: '窗口不存在' };
        const img = await win.webContents.capturePage();
        const target = file || path.join(dataDir(), '_capture.png');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, img.toPNG());
        const size = img.getSize();
        return { ok: true, file: target, width: size.width, height: size.height, bytes: fs.statSync(target).size };
      },
      onState: (state, holdSec) => {
        const states = cfg.animations?.states ?? {};
        if (!states[state]) return { error: `未知状态：${state}（可用：${Object.keys(states).join(' / ')}）` };
        currentState = state;
        send({ type: 'state', state, holdSec });
        return {};
      },
      onPlay: (anim, once) => { currentAnim = anim; send({ type: 'play', anim, once }); },
      onSay: (text, sec) => send({ type: 'say', text, sec }),
      onVisible: (v) => setVisible(v),
    });
    console.log(`[pet] 接入口就绪：http://${cfg.bus.host}:${busInfo.port}  （GET /state 看状态）`);
  } catch (e) {
    console.error('[pet] 接入口启动失败（不影响宠物本体）：', e.message);
  }
}

// ---- 启动 -------------------------------------------------------------------
app.whenReady().then(() => {
  registerPetProtocol();
  ensureUserConfig();
  const { cfg: c } = loadConfig();
  cfg = c;
  animations = listAnimations();
  console.log(`[pet] 配置：${userConfigFile()}`);
  console.log(`[pet] 素材：${animations.length} 段（${webmDir()}）`);
  if (animations.length === 0) console.error('[pet] 警告：assets/webm 里没有 .webm 素材');

  wireIpc();
  createWindow();
  createTray();
  startIntegrationBus();

  app.on('second-instance', () => setVisible(true));
  app.on('activate', () => { if (!win) createWindow(); else setVisible(true); });
});

app.on('window-all-closed', (e) => {
  // 有托盘常驻，关掉窗口不等于退出
  if (!quitting) e.preventDefault?.();
});

app.on('before-quit', () => {
  quitting = true;
  dragEnd();
  busInfo?.close?.();
});
