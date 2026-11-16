/**
 * DSH-SUEZ-Office · XLSX builder.
 *
 * Sheets from a JSON spec: header row (navy, bold, frozen), typed cells (number / percent / text),
 * column widths, freeze pane and autofilter. Inline strings keep the package small — no shared
 * string table to keep in sync while editing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ZipDoc } from './ooxml.mjs';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const colName = (i) => {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

// style ids: 0 default, 1 header, 2 number 0.00, 3 integer #,##0, 4 percent 0.0%
const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="3">
    <numFmt numFmtId="164" formatCode="#,##0.00"/>
    <numFmt numFmtId="165" formatCode="#,##0"/>
    <numFmt numFmtId="166" formatCode="0.0%"/>
  </numFmts>
  <fonts count="3">
    <font><sz val="11"/><name val="Poppins"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Poppins"/><family val="2"/></font>
    <font><b/><sz val="11"/><name val="Poppins"/><family val="2"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF030F40"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFD9E0EA"/></left><right style="thin"><color rgb="FFD9E0EA"/></right>
      <top style="thin"><color rgb="FFD9E0EA"/></top><bottom style="thin"><color rgb="FFD9E0EA"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="166" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const TYPE_STYLE = { text: 0, header: 1, number: 2, int: 3, percent: 4, bold: 5 };

function cellXml(ref, value, type) {
  if (value === null || value === undefined || value === '') return `<c r="${ref}" s="0"/>`;
  const style = TYPE_STYLE[type] ?? 0;
  // "=SUM(B2:B4)" becomes a real formula cell; no cached value, so Excel recalculates on open
  if (typeof value === 'string' && value.startsWith('=')) {
    const f = value.slice(1).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<c r="${ref}" s="${style}"><f>${f}</f></c>`;
  }
  if (type === 'text' || type === 'bold' || typeof value === 'string') {
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
  }
  return `<c r="${ref}" s="${style}"><v>${Number(value)}</v></c>`;
}

function sheetXml(sheet) {
  const header = sheet.header ?? [];
  const rows = sheet.rows ?? [];
  const cols = sheet.columns ?? header.map(() => ({}));
  const widths = cols.map((c) => (typeof c === 'number' ? c : c.width ?? 16));

  const colsXml = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';

  const parts = [];
  let r = 1;
  if (header.length) {
    parts.push(`<row r="${r}">${header.map((h, i) => cellXml(`${colName(i)}${r}`, String(h), 'header')).join('')}</row>`);
    r += 1;
  }
  for (const row of rows) {
    const cells = row.map((v, i) => cellXml(`${colName(i)}${r}`, v, cols[i]?.type ?? (typeof v === 'number' ? 'number' : 'text')));
    parts.push(`<row r="${r}">${cells.join('')}</row>`);
    r += 1;
  }

  const lastCol = colName(Math.max(header.length, ...rows.map((x) => x.length)) - 1);
  const lastRow = Math.max(1, (header.length ? 1 : 0) + rows.length);
  const freeze = sheet.freeze === false ? '' : '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';
  const autoFilter = sheet.autofilter && header.length ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : '';
  const dim = `A1:${lastCol}${lastRow}`;

  return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
  <dimension ref="${dim}"/>
  <sheetViews><sheetView workbookViewId="0" tabSelected="1">${freeze}</sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  ${colsXml}
  <sheetData>${parts.join('')}</sheetData>
  ${autoFilter}
  <printOptions horizontalCentered="0"/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

export function buildXlsx({ out, sheets = [], title }) {
  const parts = new Map();
  const names = sheets.map((s, i) => s.name ?? `Sheet${i + 1}`);

  parts.set('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>');

  parts.set('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>');

  parts.set('xl/workbook.xml', `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);

  parts.set('xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>');

  sheets.forEach((s, i) => parts.set(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  parts.set('xl/styles.xml', STYLES);
  parts.set('docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:title>${esc(title ?? '')}</dc:title><dc:creator>DSH-SUEZ-Office</dc:creator></cp:coreProperties>`);

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const doc = ZipDoc.blank();
  doc.parts = new Map([...parts].map(([k, v]) => [k, Buffer.from(v, 'utf8')]));
  doc.save(out);
  return { out, parts: parts.size, sheets: names };
}
