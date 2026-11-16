/**
 * Image re-encoding: shrink an oversized photo to a page-sized JPEG.
 *
 * A 6000 px photo is 8 MB and gains nothing on a 13.3 in slide. There is no image library on this
 * host, but there is Edge — so the file is drawn through a canvas in headless Chromium and saved as
 * JPEG at the requested quality. Small files are returned untouched.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find((p) => fs.existsSync(p));

function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return { format: 'other', width: null, height: null };
}

async function launch() {
  if (!EDGE) throw new Error('resize: no Edge/Chrome found');
  const port = 9600 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'suez-resize-'));
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });

  const t0 = Date.now();
  let targets = null;
  while (Date.now() - t0 < 15000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) { targets = await r.json(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!targets) { child.kill(); throw new Error('resize: browser never opened its debug port'); }

  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('resize: CDP socket failed')); });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  return {
    send,
    close() {
      try { ws.close(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
      setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }, 400);
    },
  };
}

/**
 * @param {string} file      local image path
 * @param {object} [o]
 * @param {number} [o.maxWidth]  target width in px (default 1800 ≈ 135 dpi on a 13.3in slide)
 * @param {number} [o.quality]   JPEG quality 1-100 (default 82)
 * @param {number} [o.minBytes]  only touch files above this size
 * @returns {Promise<{file:string, resized:boolean, bytesBefore:number, bytesAfter:number}>}
 */
export async function resizeImage(file, { maxWidth = 1800, quality = 82, minBytes = 900 * 1024 } = {}) {
  const before = fs.statSync(file);
  const info = sniff(fs.readFileSync(file));
  const tooWide = info.width && info.width > maxWidth * 1.2;
  const tooHeavy = before.size > minBytes;
  if (!tooWide && !tooHeavy) return { file, resized: false, bytesBefore: before.size, bytesAfter: before.size };

  const mime = info.format === 'png' ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  const b = await launch();
  try {
    await b.send('Page.enable');
    await b.send('Runtime.enable');
    await b.send('Page.navigate', { url: 'about:blank' });
    const expr = [
      '(async () => {',
      '  const img = new Image();',
      `  img.src = ${JSON.stringify(dataUrl)};`,
      '  await img.decode();',
      `  const scale = Math.min(1, ${maxWidth} / img.naturalWidth);`,
      '  const w = Math.round(img.naturalWidth * scale);',
      '  const h = Math.round(img.naturalHeight * scale);',
      "  const c = document.createElement('canvas');",
      '  c.width = w; c.height = h;',
      "  const ctx = c.getContext('2d');",
      '  ctx.drawImage(img, 0, 0, w, h);',
      `  return { dataUrl: c.toDataURL('image/jpeg', ${quality / 100}), w, h };`,
      '})()',
    ].join('\n');
    const res = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const out = res?.result?.value;
    if (!out?.dataUrl) return { file, resized: false, bytesBefore: before.size, bytesAfter: before.size };

    const buf = Buffer.from(out.dataUrl.split(',')[1], 'base64');
    const target = file.replace(/\.[^.]+$/, '') + '.jpg';
    fs.writeFileSync(target, buf);
    if (target !== file) fs.rmSync(file, { force: true });
    return { file: target, resized: true, width: out.w, height: out.h, bytesBefore: before.size, bytesAfter: buf.length };
  } finally {
    b.close();
  }
}
