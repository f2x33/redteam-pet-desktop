// ============================================================================
// pet.js —— 渲染层：动画播放 + 命中测试 + 交互
// ============================================================================
// 【核心机制】
//   窗口默认整窗鼠标穿透（setIgnoreMouseEvents(true, {forward:true})），
//   所以桌面别的地方照常能点。渲染层收到转发的 mousemove 后，去**当前帧的 alpha**
//   上采样：压在角色不透明像素上 → 通知主进程切回可交互；移开 → 再切回穿透。
//   这样"只有角色本体可点"，而不是"一个矩形挡在桌面上"。
//
// 【双 video 交叉淡入】
//   切换动作时若复用同一个 <video>，必然闪一下黑。两个 video 轮流当"前台"，
//   新的一帧就绪后才淡入、旧的淡出，肉眼看不到断点。
// ============================================================================

const api = window.pet;

// ---- 元素 -------------------------------------------------------------------
const vids = [document.getElementById('v0'), document.getElementById('v1')];
const bubbleEl = document.getElementById('bubble');
const hitCanvas = document.getElementById('hit');
const hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true });

// ---- 状态 -------------------------------------------------------------------
let cfg = null;
let animations = [];
let lines = null;          // 台词表（lines.json）：纯本地预设，不定时随机冒泡
let frontIdx = 0;
let currentAnim = null;
let idleTimer = null;
let stateTimer = null;
let bubbleTimer = null;
let chatterTimer = null;   // 下次主动说话的定时器
let lastInteractionAt = 0; // 上次被点/被拖的时间，用来避让
const recentLines = [];    // 最近说过的，避免短时间内重复
let dragging = false;
let dragMoved = false;
let downAt = null;
let lastClickAt = 0;
let hitAlpha = null;
let lastInteractive = null;
// 外部推来的语义状态是否生效中。生效期间**禁止**待机随机链插手，
// 否则待机定时器一到就把状态动画顶掉（实测踩到：切 working 后立刻被随机动作覆盖）。
let stateActive = false;

const ALPHA_HIT = 26;      // alpha 大于这个值算"压在角色身上"
const log = (t) => { try { api.log(t); } catch { /* ignore */ } };

// ---- 工具 -------------------------------------------------------------------
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function assetUrl(name) {
  return 'pet://app/assets/webm/' + encodeURIComponent(name) + '.webm';
}

function idleAnim() {
  return cfg?.animations?.idle?.[0] ?? animations[0] ?? null;
}

// ---- 播放 -------------------------------------------------------------------
let playToken = 0;

async function play(name, opts = {}) {
  if (!name || !animations.includes(name)) {
    log(`没有这个素材：${name}`);
    return;
  }
  const front = vids[frontIdx];
  const back = vids[1 - frontIdx];

  // 同一个动作且不是"从头再来"就跳过，避免无意义的重新解码
  if (!opts.force && currentAnim === name && back.paused === false) return;

  const token = ++playToken;
  back.loop = !opts.once;
  back.onended = null;
  back.src = assetUrl(name);
  back.currentTime = 0;

  try {
    await back.play();
  } catch (e) {
    log(`播放失败 ${name}：${e.message}`);
    return;
  }
  if (token !== playToken) return; // 期间又切了，这次作废

  back.classList.add('is-front');
  front.classList.remove('is-front');
  // 淡出完成后把旧的那路停掉，省 CPU
  setTimeout(() => { if (front !== vids[frontIdx]) { try { front.pause(); } catch { /* ignore */ } } }, 260);

  if (opts.once) {
    back.onended = () => {
      if (token !== playToken) return;
      const back2 = idleAnim();
      if (back2) play(back2, { force: true });
      scheduleIdle();
    };
  }

  frontIdx = 1 - frontIdx;
  currentAnim = name;
  try { api.report({ anim: name, state: opts.state }); } catch { /* ignore */ }
}

