/**
 * Build a SUEZ-styled deck with the JavaScript toolkit — no Python.
 *
 * Copy this file, replace SLIDES, run it. The hard parts are here on purpose:
 *   1. a slide must be wired in five places ([Content_Types].xml, the slide part, its .rels,
 *      presentation.xml.rels, presentation.xml sldIdLst) — miss one and PowerPoint says
 *      "could not open" while lenient viewers still show it;
 *   2. images need `Default Extension="png"`, and a deck that ever had PNGs already has it —
 *      adding a second one is fatal (0x80CB8000);
 *   3. shape ids must be unique: start from a watermark, never from 1.
 *
 * Usage: node build_deck.mjs --seed <template.pptx> --out <new.pptx> [--logo <logo.png>]
 * The seed only supplies theme, masters and layouts; its own slides are replaced.
 */
import path from 'node:path';
import fs from 'node:fs';
import { ZipDoc, checkPackageIntegrity } from '../scripts/ooxml.mjs';

/* ------------------------------------------------------------------ content --- */
const SLIDES = [
  { kind: 'title', title: 'Quarterly Review', subtitle: 'Operations · Q4 2026 · built with the JS toolkit' },
  {
    kind: 'bullets',
    title: 'What changed this quarter',
    items: [
      'Deck written as OOXML directly — no Python, no pip, no admin rights',
      'Every slide wired through the five relationship spots',
      'Integrity gate before delivery catches the fatal Content_Types modes',
      'Rendered through Office COM for real-fidelity QA',
    ],
  },
];

/* --------------------------------------------------------------- brand kit --- */
const NAVY = '030F40';
const GREEN = 'AADC14';
const DARK = '333F55';
const MID = '5A6B8C';
const PANEL = 'F2F5FA';
const LATIN = 'poppins';
const EA = '方正准圆_GBK';

const EMU = 914400;
const inch = (v) => Math.round(v * EMU);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A run with the SUEZ font pair; without panose/charset Office substitutes the font. */
const run = (text, { size = 1800, bold = false, color = DARK } = {}) =>
  `<a:r><a:rPr lang="en-US" sz="${size}"${bold ? ' b="1"' : ''} dirty="0">` +
  `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
  `<a:latin typeface="${LATIN}" panose="020B0604020202020204" pitchFamily="34" charset="0"/>` +
  `<a:ea typeface="${EA}" panose="02010600030101010101" pitchFamily="18" charset="-122"/>` +
  `</a:rPr><a:t>${esc(text)}</a:t></a:r>`;

const rect = (id, name, x, y, w, h, fill) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="${inch(x)}" y="${inch(y)}"/><a:ext cx="${inch(w)}" cy="${inch(h)}"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` +
  `<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`;

const textBox = (id, name, x, y, w, h, paragraphs) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr><a:xfrm><a:off x="${inch(x)}" y="${inch(y)}"/><a:ext cx="${inch(w)}" cy="${inch(h)}"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
  `<p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" wrap="square"/><a:lstStyle/>` +
  paragraphs
    .map((p) =>
      `<a:p>${p.bullet ? '<a:pPr marL="285750" indent="-285750"><a:buChar char="•"/></a:pPr>' : '<a:pPr/>'}${p.runs.join('')}</a:p>`)
    .join('') +
  `</p:txBody></p:sp>`;

const picture = (id, name, x, y, w, h, rId) =>
  `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
  `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
  `<p:spPr><a:xfrm><a:off x="${inch(x)}" y="${inch(y)}"/><a:ext cx="${inch(w)}" cy="${inch(h)}"/></a:xfrm>` +
  `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;

const wrapSlide = (name, shapes) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ` +
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
  `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
  `<p:cSld name="${esc(name)}"><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  shapes +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

/* ----------------------------------------------------------------- slide body --- */
function renderSlide(spec, nextId) {
  const shapes = [];
  let id = nextId;
  if (spec.kind === 'title') {
    shapes.push(rect(id++, 'Band', 0, 0, 13.33, 1.0, NAVY));
    shapes.push(rect(id++, 'Accent', 0.6, 1.45, 0.12, 1.05, GREEN));
    shapes.push(textBox(id++, 'Title', 0.9, 1.45, 11.0, 0.9, [{ runs: [run(spec.title, { size: 4000, bold: true, color: NAVY })] }]));
    shapes.push(textBox(id++, 'Subtitle', 0.9, 2.4, 11.0, 0.5, [{ runs: [run(spec.subtitle, { size: 1600, color: MID })] }]));
  } else {
    shapes.push(textBox(id++, 'Title', 0.6, 0.45, 11.5, 0.6, [{ runs: [run(spec.title, { size: 2800, bold: true, color: NAVY })] }]));
    shapes.push(rect(id++, 'Rule', 0.6, 1.12, 1.4, 0.06, GREEN));
    const height = spec.items.length * 0.44 + 0.55; // text boxes never clip: overflow renders past the box
    shapes.push(rect(id++, 'Panel', 0.6, 1.5, 12.13, height, PANEL));
    shapes.push(
      textBox(id++, 'Body', 0.95, 1.72, 11.5, height - 0.4,
        spec.items.map((t) => ({ bullet: true, runs: [run(t, { size: 1600 })] }))),
    );
  }
  return { xml: wrapSlide(spec.title, shapes.join('')), nextId: id };
}

