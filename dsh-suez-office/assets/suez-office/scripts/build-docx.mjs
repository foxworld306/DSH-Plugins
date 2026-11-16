/**
 * DSH-SUEZ-Office · DOCX builder.
 *
 * A Word document from a JSON spec: title block, headings, paragraphs, bullet lists, tables,
 * header/footer, A4 or 16:9. Written from scratch as OOXML parts (no template needed) — the same
 * approach as the deck builder, minus the archetypes: Word layout is linear, so the spec is linear.
 *
 * Fonts default to the brand faces installed on this host (方正准圆_GBK for CJK, Poppins for latin);
 * a machine without them falls back per Word's own rules, which is why the caller can override.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ZipDoc } from './ooxml.mjs';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FONTS = { cjk: '方正准圆_GBK', cjkBold: '方正粗圆_GBK', latin: 'Poppins' };

/** One run with explicit fonts, so CJK and latin do not fall back independently. */
function run(text, { size, bold = false, color, italic = false, font } = {}) {
  const sz = size ? `<w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>` : '';
  const b = bold ? '<w:b/><w:bCs/>' : '';
  const i = italic ? '<w:i/>' : '';
  const c = color ? `<w:color w:val="${color}"/>` : '';
  const f = font ?? (bold ? FONTS.cjkBold : FONTS.cjk);
  const rf = `<w:rFonts w:ascii="${FONTS.latin}" w:hAnsi="${FONTS.latin}" w:eastAsia="${f}" w:cs="${FONTS.latin}"/>`;
  return `<w:r><w:rPr>${rf}${b}${i}${c}${sz}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text, o = {}) {
  const { style, align, spaceBefore = 0, spaceAfter = 120, indent, numbering, size, bold, color, italic } = o;
  const pPr = [
    '<w:pPr>',
    style ? `<w:pStyle w:val="${style}"/>` : '',
    numbering ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numbering}"/></w:numPr>` : '',
    align ? `<w:jc w:val="${align}"/>` : '',
    indent ? `<w:ind w:left="${indent}" w:hanging="${Math.min(indent, 240)}"/>` : '',
    `<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}" w:line="300" w:lineRule="auto"/>`,
    '</w:pPr>',
  ].join('');
  return `<w:p>${pPr}${text ? run(text, { size, bold, color, italic }) : ''}</w:p>`;
}

function cell(text, { width, header = false, align } = {}) {
  const shade = header ? '<w:shd w:val="clear" w:color="auto" w:fill="030F40"/>' : '';
  const color = header ? 'FFFFFF' : '333F55';
  const tcPr = `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}<w:vAlign w:val="center"/></w:tcPr>`;
  const body = `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/>${align ? `<w:jc w:val="${align}"/>` : ''}</w:pPr>${run(text, { size: 10, bold: header, color })}</w:p>`;
  return `<w:tc>${tcPr}${body}</w:tc>`;
}

