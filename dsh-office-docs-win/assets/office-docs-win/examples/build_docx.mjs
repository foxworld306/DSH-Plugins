/**
 * Build a Word document from nothing — a .docx is three parts, no Python needed.
 *
 *   [Content_Types].xml   declares what each part is
 *   _rels/.rels           points at the main document
 *   word/document.xml     the content (paragraphs, table, section)
 *
 * Word opens exactly this. Add word/styles.xml only for named styles; here formatting lives
 * in the runs so the file stays readable.
 *
 * Usage: node build_docx.mjs --out <new.docx>
 */
import path from 'node:path';
import { ZipDoc, checkPackageIntegrity } from '../scripts/ooxml.mjs';

const NAVY = '030F40';
const DARK = '333F55';
const MID = '5A6B8C';
const LATIN = 'poppins';
const EA = '方正准圆_GBK';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One run; sz is half-points (sz="28" = 14 pt). */
const run = (text, { sz = 22, bold = false, color = DARK } = {}) =>
  `<w:r><w:rPr><w:rFonts w:ascii="${LATIN}" w:hAnsi="${LATIN}" w:eastAsia="${EA}" w:cs="${LATIN}"/>` +
  `${bold ? '<w:b/><w:bCs/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>` +
  `<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;

const para = (runs, { spacing = 120 } = {}) =>
  `<w:p><w:pPr><w:spacing w:after="${spacing}" w:line="276" w:lineRule="auto"/></w:pPr>${runs}</w:p>`;

const cell = (runs, { width = 3000, fill = null } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:fill="${fill}"/>` : ''}` +
  `<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:before="60" w:after="60"/></w:pPr>${runs}</w:p></w:tc>`;

const row = (cells, header = false) => `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.join('')}</w:tr>`;

const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="D9E0EA"/>`)
  .join('');

const BODY = [
  para([run('Quarterly Review', { sz: 40, bold: true, color: NAVY })], { spacing: 60 }),
  para([run('Operations · Q4 2026', { sz: 24, color: MID })], { spacing: 240 }),
  para([run('A .docx is three parts. This file was written by hand: no Word, no Python, no template.')], { spacing: 200 }),
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>` +
    `<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="2000"/></w:tblGrid>` +
    row([
      cell([run('Item', { sz: 20, bold: true, color: 'FFFFFF' })], { fill: NAVY }),
      cell([run('Owner', { sz: 20, bold: true, color: 'FFFFFF' })], { fill: NAVY }),
      cell([run('Status', { sz: 20, bold: true, color: 'FFFFFF' })], { width: 2000, fill: NAVY }),
    ], true) +
    row([cell([run('Integrity gate')]), cell([run('Office toolkit')]), cell([run('Done', { bold: true, color: '2E7D32' })], { width: 2000 })]) +
    row([cell([run('Render QA')]), cell([run('Office COM')]), cell([run('Done', { bold: true, color: '2E7D32' })], { width: 2000 })]) +
    `</w:tbl>`,
  para([run('')], { spacing: 200 }),
  para([run('With a template: replicate its fonts, colours and margins exactly — see SKILL.md.', { sz: 20, color: MID })], { spacing: 0 }),
];

const document =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${BODY.join('')}` +
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
  `<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="851" w:footer="992" w:gutter="0"/>` +
  `</w:sectPr></w:body></w:document>`;

const contentTypes =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`;

const rootRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const argv = process.argv.slice(2);
const i = argv.indexOf('--out');
const out = path.resolve(i !== -1 && argv[i + 1] ? argv[i + 1] : 'docx-js-demo.docx');

const doc = ZipDoc.blank();
doc.setPart('[Content_Types].xml', contentTypes);
doc.setPart('_rels/.rels', rootRels);
doc.setPart('word/document.xml', document);

const problems = checkPackageIntegrity(doc.parts);
doc.save(out);
console.log(`built ${out} — ${doc.parts.size} parts`);
console.log(problems.length === 0 ? 'integrity: CLEAN' : 'integrity: PROBLEMS\n  - ' + problems.join('\n  - '));
if (problems.length) process.exitCode = 1;
