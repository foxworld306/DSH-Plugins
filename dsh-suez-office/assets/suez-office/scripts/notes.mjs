/**
 * Speaker notes: the deck must be able to explain itself.
 *
 * A data page needs its 口径 written down; a photo page needs its licence. Notes are the only place
 * in a pptx that travels with the slide and is invisible on screen, so that is where they go.
 */
import fs from 'node:fs';

const NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One paragraph per line; `n.text` is already plain text. */
export function notesXml(text) {
  const paras = String(text)
    .split(/\r?\n/)
    .map((line) => (line.trim()
      ? `<a:p><a:r><a:rPr lang="zh-CN" sz="1200" dirty="0"/><a:t>${esc(line)}</a:t></a:r></a:p>`
      : '<a:p><a:endParaRPr lang="zh-CN" sz="1200"/></a:p>'))
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<p:notes xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${NS}"><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/>' +
    '<p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/>' +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>` +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
}

/**
 * Attach notes to one slide: the notes part, its rels (to the notes master) and the slide's
 * relationship. The content-type override and the notesMaster are handled by the builder.
 */
export function attachNotes(doc, slideNumber, text) {
  const name = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
  doc.setPart(name, notesXml(text));
  doc.setPart(`ppt/notesSlides/_rels/notesSlide${slideNumber}.xml.rels`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${R}/notesMaster" Target="../notesMasters/notesMaster1.xml"/></Relationships>`);

  const relsName = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
  const rels = doc.part(relsName);
  const used = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const id = Math.max(1, ...used) + 1;
  doc.setPart(relsName, rels.replace('</Relationships>',
    `<Relationship Id="rId${id}" Type="${R}/notesSlide" Target="../notesSlides/notesSlide${slideNumber}.xml"/></Relationships>`));

  const types = doc.part('[Content_Types].xml');
  if (!types.includes(`/ppt/notesSlides/notesSlide${slideNumber}.xml`)) {
    doc.setPart('[Content_Types].xml', types.replace('</Types>',
      `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>`));
  }
}

/** Compose the note text for one page from whatever provenance the storyboard carries. */
export function noteFor(spec, credits = []) {
  const lines = [];
  if (spec.note) lines.push(String(spec.note));
  if (spec.source) lines.push(`数据来源：${spec.source}`);
  if (spec.caption && !spec.source) lines.push(`图注：${spec.caption}`);
  if (spec.imageCredit) lines.push(`图片来源：${spec.imageCredit}`);
  for (const c of credits) lines.push(`图片：${c}`);
  if (spec.chart?.type) lines.push(`图表类型：${spec.chart.type}（原生图表，可在 PowerPoint 里改数据）`);
  return lines.join('\n');
}

void fs;
