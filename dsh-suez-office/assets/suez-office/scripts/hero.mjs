/**
 * DSH-SUEZ-Office · hero pages (L2).
 *
 * A hero page is designed as HTML at 1920×1080, then split in two layers:
 *   · the decoration (colour fields, gradients, textures, masks) becomes one 2× PNG
 *   · every `.t` element becomes a REAL PowerPoint text box at its measured position
 * so the page looks like a designed page and the words stay editable.
 *
 * Zero dependencies: Edge is driven over the DevTools protocol with Node's built-in WebSocket,
 * because requiring playwright inside the plugin would mean a download on every colleague's machine.
 * Runs in the plugin host (a sandboxed shell cannot spawn a browser).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];

/** CSS injected into every hero page: hidden text for the background pass, no scrollbars. */
const BASE_CSS = `
  html, body { margin: 0; padding: 0; overflow: hidden; }
  body.hide-text .t { visibility: hidden !important; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
`;

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (p && fs.existsSync(p)) return p;
  return null;
}

async function launch(browser) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'suez-hero-'));
  const child = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--disable-gpu', '--force-device-scale-factor=1',
    '--window-size=1920,1080', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });

  const t0 = Date.now();
  let version = null;
  while (Date.now() - t0 < 20000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!version) { child.kill(); throw new Error('hero: the browser never opened its debug port'); }

  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('hero: CDP socket failed')); });

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
    version: version.Browser,
    send,
    close() {
      try { ws.close(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
      setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }, 500);
    },
  };
}

/** Fill a template: {{key}} placeholders, arrays become <li> rows when the key ends with "[]". */
export function fillTemplate(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === undefined || v === null) return '';
    // a newline in the data is a line break on the page, not a literal \n
    return String(v).replace(/\r?\n/g, '<br>');
  });
}

/**
 * Render one HTML page into { background, preview, boxes }.
 *
 * @param {object} o
 * @param {string} o.html        full HTML document
 * @param {string} o.outDir      where to write <name>-bg.png / <name>-preview.png
 * @param {string} [o.name]
 * @param {number} [o.scale]     device pixel ratio for the two screenshots (default 2)
 * @param {AbortSignal} [o.signal]
 */
export async function renderHero({ html, outDir, name = 'hero', scale = 2, signal }) {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('hero: no Edge/Chrome found (set EDGE_PATH)');
  fs.mkdirSync(outDir, { recursive: true });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'suez-hero-page-'));
  const pageFile = path.join(work, 'page.html');
  fs.writeFileSync(pageFile, html.includes('<style>') ? html.replace('</head>', `<style>${BASE_CSS}</style></head>`) : html, 'utf8');

  const b = await launch(browserPath);
  try {
    await b.send('Page.enable');
    await b.send('Runtime.enable');
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: scale, mobile: false });
    await b.send('Page.navigate', { url: 'file:///' + pageFile.replace(/\\/g, '/') });

    // wait for webfonts and a settle frame
    await b.send('Runtime.evaluate', { awaitPromise: true, expression: 'document.fonts.ready.then(() => true)' });
    await new Promise((r) => setTimeout(r, 350));
    if (signal?.aborted) throw new Error('hero: cancelled');

    const measured = await b.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => [...document.querySelectorAll('.t')].map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
        const parts = el.innerHTML.split(/<br\\s*\\/?>/i).map((s) => {
          const d = document.createElement('div'); d.innerHTML = s;
          return d.textContent.replace(/\\s+/g, ' ').trim();
        });
        return {
          name: el.dataset.name || el.className || 'text',
          x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
          fontSize: parseFloat(cs.fontSize), lineHeight: lh,
          weight: Number(cs.fontWeight) || 400,
          color: (cs.color.match(/\\d+/g) || [0, 0, 0]).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase(),
          letterSpacing: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing),
          align: cs.textAlign, paragraphs: parts,
          wrapped: r.height > lh * 1.4,
        };
      }))()`,
    });

    const previewShot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const preview = path.join(outDir, `${name}-preview.png`);
    fs.writeFileSync(preview, Buffer.from(previewShot.data, 'base64'));

    await b.send('Runtime.evaluate', { expression: 'document.body.classList.add("hide-text")' });
    await new Promise((r) => setTimeout(r, 120));
    const bgShot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const background = path.join(outDir, `${name}-bg.png`);
    fs.writeFileSync(background, Buffer.from(bgShot.data, 'base64'));

    return { background, preview, boxes: measured.result.value, browser: b.version, scale };
  } finally {
    b.close();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Load one of the shipped templates. */
export function templatePath(name) {
  return path.join(import.meta.dirname, '..', 'hero', `${name}.html`);
}

export function loadTemplate(name) {
  const file = templatePath(name);
  if (!fs.existsSync(file)) {
    const have = fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, '')) : [];
    throw new Error(`hero: unknown template "${name}" (have: ${have.join(', ') || 'none'})`);
  }
  return fs.readFileSync(file, 'utf8');
}
