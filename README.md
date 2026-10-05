# 红队小队员 · 独立 Windows 桌面宠物

一个**双击就能跑**的桌面宠物：透明置顶窗，播放 10 段网络安全红队主题的透明动画。

**与 DSH 完全无关** —— 不装插件、不连 DSH、不调任何模型 API、**零花费**。

> 姊妹项目：[`dsh-redpet`](https://github.com/f2x33/redpet) 是挂在 DSH 里的插件版；
> 本仓库是**独立桌面版**，两者共用同一套素材，互不依赖。
> 素材的血统见 dsh-redpet 的 `NOTICE.md`（动画由本项目自行生成；宿主代码改造自 dsh-pet 0.3.5，MIT）。

---

## 一、跑起来（两种方式）

### A. 打包成免安装 exe（推荐，双击即用）

```powershell
cd redteam-pet-desktop
node tools\pack-portable.mjs
```

产物在 `dist\redteam-pet\`：

```
dist\redteam-pet\
├─ redteam-pet.exe      ← 双击这个
├─ *.dll / *.pak / locales/ ...   （Electron 运行时）
├─ data\                          （首次运行自动生成：你的配置 + 窗口位置）
└─ resources\app\                 （源码 + 素材，改这里就能改行为）
```

**整个 `dist\redteam-pet` 文件夹拷到任何 Windows 机器上都能跑**，不写注册表、不需要安装。
做完会占用约 **360 MB**（其中 340 MB 是 Electron 运行时）。

### B. 开发模式（改代码时用）

```powershell
node tools\run.mjs
```

它会自动找本机已有的 Electron 运行时（`%USERPROFILE%\.dsh\electron\electron.exe`），
**不需要 `npm install`**（省一次 100 MB 下载）。要用别的运行时：

```powershell
$env:ELECTRON_EXE="D:\path\to\electron.exe"; node tools\run.mjs
```

---

## 二、怎么用它

| 操作 | 效果 |
|---|---|
| **拖拽角色** | 拖着它在桌面上跑（拖的时候播"被鼠标拖拽悬空反馈"） |
| **左键点一下** | 随机播一个"点击回应"动作（挥手 / 开心跃动），播完回待机；顺口说一句（台词表 `clicks` 池） |
| **右键** | 原生菜单：点播动作 / **让它说一句** / 重载配置 / 打开配置文件夹 / 隐藏 / 退出 |
| **双击** | 立刻回待机（打断当前动作） |
| **滚轮** | 循环切换 10 个动作（调试用） |
| **托盘图标** | 显示/隐藏、点播动作、让它说一句、退出（关窗口不等于退出） |
| **桌面其他区域** | **鼠标完全穿透** —— 只有角色本体那一小块能点到 |
| **不定时** | 自己冒个泡说句话 —— 台词是你手写的预设，**不调模型、不花钱**（见 [`docs/台词配置.md`](docs/台词配置.md)） |

> 「只有角色本体能点到」是按**当前帧的 alpha** 逐像素判定的，不是一个矩形挡在桌面上。

---

## 三、配置

改配置有两种方式，效果一样：

- 右键宠物 →「**打开配置文件夹**」，编辑里面的 `config.json` / `lines.json`，然后右键 →「**重载配置**」
- 或直接编辑 `resources\app\assets\` 下的同名文件（包内默认值）

**两个配置文件：**

| 文件 | 管什么 | 详细说明 |
|---|---|---|
| `config.json` | 外观、动作池、权重、接入口、菜单文案 | 下表 |
| `lines.json` | **台词** —— 不定时自己说的话、被点时说的话、状态话术 | [`docs/台词配置.md`](docs/台词配置.md) |

| `config.json` 配置项 | 说明 |
|---|---|
| `pet.size` | 角色宽度（像素）。高度自动按 16:9 算 |
| `pet.position` | 首次出现的角落与边距（之后记住你的拖拽位置） |
| `pet.rememberPosition` | 关掉则每次都回到 `position` 指定的角落 |
| `animations.idle/turn/drag/clicks/random` | 五个动作池，放素材名（= `assets/webm/<名字>.webm`） |
| `animations.states` | **语义状态 → 动作**，给外部框架用（见第四节） |
| `weights` | 待机时随机抽池的权重：`idle` / `turn` / `random` |
| `timing.idleMinSec` ~ `idleMaxSec` | 两次随机动作之间的间隔 |
| `bus` | 本地接入口的开关与端口 |
| `menu` | 菜单文案 |

> ⚠ **两个文件都必须存成 UTF-8（无 BOM）**。带了 BOM 会导致整份配置被忽略 ——
> 程序会在日志里明确报出来，但你多半看不到日志，所以：用 VS Code / Notepad++ 存"UTF-8"，
> **别用 PowerShell 的 `Set-Content -Encoding UTF8`**（它会写 BOM）。

**加台词**：打开 `lines.json`，往 `lines` 数组里加一句就行，重载配置即生效。想立刻听一句验证：
右键 →「让它说一句」。

**加新动作**：把 `xxx.webm`（VP9-alpha 透明 webm，推荐 640×360）丢进 `assets\webm\`，
然后在上面某个池子里写上 `xxx`，重载配置即可。

**换素材**：用姊妹项目的流水线生成（`dsh-redpet` 的 `tools/gen-api.mjs` + `keyscreen.mjs`），
再用同步脚本拷过来：

```powershell
node tools\sync-assets.mjs          # 从 %USERPROFILE%\.dsh\dsh-redpet\main-animation\webm 同步
node tools\sync-assets.mjs --check  # 只对比不写
```

---

## 四、接入口：给未来的框架用（与 DSH 脱钩的那条缝）

桌宠本体**不认识任何框架**。任何程序只要 HTTP POST 一下就能驱动它 ——
这就是"今天不接也能用，明天想接谁就接谁"的设计。

默认监听 **`http://127.0.0.1:8977`**（只绑回环，不对外网开放；端口被占用会自动往后顺延）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 存活探测 |
| GET | `/state` | 当前状态、动画、可用动作、窗口坐标 |
| GET | `/anims` | 素材目录里实际存在的动作名 |
| POST | `/state` | `{"state":"working","holdSec":8}` 切语义状态 |
| POST | `/play` | `{"anim":"写代码","once":true}` 直接播某个动作 |
| POST | `/say` | `{"text":"...","sec":10}` 冒个气泡（**纯显示，不调模型**） |
| POST | `/chatter` | `{"kind":"idle"}` 让它从**本地台词表**里随便说一句（同样不调模型） |
| POST | `/visible` | `{"visible":false}` 显示 / 隐藏 |
| POST | `/debug/capture` | `{"path":"D:/x.png"}` 让 Electron 把窗口截图落盘（排查/自动化用） |

`state` 取值：`idle` / `thinking` / `working` / `error` / `done`（映射关系在配置的 `animations.states`）。
推状态时它会**顺带说一句**对应场景的台词（`lines.json` 的 `states` 池）。

**例子 —— 让你的构建脚本在编译时让小队员"忙起来"：**

```powershell
curl.exe -s -X POST -H 'Content-Type: application/json' `
  -d '{\"state\":\"working\",\"holdSec\":600}' http://127.0.0.1:8977/state
# ...跑你的构建...
curl.exe -s -X POST -H 'Content-Type: application/json' `
  -d '{\"state\":\"done\"}' http://127.0.0.1:8977/state
```

> ⚠ PowerShell 调 curl 时 JSON 引号很容易被吃掉（会报 `JSON 解析失败`）。
> 稳妥写法是把 body 写进文件再 `--data-binary "@body.json"`，细节见 [`docs/接入口.md`](docs/接入口.md)。

详细说明与各语言示例见 **[`docs/接入口.md`](docs/接入口.md)**。

---

## 五、目录结构

```
redteam-pet-desktop/
├─ package.json              type:module；main = src/main.js
├─ src/
│  ├─ main.js                主进程：透明置顶窗、鼠标穿透、拖拽、托盘、菜单、接入口挂载
│  ├─ config.js              配置三层合并（含台词表）+ 数据目录（便携优先）
│  ├─ bus.js                 本地 HTTP 接入口
│  ├─ preload.cjs            contextBridge（渲染进程与主进程唯一的门）
│  └─ renderer/
│     ├─ index.html          双 video + 气泡 + 命中测试画布
│     ├─ pet.css             全透明页面
│     └─ pet.js              动画播放、alpha 命中测试、鼠标交互、台词调度
├─ assets/
│  ├─ config.json            默认配置（外形/动作/权重/接入口）
│  ├─ lines.json             默认台词表（不定时自己说的话，纯本地预设）
│  ├─ icon.png               托盘图标
│  └─ webm/                  10 段透明动画
├─ tools/
│  ├─ run.mjs                用本机已有 Electron 启动（无需 npm install）
│  ├─ pack-portable.mjs      打包免安装目录
│  └─ sync-assets.mjs        从插件版同步素材
└─ docs/
   ├─ 接入口.md              外部框架接入指南
   └─ 台词配置.md            台词怎么写、什么时候说、排查
```

---

## 六、实现要点（改的时候别踩回去）

1. **透明窗三件套**：`transparent: true` + `frame: false` + `backgroundColor: '#00000000'`，
   并且页面的 `html, body` 背景必须是 `transparent`。
2. **鼠标穿透**：默认 `setIgnoreMouseEvents(true, { forward: true })`；
   `forward` 只转发 `mousemove`，所以命中判定在渲染进程按 **alpha** 采样做，
   压在角色不透明像素上才切回可交互 —— 桌面其他地方照常能点。
3. **拖拽**不能用 `-webkit-app-region`（它和 `ignoreMouseEvents` 打架），
   改成主进程按 `screen.getCursorScreenPoint()` 搬窗口。
4. **自定义协议 `pet://`**：`file://` 是不透明源，把 `<video>` 画进 canvas 再读像素会被判跨源。
   注册 `standard + secure` 的自定义协议后页面与视频同源，读像素合法（也不必关 `webSecurity`）。
   协议处理里**必须支持 Range 请求**，否则 `<video>` 循环播放会失败。
5. **CSP 要显式允许 `style-src pet:`** —— `'unsafe-inline'` 只管内联样式，
   不管外链样式表。踩过一次：CSS 被拦后 video 按 640×360 原生尺寸显示，窗口里出现滚动条、角色被裁切。
6. **双 video 交叉淡入**：切换动作时复用同一个 `<video>` 必然闪黑，两个轮流当前台才对。
7. **语义状态生效期间要掐掉待机定时器**，否则随机动作会把状态动画顶掉。
8. **读配置必须剥掉 UTF-8 BOM**：Node 的 `readFileSync('utf8')` **不会**自动去 BOM，
   留着它 `JSON.parse` 必炸。而且解析失败**一定要出声**（`console.warn` 写清文件名和原因）——
   最初这里是静默 `return null`，结果用户改了配置毫无反应，排查了半天。
   实测触发场景：用 PowerShell 的 `Set-Content -Encoding UTF8` 存了一次 `lines.json`。

---

## 七、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 双击 exe 没反应 | 看 `data\` 目录是否可写；或命令行跑 `redteam-pet.exe` 看报错 |
| 角色是黑底不是透明 | webm 不是 VP9-alpha。用 `keyscreen.mjs` 重新抠像，或确认用的是 Chromium 内核（Electron 就是） |
| 点不到角色 / 整窗挡桌面 | 命中测试退化了。看 `data\_capture.png`，并确认 `assets/webm` 里的素材 alpha 通道没丢 |
| 接入口连不上 | `GET /state` 里的 `busPort` 是真实端口（被占用会顺延）；或配置里 `bus.enabled=false` 被关掉了 |
| **改了 `config.json` / `lines.json` 毫无反应** | **九成是文件带了 UTF-8 BOM**（PowerShell 的 `Set-Content -Encoding UTF8`、记事本"UTF-8 带 BOM"都会写），`JSON.parse` 会直接失败、整份配置被忽略。程序会在日志里报出来。存成 **UTF-8 无 BOM** 即可；详见 [`docs/台词配置.md`](docs/台词配置.md) |
| 它一句话都不说 | `lines.json` 的 `enabled` 是不是 false、`lines` 是不是空；窗口是不是被隐藏了；`intervalMinSec/MaxSec` 是不是太大 |
| 想彻底退出 | 托盘图标右键 →「退出」；直接关窗口只是隐藏 |
| 窗口跑到屏幕外了 | 删掉 `data\window.json` 重启，会回到配置指定的角落 |

---

## 八、许可

MIT。宿主代码改造自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) `0.3.5`（MIT）。
动画素材由本项目自行生成，不含任何上游素材。详见姊妹项目的 `NOTICE.md`。