// ---- 待机调度（加权随机链）--------------------------------------------------
function scheduleIdle() {
  clearTimeout(idleTimer);
  const t = cfg?.timing ?? {};
  const min = (t.idleMinSec ?? 12) * 1000;
  const max = (t.idleMaxSec ?? 26) * 1000;
  const delay = min + Math.random() * Math.max(0, max - min);
  idleTimer = setTimeout(() => { wander(); scheduleIdle(); }, delay);
}

function wander() {
  if (stateActive) return; // 外部状态优先，待机链让位
  const w = cfg?.weights ?? {};
  const pools = [
    ['idle', Number(w.idle ?? 10)],
    ['turn', Number(w.turn ?? 8)],
    ['random', Number(w.random ?? 82)],
  ].filter(([k, wt]) => wt > 0 && Array.isArray(cfg?.animations?.[k]) && cfg.animations[k].length > 0);
  if (!pools.length) return;
  const total = pools.reduce((s, [, wt]) => s + wt, 0);
  let r = Math.random() * total;
  for (const [k, wt] of pools) {
    r -= wt;
    if (r <= 0) { play(pick(cfg.animations[k])); return; }
  }
}

// ---- 语义状态（外部接入口推来的）-------------------------------------------
function applyState(state, holdSec) {
  const states = cfg?.animations?.states ?? {};
  const anim = states[state];
  if (!anim) { log(`未知状态：${state}`); return; }
  clearTimeout(stateTimer);
  clearTimeout(idleTimer); // ★ 关键：必须掐掉待机定时器，否则它一响就顶掉状态动画
  if (state === 'idle') {
    stateActive = false;
    play(anim, { force: true, state });
    scheduleIdle();
    return;
  }
  stateActive = true;
  play(anim, { force: true, state });
  // 状态是外部推来的，不受"刚被点过就不说话"的限制，直接说
  lastInteractionAt = Date.now();
  say(state, { force: true });
  const hold = (Number(holdSec) || cfg?.timing?.stateHoldSec || 6) * 1000;
  stateTimer = setTimeout(() => {
    stateActive = false;
    const back = states.idle;
    if (back) play(back, { force: true, state: 'idle' });
    scheduleIdle();
  }, hold);
}

// ---- 台词（纯本地预设，不调任何模型）----------------------------------------
// 台词全部来自 lines.json，人手写的。这里只负责：挑一句、替换占位符、冒个泡。
// 没有任何网络请求，所以零花费、零延迟，断网也能说话。

/** 替换 {time} {date} {name} 这类占位符。 */
function subst(text) {
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return String(text)
    .replace(/\{time\}/g, `${p2(now.getHours())}:${p2(now.getMinutes())}`)
    .replace(/\{date\}/g, `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`)
    .replace(/\{name\}/g, cfg?.pet?.name ?? '红队小队员');
}

/** 按场景取池子。kind: 'idle' | 'clicks' | 状态名（thinking/working/error/done…） */
function poolFor(kind) {
  if (!lines) return [];
  if (kind === 'idle') {
    const main = Array.isArray(lines.lines) ? lines.lines.slice() : [];
    const ln = lines.lateNight;
    if (ln && ln.enabled !== false && Array.isArray(ln.lines) && ln.lines.length) {
      const h = new Date().getHours();
      const from = Number(ln.fromHour ?? 0);
      const to = Number(ln.toHour ?? 6);
      const inRange = from <= to ? (h >= from && h < to) : (h >= from || h < to);
      if (inRange) return main.concat(ln.lines);
    }
    return main;
  }
  if (kind === 'clicks') return Array.isArray(lines.clicks) ? lines.clicks.slice() : [];
  const s = lines.states?.[kind];
  return Array.isArray(s) ? s.slice() : [];
}

/** 从池子里挑一句，尽量不跟最近说过的重复。 */
function pickLine(pool) {
  if (!pool.length) return null;
  const fresh = pool.filter((l) => !recentLines.includes(l));
  const use = fresh.length ? fresh : pool;
  const line = use[Math.floor(Math.random() * use.length)];
  recentLines.push(line);
  const keep = Math.max(1, Number(lines?.noRepeat ?? 8));
  while (recentLines.length > keep) recentLines.shift();
  return line;
}

