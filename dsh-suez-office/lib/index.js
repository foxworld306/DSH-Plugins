/**
 * DSH-SUEZ-Office · plugin entry.
 *
 * Three tools and one skill:
 *   - suez_build_deck  storyboard spec  →  .pptx seeded from the official SUEZ template
 *   - suez_render_page one slide        →  PNG with real Office fidelity
 *   - suez_lint_deck   any .pptx        →  three package gates + layout lint
 *   - skill suez-docgen carries the archetype catalogue, the chart types and the rules
 *
 * Everything heavy lives in assets/suez-office/scripts as plain ESM with zero dependencies, so the
 * plugin never drags a second copy of the framework into the user's profile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerRenderTool } from './render-tool.js';
import { registerImageTool } from './image-tool.js';
/** Palette for a skin, defaulting to SUEZ. */
function skinPalette(style) {
  const key = String(style ?? 'suez').toLowerCase();
  const table = {
    suez: { navy: '030F40', lime: 'AADC14', blue: '77B7FC', tint: '80B1E0', panel: 'F2F5FA', grid: 'D9E0EA', ink: '333F55', mid: '5A6B8C', white: 'FFFFFF' },
    editorial: { navy: '1A1A1A', lime: 'E8B4B8', blue: '2F4858', tint: 'C9BFB0', panel: 'F3EFE7', grid: 'DCD5C8', ink: '2A2A2A', mid: '6B6459', white: 'FFFFFF' },
    tech: { navy: '0B0F14', lime: '3DDC97', blue: '2E6BE6', tint: 'A9BACC', panel: 'E9F0F7', grid: 'C9D6E2', ink: '16202B', mid: '4E6076', white: 'FFFFFF' },
    minimal: { navy: '141414', lime: 'E5484D', blue: 'C8102E', tint: 'B3B3B3', panel: 'F4F4F4', grid: 'E2E2E2', ink: '1F1F1F', mid: '6F6F6F', white: 'FFFFFF' },
  };
  return table[key] ?? table.suez;
}

import { shrinkLocalImages } from './shrink.js';
import { registerInspectTools } from './inspect-tools.js';
import { registerPptxEditTool } from './edit-tool.js';
import { registerDocxTool } from './docx-tool.js';
import { registerXlsxTool } from './xlsx-tool.js';
import { registerDocxEditTools } from './docx-xlsx-edit.js';

const ASSET = path.join(import.meta.dirname, '..', 'assets', 'suez-office');
const SCRIPTS = path.join(ASSET, 'scripts');
const SKILL_MD = path.join(ASSET, 'SKILL.md');
const LOG_DIR = path.join(process.env.LOCALAPPDATA || process.env.TMP || '.', 'dsh-suez-office');

export const name = 'suez-office';
export const inject = ['skills', 'tools', 'workingDirectory'];

const log = (msg, detail) => {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = `${new Date().toISOString()} ${msg}${detail ? ' :: ' + String(detail).slice(0, 400) : ''}\n`;
    fs.appendFileSync(path.join(LOG_DIR, 'plugin.log'), line);
  } catch { /* logging must never break a build */ }
};

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

function skillBody() {
  const raw = fs.readFileSync(SKILL_MD, 'utf8');
  return raw.replace(/^---[\s\S]*?---\s*/, '');
}

function skillContent() {
  const paths = {
    node: process.execPath,
    scripts: SCRIPTS.replace(/\\/g, '/'),
    assets: ASSET.replace(/\\/g, '/'),
  };
  return (
    skillBody() +
    `\n## Runtime paths (absolute, never rely on PATH)\n\n\`\`\`json\n${JSON.stringify({ suezDocGen: paths }, null, 2)}\n\`\`\`\n`
  );
}

function skillCandidate() {
  const raw = fs.readFileSync(SKILL_MD, 'utf8');
  const fm = raw.match(/^---([\s\S]*?)---/)?.[1] ?? '';
  const description = new RegExp('description:\\s*(.+)').exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '');
  return {
    name: 'suez-office',
    description: description ?? 'SUEZ 版式系统：用故事板生成品牌一致的 PPTX',
    provider: 'suez-docgen-plugin',
    source: 'bundled',
    rank: 600,
    // SkillInvocation is exactly { modelInvocable, userInvocable }; anything else makes the
    // registry throw at register() time and the skill silently never appears.
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: ASSET.replace(/\\/g, '/') },
    locator: SKILL_MD.replace(/\\/g, '/'),
  };
}

