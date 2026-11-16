/**
 * DSH-SUEZ-Office · page renderer.
 *
 * Shipped here rather than borrowed: the layout lint can prove a deck is not broken, but only a
 * real Office render proves it looks right. Keeping the script inside this plugin means DocGen
 * still works when the other Office plugin is disabled.
 *
 * Runs from the plugin host process, so it needs no sandbox approval; async so a 20 s render does
 * not block the host, and cancellable so a stuck COM call can be killed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const HARD_LIMIT_MS = 15 * 60 * 1000;

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => resolve());
    k.on('exit', () => resolve());
    setTimeout(resolve, 5000).unref?.();
  });
}

/**
 * @param {object} o
 * @param {string} o.script   absolute path to qa_render.ps1
 * @param {string} o.file     the .pptx/.docx/.xlsx to render
 * @param {number} [o.page]
 * @param {string} o.out      output path (.png for pptx, .pdf for docx/xlsx)
 * @param {number} [o.timeoutSec]
 * @param {AbortSignal} [o.signal]
 */
export async function renderPage({ script, file, page = 1, out, timeoutSec = -1, signal }) {
  if (!fs.existsSync(script)) throw new Error(`render script missing: ${script}`);
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-File', file, '-Page', String(page), '-Out', out];
  if (Number(timeoutSec) >= 0) args.push('-TimeoutSec', String(Number(timeoutSec)));

  const started = Date.now();
  const child = spawn(PS, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout = (stdout + c).slice(-64 * 1024); });
  child.stderr.on('data', (c) => { stdout = (stdout + c).slice(-64 * 1024); });

  let cancelled = false;
  const onAbort = () => { cancelled = true; void killTree(child.pid); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const backstop = setTimeout(() => void killTree(child.pid), HARD_LIMIT_MS);
  backstop.unref?.();

  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', (c) => resolve(c ?? -1));
  });
  clearTimeout(backstop);
  if (signal) signal.removeEventListener('abort', onAbort);

  const elapsed = Date.now() - started;
  if (cancelled) throw new Error(`render cancelled after ${elapsed} ms`);
  if (code !== 0) throw new Error(`render failed (exit ${code}) after ${elapsed} ms\n${stdout.slice(-2000)}`);

  const candidates = [...new Set([out, `${out}.pdf`, out.replace(/\.(png|jpe?g)$/i, '.pdf')])];
  const produced = candidates.find((p) => fs.existsSync(p));
  if (!produced) throw new Error(`render reported success but produced no file at ${out}\n${stdout.slice(-800)}`);
  const size = fs.statSync(produced).size;
  return { out: produced, bytes: size, elapsedMs: elapsed, log: stdout.slice(-1500) };
}
