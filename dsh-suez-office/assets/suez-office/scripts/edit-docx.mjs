/**
 * DSH-SUEZ-Office · surgical DOCX editing.
 *
 * Word documents are linear, so "edit" means: replace the text of a paragraph (by literal match or
 * by index) or of a table cell, keeping the paragraph's own properties (indent, spacing, style) and
 * the run's font/size/colour. Nothing else in the document changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ZipDoc, checkPackageIntegrity, checkStructure } from './ooxml.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const textOf = (xml) => [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('');

/** Keep <w:pPr> and the first run's <w:rPr>, replace everything else with one run. */
function rewriteParagraph(pXml, text) {
  const pPr = /^<w:p[^>]*>([\s\S]*?)<\/w:pPr>/.exec(pXml)?.[0] ?? null;
  const open = /^<w:p[^>]*>/.exec(pXml)[0];
  const body = pXml.slice(open.length, -'</w:p>'.length);
  const pPrBlock = /^<w:pPr[\s\S]*?<\/w:pPr>/.exec(body)?.[0] ?? '';
  const rPr = /<w:rPr[^>]*>[\s\S]*?<\/w:rPr>|<w:rPr[^>]*\/>/.exec(body)?.[0] ?? '';
  void pPr;
  const runs = String(text)
    .split(/\r?\n/)
    .map((line, i) => `${i ? '<w:r><w:br/></w:r>' : ''}<w:r>${rPr}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`)
    .join('');
  return `${open}${pPrBlock}${runs}</w:p>`;
}

/** All top-level-or-nested paragraphs, in document order, as [xml, startIndex]. */
function paragraphs(xml) {
  const out = [];
  const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml))) out.push({ xml: m[0], index: m.index });
  return out;
}

function setParagraph(doc, { match, index, text }) {
  const part = 'word/document.xml';
  const xml = doc.part(part);
  const list = paragraphs(xml);
  let target = null;
  if (typeof index === 'number') {
    target = list[index - 1] ?? null;
    if (!target) throw new Error(`paragraph ${index} not found (document has ${list.length})`);
  } else if (match) {
    target = list.find((p) => textOf(p.xml).includes(match)) ?? null;
    if (!target) throw new Error(`no paragraph contains "${match}"`);
  } else {
    throw new Error('setParagraph needs "match" (literal text) or "index"');
  }
  const replaced = rewriteParagraph(target.xml, text);
  doc.setPart(part, xml.slice(0, target.index) + replaced + xml.slice(target.index + target.xml.length));
  return `段落 → "${String(text).slice(0, 24)}"`;
}

function tables(xml) {
  const out = [];
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
  let m;
  while ((m = re.exec(xml))) out.push({ xml: m[0], index: m.index });
  return out;
}

function setTableCell(doc, { table = 1, row, col, text }) {
  const part = 'word/document.xml';
  const xml = doc.part(part);
  const tbl = tables(xml)[table - 1];
  if (!tbl) throw new Error(`table ${table} not found (document has ${tables(xml).length})`);

  const rows = [...tbl.xml.matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)].map((m) => m[0]);
  const tr = rows[row - 1];
  if (!tr) throw new Error(`row ${row} not found (table ${table} has ${rows.length} rows)`);

  const cells = [...tr.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((m) => m[0]);
  const tc = cells[col - 1];
  if (!tc) throw new Error(`column ${col} not found (row ${row} has ${cells.length} cells)`);

  const p = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/.exec(tc);
  if (!p) throw new Error('cell has no paragraph');
  const newTc = tc.replace(p[0], rewriteParagraph(p[0], text));

  const newTr = tr.replace(tc, newTc);
  const newTbl = tbl.xml.replace(tr, newTr);
  doc.setPart(part, xml.slice(0, tbl.index) + newTbl + xml.slice(tbl.index + tbl.xml.length));
  return `表格 ${table} · 第 ${row} 行第 ${col} 列 → "${String(text).slice(0, 20)}"`;
}

export function editDocx({ input, out, ops = [] }) {
  if (path.resolve(input) === path.resolve(out)) throw new Error('editDocx: 输出必须是新路径');
  const doc = new ZipDoc(input);
  const applied = [];
  for (const op of ops) {
    if (op.op === 'setParagraph') applied.push(setParagraph(doc, op));
    else if (op.op === 'setTableCell') applied.push(setTableCell(doc, op));
    else throw new Error(`unknown op "${op.op}" (setParagraph | setTableCell)`);
  }
  const problems = [...checkPackageIntegrity(doc.parts, { checkXml: true }), ...checkStructure(doc.parts)];
  if (problems.length) return { out: null, applied, problems };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  doc.save(out);
  return { out, applied, problems: [] };
}
