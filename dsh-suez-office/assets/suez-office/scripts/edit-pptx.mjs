/**
 * DSH-SUEZ-Office · surgical PPTX editing.
 *
 * The point is NOT to rebuild the deck: the user's file already has the layout, the fonts, the
 * pictures and whatever they dragged around by hand. So every operation touches as little XML as
 * possible, and the file is always written to a NEW path (never over the one being edited).
 *
 * Supported ops:
 *   setText        { slide, shape, text }                 replace a shape's text, keeping its run style
 *   setImage       { slide, shape, file }                 swap the picture a shape points at
 *   setChartValues { slide, chart, series, values }       rewrite a chart series cache
 *   duplicateSlide { slide }                              copy the slide right after itself
 *   removeSlide    { slide }                              delete the slide and its relationships
 */
import fs from 'node:fs';
import path from 'node:path';
import { ZipDoc, checkPackageIntegrity, checkStructure } from './ooxml.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const R_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const slideParts = (doc) =>
  [...doc.parts.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));

const slidePart = (doc, n) => {
  const parts = slideParts(doc);
  if (n < 1 || n > parts.length) throw new Error(`slide ${n} out of range (deck has ${parts.length})`);
  return parts[n - 1];
};

/** Replace the text of one shape, keeping its bodyPr (autofit/anchor) and its first run's style. */
function replaceShapeText(shapeXml, text) {
  const bodyMatch = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(shapeXml);
  if (!bodyMatch) throw new Error('shape has no text body');
  const prefix = bodyMatch[1].split(/<a:p[ >]/)[0];           // bodyPr + lstStyle, verbatim
  const rPr = /<a:rPr[^>]*>[\s\S]*?<\/a:rPr>|<a:rPr[^>]*\/>/.exec(bodyMatch[1])?.[0] ?? '<a:rPr lang="zh-CN"/>';
  const paras = String(text)
    .split(/\r?\n/)
    .map((line) => `<a:p><a:r>${rPr}<a:t>${esc(line)}</a:t></a:r></a:p>`)
    .join('');
  return shapeXml.replace(/<p:txBody>[\s\S]*?<\/p:txBody>/, `<p:txBody>${prefix}${paras}</p:txBody>`);
}

function eachShape(xml, fn) {
  return xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (shape) => fn(shape));
}

function findNamedShape(xml, name) {
  const re = new RegExp(`<p:sp>(?:(?!</p:sp>)[\\s\\S])*?name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?</p:sp>`);
  return re.exec(xml)?.[0] ?? null;
}

function setSlideText(doc, n, name, text) {
  const part = slidePart(doc, n);
  const xml = doc.part(part);
  const shape = findNamedShape(xml, name);
  if (!shape) {
    const names = [...xml.matchAll(/<p:(?:sp|pic|graphicFrame)>[\s\S]*?name="([^"]+)"/g)].map((m) => m[1]);
    throw new Error(`slide ${n}: no text shape named "${name}". Shapes: ${names.join(', ')}`);
  }
  doc.setPart(part, xml.replace(shape, replaceShapeText(shape, text)));
  return `${part} · ${name} → "${String(text).split('\n')[0].slice(0, 24)}"`;
}