/** 说一句。返回是否真的说了。 */
function say(kind, opts = {}) {
  if (!lines || lines.enabled === false) return false;
  if (document.visibilityState === 'hidden') return false; // 藏起来时别自言自语
  if (!opts.force) {
    const quiet = Number(lines.quietAfterInteractionSec ?? 25) * 1000;
    if (Date.now() - lastInteractionAt < quiet) return false;
  }
  const line = pickLine(poolFor(kind));
  if (!line) return false;
  showBubble(subst(line), Number(lines.showSec) || 8);
  return true;
}

/** 排下一次主动说话：每次说完在 [intervalMinSec, intervalMaxSec] 里随机等。 */
function scheduleChatter() {
  clearTimeout(chatterTimer);
  if (!lines || lines.enabled === false) return;
  const min = Number(lines.intervalMinSec ?? 90) * 1000;
  const max = Number(lines.intervalMaxSec ?? 300) * 1000;
  const delay = Math.max(3000, min + Math.random() * Math.max(0, max - min));
  chatterTimer = setTimeout(() => {
    say('idle');
    scheduleChatter();
  }, delay);
}

// ---- 气泡（显示台词；外部也能通过接入口 POST /say 推文字进来）---------------
function showBubble(text, sec) {
  bubbleEl.textContent = String(text);
  bubbleEl.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { bubbleEl.hidden = true; }, (Number(sec) || 6) * 1000);
}

// ---- alpha 命中测试 ---------------------------------------------------------
function refreshHitAlpha() {
  const front = vids[frontIdx];
  if (!front || !front.videoWidth || front.readyState < 2) return;
  try {
    hitCtx.clearRect(0, 0, hitCanvas.width, hitCanvas.height);
    hitCtx.drawImage(front, 0, 0, hitCanvas.width, hitCanvas.height);
    hitAlpha = hitCtx.getImageData(0, 0, hitCanvas.width, hitCanvas.height).data;
  } catch (e) {
    // 读不到像素时退化为"整窗可点"，宁可多点几下也不要完全点不动
    if (hitAlpha === null) log('命中测试不可用（读像素失败），退化为整窗可点：' + e.message);
    hitAlpha = false;
  }
}

/** 取该点周围 3×3 的最大 alpha，容忍边缘抖动。 */
function alphaNear(clientX, clientY) {
  if (hitAlpha === false) return 255;
  if (!hitAlpha) return 0;
  const W = hitCanvas.width;
  const H = hitCanvas.height;
  const cx = Math.round((clientX / window.innerWidth) * W);
  const cy = Math.round((clientY / window.innerHeight) * H);
  let best = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const a = hitAlpha[(y * W + x) * 4 + 3];
      if (a > best) best = a;
    }
  }
  return best;
}

function setInteractive(on) {
  if (on === lastInteractive) return;
  lastInteractive = on;
  try { api.setInteractive(on); } catch { /* ignore */ }
}

setInterval(refreshHitAlpha, 90);

// ---- 鼠标交互 ---------------------------------------------------------------
document.addEventListener('mousemove', (e) => {
  if (dragging) {
    if (downAt && (Math.abs(e.clientX - downAt.x) > 3 || Math.abs(e.clientY - downAt.y) > 3)) dragMoved = true;
    return;
  }
  const on = alphaNear(e.clientX, e.clientY) > ALPHA_HIT;
  setInteractive(on);
  document.body.style.cursor = on ? 'grab' : 'default';
});

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (alphaNear(e.clientX, e.clientY) <= ALPHA_HIT) return;
  e.preventDefault();
  dragging = true;
  dragMoved = false;
  downAt = { x: e.clientX, y: e.clientY };
  setInteractive(true);
  document.body.style.cursor = 'grabbing';
  // 立刻开始跟随光标：offset 用鼠标在窗口内的相对位置，所以窗口不会跳
  try { api.drag({ phase: 'start', offset: { x: e.clientX, y: e.clientY } }); } catch { /* ignore */ }

  const dragPool = cfg?.animations?.drag ?? [];
  if (dragPool.length) play(pick(dragPool), { force: true });
});

