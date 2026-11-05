/**
 * Format suite — verifies the shipped toolkit against real files, for PPTX / DOCX / XLSX.
 *
 *   node test/format_suite.mjs [--keep]
 *
 * It generates fixtures with the shipped examples first (so the examples are covered too),
 * then mutates copies to prove the integrity gate actually rejects broken packages, then
 * exercises the read/edit path. Every check prints PASS/FAIL with the reason; exit code is
 * 1 if anything failed.
 *
 * COM (Word/Excel/PowerPoint) is deliberately NOT touched here — that runs in
 * test/com_suite.ps1, so this file stays fast and safe to run anywhere.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipDoc, checkPackageIntegrity, duplicateParaIds, shapeBlockRegex, xmlError } from '../assets/office-docs-win/scripts/ooxml.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASSETS = path.join(ROOT, 'assets', 'office-docs-win');
const EXAMPLES = path.join(ASSETS, 'examples');
const SCRIPTS = path.join(ASSETS, 'scripts');
const WORK = path.join(ROOT, '..', '.office-docs-render', 'suite');
const KEEP = process.argv.includes('--keep');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } catch (err) {
    failures.push({ name, message: err && err.message ? err.message : String(err) });
    console.log(`  FAIL  ${name}\n          ${err && err.message ? err.message : err}`);
  }
}

const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};
const assertEq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
};

/**
 * Run node and capture its output.
 *
 * The DSH sandbox denies named pipes, so child_process with stdio:"pipe" dies with EPERM and a
 * null status. Redirecting through cmd.exe writes to a regular file instead, which works both
 * sandboxed and unsandboxed; on non-Windows hosts we fall back to a plain pipe.
 */