function setSlideImage(doc, n, name, file) {
  const part = slidePart(doc, n);
  const xml = doc.part(part);
  const re = new RegExp(`<p:pic>(?:(?!</p:pic>)[\\s\\S])*?name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?</p:pic>`);
  const pic = re.exec(xml)?.[0];
  if (!pic) throw new Error(`slide ${n}: no picture named "${name}"`);

  const embed = /r:embed="(rId\d+)"/.exec(pic)?.[1];
  const relsPart = part.replace('slides/', 'slides/_rels/') + '.rels';
  const rels = doc.part(relsPart);
  const used = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const newRid = `rId${Math.max(0, ...used) + 1}`;

  const ext = (path.extname(file).slice(1) || 'png').toLowerCase();
  const mediaName = `ppt/media/edit-${Date.now().toString(36)}.${ext}`;
  doc.setPart(mediaName, fs.readFileSync(file));
  doc.setPart(relsPart, rels.replace('</Relationships>',
    `<Relationship Id="${newRid}" Type="${R_BASE}/image" Target="../media/${path.basename(mediaName)}"/></Relationships>`));

  doc.setPart(part, xml.replace(pic, pic.replace(`r:embed="${embed}"`, `r:embed="${newRid}"`)));

  const types = doc.part('[Content_Types].xml');
  const needDefault = !new RegExp(`Extension="${ext}"`, 'i').test(types);
  if (needDefault) {
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    doc.setPart('[Content_Types].xml', types.replace('</Types>', `<Default Extension="${ext}" ContentType="${mime}"/></Types>`));
  }
  return `${part} · ${name} → ${path.basename(file)}`;
}

function setChartValues(doc, n, chartIndex, seriesIndex, values, format = 'General') {
  const part = slidePart(doc, n);
  const rels = doc.part(part.replace('slides/', 'slides/_rels/') + '.rels');
  const charts = [...rels.matchAll(/Target="\.\.\/charts\/(chart\d+\.xml)"/g)].map((m) => m[1]);
  if (!charts.length) throw new Error(`slide ${n} has no chart`);
  const chartName = charts[chartIndex ?? 0];
  if (!chartName) throw new Error(`slide ${n}: chart ${chartIndex} not found (has ${charts.length})`);

  const partName = 'ppt/charts/' + chartName;
  let xml = doc.part(partName);

  // caches appear in series order; only the requested series cache is rewritten
  let seen = -1;
  const cacheRe = /<c:numCache>[\s\S]*?<\/c:numCache>/g;
  const num = values.length;
  xml = xml.replace(cacheRe, (block) => {
    seen += 1;
    if (seen !== (seriesIndex ?? 0)) return block;
    const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('');
    return `<c:numCache><c:formatCode>${format}</c:formatCode><c:ptCount val="${num}"/>${pts}</c:numCache>`;
  });
  // the formula ranges must agree with the new count, or PowerPoint drops the chart
  let ref = -1;
  xml = xml.replace(/<c:f>Sheet1!\$[A-Z]\$\d+:\$[A-Z]\$\d+<\/c:f>/g, (m) => {
    ref += 1;
    if (ref !== (seriesIndex ?? 0)) return m;
    const col = /Sheet1!\$([A-Z])\$/.exec(m)[1];
    return `<c:f>Sheet1!$${col}$2:$${col}$${num + 1}</c:f>`;
  });

  doc.setPart(partName, xml);
  return `${partName} · 系列 ${seriesIndex ?? 0} → [${values.join(', ')}]`;
}

