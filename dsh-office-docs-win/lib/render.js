/**
 * Rendering/PDF export through Office COM, run from the plugin host process.
 *
 * Why this lives here and not in a shell tool: the sandbox hands a restricted token to tool
 * commands, and under that token Word/PowerPoint open the file and then hang (measured
 * 2026-10-30). Host code runs outside that sandbox, so spawning PowerShell from here renders
 * without the per-call `danger-full-access` approval a colleague could never grant.
 *
 * The fidelity still comes from Office itself — this is a thin, well-supervised wrapper
 * around scripts/qa_render.ps1 (staging copy, zombie cleanup, watchdog, WithWindow fallback).
 *
 * Async on purpose: the tool contract requires `execute` to observe `exec.signal` and to leave
 * the host responsive. `spawnSync` here would block the whole host process — every session, not
 * just this call — for the length of the render (measured 23 s on a 21-page document).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Wall-clock backstop; the script supervises Office COM itself (its own `-TimeoutSec`). */
const HARD_LIMIT_MS = 15 * 60 * 1000;
/** How long a killed PowerShell gets to exit before we stop waiting for it. */
const KILL_GRACE_MS = 5000;

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => resolve());
    killer.on('exit', () => resolve());
    setTimeout(resolve, KILL_GRACE_MS).unref?.();
  });
}

/**
 * Render one page/slide to a PNG (pptx) or export the whole document to PDF (docx/xlsx).
 *
 * @param {object} options
 * @param {string} options.script  absolute path to qa_render.ps1
 * @param {string} options.file    absolute path to the document
 * @param {number|string} [options.page]
 * @param {string} options.out     absolute output path (.png for pptx; .pdf is appended otherwise)
 * @param {number} [options.timeoutSec]  forwarded to the script's own watchdog; -1 = its default
 * @param {AbortSignal} [options.signal] caller cancellation; kills the PowerShell tree
 * @returns {Promise<{out: string, bytes: number, elapsedMs: number, summary: string, log: string}>}
 */
export async function renderDocument({ script, file, page = 1, out, timeoutSec = -1, signal }) {
  if (!fs.existsSync(script)) throw new Error(`render script missing: ${script}`);
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  if (signal && signal.aborted) throw new Error('render cancelled before it started');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-File', file,        // same name as the script's own parameter; PowerShell binds by position/name order
    '-Page', String(page),
    '-Out', out,
  ];
  if (timeoutSec !== undefined && timeoutSec !== null && Number(timeoutSec) >= 0) {
    args.push('-TimeoutSec', String(Number(timeoutSec)));
  }

  const started = Date.now();
  const child = spawn(PS, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-64 * 1024); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-64 * 1024); });

  let cancelled = false;
  let hardTimedOut = false;
  const onAbort = () => {
    cancelled = true;
    void killTree(child.pid);
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const hardTimer = setTimeout(() => {
    hardTimedOut = true;
    void killTree(child.pid);
  }, HARD_LIMIT_MS);
  hardTimer.unref?.();

  const { code, spawnError } = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, spawnError: error }));
    child.on('close', (exitCode) => resolve({ code: exitCode, spawnError: null }));
  });
  clearTimeout(hardTimer);
  if (signal) signal.removeEventListener('abort', onAbort);

  const elapsed = Date.now() - started;

  if (cancelled) throw new Error(`render cancelled after ${elapsed} ms`);
  if (hardTimedOut) throw new Error(`render killed after ${Math.round(HARD_LIMIT_MS / 1000)} s (host backstop)`);
  if (spawnError) throw new Error(`could not start PowerShell: ${spawnError.message}`);
  if (code !== 0) {
    const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').slice(-4000);
    throw new Error(`render failed (exit ${code}) after ${elapsed} ms\n${detail}`);
  }

  // qa_render.ps1 writes exactly `out` for pptx, but swaps the extension to .pdf for
  // docx/xlsx (it exports a whole document, not a page image), so accept both spellings.
  const candidates = [...new Set([out, `${out}.pdf`, out.replace(/\.(png|jpg|jpeg)$/i, '.pdf')])];
  const produced = candidates.filter((p) => fs.existsSync(p));
  if (produced.length === 0) {
    throw new Error(`render reported success but produced no file at ${out}\n${stdout.slice(-1000)}`);
  }
  const fileOut = produced[0];
  const size = fs.statSync(fileOut).size;

  return {
    out: fileOut,
    bytes: size,
    elapsedMs: elapsed,
    summary: `rendered ${path.basename(fileOut)} (${Math.round(size / 1024)} KB) in ${(elapsed / 1000).toFixed(1)} s`,
    log: stdout.slice(-2000),
  };
}