function runNode(args) {
  if (process.platform !== 'win32') {
    const res = spawnSync(process.execPath, args, { encoding: 'utf8' });
    return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
  }
  // give the child a real file handle instead of a pipe: no named pipe, no cmd.exe quoting
  const log = path.join(WORK, `.run-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  const fd = fs.openSync(log, 'w');
  const res = spawnSync(process.execPath, args, { stdio: ['ignore', fd, fd], windowsHide: true });
  fs.closeSync(fd);
  const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  fs.rmSync(log, { force: true });
  const status = res.error ? -1 : res.status;
  return { status, out: text, err: text };
}

/** Run a shipped example script; it must exit 0. */
function runExample(script, args) {
  const res = runNode([path.join(EXAMPLES, script), ...args]);
  if (res.status !== 0) {
    throw new Error(`${script} exited ${res.status}: ${(res.out || '').trim().split('\n')[0]}`);
  }
  return res.out.trim();
}

function runDump(file, slide) {
  const args = [path.join(SCRIPTS, 'dump.mjs'), file];
  if (slide !== undefined) args.push(String(slide));
  const res = runNode(args);
  return { status: res.status, out: res.out, err: res.err };
}

function runCheck(file) {
  const res = runNode([path.join(SCRIPTS, 'ooxml.mjs'), 'check', file]);
  return { status: res.status, out: res.out, err: res.err };
}

const problemsOf = (parts, opts) => checkPackageIntegrity(parts, opts);

/** Common mutations, each must be detected. */
function mutate(srcFile, dstFile, mutateParts) {
  const doc = new ZipDoc(srcFile);
  mutateParts(doc);
  doc.save(dstFile);
  return problemsOf(doc.parts);
}

/* =========================================================== fixtures ========= */
console.log('\n--- fixtures (shipped examples) ---');
const DECK = path.join(WORK, 'demo.pptx');
const DOCX = path.join(WORK, 'demo.docx');
const XLSX = path.join(WORK, 'demo.xlsx');

check('build_deck.mjs runs', () => runExample('build_deck.mjs', ['--out', DECK]).split('\n')[0]);
check('build_docx.mjs runs', () => runExample('build_docx.mjs', ['--out', DOCX]).split('\n')[0]);
check('build_xlsx.mjs runs', () => runExample('build_xlsx.mjs', ['--out', XLSX]).split('\n')[0]);

for (const [label, file] of [['pptx', DECK], ['docx', DOCX], ['xlsx', XLSX]]) {
  check(`${label}: example output exists and is non-trivial`, () => {
    assert(fs.existsSync(file), 'file was not created');
    const kb = fs.statSync(file).size / 1024;
    assert(kb > 0.8, `suspiciously small (${kb.toFixed(1)} KB)`);
    return `${kb.toFixed(1)} KB`;
  });
  check(`${label}: integrity gate is CLEAN`, () => {
    const doc = new ZipDoc(file);
    const problems = problemsOf(doc.parts);
    assertEq(problems.length, 0, 'integrity problems: ' + problems.join(' | '));
    return `${doc.parts.size} parts`;
  });
  check(`${label}: XML well-formed everywhere`, () => {
    const doc = new ZipDoc(file);
    const bad = [];
    for (const [name, value] of doc.parts) {
      const low = name.toLowerCase();
      if (!(low.endsWith('.xml') || low.endsWith('.rels'))) continue;
      const err = xmlError(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
      if (err) bad.push(`${name}: ${err}`);
    }
    assertEq(bad.length, 0, 'malformed: ' + bad.join(' | '));
    return 'all parts well-formed';
  });
}

/* ============================================================== read path ===== */
console.log('\n--- read path (dump.mjs) ---');

check('pptx: dump finds both slides and the title text', () => {
  const { status, out } = runDump(DECK);
  assertEq(status, 0, 'dump failed: ' + out);
  assert(/slide1\.xml/.test(out), 'slide1 missing from dump');
  assert(/slide2\.xml/.test(out), 'slide2 missing from dump');
  assert(/Quarterly Review/.test(out), 'title text missing from dump');
  return out.split('\n')[0];
});

check('pptx: dump with slide number limits output to that slide', () => {
  const { out } = runDump(DECK, 1);
  assert(/slide1\.xml/.test(out), 'slide1 missing');
  assert(!/slide2\.xml/.test(out), 'slide2 leaked into single-slide dump');
  return 'slide filter works';
});

check('docx: dump finds headings, paragraphs and the table', () => {
  const { status, out } = runDump(DOCX);
  assertEq(status, 0, 'dump failed: ' + out);
  assert(/document\.xml/.test(out), 'document part missing');
  assert(/w:tbl|table/i.test(out), 'table not reported');
  return out.split('\n')[0];
});

check('xlsx: dump finds the sheet name and a formula', () => {
  const { status, out } = runDump(XLSX);
  assertEq(status, 0, 'dump failed: ' + out);
  assert(/预算汇总/.test(out), 'sheet name missing from dump');
  assert(/SUM\(|=/.test(out), 'formula missing from dump');
  return out.split('\n')[0];
});

check('dump rejects an unsupported extension with a clear message', () => {
  const fake = path.join(WORK, 'x.txt');
  fs.writeFileSync(fake, 'not office\n');
  const { status, err } = runDump(fake);
  assertEq(status, 1, 'expected exit code 1');
  assert(/unsupported/.test(err), 'message should say unsupported, got: ' + err.trim());
  return err.trim();
});

/* ============================================================== edit path ===== */
console.log('\n--- edit path (read, modify, save, re-read) ---');

check('pptx: replace a run and keep the package valid', () => {
  const out = path.join(WORK, 'edited.pptx');
  const doc = new ZipDoc(DECK);
  const xml = doc.part('ppt/slides/slide1.xml');
  const titleBlock = xml.match(shapeBlockRegex('Title'));
  assert(titleBlock, 'no shape named Title in slide1');
  assert(/Quarterly Review/.test(titleBlock[0]), 'fixture title text not found');
  // shapeBlockRegex is the safe way in: a blind replace would hit <p:cSld name="Quarterly Review">
  const edited = titleBlock[0].replace('Quarterly Review', 'Edited Title 2027');
  doc.setPart('ppt/slides/slide1.xml', xml.replace(titleBlock[0], edited));
  doc.save(out);
  const problems = problemsOf(new ZipDoc(out).parts);
  assertEq(problems.length, 0, 'broken after edit: ' + problems.join(' | '));
  const { out: dump } = runDump(out);
  assert(/Edited Title 2027/.test(dump), 'edit not visible in dump');
  return 'text replaced, still CLEAN';
});

check('docx: append a paragraph before sectPr and keep the package valid', () => {
  const out = path.join(WORK, 'edited.docx');
  const doc = new ZipDoc(DOCX);
  const xml = doc.part('word/document.xml');
  assert(/<w:sectPr/.test(xml), 'fixture has no sectPr');
  const para =
    '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr>' +
    '<w:t>Appended by format_suite.</w:t></w:r></w:p>';
  doc.setPart('word/document.xml', xml.replace(/<w:sectPr/, para + '<w:sectPr'));
  doc.save(out);
  const problems = problemsOf(new ZipDoc(out).parts);
  assertEq(problems.length, 0, 'broken after append: ' + problems.join(' | '));
  const { out: dump } = runDump(out);
  assert(/Appended by format_suite/.test(dump), 'appended paragraph not visible in dump');
  return 'paragraph appended, still CLEAN';
});

check('xlsx: change a cell and keep cached formula values valid', () => {
  const out = path.join(WORK, 'edited.xlsx');
  const doc = new ZipDoc(XLSX);
  const name = [...doc.parts.keys()].find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n));
  assert(name, 'sheet1.xml not found');
  const xml = doc.part(name);
  assert(/<v>2980<\/v>/.test(xml), 'expected cached value 2980 in fixture');
  doc.setPart(name, xml.replace('<v>2980</v>', '<v>3210</v>'));
  doc.save(out);
  const problems = problemsOf(new ZipDoc(out).parts);
  assertEq(problems.length, 0, 'broken after cell edit: ' + problems.join(' | '));
  const { out: dump } = runDump(out);
  assert(/3210/.test(dump), 'new value not visible in dump');
  return 'cell value changed, still CLEAN';
});

check('roundtrip: load → save → load keeps every part byte-identical', () => {
  for (const file of [DECK, DOCX, XLSX]) {
    const first = new ZipDoc(file);
    const copy = path.join(WORK, 'roundtrip' + path.extname(file));
    first.save(copy);
    const second = new ZipDoc(copy);
    assertEq(second.parts.size, first.parts.size, `part count changed for ${path.basename(file)}`);
    for (const [name, value] of first.parts) {
      const again = second.parts.get(name);
      assert(again !== undefined, `part lost in roundtrip: ${name}`);
      assert(Buffer.from(value).equals(Buffer.from(again)), `part bytes changed in roundtrip: ${name}`);
    }
  }
  return '3 formats, all parts identical';
});

/* ======================================================== broken packages ===== */
console.log('\n--- negative cases (the gate must reject these) ---');

check('truncated zip is rejected', () => {
  const bad = path.join(WORK, 'truncated.pptx');
  const buf = fs.readFileSync(DECK);
  fs.writeFileSync(bad, buf.subarray(0, Math.floor(buf.length * 0.6)));
  let threw = null;
  try {
    new ZipDoc(bad);
  } catch (err) {
    threw = err.message;
  }
  assert(threw, 'ZipDoc accepted a truncated archive');
  return threw.slice(0, 80);
});

check('missing [Content_Types].xml is rejected with a clear message', () => {
  const bad = path.join(WORK, 'no-content-types.docx');
  const doc = new ZipDoc(DOCX);
  doc.parts.delete('[Content_Types].xml');
  doc.save(bad);
  let threw = null;
  try {
    problemsOf(new ZipDoc(bad).parts);
  } catch (err) {
    threw = err.message;
  }
  assert(threw && /Content_Types/.test(threw), 'expected a Content_Types error, got: ' + threw);
  return threw;
});

check('duplicate <Default Extension> is reported', () => {
  const bad = path.join(WORK, 'dup-default.pptx');
  const problems = mutate(DECK, bad, (doc) => {
    const ct = doc.part('[Content_Types].xml');
    doc.setPart('[Content_Types].xml', ct.replace('</Types>', '<Default Extension="xml" ContentType="application/xml"/></Types>'));
  });
  assert(problems.some((p) => /duplicate <Default/.test(p)), 'duplicate Default not reported: ' + problems.join(' | '));
  return problems[0];
});

check('part without a content type is reported', () => {
  const bad = path.join(WORK, 'orphan-part.pptx');
  const problems = mutate(DECK, bad, (doc) => {
    doc.setPart('ppt/media/stray.bin', Buffer.from([1, 2, 3]));
  });
  assert(problems.some((p) => /no Default\/Override content type/.test(p)), 'orphan part not reported: ' + problems.join(' | '));
  return problems[0];
});

check('malformed XML is reported with a line hint', () => {
  const bad = path.join(WORK, 'bad-xml.docx');
  const problems = mutate(DOCX, bad, (doc) => {
    doc.setPart('word/document.xml', doc.part('word/document.xml').replace('</w:body>', '<w:body>'));
  });
  assert(problems.some((p) => /malformed XML/.test(p)), 'malformed XML not reported: ' + problems.join(' | '));
  assert(problems.some((p) => /line \d+/.test(p)), 'error should carry a line number: ' + problems.join(' | '));
  return problems.find((p) => /malformed XML/.test(p)).slice(0, 90);
});

check('duplicate w14:paraId inside one docx part is reported', () => {
  const dup = duplicateParaIds(new ZipDoc(DOCX).parts);
  const total = Object.values(dup).reduce((n, m) => n + Object.keys(m).length, 0);
  assertEq(total, 0, 'fixture already has duplicate paraIds: ' + JSON.stringify(dup));
  const bad = path.join(WORK, 'dup-paraid.docx');
  const doc = new ZipDoc(DOCX);
  const xml = doc.part('word/document.xml');
  let ids = [...xml.matchAll(/w14:paraId="([0-9A-Fa-f]{8})"/g)].map((m) => m[1]);
  if (ids.length < 2) {
    // hand-made docx has no paraIds; inject two identical ones to exercise the detector
    let n = 0;
    doc.setPart('word/document.xml', xml.replace(/<w:p>/g, () => `<w:p w14:paraId="1A2B3C4D" w14:textId="77777777">`));
    ids = ['1A2B3C4D', '1A2B3C4D'];
  } else {
    doc.setPart('word/document.xml', xml.replace(`w14:paraId="${ids[1]}"`, `w14:paraId="${ids[0]}"`));
  }
  doc.save(bad);
  const found = duplicateParaIds(new ZipDoc(bad).parts);
  assert(Object.keys(found).length > 0, 'duplicate paraId not detected');
  return Object.keys(found).join(', ');
});

/* ================================================= structure / rels (new) ===== */
console.log('\n--- structural checks (PowerPoint is stricter than plain XML) ---');

check('pptx: an empty <p:sp/> inside spTree is rejected', () => {
  const bad = path.join(WORK, 'empty-sp.pptx');
  const problems = mutate(DECK, bad, (doc) => {
    doc.setPart('ppt/slides/slide1.xml', doc.part('ppt/slides/slide1.xml').replace('</p:spTree>', '<p:sp/></p:spTree>'));
  });
  assert(problems.some((p) => /spTree|not a valid shape/i.test(p)), 'empty <p:sp/> accepted: ' + (problems.join(' | ') || 'no problems'));
  return problems.find((p) => /spTree|shape/i.test(p));
});

check('pptx: duplicate shape ids inside one slide are rejected', () => {
  const bad = path.join(WORK, 'dup-ids.pptx');
  const problems = mutate(DECK, bad, (doc) => {
    const xml = doc.part('ppt/slides/slide1.xml');
    const first = xml.match(/<p:cNvPr id="(\d+)"/);
    assert(first, 'no cNvPr in slide');
    const second = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]).find((id) => id !== first[1]);
    assert(second, 'slide has only one shape');
    doc.setPart('ppt/slides/slide1.xml', xml.replace(`<p:cNvPr id="${second}"`, `<p:cNvPr id="${first[1]}"`));
  });
  assert(problems.some((p) => /duplicate shape id/i.test(p)), 'duplicate shape id accepted: ' + (problems.join(' | ') || 'no problems'));
  return problems.find((p) => /duplicate shape id/i.test(p));
});

check('dangling relationship target is rejected', () => {
  const bad = path.join(WORK, 'dangling.pptx');
  const problems = mutate(DECK, bad, (doc) => {
    const relsName = 'ppt/slides/_rels/slide1.xml.rels';
    const rels = doc.part(relsName);
    assert(/Target="\.\.\/slideLayouts\//.test(rels), 'fixture layout relationship not found');
    doc.setPart(relsName, rels.replace(/Target="\.\.\/slideLayouts\/[^"]+"/, 'Target="../slideLayouts/does-not-exist.xml"'));
  });
  assert(problems.some((p) => /missing relationship target/i.test(p)), 'dangling rel accepted: ' + (problems.join(' | ') || 'no problems'));
  return problems.find((p) => /missing relationship target/i.test(p));
});

check('xlsx: sheet r:id pointing at a missing relationship is rejected', () => {
  const bad = path.join(WORK, 'sheet-rel.xlsx');
  const problems = mutate(XLSX, bad, (doc) => {
    doc.setPart('xl/_rels/workbook.xml.rels', doc.part('xl/_rels/workbook.xml.rels').replace(/Id="rId1"/, 'Id="rIdX"'));
  });
  assert(problems.some((p) => /relationship|r:id/i.test(p)), 'broken sheet rel accepted: ' + (problems.join(' | ') || 'no problems'));
  return problems.find((p) => /relationship|r:id/i.test(p));
});

/* ============================================================ path handling === */
console.log('\n--- error paths (the tool must say what is wrong) ---');

check('a directory is rejected, not read as a file', () => {
  const { status, err } = runDump(WORK);
  assertEq(status, 1, 'expected failure');
  assert(/EISDIR|directory|ERROR/i.test(err), 'unclear message: ' + err.trim());
});

check('a zero-byte file is rejected', () => {
  const empty = path.join(WORK, 'empty.pptx');
  fs.writeFileSync(empty, '');
  const { status, err } = runDump(empty);
  assertEq(status, 1, 'expected failure');
  assert(/ERROR|not a zip|empty|too small/i.test(err), 'unclear message: ' + err.trim());
});

check('a docx renamed .pptx fails on the part it actually lacks', () => {
  const liar = path.join(WORK, 'actually-docx.pptx');
  fs.copyFileSync(DOCX, liar);
  const { status, err } = runDump(liar);
  assertEq(status, 1, 'expected failure');
  assert(/ERROR|no slide|ppt\/slides/i.test(err), 'unclear message: ' + err.trim());
});

check('check reports a truncated zip instead of crashing', () => {
  const cut = path.join(WORK, 'cut.pptx');
  fs.copyFileSync(DECK, cut);
  const buf = fs.readFileSync(cut);
  fs.writeFileSync(cut, buf.subarray(0, Math.floor(buf.length / 2)));
  const r = runCheck(cut);
  assertEq(r.status, 1, 'expected exit code 1');
  assert(/central directory|truncat|zip|EOCD/i.test(r.out + r.err), 'unclear message: ' + (r.out + r.err).trim().slice(0, 160));
});
console.log('\n--- pdf (read path, no Office needed) ---');

/** A minimal, uncompressed N-page PDF - deterministic, no Office needed. */
function writeTinyPdf(file, pages = 2) {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`];
  for (let i = 0; i < pages; i++) {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R >>`);
    const body = `BT /F1 24 Tf 72 720 Td (Page ${i + 1}) Tj ET`;
    objs.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info << /Producer (format suite) /Title (Two pager) >> >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(file, out, 'latin1');
  return file;
}

check('pdf: dump reports version, page count and metadata', () => {
  const file = writeTinyPdf(path.join(WORK, 'tiny.pdf'), 2);
  const { status, out, err } = runDump(file);
  assertEq(status, 0, 'dump failed: ' + (err || '').trim());
  assert(/version 1\.4/.test(out), 'version missing: ' + out);
  assert(/pages: 2 .*page tree/.test(out), 'page count missing: ' + out);
  assert(/title: Two pager/.test(out), 'metadata title missing: ' + out);
});

check('pdf: a 5-page file is counted correctly', () => {
  const file = writeTinyPdf(path.join(WORK, 'five.pdf'), 5);
  const { out } = runDump(file);
  const line = out.split('\n').find((l) => l.includes('pages')) || '';
  assert(/pages: 5 /.test(out), 'expected 5 pages, got: ' + line);
});

check('pdf: a spreadsheet renamed .pdf is rejected with a useful message', () => {
  const fake = path.join(WORK, 'renamed.pdf');
  fs.copyFileSync(DOCX, fake);   // any zip package stands in for the xlsm that used to be called .pdf
  const { status, err } = runDump(fake);
  assertEq(status, 1, 'expected failure');
  assert(/not a PDF/.test(err), 'message should name the problem: ' + err.trim());
  assert(/renamed/.test(err), 'message should hint at the usual cause: ' + err.trim());
});
console.log('\n--- paths ---');

check('non-ASCII name with spaces and parentheses works end to end', () => {
  const weird = path.join(WORK, '季度 评审 (终稿) v2.pptx');
  fs.copyFileSync(DECK, weird);
  const doc = new ZipDoc(weird);
  assertEq(problemsOf(doc.parts).length, 0, 'integrity failed for non-ASCII path');
  const { status, out } = runDump(weird);
  assertEq(status, 0, 'dump failed for non-ASCII path: ' + out);
  assert(/slide1\.xml/.test(out), 'dump produced no slides');
  return 'read + dump OK';
});

check('ZipDoc.blank() can build a package from nothing', () => {
  const doc = ZipDoc.blank();
  assertEq(doc.parts.size, 0, 'blank() should start empty');
  assertEq(doc.path, null, 'blank() should have no source path');
  doc.setPart(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  doc.setPart('a.xml', '<?xml version="1.0"?><root/>');
  const out = path.join(WORK, 'blank-built.zip');
  doc.save(out);
  const again = new ZipDoc(out);
  assertEq(again.parts.size, 2, 'roundtrip lost parts');
  return 'empty → 2 parts → saved and reopened';
});

/* ================================================================ summary ===== */
const total = passed + failures.length;
console.log('\n' + '='.repeat(72));
console.log(`RESULT: ${failures.length === 0 ? 'ALL GREEN' : 'FAILURES'} — ${passed}/${total} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailed checks:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
}
if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
process.exitCode = failures.length ? 1 : 0;
