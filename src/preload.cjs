// ============================================================================
// preload.cjs —— 渲染进程与主进程之间唯一的那道门
// ============================================================================
// 故意用 CommonJS（.cjs）：ESM preload 要求 sandbox:false 且文件名 .mjs，
// 而 .cjs 在所有 Electron 版本上都是最稳的加载方式。
//
// 只暴露这几个动作，渲染进程拿不到 Node、拿不到 ipcRenderer 本体。
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  /** 告诉主进程：鼠标现在是否压在角色身上（决定窗口要不要穿透）。 */
  setInteractive: (on) => ipcRenderer.send('pet:interactive', !!on),

  /** 拖拽：{ phase: 'start', offset: {x,y} } / { phase: 'end' }。 */
  drag: (msg) => ipcRenderer.send('pet:drag', msg),

  /** 弹出原生右键菜单（菜单内容在主进程里建，方便以后加项）。 */
  menu: () => ipcRenderer.send('pet:menu'),

  /** 渲染进程就绪，请求下发配置。 */
  ready: () => ipcRenderer.send('pet:ready'),

  /** 上报当前动画/状态，供接入口 GET /state 查询。 */
  report: (msg) => ipcRenderer.send('pet:anim', msg),

  /** 往主进程控制台打日志（打包后看不到 devtools 时很有用）。 */
  log: (text) => ipcRenderer.send('pet:log', String(text)),

  /** 接收主进程指令：{type:'config'|'play'|'state'|'say'}。 */
  onCommand: (fn) => {
    ipcRenderer.on('pet:cmd', (_e, msg) => fn(msg));
  },
});
