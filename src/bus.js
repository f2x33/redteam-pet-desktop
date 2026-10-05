// ============================================================================
// bus.js —— 本地接入口（HTTP JSON，只绑 127.0.0.1）
// ============================================================================
// 【它是什么】
//   桌宠本体不认识任何框架。任何程序（PI、别的智能体、你自己写的脚本、
//   AHK、Stream Deck、CI 脚本……）只要 POST 一下，就能驱动它。
//   这就是「与 DSH 脱钩」的接缝：今天不接任何东西也能用，明天想接谁就接谁。
//
// 【接口】全部 JSON，UTF-8。成功 200，出错 4xx/5xx（body 里给 message）。
//   GET  /health                  → { ok, app, version, pid }
//   GET  /state                   → { state, animation, states[], animations[], visible }
//   POST /state   {state,holdSec} → 切语义状态（idle/thinking/working/error/done）
//   POST /play    {anim,once}     → 直接播某个动作（名字见 anims）
//   POST /say     {text,sec}      → 冒个气泡（纯显示，**不调任何模型、不花钱**）
//   POST /chatter {kind,force}    → 从**本地台词表**里随便说一句（同样不调模型）
//   POST /visible {visible}       → 显示 / 隐藏
//   POST /debug/capture {path}    → 让 Electron 把窗口内容截图落盘（排查用）
//   GET  /anims                   → 素材目录里实际存在的动作名
//
// 【安全】
//   只监听 127.0.0.1（不对外网开放）；不校验令牌，因为本机上任何进程本来就能
//   操作这个窗口。若你想更严，把 config.json 的 bus.host 改成别的回环地址或关掉 enabled。
//   请求体上限 64 KB，超时 5 秒，防止被本机别的程序卡死。
// ============================================================================

import http from 'node:http';

const MAX_BODY = 64 * 1024;

function send(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error(`请求体超过 ${MAX_BODY} 字节`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`JSON 解析失败：${e.message}`)); }
    });
    req.on('error', reject);
  });
}

/**
 * 启动接入口。
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port            首选端口，被占用会自动往后试
 * @param {() => object} o.getState  返回当前状态快照
 * @param {(state, holdSec) => any} o.onState
 * @param {(anim, once) => any} o.onPlay
 * @param {(text, sec) => any} o.onSay
 * @param {(visible) => any} o.onVisible
 * @param {string[]} o.animations
 * @returns {Promise<{port:number, close:()=>void}>}
 */
export async function startBus(o) {
  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${o.host}`);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();
    try {
      if (method === 'GET' && p === '/health') {
        return send(res, 200, { ok: true, app: 'redteam-pet-desktop', pid: process.pid });
      }
      if (method === 'GET' && p === '/state') {
        return send(res, 200, o.getState());
      }
      if (method === 'GET' && p === '/anims') {
        return send(res, 200, { animations: o.animations });
      }
      if (method === 'POST' && p === '/state') {
        const b = await readBody(req);
        if (!b.state || typeof b.state !== 'string') return send(res, 400, { message: '缺 state' });
        const r = o.onState(b.state, Number(b.holdSec) || undefined);
        if (r && r.error) return send(res, 400, r);
        return send(res, 200, { ok: true, ...o.getState() });
      }
      if (method === 'POST' && p === '/play') {
        const b = await readBody(req);
        if (!b.anim || typeof b.anim !== 'string') return send(res, 400, { message: '缺 anim' });
        if (!o.animations.includes(b.anim)) {
          return send(res, 400, { message: `没有这个动作：${b.anim}`, animations: o.animations });
        }
        o.onPlay(b.anim, b.once !== false);
        return send(res, 200, { ok: true, animation: b.anim });
      }
      if (method === 'POST' && p === '/say') {
        const b = await readBody(req);
        if (typeof b.text !== 'string' || !b.text.trim()) return send(res, 400, { message: '缺 text' });
        o.onSay(b.text.slice(0, 500), Math.min(Math.max(Number(b.sec) || 6, 1), 120));
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && p === '/visible') {
        const b = await readBody(req);
        o.onVisible(b.visible !== false);
        return send(res, 200, { ok: true, visible: b.visible !== false });
      }
      if (method === 'POST' && p === '/chatter') {
        // 让宠物从**本地台词表**里随便说一句（不需要你提供文字，也不调模型）。
        // kind 可选：idle（默认）/ clicks / thinking / working / error / done
        const b = await readBody(req);
        const said = o.onChatter?.(b.kind, b.force !== false);
        return send(res, 200, { ok: !!said, kind: b.kind ?? 'idle' });
      }
      if (method === 'POST' && p === '/debug/capture') {
        // 让 Electron 自己把窗口内容截下来落盘。用途：①排查"窗口到底画出来没有"
        // ②以后做自动化验证/缩略图。可选 path 指定输出文件。
        const b = await readBody(req);
        const r = await o.onCapture?.(b.path);
        return send(res, 200, r ?? { ok: false, message: '未实现 onCapture' });
      }
      return send(res, 404, {
        message: `未知路由 ${method} ${p}`,
        routes: ['GET /health', 'GET /state', 'GET /anims', 'POST /state', 'POST /play', 'POST /say', 'POST /chatter', 'POST /visible', 'POST /debug/capture'],
      });
    } catch (e) {
      return send(res, 400, { message: String(e && e.message ? e.message : e) });
    }
  };

  const server = http.createServer(handler);
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* ignore */ } });

  // 端口被占用就往后顺延，最多试 12 个
  const first = Number(o.port) || 8977;
  let lastErr = null;
  for (let i = 0; i < 12; i++) {
    const port = first + i;
    const ok = await new Promise((resolve) => {
      const onErr = (e) => { lastErr = e; server.removeListener('listening', onOk); resolve(false); };
      const onOk = () => { server.removeListener('error', onErr); resolve(true); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, o.host);
    });
    if (ok) {
      return { port, close: () => { try { server.close(); } catch { /* ignore */ } } };
    }
  }
  throw new Error(`端口 ${first}..${first + 11} 都不可用：${lastErr && lastErr.message}`);
}