function duplicateSlide(doc, n, watermarkId) {
  const src = slidePart(doc, n);
  const nums = slideParts(doc).map((p) => Number(/(\d+)/.exec(p)[1]));
  const newNo = Math.max(...nums) + 1;
  const dst = `ppt/slides/slide${newNo}.xml`;
  doc.setPart(dst, doc.part(src));
  const srcRels = src.replace('slides/', 'slides/_rels/') + '.rels';
  if (doc.has(srcRels)) doc.setPart(dst.replace('slides/', 'slides/_rels/') + '.rels', doc.part(srcRels));

  const presRels = doc.part('ppt/_rels/presentation.xml.rels');
  const used = [...presRels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const rid = Math.max(100, ...used) + 1;
  doc.setPart('ppt/_rels/presentation.xml.rels', presRels.replace('</Relationships>',
    `<Relationship Id="rId${rid}" Type="${R_BASE}/slide" Target="slides/slide${newNo}.xml"/></Relationships>`));

  const pres = doc.part('ppt/presentation.xml');
  const ids = [...pres.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => Number(m[1]));
  const sldId = Math.max(watermarkId, ...ids) + 1;
  // insert right after the source slide's id, not at the end
  const srcRelId = /r:id="(rId\d+)"[^>]*Target="slides\/(slide\d+\.xml)"/g;
  let srcId = null;
  for (const m of presRels.matchAll(new RegExp(`<Relationship Id="(rId\\d+)" Type="${R_BASE}/slide" Target="slides/${path.basename(src)}"/>`, 'g'))) srcId = m[1];
  const entry = `<p:sldId id="${sldId}" r:id="rId${rid}"/>`;
  if (srcId && pres.includes(`r:id="${srcId}"`)) {
    const re = new RegExp(`(<p:sldId id="\\d+" r:id="${srcId}"/>)`);
    doc.setPart('ppt/presentation.xml', pres.replace(re, `$1${entry}`));
  } else {
    doc.setPart('ppt/presentation.xml', pres.replace('</p:sldIdLst>', `${entry}</p:sldIdLst>`));
  }

  const types = doc.part('[Content_Types].xml');
  if (!types.includes(`/${dst}`)) {
    doc.setPart('[Content_Types].xml', types.replace('</Types>',
      `<Override PartName="/${dst}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`));
  }
  void srcRelId;
  return `${src} → ${dst}（插在原页之后）`;
}

function removeSlide(doc, n) {
  const part = slidePart(doc, n);
  const relsPart = part.replace('slides/', 'slides/_rels/') + '.rels';
  const presRels = doc.part('ppt/_rels/presentation.xml.rels');
  const line = new RegExp(`<Relationship Id="(rId\\d+)" Type="${R_BASE}/slide" Target="slides/${path.basename(part)}"/>`).exec(presRels);
  const rid = line?.[1];

  doc.parts.delete(part);
  if (doc.has(relsPart)) doc.parts.delete(relsPart);
  doc.setPart('ppt/_rels/presentation.xml.rels', presRels.replace(line?.[0] ?? '', ''));
  const pres = doc.part('ppt/presentation.xml');
  if (rid) doc.setPart('ppt/presentation.xml', pres.replace(new RegExp(`<p:sldId id="\\d+" r:id="${rid}"/>`), ''));
  const types = doc.part('[Content_Types].xml');
  doc.setPart('[Content_Types].xml', types.replace(new RegExp(`<Override PartName="/${part}"[^>]*/>`), ''));
  return `${part} 已删除`;
}

/**
 * Apply a list of operations and write a NEW file.
 * @returns {{out:string, applied:string[], problems:string[]}}
 */
export function editPptx({ input, out, ops = [] }) {
  if (path.resolve(input) === path.resolve(out)) {
    throw new Error('editPptx: 不覆盖原文件——输出必须是新路径（例如 deck-v2.pptx）');
  }
  const doc = new ZipDoc(input);
  const applied = [];

  for (const op of ops) {
    const slide = Number(op.slide);
    switch (op.op) {
      case 'setText':
        applied.push(setSlideText(doc, slide, op.shape, op.text ?? ''));
        break;
      case 'setImage':
        applied.push(setSlideImage(doc, slide, op.shape, op.file));
        break;
      case 'setChartValues':
        applied.push(setChartValues(doc, slide, op.chart ?? 0, op.series ?? 0, op.values ?? [], op.format ?? 'General'));
        break;
      case 'duplicateSlide':
        applied.push(duplicateSlide(doc, slide, 255));
        break;
      case 'removeSlide':
        applied.push(removeSlide(doc, slide));
        break;
      default:
        throw new Error(`unknown op "${op.op}" (setText | setImage | setChartValues | duplicateSlide | removeSlide)`);
    }
  }

  const problems = [...checkPackageIntegrity(doc.parts, { checkXml: true }), ...checkStructure(doc.parts)];
  if (problems.length) {
    // do not write a file we know is broken; the caller sees why
    return { out: null, applied, problems };
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  doc.save(out);
  return { out, applied, problems: [] };
}

export { slideParts };
