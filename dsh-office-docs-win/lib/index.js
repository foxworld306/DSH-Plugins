/**
 * dsh-office-docs-win — Office authoring/QA for locked-down Windows hosts.
 *
 * Registers
 *   - the `office-docs-win` skill (docs + scripts shipped in ./assets), and
 *   - two tools that run the toolkit in-process: `office_docs_check`, `office_docs_dump`.
 *
 * No Python anywhere: the OOXML layer is JavaScript (node:zlib only), verified line-for-line
 * against the original Python implementation by test/diff_test.ps1. Rendering stays
 * PowerShell + Office COM because that is the only engine with real fidelity.
 *
 * Zero dependencies on purpose: importing @deepseek-ai/dsh-tools would pull a second copy of
 * the framework into the user profile and hand the host registry objects of the wrong instance.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipDoc, checkPackageIntegrity, duplicateParaIds } from '../assets/office-docs-win/scripts/ooxml.mjs';
import { dumpPptx, dumpDocx, dumpXlsx, dumpPdf } from '../assets/office-docs-win/scripts/dump.mjs';
import { renderDocument } from './render.js';

export const name = 'office-docs-win';
export const inject = ['skills', 'tools', 'workingDirectory'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..', 'assets', 'office-docs-win');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');

const SKILL_NAME = 'office-docs-win';
const BUNDLED_RANK = 600;   // same rank the official dsh-skill-office package uses

function parseFrontmatter(raw, label) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  if (!m) throw new Error(`office-docs-win: ${label} has no YAML frontmatter`);
  const description = /(^|\n)description:\s*["']?([^\n"']+)/.exec(m[1]);
  if (!description) throw new Error(`office-docs-win: ${label} has no description`);
  return { description: description[2].trim(), body: raw.slice(m[0].length).trim() };
}

/**
 * Absolute interpreter paths, appended to the skill text. The model must not rely on PATH:
 * colleagues without Python have no `python` at all, and a packaged DSH ships this very
 * executable inside its resources directory.
 */
function runtimeBlock() {
  const payload = {
    officeDocsWin: {
      node: process.execPath,
      scripts: SCRIPTS,
      assets: path.join(SKILL_DIR, 'assets'),
    },
  };
  return [
    '',
    '## Runtime paths (installed by the plugin — use these absolute paths, never `python`)',
    '',
    'This deployment has **no Python**. Every toolkit script is JavaScript and runs with the',
    'Node executable below; the calls are otherwise identical to the ones shown in this document',
    '(`dump.mjs` replaces `dump_pptx.py`, `ooxml.mjs` replaces `ooxml.py` and exposes the same',
    'names: `ZipDoc`, `part`, `setPart`, `save`, `checkPackageIntegrity`, `duplicateParaIds`).',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    'so a structure dump is:',
    '',
    `    "${process.execPath}" "${path.join(SCRIPTS, 'dump.mjs')}" <file.pptx|docx|xlsx|pdf> [slide]`,
    '',
    'and an integrity check is:',
    '',
    `    "${process.execPath}" "${path.join(SCRIPTS, 'ooxml.mjs')}" check <file>`,
    '',
    'Rendering/PDF stays PowerShell + Office COM (`scripts/qa_render.ps1`), unchanged.',
  ].join('\n');
}

function skillCandidate() {
  const raw = fs.readFileSync(SKILL_MD, 'utf8');
  const { description } = parseFrontmatter(raw, SKILL_MD);
  return {
    name: SKILL_NAME,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'office-docs-win-plugin',
    source: 'bundled',
    rank: BUNDLED_RANK,
    resourceBase: { kind: 'directory', path: SKILL_DIR.split(path.sep).join('/') },
    locator: SKILL_MD,
  };
}

function render(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

const TEXT_OUTPUT = { schema: { type: 'string' }, render };

/** The session's own directory, so a relative path means what the user sees. */
async function sessionCwd(ctx, exec) {
  try {
    if (ctx.workingDirectory && exec && exec.agent) {
      return await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    }
  } catch {
    /* fall back to the host directory */
  }
  return process.cwd();
}

/** True when the first bytes of `file` are `magic` (cheap format sniff, never throws). */
function sniffHeader(file, magic) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(magic.length);
    fs.readSync(fd, buf, 0, magic.length, 0);
    fs.closeSync(fd);
    return buf.toString('latin1') === magic;
  } catch {
    return false;
  }
}

function requireFile(file, cwd) {
  if (typeof file !== 'string' || file.trim() === '') throw new Error('`file` must be a path to a .pptx/.docx/.xlsx file');
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(cwd || process.cwd(), file);
  if (!fs.existsSync(resolved)) throw new Error(`file not found: ${resolved}`);
    if (fs.statSync(resolved).isDirectory()) throw new Error(`is a directory, not a file: ${resolved}`);
  return resolved;
}

/* ------------------------------------------------------------------ logging --- */
/**
 * Append to a small log so a colleague's failure can be diagnosed without a debugger:
 * whether the host handed us the services we need, and anything that threw.
 */