function table({ columns = [], widths, rows = [], align = [] }) {
  const total = 9026;                                      // A4 text width in twips (both margins 1 inch)
  const w = widths ?? columns.map(() => Math.round(total / Math.max(1, columns.length)));
  const border = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D9E0EA"/>`).join('') + '</w:tblBorders>';
  const grid = '<w:tblGrid>' + w.map((x) => `<w:gridCol w:w="${x}"/>`).join('') + '</w:tblGrid>';
  const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${columns.map((c, i) => cell(c, { width: w[i], header: true })).join('')}</w:tr>`;
  const body = rows.map((r) => `<w:tr>${r.map((c, i) => cell(c, { width: w[i], align: align[i] })).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>${border}</w:tblPr>${grid}${head}${body}</w:tbl>` +
    '<w:p><w:pPr><w:spacing w:before="0" w:after="120"/></w:pPr></w:p>';
}

const styles = `${XML}<w:styles xmlns:w="${W}">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="${FONTS.latin}" w:hAnsi="${FONTS.latin}" w:eastAsia="${FONTS.cjk}" w:cs="${FONTS.latin}"/>
    <w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-GB" w:eastAsia="zh-CN"/>
  </w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:rPr><w:rFonts w:eastAsia="${FONTS.cjkBold}"/><w:b/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:rPr><w:color w:val="5A6B8C"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="120"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="${FONTS.cjkBold}"/><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="240" w:after="80"/></w:pPr>
    <w:rPr><w:rFonts w:eastAsia="${FONTS.cjkBold}"/><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Caption2"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/>
    <w:rPr><w:color w:val="7A87A0"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
</w:styles>`;

const numbering = `${XML}<w:numbering xmlns:w="${W}">
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>
    <w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="420" w:hanging="240"/></w:pPr></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

function documentXml(spec) {
  const body = [];
  if (spec.title) body.push(para(spec.title, { style: 'Title', spaceAfter: 80 }));
  if (spec.subtitle) body.push(para(spec.subtitle, { style: 'Subtitle', spaceAfter: 240 }));
  if (spec.meta) body.push(para(spec.meta, { style: 'Caption2', spaceAfter: 360 }));

  for (const sec of spec.sections ?? []) {
    if (sec.heading) body.push(para(sec.heading, { style: sec.level === 2 ? 'Heading2' : 'Heading1' }));
    for (const p of sec.paragraphs ?? []) body.push(para(p, { spaceAfter: 160 }));
    for (const b of sec.bullets ?? []) body.push(para(b, { numbering: 1, spaceAfter: 80 }));
    if (sec.table) {
      body.push(...[table(sec.table)]);
      if (sec.table.caption) body.push(para(sec.table.caption, { style: 'Caption2', spaceAfter: 240 }));
    }
    if (sec.pageBreakAfter) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  }

  const landscape = spec.pageSize === 'A4-landscape';
  const pgSz = landscape ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' : '<w:pgSz w:w="11906" w:h="16838"/>';
  const sectPr = `<w:sectPr>${pgSz}<w:pgMar w:top="1134" w:right="1440" w:bottom="1134" w:left="1440" w:header="709" w:footer="709" w:gutter="0"/>` +
    (spec.header ? `<w:headerReference w:type="default" r:id="rIdHeader"/>` : '') +
    (spec.footer ? `<w:footerReference w:type="default" r:id="rIdFooter"/>` : '') + '</w:sectPr>';

  return `${XML}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body.join('')}${sectPr}</w:body></w:document>`;
}

const headerXml = (text) => `${XML}<w:hdr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run(text, { size: 8, color: '7A87A0' })}</w:p></w:hdr>`;
const footerXml = (text) => `${XML}<w:ftr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run(text, { size: 8, color: '7A87A0' })}</w:p></w:ftr>`;

const coreProps = (spec) => `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
  `<dc:title>${esc(spec.title ?? '')}</dc:title><dc:creator>${esc(spec.author ?? 'DSH-SUEZ-Office')}</dc:creator></cp:coreProperties>`;

export function buildDocx({ out, ...spec }) {
  const parts = new Map();
  parts.set('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    (spec.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '') +
    (spec.footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>');

  parts.set('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>');

  const docRels = [
    `<Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdNumbering" Type="${R}/numbering" Target="numbering.xml"/>`,
  ];
  if (spec.header) docRels.push(`<Relationship Id="rIdHeader" Type="${R}/header" Target="header1.xml"/>`);
  if (spec.footer) docRels.push(`<Relationship Id="rIdFooter" Type="${R}/footer" Target="footer1.xml"/>`);

  parts.set('word/_rels/document.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${docRels.join('')}</Relationships>`);
  parts.set('word/document.xml', documentXml(spec));
  parts.set('word/styles.xml', styles);
  parts.set('word/numbering.xml', numbering);
  if (spec.header) parts.set('word/header1.xml', headerXml(spec.header));
  if (spec.footer) parts.set('word/footer1.xml', footerXml(spec.footer));
  parts.set('docProps/core.xml', coreProps(spec));

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const doc = ZipDoc.blank();
  // save() compresses buffers: hand it UTF-8 bytes, not strings (member length must match the body)
  doc.parts = new Map([...parts].map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')]));
  doc.save(out);
  return { out, parts: parts.size };
}