function endPointer(e) {
  if (!dragging) return;
  dragging = false;
  downAt = null;
  document.body.style.cursor = 'default';
  try { api.drag({ phase: 'end' }); } catch { /* ignore */ }

  if (dragMoved) {
    // 拖完落地：回到待机
    const back = idleAnim();
    if (back) play(back, { force: true });
    scheduleIdle();
    return;
  }
  react();
}

document.addEventListener('mouseup', (e) => { if (e.button === 0) endPointer(e); });
window.addEventListener('blur', () => { if (dragging) endPointer(null); });

/** 点击回应：从 clicks 池里随机挑一个，播完自动回待机。 */
function react() {
  const now = Date.now();
  const cd = cfg?.timing?.clickCooldownMs ?? 260;
  if (now - lastClickAt < cd) return;
  lastClickAt = now;
  lastInteractionAt = now;
  const pool = cfg?.animations?.clicks ?? [];
  stateActive = false; // 手动交互优先，解除外部状态的锁定
  if (pool.length) {
    play(pick(pool), { once: true });
    clearTimeout(idleTimer);
  }
  // 被点的时候顺口说一句（clicks 池为空就只说动画不吭声）
  say('clicks', { force: true });
}

document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  try { api.menu(); } catch { /* ignore */ }
});

// 双击 = 直接回待机（方便外部调试时打断某个动作）
document.addEventListener('dblclick', (e) => {
  e.preventDefault();
  stateActive = false;
  const back = idleAnim();
  if (back) play(back, { force: true });
  scheduleIdle();
});

// 滚轮 = 循环切换动作（调试用，也给"手动点播"一个快捷方式）
document.addEventListener('wheel', (e) => {
  if (!animations.length) return;
  e.preventDefault();
  stateActive = false;
  const i = animations.indexOf(currentAnim);
  const next = animations[(i + (e.deltaY > 0 ? 1 : -1) + animations.length) % animations.length];
  play(next, { force: true });
  scheduleIdle();
}, { passive: false });

// ---- 主进程指令 -------------------------------------------------------------
api.onCommand((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'config') {
    cfg = msg.cfg;
    animations = Array.isArray(msg.animations) ? msg.animations : [];
    lines = msg.lines ?? null;
    const total = lines ? poolFor('idle').length + poolFor('clicks').length
      + Object.keys(lines.states ?? {}).reduce((s, k) => s + poolFor(k).length, 0) : 0;
    log(`配置就绪：${animations.length} 段素材，状态 ${Object.keys(cfg?.animations?.states ?? {}).join('/')}`
      + `，台词 ${total} 条${lines?.enabled === false ? '（已关闭）' : ''}`);
    const back = idleAnim();
    if (back) play(back, { force: true, state: 'idle' });
    scheduleIdle();
    scheduleChatter();
    return;
  }
  if (msg.type === 'play') { stateActive = false; play(msg.anim, { once: msg.once, force: true }); scheduleIdle(); return; }
  if (msg.type === 'state') { applyState(msg.state, msg.holdSec); return; }
  if (msg.type === 'say') { showBubble(msg.text, msg.sec); return; }
  // 菜单「让它说一句」/ 接入口 POST /chatter：忽略避让窗口，立刻说
  if (msg.type === 'chatter') { say(msg.kind ?? 'idle', { force: msg.force !== false }); scheduleChatter(); return; }
  // 隐藏/显示时调整：藏起来别自言自语，显示出来后重新排期
  if (msg.type === 'visible') {
    if (msg.visible) scheduleChatter(); else clearTimeout(chatterTimer);
    return;
  }
});

api.ready();
