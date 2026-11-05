/**
 * CDP + OWA service.svc 会话层。
 *
 * 为什么这么做：目标租户禁止 Microsoft Graph（条件访问直接拦掉客户端应用），
 * 但 Outlook Web 自己可以正常访问邮箱。于是用调试协议附着到已登录的 OWA
 * 标签页，在页面上下文里复用它的会话与 Bearer token 调用 `/owa/service.svc`。
 *
 * token 只保存在页面 sessionStorage 的 `dsh:tok` 键里，不落盘、不跨机器。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { defaultPort, defaultProfileDir, resolveBrowser } from './browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPTURE_JS = `(() => {
  if (window.__dshFetchPatched) return 'already';
  window.__dshFetchPatched = true;
  const orig = window.fetch;
  window.fetch = function (...args) {
    try {
      const init = args[1] || {};
      const h = new Headers(init.headers || {});
      const au = h.get('authorization');
      if (au && /^Bearer /.test(au)) {
        sessionStorage.setItem('dsh:tok', JSON.stringify({ auth: au, at: Date.now() }));
      }
    } catch (e) {}
    return orig.apply(this, args);
  };
  return 'patched';
})()`;

const READ_TOK_JS = `(() => { try { return sessionStorage.getItem('dsh:tok'); } catch (e) { return null; } })()`;

const PAGE_STATE_JS = `(() => {
  let tok = null;
  try { tok = sessionStorage.getItem('dsh:tok'); } catch (e) {}
  return { url: location.href, title: document.title, hasToken: !!tok };
})()`;

export class OwaSession {
  constructor(config = {}) {
    this.port = Number(config.port ?? defaultPort());
    this.profileDir = config.profileDir || defaultProfileDir();
    // 'auto' = 跟随 Windows 默认浏览器（限 Chromium 系），同事不需要改配置
    this.edgePath = config.edgePath || process.env.OWA_EDGE || 'auto';
    this.resolvedExe = null;
    this.browserSource = null;
    this.mailUrl = config.mailUrl || 'https://outlook.office.com/mail/';
    this.calendarUrl = config.calendarUrl || 'https://outlook.office.com/calendar/';
    this.timeZone = config.timeZone || 'China Standard Time';
    this.reqTimeoutMs = Number(config.requestTimeoutMs ?? 30000);
    this.conn = null;
    this.targetId = null;
    this.callerSignal = null;
  }

  /**
   * 宿主协作式取消信号（AbortSignal）：index.js 在工具执行开始/结束调用。
   * abort 后所有 CDP 等待（握手/请求/HTTP 探测/轮询）快速失败，
   * 不必等 CDP 自身超时（45s+）才报错。
   * 不带 addEventListener 的非标准对象（如冒烟测试的模拟 exec）按 null 处理。
   */
  beginSignal(signal) {
    this.callerSignal = signal && typeof signal.addEventListener === 'function' ? signal : null;
  }

  /** 把宿主取消信号接到一次性的中止回调（无信号则 no-op）。 */
  #listenAbort(fn) {
    if (this.callerSignal) {
      if (this.callerSignal.aborted) { queueMicrotask(fn); return; }
      this.callerSignal.addEventListener('abort', fn, { once: true });
    }
  }

  #unlistenAbort(fn) {
    if (this.callerSignal) this.callerSignal.removeEventListener('abort', fn);
  }

  get endpoint() { return `http://127.0.0.1:${this.port}`; }

  async #json(p) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: p, timeout: 3000 }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          this.#unlistenAbort(onAbort);
          try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('CDP 返回非 JSON: ' + b.slice(0, 200))); }
        });
      });
      const onAbort = () => req.destroy(new Error('操作已取消（宿主侧中断）'));
      this.#listenAbort(onAbort);
      req.on('timeout', () => { this.#unlistenAbort(onAbort); req.destroy(new Error('CDP 超时')); });
      req.on('error', (e) => { this.#unlistenAbort(onAbort); reject(e); });
    });
  }

  async #browserUp() {
    try { return await this.#json('/json/version'); } catch { return null; }
  }

  /** 解析并缓存浏览器 exe（'auto' 时跟随默认浏览器，见 browser.js）。 */
  #resolveExe() {
    if (this.resolvedExe) return this.resolvedExe;
    const picked = resolveBrowser(this.edgePath);
    this.resolvedExe = picked.exe;
    this.browserSource = picked.source;
    return this.resolvedExe;
  }

  async ensureBrowser() {
    const up = await this.#browserUp();
    if (up) return up;
    const exe = this.#resolveExe();
    if (!fs.existsSync(exe)) {
      throw new Error(`找不到浏览器：${exe}（来源：${this.browserSource || '配置'}）。可用配置项 edgePath 指定，或安装 Chrome/Edge。`);
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.port}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      this.mailUrl,
    ];
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 60; i++) {
      if (this.callerSignal?.aborted) throw new Error('操作已取消（宿主侧中断）');
      await sleep(500);
      const v = await this.#browserUp();
      if (v) return v;
    }
    throw new Error(`浏览器 30 秒内没有开放调试端口 ${this.port}（浏览器: ${exe}，profile: ${this.profileDir}）`);
  }

  async #pages() {
    const list = await this.#json('/json/list');
    return (list || []).filter((t) => t.type === 'page');
  }

  async #pickPage() {
    const pages = await this.#pages();
    if (pages.length === 0) return null;
    return pages.find((t) => /outlook\.(office|cloud)\.microsoft|outlook\.office\.com/i.test(t.url)) || pages[0];
  }

  #connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const pending = new Map();
      let seq = 0;
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        try { ws.close(); } catch {}
        reject(new Error('操作已取消（CDP 握手被中断）'));
      };
      this.#listenAbort(onAbort);
      const handshakeTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error('CDP WebSocket 握手超时（10s）：浏览器/OWA 页面状态可能异常，请刷新 OWA 标签页或重启 DSH 后重试'));
      }, 10000);
      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        this.#unlistenAbort(onAbort);
        resolve({
          send: (method, params = {}) => new Promise((res, rej) => {
            const id = ++seq;
            const timeout = this.reqTimeoutMs + 15000;
            const onAbortReq = () => {
              const h = pending.get(id);
              if (!h) return;
              pending.delete(id);
              clearTimeout(t);
              this.#unlistenAbort(onAbortReq);
              rej(new Error('操作已取消（CDP 请求被中断）'));
            };
            this.#listenAbort(onAbortReq);
            const t = setTimeout(() => {
              pending.delete(id);
              this.#unlistenAbort(onAbortReq);
              rej(new Error(`CDP 请求超时（${timeout}ms）: ${method} —— 连接可能已断开`));
            }, timeout);
            pending.set(id, (m) => { this.#unlistenAbort(onAbortReq); clearTimeout(t); (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)); });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (e) {
              clearTimeout(t);
              rej(new Error(`CDP 发送失败: ${method}: ${e && e.message}`));
            }
          }),
          close: () => { try { ws.close(); } catch {} },
        });
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        this.#unlistenAbort(onAbort);
        reject(new Error('无法连接 CDP WebSocket'));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      };
    });
  }

  async attach() {
    if (this.conn) return this.conn;
    await this.ensureBrowser();
    let page = null;
    for (let i = 0; i < 20; i++) {
      if (this.callerSignal?.aborted) throw new Error('操作已取消（宿主侧中断）');
      page = await this.#pickPage();
      if (page) break;
      await sleep(500);
    }
    if (!page) throw new Error('浏览器里没有可用标签页');
    this.targetId = page.id;
    this.conn = await this.#connect(page.webSocketDebuggerUrl);
    if (!/outlook/i.test(page.url)) {
      try {
        await this.conn.send('Page.enable', {});
        await this.conn.send('Page.navigate', { url: this.mailUrl });
        await sleep(2500);
      } catch {}
    }
    try { await this.conn.send('Page.enable', {}); } catch {}
    try { await this.conn.send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_JS }); } catch {}
    await this.evaluate(CAPTURE_JS);
    return this.conn;
  }

  async evaluate(expression) {
    const conn = this.conn || (await this.attach());
    let r;
    try {
      r = await conn.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
    } catch (e) {
      this.conn = null; // CDP 连接可能已断开：丢弃缓存，下次调用重新 attach
      throw e;
    }
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || '页面内 JS 异常');
    }
    return r.result.value;
  }

  async pageState() {
    await this.attach();
    return this.evaluate(PAGE_STATE_JS);
  }

  async token({ force = false } = {}) {
    await this.attach();
    if (force) await this.evaluate(`(() => { try { sessionStorage.removeItem('dsh:tok'); } catch (e) {} return 1; })()`);
    const read = async () => {
      const raw = await this.evaluate(READ_TOK_JS);
      if (!raw) return null;
      const t = JSON.parse(raw);
      return Date.now() - t.at < 45 * 60 * 1000 ? t.auth : null;
    };
    let auth = await read();
    if (auth) return auth;
    // 页面空闲时不会发请求：整页导航一次，逼它重新走启动流程并带上新令牌
    try { await this.conn.send('Page.navigate', { url: this.mailUrl }); } catch {}
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (this.callerSignal?.aborted) throw new Error('操作已取消（宿主侧中断）');
      await sleep(1200);
      auth = await read();
      if (auth) return auth;
    }
    throw new Error('拿不到 OWA 的访问令牌：页面可能已登出或处于空闲。请在浏览器窗口里打开一封邮件后重试。');
  }

  /** 调用 /owa/service.svc。401 时强制刷新令牌并重试一次。 */
  async call(action, body, app = 'Mail', attempt = 0) {
    const auth = await this.token({ force: attempt > 0 });
    const payload = JSON.stringify({
      __type: `${action}JsonRequest:#Exchange`,
      Header: {
        __type: 'JsonRequestHeaders:#Exchange',
        RequestServerVersion: 'V2018_01_08',
        TimeZoneContext: {
          __type: 'TimeZoneContext:#Exchange',
          TimeZoneDefinition: { __type: 'TimeZoneDefinitionType:#Exchange', Id: this.timeZone },
        },
      },
      Body: body,
    });
    const expr = `(async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), ${JSON.stringify(this.reqTimeoutMs)});
      try {
        const r = await fetch(${JSON.stringify(`/owa/service.svc?action=${action}&app=${app}&n=`)} + Math.floor(Math.random() * 100000), {
          method: 'POST',
          credentials: 'include',
          signal: ctl.signal,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Action': ${JSON.stringify(action)},
            'X-OWA-ActionSource': ${JSON.stringify(action)},
            'Prefer': 'IdType="ImmutableId"',
            'Authorization': ${JSON.stringify(auth)},
          },
          body: ${JSON.stringify(payload)},
        });
        const text = await r.text();
        return { status: r.status, text };
      } catch (e) {
        if (e && e.name === 'AbortError') return { status: 0, text: 'OWA 请求超时（' + ${JSON.stringify(this.reqTimeoutMs)} + 'ms 无响应）：OWA 后端或浏览器会话可能异常，请稍后重试' };
        return { status: 0, text: '页面内 fetch 异常: ' + ((e && e.message) || String(e)) };
      } finally {
        clearTimeout(timer);
      }
    })()`;
    const out = await this.evaluate(expr);
    if (out.status === 401 && attempt === 0) return this.call(action, body, app, 1);
    let json = null;
    try { json = JSON.parse(out.text); } catch {}
    return { status: out.status, json, text: out.text };
  }

  static message(res) {
    const rm = res && res.json && res.json.Body && res.json.Body.ResponseMessages;
    if (!rm) return null;
    const arr = Array.isArray(rm) ? rm : rm.Items || [];
    return arr[0] || null;
  }

  static ensureOk(res, msg) {
    if (res.status !== 200 || !res.json) {
      throw new Error(`OWA 接口返回 HTTP ${res.status}: ${String(res.text).slice(0, 400)}`);
    }
    if (!msg) throw new Error('OWA 接口响应缺少 ResponseMessages');
    if (msg.ResponseClass === 'Error') throw new Error(`OWA 接口报错: ${msg.MessageText || JSON.stringify(msg).slice(0, 300)}`);
    return msg;
  }

  async close() {
    try { this.conn && this.conn.close(); } catch {}
    this.conn = null;
  }
}
