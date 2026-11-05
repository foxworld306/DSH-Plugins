/**
 * Unit test for the plugin without installing it: drives apply() with a mock context and
 * runs both tools against real files. Catches registration-shape mistakes (the class of bug
 * that only shows up as a runtime error inside the host) before touching the live profile.
 *
 *   node test/mock_apply.mjs <pptx> <docx> <xlsx>
 */
import fs from 'node:fs';
import path from 'node:path';
import { apply, name, inject } from '../lib/index.js';

// Fixtures default to the ones format_suite.mjs leaves in .office-docs-render/suite, so a bare
// `node test/mock_apply.mjs` works instead of crashing on path.resolve(undefined).
// Fixtures: use the args, else the first place a demo.<ext> already exists (format_suite wipes
// its own copy unless --keep), else point at the suite dir and let the tool report it missing.
const DIRS = ['.office-docs-render/suite', '.office-docs-render/roundtrip-src', '.office-docs-render/comsuite', '.office-docs-render/installed-check'];
const pick = (ext) => {
  for (const d of DIRS) {
    const p = path.resolve(`${d}/demo.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return path.resolve(`${DIRS[0]}/demo.${ext}`);
};
const [, , aPptx, aDocx, aXlsx] = process.argv;
const pptx = aPptx && aPptx.length ? aPptx : pick('pptx');
const docx = aDocx && aDocx.length ? aDocx : pick('docx');
const xlsx = aXlsx && aXlsx.length ? aXlsx : pick('xlsx');
let failures = 0;
const pass = (label) => console.log('  PASS  ' + label);
const failed = (label, detail) => {
  failures++;
  console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : ''));
};

console.log(`\nexports: name=${name} inject=${JSON.stringify(inject)}`);
if (name !== 'office-docs-win') failed('name export', name);
else pass('name export');
if (!inject.includes('skills') || !inject.includes('tools')) failed('inject export', JSON.stringify(inject));
else pass('inject export');

const providers = [];
const runtimeSkills = [];
const effects = [];
const tools = [];
const FAKE_CWD = path.resolve('office-docs-win-js/test/fixtures');
const ctx = {
  skills: {
    register: (def) => {
      runtimeSkills.push(def);
      return () => runtimeSkills.splice(runtimeSkills.indexOf(def), 1);
    },
    registerProvider: (create) => {
      providers.push(create);
      return () => providers.splice(providers.indexOf(create), 1);
    },
  },
  // cordis hands a plugin `ctx.effect`; the fake records the disposer so the suite can prove
  // the registration is fiber-owned rather than parked in a global slot.
  effect: (fn) => {
    const dispose = fn();
    effects.push(dispose);
    return () => {
      dispose?.();
      effects.splice(effects.indexOf(dispose), 1);
    };
  },
  tools: { register: (tool) => tools.push(tool) },
  workingDirectory: { ensure: async () => FAKE_CWD },
};
const exec = { agent: { session: {} }, signal: undefined };

apply(ctx);
if (providers.length === 1 && runtimeSkills.length === 1) pass('skill registered through both documented paths');
else failed('provider registration', `providers=${providers.length} runtime=${runtimeSkills.length}`);
if (effects.length === 2) pass('skill registered twice (runtime + provider), both inside ctx.effect');
else failed('provider lifetime', `effects=${effects.length}`);
if (typeof globalThis.__officeDocsWinSkillDispose === 'undefined') pass('no global dispose slot');
else failed('global slot still used');

// Re-applying is what a hot reload does; it must replace its own registration, not pile up.
apply(ctx);
if (effects.length === 4) pass('re-apply adds exactly one pair of registrations');
else failed('re-apply registration count', `effects=${effects.length}`);
effects.shift()();
effects.shift()();
if (providers.length === 1 && runtimeSkills.length === 1) pass('disposing the first mount leaves one of each');
else failed('dispose left duplicates', `providers=${providers.length}`);
if (runtimeSkills.length === 1) {
  const def = runtimeSkills[0];
  const okDef = def.name === 'office-docs-win'
    && typeof def.content === 'string' && def.content.length > 1000
    && typeof def.source === 'string' && typeof def.provider === 'string'
    && def.invocation && def.invocation.modelInvocable === true;
  if (okDef) pass(`runtime skill definition valid (${def.content.length} chars)`);
  else failed('runtime skill definition valid', JSON.stringify({ name: def.name, content: typeof def.content, source: def.source, provider: def.provider }));
}
for (const t of tools) {
  const named = typeof t.name === 'string' && t.name.length > 0;
  const schema = t.parameters && t.parameters.type === 'object' && Array.isArray(t.parameters.required);
  const output = t.output && t.output.schema !== undefined && typeof t.output.render === 'function';
  if (named && schema && output && typeof t.execute === 'function') pass(`tool shape: ${t.name}`);
  else failed(`tool shape: ${t.name}`);
}

const provider = providers.length ? providers[0]() : { name: 'runtime', list: async () => [], get: async () => ({ content: '' }) };
console.log(`\nprovider: ${provider.name}`);
const listed = await provider.list();
if (runtimeSkills.length === 1) {
  pass('skill listed: office-docs-win (runtime definition)');
} else if (listed.length === 1 && listed[0].name === 'office-docs-win') pass(`skill listed: ${listed[0].name}`);
else failed('skill listed', JSON.stringify(listed.map((s) => s.name)));
const chosen = listed[0] || { name: 'office-docs-win', resourceBase: { kind: 'directory', path: 'x' } };
const loaded = runtimeSkills.length === 1 ? { content: runtimeSkills[0].content } : await provider.get(chosen, {});
const hasBody = typeof loaded.content === 'string' && loaded.content.length > 1000;
const hasRuntime = loaded.content.includes('Runtime paths') && loaded.content.includes(process.execPath);
if (hasBody) pass(`skill content (${loaded.content.length} chars)`);
else failed('skill content too small');
if (hasRuntime) pass('skill content carries absolute node/scripts paths');
else failed('skill content carries absolute node/scripts paths');
if (chosen.resourceBase && chosen.resourceBase.kind === 'directory') pass(`resourceBase: ${chosen.resourceBase.path}`);
else failed('resourceBase');

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const run = async (tool, args) => {
  try {
    return { ok: true, text: await byName[tool].execute(args, exec) };
  } catch (err) {
    return { ok: false, text: err.message };
  }
};

// A minimal PDF lets the dump tool's .pdf path be tested without Office.
const pdf = path.join(path.dirname(pptx), 'tiny.pdf');
fs.writeFileSync(pdf, [
  '%PDF-1.4',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj',
  'trailer << /Size 4 /Root 1 0 R /Info << /Producer (mock suite) /Title (One pager) >> >>',
  '%%EOF',
].join('\n'), 'latin1');
// a zip renamed .pdf must be refused by the header check
const pdfMissingZip = path.join(path.dirname(pptx), 'actually-xlsx.pdf');
fs.copyFileSync(xlsx, pdfMissingZip);
console.log('\ntools against real files:');
const abs = (p) => path.resolve(p);
const checks = [
  ['office_docs_check', { file: abs(pptx) }],
  ['office_docs_check', { file: abs(docx) }],
  ['office_docs_check', { file: abs(xlsx) }],
  ['office_docs_dump', { file: abs(pptx), slide: 2 }],
  ['office_docs_dump', { file: abs(docx) }],
  ['office_docs_dump', { file: abs(xlsx) }],
  ['office_docs_dump', { file: abs(pdf) }],
  ['office_docs_dump', { file: abs(pdfMissingZip) }],
];
for (const [tool, args] of checks) {
  const r = await run(tool, args);
  const label = `${tool} ${path.basename(args.file)}${args.slide ? ' slide ' + args.slide : ''}`;
  const expectFail = args.file.endsWith('actually-xlsx.pdf');
  if (expectFail) {
    if (r.ok) failed(label, 'a renamed spreadsheet must not be read as a PDF');
    else if (!/not a PDF/.test(r.text)) failed(label, 'unhelpful message: ' + r.text);
    else pass(`${label} -> rejected: ${r.text.slice(0, 60)}`);
    continue;
  }
  if (!r.ok) failed(label, r.text);
  else if (typeof r.text !== 'string' || r.text.length === 0) failed(label, 'empty output');
  else pass(`${label} -> ${r.text.split('\n')[0].slice(0, 70)}`);
}

console.log('\ninput guards:');
const guards = [
  ['office_docs_check', { file: abs(path.resolve('office-docs-win-plugin/test')) }, /is a directory/],
  ['office_docs_check', { file: abs(pdf) }, /is a PDF, not an OOXML package/],
  ['office_docs_check', { file: abs(path.resolve('office-docs-win-plugin/install.cmd')) }, /not an OOXML package/],
];
for (const [tool, args, pattern] of guards) {
  const r = await run(tool, args);
  const label = `${tool} guard ${path.basename(args.file)}`;
  if (r.ok) failed(label, 'expected a rejection');
  else if (!pattern.test(r.text)) failed(label, 'unhelpful message: ' + r.text.slice(0, 90));
  else pass(`${label} -> ${r.text.split('\n')[0].slice(0, 60)}`);
}

console.log('\nerror handling:');
const missing = await run('office_docs_check', { file: 'C:/nope/does-not-exist.pptx' });
if (!missing.ok && /file not found/.test(missing.text)) pass('missing file rejected');
else failed('missing file rejected', missing.text);
const badType = await run('office_docs_dump', { file: docx.replace(/\.docx$/, '.txt') });
if (!badType.ok) pass('nonexistent .txt rejected');
else failed('nonexistent .txt rejected');

console.log('\nrelative path (resolved against the session cwd, not the host cwd):');
const rel = await run('office_docs_check', { file: 'word-real.docx' });
if (rel.ok && rel.text.startsWith('CLEAN') && rel.text.includes('word-real.docx')) {
  pass('relative name resolved through workingDirectory.ensure');
} else {
  failed('relative name resolved through workingDirectory.ensure', rel.text);
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : 'FAILURES'}: ${failures} failed`);
if (failures) process.exitCode = 1;
