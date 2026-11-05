/**
 * Build an Excel workbook from nothing — six parts, no Python.
 *
 *   [Content_Types].xml            part types
 *   _rels/.rels                    -> xl/workbook.xml
 *   xl/workbook.xml                sheet list + fullCalcOnLoad so formulas update on open
 *   xl/_rels/workbook.xml.rels     -> the sheet and the styles
 *   xl/styles.xml                  number formats, header fill
 *   xl/worksheets/sheet1.xml       cells
 *
 * Strings use `t="inlineStr"` so no sharedStrings.xml is needed — fewer parts, fewer failure
 * modes. Switch to shared strings only for large, repetitive sheets.
 *
 * Usage: node build_xlsx.mjs --out <new.xlsx>
 */
import path from 'node:path';
import { ZipDoc, checkPackageIntegrity } from '../scripts/ooxml.mjs';

const NAVY = '030F40';
const GREEN = 'AADC14';
const DARK = '333F55';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Column letter for a 1-based index (1 -> A, 27 -> AA). */
const col = (n) => {
  let s = '';
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

/** Styles: 0 default, 1 header, 2 label, 3 thousands, 4 percent. */
const STYLE = { plain: 0, header: 1, label: 2, thousands: 3, percent: 4 };

const text = (ref, value, style = 0) =>
  `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
const number = (ref, value, style = 0) =>
  `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${Number(value)}</v></c>`;
/** A formula plus its cached value, so viewers that do not recalculate still show a number. */
const formula = (ref, expression, cached, style = 0) =>
  `<c r="${ref}"${style ? ` s="${style}"` : ''}><f>${esc(expression)}</f><v>${cached}</v></c>`;

/* --------------------------------------------------------------------- content --- */
const HEADER = ['Region', 'Q3', 'Q4', 'Growth'];
const DATA = [
  ['North', 1240, 1510],
  ['South', 980, 1105],
  ['East', 760, 940],
];

const rowsXml = [
  // header row
  `<row r="1">${HEADER.map((h, i) => text(col(i + 1) + '1', h, STYLE.header)).join('')}</row>`,
  // data rows
  ...DATA.map((r, index) => {
    const n = index + 2;
    const growth = ((r[2] - r[1]) / r[1]).toFixed(6);
    return `<row r="${n}">` +
      text('A' + n, r[0]) +
      number('B' + n, r[1], STYLE.thousands) +
      number('C' + n, r[2], STYLE.thousands) +
      formula('D' + n, `(C${n}-B${n})/B${n}`, growth, STYLE.percent) +
      `</row>`;
  }),
  // totals row: SUM over the data rows, growth on the totals
  (() => {
    const n = DATA.length + 2;
    const sumB = DATA.reduce((acc, r) => acc + r[1], 0);
    const sumC = DATA.reduce((acc, r) => acc + r[2], 0);
    return `<row r="${n}">` +
      text('A' + n, 'Total', STYLE.label) +
      formula('B' + n, `SUM(B2:B${n - 1})`, sumB, STYLE.thousands) +
      formula('C' + n, `SUM(C2:C${n - 1})`, sumC, STYLE.thousands) +
      formula('D' + n, `(C${n}-B${n})/B${n}`, ((sumC - sumB) / sumB).toFixed(6), STYLE.percent) +
      `</row>`;
  })(),
].join('');

const sheet =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<dimension ref="A1:D${DATA.length + 2}"/>` +
  `<sheetViews><sheetView workbookViewId="0" tabSelected="1">` +
  `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
  `</sheetView></sheetViews>` +
  `<sheetFormatPr defaultRowHeight="15"/>` +
  `<cols><col min="1" max="1" width="16" customWidth="1"/><col min="2" max="4" width="13" customWidth="1"/></cols>` +
  `<sheetData>${rowsXml}</sheetData>` +
  `<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>` +
  `</worksheet>`;

const styles =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="3">` +
  `<font><sz val="11"/><color rgb="FF${DARK}"/><name val="Aptos Narrow"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Aptos Narrow"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FF${NAVY}"/><name val="Aptos Narrow"/></font>` +
  `</fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF${NAVY}"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="2"><border/><border><bottom style="thin"><color rgb="FF${GREEN}"/></bottom></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="5">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="left"/></xf>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>` +
  `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

const workbook =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="预算汇总" sheetId="1" r:id="rId1"/></sheets>` +
  `<calcPr calcId="191029" fullCalcOnLoad="1"/>` +
  `</workbook>`;

const contentTypes =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`;

const rootRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const workbookRels =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

const argv = process.argv.slice(2);
const i = argv.indexOf('--out');
const out = path.resolve(i !== -1 && argv[i + 1] ? argv[i + 1] : 'xlsx-js-demo.xlsx');

const doc = ZipDoc.blank();
doc.setPart('[Content_Types].xml', contentTypes);
doc.setPart('_rels/.rels', rootRels);
doc.setPart('xl/workbook.xml', workbook);
doc.setPart('xl/_rels/workbook.xml.rels', workbookRels);
doc.setPart('xl/styles.xml', styles);
doc.setPart('xl/worksheets/sheet1.xml', sheet);

const problems = checkPackageIntegrity(doc.parts);
doc.save(out);
console.log(`built ${out} — ${doc.parts.size} parts, ${DATA.length + 2} rows`);
console.log(problems.length === 0 ? 'integrity: CLEAN' : 'integrity: PROBLEMS\n  - ' + problems.join('\n  - '));
if (problems.length) process.exitCode = 1;