function installSkill(ctx) {
  const skills = ctx.skills;
  const effect = typeof ctx.effect === 'function' ? (fn) => ctx.effect(fn) : (fn) => fn();
  const candidate = skillCandidate();

  if (typeof skills.register === 'function') {
    effect(() => skills.register({
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      resourceBase: candidate.resourceBase,
      path: SKILL_MD,
      content: skillContent(),
    }));
    log('skill registered via register()');
  }
  if (typeof skills.registerProvider === 'function') {
    effect(() => skills.registerProvider(() => ({
      name: 'suez-docgen-plugin',
      list: () => Promise.resolve([candidate]),
      get: async (chosen) => {
        const { rank: _r, locator: _l, ...summary } = chosen;
        return { ...summary, content: skillContent() };
      },
    })));
    log('skill registered via registerProvider()');
  }
}

/* ------------------------------------------------------------------- tools --- */

/**
 * The session's own directory, so a relative path means what the user sees.
 * The service takes the *agent*: called with no arguments it returns nothing and every relative
 * path silently resolves against the host's home directory.
 */
async function sessionCwd(ctx, exec) {
  try {
    if (ctx.workingDirectory && exec && exec.agent) {
      const dir = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      if (dir) return dir;
    }
  } catch { /* fall back to the host directory */ }
  return exec?.cwd ?? process.cwd();
}

const resolveFrom = (cwd, p) => (path.isAbsolute(p) ? p : path.resolve(cwd, p));