function log(...parts) {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'dsh-office-docs-win');
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
    fs.appendFileSync(path.join(dir, 'plugin.log'), line);
  } catch {
    /* logging must never break the plugin */
  }
}

/**
 * A service can appear after this plugin was applied — the host does not necessarily
 * honour the module-level `inject` export — so wait for it at runtime when it is missing.
 * (Without this the skill provider silently never registered while the tools worked.)
 */
function withService(ctx, serviceName, run) {
  const ready = (scope) => {
    try {
      run(scope);
      log(`ok: ${serviceName} registered`);
    } catch (err) {
      log(`FAILED: ${serviceName}`, err && err.stack ? err.stack : String(err));
    }
  };
  if (ctx[serviceName]) {
    ready(ctx);
    return;
  }
  if (typeof ctx.inject === 'function') {
    log(`deferring until "${serviceName}" exists`);
    ctx.inject([serviceName], ready);
    return;
  }
  log(`no "${serviceName}" service and no ctx.inject — skipped`);
}

/**
 * Make the skill visible. Two mechanisms, because which one a host exposes has already
 * varied: `skills.register()` stores the definition inline (no file IO at read time),
 * `skills.registerProvider()` serves it from disk. Either satisfies the `skill` tool.
 */
/**
 * Make the skill visible through the host's skill registry.
 *
 * One registration per mount, owned by this plugin's fiber (`ctx.effect`): recomposing the
 * plugin disposes it and mounts a fresh one, and nothing else removes it. The previous version
 * kept the disposer in a global slot and disposed + re-registered on every apply; the host's
 * catalog then kept pointing at a provider that had already been disposed, and the skill
 * answered "unknown or no longer available" instead of loading (reproduced 2026-11-05).
 */
/**
 * Make the skill visible through the host's skill registry.
 *
 * Two registrations, because they fail differently:
 *   - `skills.register()` inserts the definition itself. It is the documented runtime path, it
 *     invalidates the catalog cache, and the registry ranks it above provider entries — so the
 *     skill shows up even when the session's catalog was collected before this plugin mounted.
 *   - `skills.registerProvider()` serves the same skill from disk, re-reading SKILL.md on every
 *     load. It is the path the official dsh-skill-office uses, and it keeps doc edits live.
 * Both are owned by this plugin's fiber (`ctx.effect`), so recomposing the plugin replaces them
 * instead of piling up. Measured 2026-11-05: with only the provider registered, the host's
 * catalog never showed the skill; the same code in a bare registry did, so the provider alone is
 * not something a published plugin should rely on.
 */
function installSkill(ctx) {
  const skills = ctx.skills;
  const effect = typeof ctx.effect === 'function' ? (fn) => ctx.effect(fn) : (fn) => fn();
  const candidate = skillCandidate();

  if (typeof skills.register === 'function') {
    effect(() =>
      skills.register({
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        source: candidate.source,
        provider: candidate.provider,
        resourceBase: candidate.resourceBase,
        path: SKILL_MD,
        content: skillContent(),
      }),
    );
    log('skill registered via skills.register()');
  }

  if (typeof skills.registerProvider === 'function') {
    effect(() =>
      skills.registerProvider(() => ({
        name: 'office-docs-win-plugin',
        list: () => Promise.resolve([candidate]),
        get: async (chosen) => {
          const { rank: _rank, locator: _locator, ...summary } = chosen;
          return { ...summary, content: skillContent() };
        },
      })),
    );
    log('skill registered via skills.registerProvider()');
  }

  if (typeof skills.register !== 'function' && typeof skills.registerProvider !== 'function') {
    throw new Error('skills service exposes neither register() nor registerProvider()');
  }
}

/** SKILL.md body plus the absolute runtime paths this installation actually uses. */
function skillContent() {
  const raw = fs.readFileSync(SKILL_MD, 'utf8');
  const { body } = parseFrontmatter(raw, SKILL_MD);
  return body + runtimeBlock();
}
export function apply(ctx, config = {}) {
  void config;
  log(`apply: has skills=${Boolean(ctx.skills)} tools=${Boolean(ctx.tools)} inject=${typeof ctx.inject} node=${process.execPath}`);

  /* ---------------------------------------------------------------- skill --- */
  withService(ctx, 'skills', (scope) => installSkill(scope));

  /* ---------------------------------------------------------------- tools --- */
  withService(ctx, 'tools', (scope) => {
    if (typeof scope.tools.register !== 'function') throw new Error('tools.register is missing');
    registerTools(scope);
  });
}