/* -------------------------------------------------------------------- wiring --- */
function addSlide(doc, slideXml, { layoutTarget, image, logoShape }) {
  const numbers = [...doc.parts.keys()]
    .map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const n = numbers.length ? Math.max(...numbers) + 1 : 1;
  const slideName = `ppt/slides/slide${n}.xml`;
  const xml = logoShape || !image ? slideXml : slideXml.replace('</p:spTree>', logoShape + '</p:spTree>');

  // (1) slide part  (2) its own relationships — layout, and the logo image
  const rels = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/${layoutTarget}"/>`,
  ];
  if (image) {
    rels.push(`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${image.fileName}"/>`);
  }
  doc.setPart(slideName, xml);
  doc.setPart(`ppt/slides/_rels/slide${n}.xml.rels`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);

  // (3) presentation.xml.rels — a fresh rId that cannot collide
  const presRels = doc.part('ppt/_rels/presentation.xml.rels');
  const used = [...presRels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const rId = Math.max(100, ...used) + 1;
  doc.setPart('ppt/_rels/presentation.xml.rels', presRels.replace('</Relationships>',
    `<Relationship Id="rId${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/></Relationships>`));

  // (4) presentation.xml sldIdLst — ids above 256, unique per deck
  const pres = doc.part('ppt/presentation.xml');
  const ids = [...pres.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => Number(m[1]));
  const sldId = Math.max(255, ...ids) + 1;
  doc.setPart('ppt/presentation.xml', pres.replace('</p:sldIdLst>', `<p:sldId id="${sldId}" r:id="rId${rId}"/></p:sldIdLst>`));

  // (5) [Content_Types].xml — Override per slide; the png Default only when it is missing
  let types = doc.part('[Content_Types].xml').replace('</Types>',
    `<Override PartName="/${slideName}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`);
  if (image && !/<Default Extension="png"/i.test(types)) {
    types = types.replace('<Default ', '<Default Extension="png" ContentType="image/png"/><Default ');
  }
  doc.setPart('[Content_Types].xml', types);
}

/** Remove the seed's own slides so only generated ones remain. */
function dropSlides(doc) {
  for (const name of [...doc.parts.keys()]) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name) || /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name)) {
      doc.parts.delete(name);
    }
  }
  doc.setPart('[Content_Types].xml',
    doc.part('[Content_Types].xml').replace(/<Override PartName="\/ppt\/slides\/slide\d+\.xml"[^>]*\/>/g, ''));
  doc.setPart('ppt/_rels/presentation.xml.rels',
    doc.part('ppt/_rels/presentation.xml.rels').replace(/<Relationship Id="rId\d+" Type="[^"]*\/slide" Target="slides\/slide\d+\.xml"\/>/g, ''));
  doc.setPart('ppt/presentation.xml', doc.part('ppt/presentation.xml').replace(/<p:sldId [^>]*\/>/g, ''));
}

/* ---------------------------------------------------------------------- main --- */
const argOf = (argv, flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const argv = process.argv.slice(2);
const seed = path.resolve(argOf(argv, '--seed', path.join(import.meta.dirname, '..', 'assets', '_selftest.pptx')));
const out = path.resolve(argOf(argv, '--out', 'deck-js-demo.pptx'));
const logoArg = argOf(argv, '--logo', null);

const doc = new ZipDoc(seed);
const layout = /slideLayout7\.xml/.test(doc.part('ppt/slides/_rels/slide1.xml.rels')) ? 'slideLayout7.xml' : 'slideLayout2.xml';
dropSlides(doc);

let image = null;
if (logoArg) {
  image = { fileName: path.basename(path.resolve(logoArg)), buffer: fs.readFileSync(path.resolve(logoArg)) };
  doc.setPart(`ppt/media/${image.fileName}`, image.buffer);
}

let watermark = 100;
for (const spec of SLIDES) {
  const slide = renderSlide(spec, watermark);
  watermark = slide.nextId + 10;
  // the SUEZ logo belongs on every page, bottom right of a 13.33x7.5in slide
  const logoShape = image ? picture(slide.nextId, 'SUEZ Logo', 11.9, 6.85, 1.25, 0.32, 'rId2') : null;
  addSlide(doc, slide.xml, { layoutTarget: layout, image, logoShape });
}

const problems = checkPackageIntegrity(doc.parts);
doc.save(out);
console.log(`built ${out} — ${SLIDES.length} slide(s), ${doc.parts.size} parts, layout ${layout}${image ? ', logo ' + image.fileName : ''}`);
console.log(problems.length === 0 ? 'integrity: CLEAN' : 'integrity: PROBLEMS\n  - ' + problems.join('\n  - '));
if (problems.length) process.exitCode = 1;
