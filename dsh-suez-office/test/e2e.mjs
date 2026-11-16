/**
 * End-to-end smoke test: every tool, through the plugin entry point, on real files.
 *
 *   node test/e2e.mjs --seed "<path to SUEZ template>.pptx"
 *
 * Each step is an actual tool call (same code path the model uses), and the artefacts are checked
 * with the package gates + Office COM rendering. Exit code 1 if anything fails.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const seedArg = args.indexOf('--seed');
const SEED = seedArg >= 0 ? args[seedArg + 1] : '';
const OUT = path.join(os.tmpdir(), 'suez-e2e-' + Date.now().toString(36));
fs.mkdirSync(OUT, { recursive: true });

const here = import.meta.dirname;
const entry = path.join(here, '..', 'lib', 'index.js');

const mod = await import(path.join(entry).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const tools = [];
mod.apply({
  skills: { register: () => () => {}, registerProvider: () => () => {} },
  tools: { register: (t) => tools.push(t) },
  effect: (fn) => fn(),
  workingDirectory: { ensure: async (a) => (a ? OUT : undefined) },
});
const t = (name) => tools.find((x) => x.name === name);

const results = [];
let failed = 0;

async function step(label, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ label, ok: true, ms: Date.now() - t0, detail: detail ?? '' });
  } catch (e) {
    failed += 1;
    results.push({ label, ok: false, ms: Date.now() - t0, detail: String(e.message).split('\n')[0].slice(0, 120) });
  }
}

const exists = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;
const clean = (text) => /CLEAN/.test(text);

const deck = path.join(OUT, 'deck.pptx');
const freeDeck = path.join(OUT, 'free.pptx');
const docx = path.join(OUT, 'doc.docx');
const xlsx = path.join(OUT, 'book.xlsx');

// 1. build a SUEZ deck ------------------------------------------------------------------------
await step('suez_build_deck (mode: suez)', async () => {
  const out = await t('suez_build_deck').execute({
    mode: 'suez',
    seed: SEED,
    out: deck,
    spec: JSON.stringify({
      footerTitle: 'e2e',
      slides: [
        { archetype: 'statement', text: '端到端测试。' },
        { archetype: 'table', title: '对照表', columns: ['A', 'B'], rows: [['x', '1']] },
      ],
    }),
  }, { agent: {} });
  if (!exists(deck) || !clean(out)) throw new Error(out.slice(0, 120));
  return '2 pages, package CLEAN';
});

// 2. build a free-form deck -------------------------------------------------------------------
await step('suez_build_deck (mode: free)', async () => {
  const html = path.join(OUT, 'p1.html');
  fs.writeFileSync(html, '<!doctype html><style>body{width:1920px;height:1080px;margin:0;background:#eee}' +
    '.t{position:absolute;left:120px;top:120px;font-size:64px}</style><p class="t">自由发挥</p>', 'utf8');
  const out = await t('suez_build_deck').execute({
    mode: 'free', out: freeDeck,
    spec: JSON.stringify({ slides: [{ archetype: 'heroHtml', html }] }),
  }, { agent: {} });
  if (!exists(freeDeck) || !clean(out)) throw new Error(out.slice(0, 120));
  return '1 page, package CLEAN';
});

// 3. gates refuse a deck without a mode -------------------------------------------------------
await step('suez_build_deck rejects a missing mode', async () => {
  try {
    await t('suez_build_deck').execute({ seed: SEED, out: path.join(OUT, 'x.pptx'), spec: JSON.stringify({ slides: [{ archetype: 'statement', text: 'x' }] }) }, { agent: {} });
  } catch (e) {
    if (/mode/.test(e.message)) return 'refused as designed';
    throw e;
  }
  throw new Error('built without a mode');
});

// 4. dump / check / lint ----------------------------------------------------------------------
await step('suez_dump (pptx)', async () => {
  const out = await t('suez_dump').execute({ file: deck, slide: 1 }, { agent: {} });
  if (!out.includes('slide size')) throw new Error('no slide size in dump');
  return out.split('\n')[0];
});

await step('suez_check (pptx)', async () => {
  const out = await t('suez_check').execute({ file: deck }, { agent: {} });
  if (!clean(out)) throw new Error(out.slice(0, 120));
  return out.split('\n')[0].slice(0, 60);
});

await step('suez_lint_deck', async () => {
  const out = await t('suez_lint_deck').execute({ file: deck }, { agent: {} });
  if (/ERROR/i.test(out) && !/no errors|0 error/i.test(out)) throw new Error(out.slice(0, 120));
  return out.split('\n').slice(0, 2).join(' / ').slice(0, 80);
});

// 5. render -----------------------------------------------------------------------------------
await step('suez_render_page (pptx → png)', async () => {
  const png = path.join(OUT, 'p1.png');
  await t('suez_render_page').execute({ file: deck, page: 1, out: png }, { agent: {} });
  if (!exists(png)) throw new Error('no png');
  return Math.round(fs.statSync(png).size / 1024) + ' KB';
});

// 6. edit the deck ----------------------------------------------------------------------------
await step('suez_edit_pptx (text + duplicate)', async () => {
  const src = await t('suez_dump').execute({ file: deck, slide: 1 }, { agent: {} });
  const names = [...src.matchAll(/sp\s+([^\s[][^\[]*?)\s+\[/g)].map((m) => m[1].trim());
  const shape = names.find((n) => /statement|title/i.test(n)) ?? names[names.length - 1];
  const out = path.join(OUT, 'deck-v2.pptx');
  const res = await t('suez_edit_pptx').execute({
    input: deck, out,
    ops: JSON.stringify([{ op: 'setText', slide: 1, shape, text: '改过的句子' }, { op: 'duplicateSlide', slide: 2 }]),
  }, { agent: {} });
  if (!exists(out) || !clean(res)) throw new Error(res.slice(0, 140));
  return 'shape "' + shape + '" + duplicateSlide';
});

// 7. comment on the deck ----------------------------------------------------------------------
await step('suez_add_comment (pptx)', async () => {
  const out = path.join(OUT, 'deck-commented.pptx');
  const res = await t('suez_add_comment').execute({ input: deck, out, index: 1, text: '这里要补图' }, { agent: {} });
  if (!exists(out) || !clean(res)) throw new Error(res.slice(0, 140));
  const dump = await t('suez_dump').execute({ file: out, slide: 1 }, { agent: {} });
  if (!dump.includes('这里要补图')) throw new Error('comment not readable back');
  return 'written + read back';
});

// 8. Word -------------------------------------------------------------------------------------
await step('suez_build_docx', async () => {
  const out = await t('suez_build_docx').execute({
    out: docx,
    spec: JSON.stringify({
      title: '标题', subtitle: '副标题', header: '页眉', footer: '页脚',
      sections: [
        { heading: '一、正文', paragraphs: ['一段话。'], bullets: ['要点'] },
        { heading: '二、表格', table: { columns: ['A', 'B'], rows: [['x', '1']] } },
      ],
    }),
  }, { agent: {} });
  if (!exists(docx) || !clean(out)) throw new Error(out.slice(0, 140));
  return '2 sections + table, package CLEAN';
});

await step('suez_edit_docx (paragraph + cell)', async () => {
  const out = path.join(OUT, 'doc-v2.docx');
  const res = await t('suez_edit_docx').execute({
    input: docx, out,
    ops: JSON.stringify([{ op: 'setParagraph', match: '一段话', text: '改过的段落。' }, { op: 'setTableCell', table: 1, row: 2, col: 2, text: '9' }]),
  }, { agent: {} });
  if (!exists(out) || !clean(res)) throw new Error(res.slice(0, 140));
  return 'paragraph + cell replaced';
});

await step('suez_add_comment (docx)', async () => {
  const out = path.join(OUT, 'doc-commented.docx');
  const res = await t('suez_add_comment').execute({ input: docx, out, match: '一、正文', text: '确认口径' }, { agent: {} });
  if (!exists(out) || !clean(res)) throw new Error(res.slice(0, 140));
  const dump = await t('suez_dump').execute({ file: out }, { agent: {} });
  if (!dump.includes('确认口径')) throw new Error('comment not readable back');
  return 'written + read back';
});

await step('suez_clean_docx (revisions + comments)', async () => {
  const out = path.join(OUT, 'doc-clean.docx');
  const res = await t('suez_clean_docx').execute({ input: path.join(OUT, 'doc-commented.docx'), out, acceptRevisions: true, stripComments: true }, { agent: {} });
  if (!exists(out) || !clean(res)) throw new Error(res.slice(0, 140));
  const dump = await t('suez_dump').execute({ file: out }, { agent: {} });
  if (/comments/i.test(dump)) throw new Error('comments still present');
  return 'comments stripped, package CLEAN';
});

// 9. Excel ------------------------------------------------------------------------------------
await step('suez_build_xlsx (with a formula)', async () => {
  const out = await t('suez_build_xlsx').execute({
    out: xlsx,
    spec: JSON.stringify({
      sheets: [{
        name: 'S1', header: ['项目', 'Q3', 'Q2'],
        columns: [{ width: 22 }, { width: 14, type: 'number' }, { width: 14, type: 'number' }],
        rows: [['营收', 28.05, 28.24], ['毛利', 5.5, 4.74], ['合计', '=SUM(B2:B3)', '=SUM(C2:C3)']],
      }],
    }),
  }, { agent: {} });
  if (!exists(xlsx) || !clean(out)) throw new Error(out.slice(0, 140));
  const dump = await t('suez_dump').execute({ file: xlsx }, { agent: {} });
  if (!dump.toLowerCase().includes('sheet')) throw new Error('dump has no sheets');
  return 'formula cells, package CLEAN';
});

await step('suez_edit_xlsx (value + formula)', async () => {
  const out = path.join(OUT, 'book-v2.xlsx');
  const res = await t('suez_edit_xlsx').execute({
    input: xlsx, out,
    ops: JSON.stringify([
      { op: 'setCell', sheet: 'S1', cell: 'B2', value: 29.42 },
      { op: 'setCell', sheet: 'S1', cell: 'B5', value: 0, formula: '=SUM(B2:B4)' },
    ]),
  }, { agent: {} });
  if (!exists(out) || !clean(res)) throw new Error(res.slice(0, 140));
  return 'value + formula written';
});

// 10. PDF -------------------------------------------------------------------------------------
await step('suez_export_pdf (docx → pdf)', async () => {
  const pdf = path.join(OUT, 'doc.pdf');
  const res = await t('suez_export_pdf').execute({ file: docx, out: pdf }, { agent: {} });
  if (!exists(pdf)) throw new Error(res.slice(0, 140));
  return Math.round(fs.statSync(pdf).size / 1024) + ' KB';
});

await step('suez_render_page (docx → pdf)', async () => {
  const pdf = path.join(OUT, 'xlsx-view.pdf');
  await t('suez_render_page').execute({ file: path.join(OUT, 'book-v2.xlsx'), out: pdf }, { agent: {} });
  if (!exists(pdf)) throw new Error('no pdf');
  return Math.round(fs.statSync(pdf).size / 1024) + ' KB';
});

// 11. images ----------------------------------------------------------------------------------
await step('suez_fetch_image', async () => {
  const outDir = path.join(OUT, 'img');
  const res = await t('suez_fetch_image').execute({
    url: 'https://images.pexels.com/photos/325185/pexels-photo-325185.jpeg',
    out: outDir, name: 'e2e-photo', license: 'Pexels License', author: 'Pexels', source: 'https://www.pexels.com/',
  }, { agent: {} });
  if (!fs.existsSync(outDir)) throw new Error(res.slice(0, 160));
  const files = fs.readdirSync(outDir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
  if (!files.length) throw new Error(res.slice(0, 160));
  const hasCredits = fs.existsSync(path.join(outDir, 'credits.json'));
  return files[0] + (hasCredits ? ' + credits.json' : ' (no credits.json)');
});

// ------------------------------------------------------------------------------------------
const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(44)} ${String(r.ms + 'ms').padStart(7)}  ${r.detail}`);
console.log(lines.join('\n'));
console.log(`\n${results.length - failed}/${results.length} steps passed in ${OUT}`);
process.exit(failed ? 1 : 0);