function registerTools(ctx) {

  ctx.tools.register({
    name: 'office_docs_check',
    description:
      'Validate an Office package before delivery (.pptx/.docx/.xlsx): [Content_Types].xml rules that make ' +
      'PowerPoint/Word refuse the file (duplicate Default, duplicate Override, uncovered part), XML ' +
      'well-formedness of every part, and (docx) w14:paraId collisions. Returns CLEAN or the problem list. ' +
      'Run this after ANY structural edit and before handing a file to the user.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the Office file: absolute, or relative to the session working directory.' },
        xml: { type: 'boolean', description: 'Also check XML well-formedness (default true; false is faster).' },
      },
      required: ['file'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const file = requireFile(args && args.file, await sessionCwd(ctx, exec));
      // a PDF has no zip package; say that instead of letting the zip reader complain about EOCD
      const checkExt = path.extname(file).slice(1).toLowerCase();
      if (!['pptx', 'docx', 'xlsx'].includes(checkExt) && !sniffHeader(file, '%PDF-')) {
        throw new Error(`${path.basename(file)} is not an OOXML package (expected .pptx/.docx/.xlsx, got .${checkExt}). ` +
          'Only zipped Office formats carry [Content_Types].xml to validate.');
      }
      if (sniffHeader(file, '%PDF-')) {
        throw new Error(path.basename(file) + ' is a PDF, not an OOXML package - there is nothing to validate. ' +
          'Use office_docs_dump for its page count and metadata.');
      }
      const doc = new ZipDoc(file);
      const problems = checkPackageIntegrity(doc.parts, { checkXml: !(args && args.xml === false) });
      const dupes = duplicateParaIds(doc.parts);
      const paraidProblems = Object.entries(dupes).map(
        ([part, ids]) => `paraId collision in ${part}: ${Object.entries(ids).map(([k, v]) => `${k}x${v}`).join(', ')}`,
      );
      const all = [...problems, ...paraidProblems];
      if (all.length === 0) return `CLEAN  ${file}  (${doc.parts.size} parts)`;
      return [`PROBLEMS  ${file}  (${all.length})`, ...all.map((p) => '  - ' + p)].join('\n');
    },
  });

  ctx.tools.register({
    name: 'office_docs_dump',
    description:
      'Dump the structure of an Office file before editing or when replicating a template: pptx shapes per ' +
      'slide (type, name, position/size in inches, text, fonts, colours) and slide size; docx paragraph and ' +
      'table inventory plus headers/footers; xlsx sheet tab names, row counts and the first 40 cells with ' +
      'shared strings and formulas resolved. Use it instead of guessing part names or coordinates.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the Office file: absolute, or relative to the session working directory.' },
        slide: { type: 'number', description: 'pptx only: dump a single slide number (1-based).' },
      },
      required: ['file'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const file = requireFile(args && args.file, await sessionCwd(ctx, exec));
      const ext = file.toLowerCase().split('.').pop();
      const slide = args && typeof args.slide === 'number' ? args.slide : null;
      if (ext === 'pptx') return dumpPptx(file, slide);
      if (ext === 'docx') return dumpDocx(file);
      if (ext === 'xlsx') return dumpXlsx(file);
      if (ext === 'pdf') return dumpPdf(file);
      throw new Error(`unsupported file type .${ext} (expected .pptx, .docx, .xlsx or .pdf)`);
    },
  });

  ctx.tools.register({
    name: 'office_docs_render',
    description:
      'Render one page of an Office file to an image or PDF with real Office fidelity: pptx -> PNG, ' +
      'docx/xlsx -> PDF. Runs Office COM from the plugin host (no sandbox approval needed). Use it for ' +
      'visual QA after every structural edit: inspect the PNG with read_image, assume the first render ' +
      'has bugs (overflow past the panel, overlapping lines, wrapped legends, low contrast).',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to the .pptx/.docx/.xlsx file: absolute, or relative to the session working directory.' },
        page: { type: 'number', description: 'Page/slide number to render (1-based). Default 1; pptx renders exactly that slide.' },
        out: { type: 'string', description: 'Output path. Default: <working dir>/.office-docs-render/<name>-p<page>.png for pptx, .pdf for docx/xlsx.' },
        timeoutSec: { type: 'number', description: 'Watchdog budget in seconds. Default: auto (180 s pptx, 600 s docx/xlsx); 0 disables.' },
      },
      required: ['file'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const file = requireFile(args && args.file, cwd);
      const page = args && typeof args.page === 'number' ? args.page : 1;
      const name = path.basename(file, path.extname(file));
      const out =
        args && typeof args.out === 'string' && args.out.trim() !== ''
          ? path.isAbsolute(args.out)
            ? args.out
            : path.resolve(cwd, args.out)
          : path.join(cwd, '.office-docs-render', `${name}-p${page}${/^(docx|xlsx)$/i.test(path.extname(file).slice(1)) ? '.pdf' : '.png'}`);
      const result = await renderDocument({
        script: path.join(SCRIPTS, 'qa_render.ps1'),
        file,
        page,
        out,
        timeoutSec: args && typeof args.timeoutSec === 'number' ? args.timeoutSec : -1,
        signal: exec && exec.signal,
      });
      const log = result.log ? '\n' + result.log.split('\n').slice(-6).join('\n') : '';
      return `${result.summary}\n${result.out}${log}`;
    },
  });
}