async function loadModules() {
  const load = (file) => import(path.join(SCRIPTS, file).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const [deck, lint, validate, ooxml] = await Promise.all([
    load('deck.mjs'), load('lint.mjs'), load('validate.mjs'), load('ooxml.mjs'),
  ]);
  return { ...deck, ...lint, ...validate, ...ooxml };
}

function registerTools(ctx) {
  ctx.tools.register({
    name: 'suez_build_deck',
    description:
      'Build a .pptx from a storyboard spec. **mode is required**: "suez" (official template + ' +
      'archetypes) or "free" (every page hand-made as HTML, no template). If the user has not ' +
      'chosen yet, ask them first — this tool refuses to start without a mode. The SUEZ mode is seeded from the official ' +
      'SUEZ template, so masters, layouts, theme and the embedded brand fonts survive; every page ' +
      'is one of the archetypes (cover / hero / bigNumber / bento / assertion / cards / bullets / ' +
      'imageSplit / imageCard / chart / matrix / timeline / bars / table / statement / quote / ' +
      'section / closing). Charts are native parts with 11 types. Returns the build report: ' +
      'package problems, layout lint and rhythm advice.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'JSON: {"seed"?: string, "footerTitle"?: string, "slides": [{archetype, ...}]}' },
        out: { type: 'string', description: 'Output .pptx path (absolute, or relative to the session cwd).' },
        seed: { type: 'string', description: 'Optional template .pptx override. Defaults to spec.seed.' },
        mode: { type: 'string', enum: ['suez', 'free'], description: 'REQUIRED. "suez" = official template + archetypes; "free" = hand-made HTML pages, no template. Ask the user before choosing.' },
      },
      required: ['spec', 'out', 'mode'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const parsed = JSON.parse(args.spec);
      const slides = parsed.slides ?? parsed;
      if (!Array.isArray(slides) || !slides.length) throw new Error('spec.slides must be a non-empty array');
      const mode = args.mode ?? parsed.mode;
      if (mode !== 'suez' && mode !== 'free') {
        throw new Error(
          'mode 未声明：先问用户——「这册用 SUEZ 模板（走底座 + 英雄页），还是完全自由发挥（我按你的 prompt 自己设计版面）？」' +
          ' 然后在 spec.mode 或参数 mode 里传 "suez" 或 "free"。',
        );
      }
      const freeMode = mode === 'free';
      if (freeMode) {
        const handmade = slides.every((s) => s && s.archetype === 'heroHtml' && (s.html || s.template));
        if (!handmade) {
          throw new Error('free 模式下每一页都必须是 heroHtml（给 html 或 template）：自由发挥不使用原型版式。若要混用原型，请改用 mode: "suez"。');
        }
      }
      // free mode needs a neutral master too: the blank 8 KB seed, plus a matching palette
      // 不传 seed 时用插件自带的那份 SUEZ 模板：新用户不需要自己找模板文件
      let seedPath = args.seed ?? parsed.seed ?? '';
      if (!freeMode && !seedPath) seedPath = path.join(ASSET, 'seed', 'suez-template.pptx');
      if (freeMode && !seedPath) {
        seedPath = path.join(ASSET, 'seeds', 'minimal.pptx');
        if (!parsed.style) parsed.style = 'minimal';
      }
      const seed = seedPath ? resolveFrom(cwd, seedPath) : '';
      const wantsSkin = Boolean(parsed.style && parsed.style !== 'suez');
      if (!wantsSkin && (!seed || !fs.existsSync(seed))) {
        throw new Error(`template seed not found: ${seed || '(missing)'} — 插件自带模板应在 assets/suez-office/seed/suez-template.pptx，或显式传 "seed"`);
      }
      const out = resolveFrom(cwd, args.out);
      await shrinkLocalImages(slides, path.dirname(out), { scriptsDir: SCRIPTS, log });
      const { buildDeck } = await loadModules();

      // hero pages are designed in HTML: render the decoration to a 2x PNG and keep the words as
      // text boxes, then hand the result to the (synchronous) builder
      const heroMod = await import(path.join(SCRIPTS, 'hero.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
      for (const [i, s] of slides.entries()) {
        if (s?.archetype !== 'heroHtml') continue;
        let html = s.html;
        if (!html) {
          const tpl = heroMod.loadTemplate(s.template ?? 'section');
        const varBag = { ...s, ...(s.vars ?? {}) };
        // a value that points at a local image becomes a file:// URL, so <img src="{{screenshot}}"> works
        for (const [k, v] of Object.entries(varBag)) {
          if (typeof v !== 'string' || !/\.(png|jpe?g|svg)$/i.test(v)) continue;
          const abs = resolveFrom(cwd, v);
          if (fs.existsSync(abs)) varBag[k] = 'file:///' + abs.split(String.fromCharCode(92)).join('/');
        }
          // hero templates use {{c_*}} tokens so a skin's palette reaches them too
          const pal = skinPalette(parsed.style);
          const css = (hex) => (String(hex).startsWith("#") ? hex : "#" + hex);
          varBag.c_dark = css(pal.navy); varBag.c_light = css(pal.white); varBag.c_panel = css(pal.panel);
          varBag.c_accent = css(pal.lime); varBag.c_blue = css(pal.blue); varBag.c_tint = css(pal.tint);
          varBag.c_muted = css(pal.mid); varBag.c_grid = css(pal.grid); varBag.c_ink = css(pal.ink);
          varBag.c_rule = css(pal.grid);
          html = heroMod.fillTemplate(tpl, varBag);
        } else if (fs.existsSync(resolveFrom(cwd, html))) {
          html = fs.readFileSync(resolveFrom(cwd, html), 'utf8');
        }
        const hero = await heroMod.renderHero({ html, outDir: path.join(path.dirname(out), '.suez-hero'), name: `p${i + 1}`, scale: 2 });
        s.image = hero.background;
        s.boxes = hero.boxes;
        log('hero', `p${i + 1} ${hero.boxes.length} text boxes, ${hero.browser}`);
      }

      const r = buildDeck({ seed, out, slides: slides.map(({ boxes, ...rest }) => ({ ...rest, boxes })), footerTitle: parsed.footerTitle ?? '', style: parsed.style, mode });
      log('build', `${out} pages=${r.slides.length} problems=${r.problems.length} lint=${r.lint.errors.length}`);

      return [
        `built ${r.out}`,
        `  pages: ${r.slides.map((s) => `${s.page}:${s.archetype}`).join('  ')}`,
        `  layout: ${r.layoutTarget}   grid: 6 × ${r.grid.colWidth}" / gutter ${r.grid.gutter}"`,
        r.problems.length ? `  PACKAGE PROBLEMS (${r.problems.length}):\n   - ${r.problems.join('\n   - ')}` : '  package: CLEAN',
        r.lint.errors.length ? `  LINT ERRORS (${r.lint.errors.length}):\n   - ${r.lint.errors.join('\n   - ')}` : '  lint: CLEAN',
        r.lint.warnings.length ? `  lint warnings: ${r.lint.warnings.length}\n   - ${r.lint.warnings.slice(0, 6).join('\n   - ')}` : '',
        `  rhythm: ${r.rhythm.stats.visualPages}/${r.rhythm.stats.pages} anchor pages, body dark ${(r.rhythm.stats.darkRatio * 100).toFixed(0)}%`,
        r.rhythm.issues.length ? `   - ${r.rhythm.issues.join('\n   - ')}` : '  rhythm: OK',
      ].filter(Boolean).join('\n');
    },
  });

  registerRenderTool(ctx, { scriptsDir: SCRIPTS, resolveFrom, sessionCwd, log });
  registerImageTool(ctx, { scriptsDir: SCRIPTS, resolveFrom, sessionCwd, log });
  registerInspectTools(ctx, { scriptsDir: SCRIPTS, resolveFrom, sessionCwd, log });
  registerPptxEditTool(ctx, { scriptsDir: SCRIPTS, resolveFrom, sessionCwd, log });
  registerDocxTool(ctx, { scriptsDir: SCRIPTS, resolveFrom, sessionCwd, log });
  registerXlsxTool(ctx, { scriptsDir: SCRIPTS, resolveFrom, sessionCwd, log });
  registerDocxEditTools(ctx, { scriptsDir: SCRIPTS, resolveFrom, sessionCwd, log });

  ctx.tools.register({
    name: 'suez_lint_deck',
    description:
      'Run the three package gates and the layout lint on an existing .pptx: schema-level enums and ' +
      'geometry, content types, relationship targets, page bounds, text-on-text overlap, font floors, ' +
      'contrast and text density. Use it on any deck before delivery, including ones you did not build.',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string', description: '.pptx path (absolute, or relative to the session cwd).' } },
      required: ['file'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const file = resolveFrom(cwd, args.file);
      if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
      const { ZipDoc, checkPackageIntegrity, checkStructure, validatePackage, lintPackage } = await loadModules();
      const doc = new ZipDoc(file);
      const pkg = [...checkPackageIntegrity(doc.parts), ...checkStructure(doc.parts), ...validatePackage(doc)];
      const lint = lintPackage(doc);
      log('lint', `${file} pkg=${pkg.length} errors=${lint.errors.length}`);
      return [
        `${path.basename(file)} — ${lint.stats.pages} pages, ${lint.stats.shapes} shapes, smallest type ${lint.stats.smallestText}pt`,
        pkg.length ? `  package problems (${pkg.length}):\n   - ${pkg.join('\n   - ')}` : '  package: CLEAN',
        lint.errors.length ? `  lint errors (${lint.errors.length}):\n   - ${lint.errors.join('\n   - ')}` : '  lint: CLEAN',
        lint.warnings.length ? `  warnings (${lint.warnings.length}):\n   - ${lint.warnings.join('\n   - ')}` : '',
      ].filter(Boolean).join('\n');
    },
  });
}

export function apply(ctx) {
  log(`apply: skills=${Boolean(ctx.skills)} tools=${Boolean(ctx.tools)} node=${process.execPath}`);
  const withService = (service, run) => {
    try {
      if (ctx[service]) return run(ctx);
      if (typeof ctx.inject === 'function') return ctx.inject([service], () => run(ctx));
    } catch (err) { log(`FAILED: ${service}`, err?.stack ?? String(err)); }
  };
  withService('skills', installSkill);
  withService('tools', registerTools);
}
