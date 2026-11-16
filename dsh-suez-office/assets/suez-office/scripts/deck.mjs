/**
 * DSH-SUEZ-Office · deck builder.
 *
 * Takes the official SUEZ template as a SEED: masters, layouts, theme, colour map and the six
 * embedded font subsets all survive — only the slides are replaced. That is the difference
 * between "a deck that looks like SUEZ" and "a deck that IS the SUEZ template with new pages",
 * and it is also what keeps the brand fonts rendering on a machine that has not installed them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ZipDoc, checkPackageIntegrity, checkStructure } from './ooxml.mjs';
import { validatePackage } from './validate.mjs';
import { checkRhythm } from './rhythm.mjs';
import { rewriteCover, rewriteAgenda, coverLayoutTarget } from './cover.mjs';
import { attachNotes, noteFor } from './notes.mjs';
import { lintPackage } from './lint.mjs';
import { columnChartXml } from './charts.mjs';
import { renderPage } from './archetypes.mjs';
import { setPictureDefaults } from './layout.mjs';
import { COLOR, GRID, applyPalette } from './tokens.mjs';
import { DEFAULT_PALETTE, skinFor } from './styles.mjs';

const SLIDE_RE = /^ppt\/slides\/slide\d+\.xml$/;
const SLIDE_RELS_RE = /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/;
const NOTES_RE = /^ppt\/notesSlides\/notesSlide\d+\.xml$/;
const NOTES_RELS_RE = /^ppt\/notesSlides\/_rels\/notesSlide\d+\.xml\.rels$/;

/**
 * Remove the seed's own content: slides, their notes, the charts they owned.
 * Orphan parts are harmless; DANGLING relationships are not — a relationship pointing at a
 * deleted part is exactly the kind of thing `checkStructure` calls a builder bug.
 */
export function stripSeed(doc) {
  for (const name of [...doc.parts.keys()]) {
    if (SLIDE_RE.test(name) || SLIDE_RELS_RE.test(name) || NOTES_RE.test(name) || NOTES_RELS_RE.test(name)) {
      doc.parts.delete(name);
    }
    // charts and their workbooks belong to the deleted slides; keeping them doubled the file to 736 KB
    if (/^ppt\/(charts|embeddings)\//.test(name)) doc.parts.delete(name);
  }
  const types = doc.part('[Content_Types].xml')
    .replace(/<Override PartName="\/ppt\/slides\/slide\d+\.xml"[^>]*\/>/g, '')
    .replace(/<Override PartName="\/ppt\/notesSlides\/notesSlide\d+\.xml"[^>]*\/>/g, '')
    .replace(/<Override PartName="\/ppt\/(charts|embeddings)\/[^"]+"[^>]*\/>/g, '');
  doc.setPart('[Content_Types].xml', types);

  doc.setPart('ppt/_rels/presentation.xml.rels', doc.part('ppt/_rels/presentation.xml.rels')
    .replace(/<Relationship Id="rId\d+" Type="[^"]*\/(slide|notesSlide)" Target="(slides|notesSlides)\/[^"]+"\/>/g, ''));

  doc.setPart('ppt/presentation.xml', doc.part('ppt/presentation.xml')
    .replace(/<p:sldId [^>]*\/>/g, '')
    .replace(/<p:notesMasterIdLst>[\s\S]*?<\/p:notesMasterIdLst>/g, ''));
  return doc;
}

/**
 * Pick the least decorated layout of the seed.
 * Some corporate layouts carry a full-bleed rectangle in the same colour as the background;
 * leaving it in place paints over everything the slide puts underneath.
 */
export function pickLayout(doc) {
  const names = [...doc.parts.keys()].filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(n));
  const scored = names.map((n) => {
    const xml = doc.part(n);
    const shapes = (xml.match(/<p:sp>/g) || []).length;
    const tables = (xml.match(/<p:graphicFrame>/g) || []).length;
    const fullBleed = /<a:ext cx="(1[12]\d{6})" cy="(6\d{6}|7\d{6})"/.test(xml) ? 60 : 0;
    return { n, score: shapes + tables * 2 + fullBleed, shapes };
  }).sort((a, b) => a.score - b.score);
  if (!scored.length) throw new Error('seed has no slide layouts');
  return path.basename(scored[0].n);
}

function addSlide(doc, slideXml, { layoutTarget, images, charts = [], watermarkId }) {
  const nums = [...doc.parts.keys()].map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n)).filter(Boolean).map((m) => Number(m[1]));
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  const slideName = `ppt/slides/slide${n}.xml`;

  const rels = [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/${layoutTarget}"/>`];
  for (const img of images) {
    rels.push(`<Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${img.fileName}"/>`);
  }
  for (const ch of charts) {
    rels.push(`<Relationship Id="${ch.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="${ch.target}"/>`);
  }
  doc.setPart(slideName, slideXml);
  doc.setPart(`ppt/slides/_rels/slide${n}.xml.rels`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);

  const presRels = doc.part('ppt/_rels/presentation.xml.rels');
  const used = [...presRels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const rId = Math.max(100, ...used) + 1;
  doc.setPart('ppt/_rels/presentation.xml.rels', presRels.replace('</Relationships>',
    `<Relationship Id="rId${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/></Relationships>`));

  const pres = doc.part('ppt/presentation.xml');
  const ids = [...pres.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => Number(m[1]));
  const sldId = Math.max(watermarkId, ...ids) + 1;
  doc.setPart('ppt/presentation.xml', pres.replace('</p:sldIdLst>', `<p:sldId id="${sldId}" r:id="rId${rId}"/></p:sldIdLst>`));

  let types = doc.part('[Content_Types].xml').replace('</Types>',
    `<Override PartName="/${slideName}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`);
  // every media extension needs its own Default; a photo of type .jpg under a png-only
  // Content_Types is PowerPoint 0x80CB8002 (our own integrity gate catches it).
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
  const exts = new Set(images.map((im) => (path.extname(im.fileName).slice(1) || 'png').toLowerCase()));
  exts.add('png');
  for (const ext of exts) {
    if (!new RegExp('Default Extension="' + ext + '"', 'i').test(types)) {
      types = types.replace('<Default ', '<Default Extension="' + ext + '" ContentType="' + (MIME[ext] ?? 'image/png') + '"/><Default ');
    }
  }
  doc.setPart('[Content_Types].xml', types);
  return { slideName, sldId };
}

/**
 * Build the deck.
 * @param {object} o
 * @param {string} o.seed    path to the official template (.pptx)
 * @param {string} o.out     output path
 * @param {Array}  o.slides  page specs, each with an `archetype`
 * @param {string} [o.logo]  PNG added to cover/section/closing pages
 * @param {string} [o.footerTitle] text in the footer of every content page
 */
export function buildDeck({ seed, out, slides, logo, footerTitle = '', style }) {
  // a free-style skin brings its own seed (master + theme) and its own palette
  const skin = skinFor(style);
  if (skin?.free) {
    seed = path.join(import.meta.dirname, '..', 'seeds', skin.seed);
    applyPalette(skin.palette);
  } else if (skin) {
    applyPalette(DEFAULT_PALETTE);
  }
  // 没有显式 seed 时用插件自带的那份 SUEZ 模板（库与工具行为保持一致）
  if (!seed) seed = path.join(import.meta.dirname, '..', 'seed', 'suez-template.pptx');
  if (!fs.existsSync(seed)) throw new Error('seed not found: ' + seed);

  const doc = new ZipDoc(seed);

  // The cover is the company's, not ours: keep the seed's cover slide (layout band, barcode motif,
  // logo all live there) and rewrite only its text placeholders.
  // Only a text-only first slide is safe to clone as the cover: a foreign deck's slide 1 often
  // carries a chart or a picture, and copying it keeps a reference to a part that stripSeed deletes.
  const coverSource = doc.has('ppt/slides/slide1.xml') ? doc.part('ppt/slides/slide1.xml') : null;
  const coverIsPlainText = Boolean(coverSource)
    && !/<p:(pic|graphicFrame)\b/.test(coverSource)
    && (coverSource.match(/<p:sp>/g) || []).length <= 4;
  const seedCover = coverIsPlainText
    ? { xml: coverSource, layout: coverLayoutTarget(doc.part('ppt/slides/_rels/slide1.xml.rels')) }
    : null;

  // "Summary - 4 chapters" / "Summary - 8 chapters" are layouts 7 and 8 in the SUEZ template; the
  // seed also has a slide on each of them, which is what we clone for the agenda page.
  const seedAgenda = {};
  for (const name of [...doc.parts.keys()].filter((k) => SLIDE_RE.test(k))) {
    const rels = doc.part(name.replace('slides/', 'slides/_rels/') + '.rels');
    const layout = coverLayoutTarget(rels);
    const slots = layout === 'slideLayout7.xml' ? 4 : layout === 'slideLayout8.xml' ? 8 : 0;
    if (slots && !seedAgenda[slots]) seedAgenda[slots] = { xml: doc.part(name), layout };
  }

  stripSeed(doc);
  const layoutTarget = pickLayout(doc);

  // an agenda with more than eight chapters continues on another page; eight is what the
  // template's summary layout holds
  const expandedSlides = slides.flatMap((s) => {
    if (s?.archetype !== 'agenda' || (s.chapters ?? []).length <= 8) return [s];
    const chunks = [];
    for (let i = 0; i < s.chapters.length; i += 8) chunks.push(s.chapters.slice(i, i + 8));
    return chunks.map((chapters, i) => ({
      ...s,
      chapters,
      startNumber: i * 8 + 1,
      title: i === 0 ? s.title : (s.continuationTitle ?? s.title),
    }));
  });

  // the seed's notes master survives stripping; every notes slide needs it
  const seedNotesMaster = doc.has('ppt/notesMasters/notesMaster1.xml')
    ? { xml: doc.part('ppt/notesMasters/notesMaster1.xml'), rels: doc.has('ppt/notesMasters/_rels/notesMaster1.xml.rels') ? doc.part('ppt/notesMasters/_rels/notesMaster1.xml.rels') : null }
    : null;

  const images = [];
  let logoRid = null;
  if (logo && fs.existsSync(logo)) {
    const fileName = path.basename(logo);
    doc.setPart(`ppt/media/${fileName}`, fs.readFileSync(logo));
    logoRid = 'rId2';
    images.push({ rId: logoRid, fileName });
  }

  // per-slide image registry: a page may carry a hero photo, or one photo per card
  // the same photo can appear on several pages (imageCard + imageSplit): one media part is enough
  const imageByPath = new Map();
  const registerImage = (file) => {
    const key = path.resolve(file).toLowerCase();
    if (imageByPath.has(key)) return imageByPath.get(key);
    const ext = (path.extname(file).slice(1) || 'png').toLowerCase();
    const fileName = `img-${images.length + 1}.${ext}`;
    const rId = `rId${images.length + 10}`;
    doc.setPart(`ppt/media/${fileName}`, fs.readFileSync(file));
    const entry = { rId, fileName };
    images.push(entry);
    imageByPath.set(key, entry);
    return entry;
  };

  let chartCount = [...doc.parts.keys()].filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).length;

  const built = [];
  expandedSlides.forEach((spec, i) => {
    const slideImages = [];
    const slideCharts = [];
    let imageRid = null;
    if (spec.image && fs.existsSync(spec.image)) {
      const entry = registerImage(spec.image);
      imageRid = entry.rId;
      slideImages.push(entry);
    }
    const cardRids = (spec.cards || []).map((c) =>
      c.image && fs.existsSync(c.image) ? (() => { const e = registerImage(c.image); slideImages.push(e); return e.rId; })() : null,
    );
    // one native chart per slide: the part, its relationship and its content-type override
    let chartRid = null;
    if (spec.chart) {
      chartCount += 1;
      const chartName = `ppt/charts/chart${chartCount}.xml`;
      doc.setPart(chartName, columnChartXml(spec.chart));
      chartRid = 'rId' + (30 + chartCount);
      slideCharts.push({ rId: chartRid, target: `../charts/chart${chartCount}.xml` });
      const ct = doc.part('[Content_Types].xml');
      if (!ct.includes(chartName)) {
        doc.setPart('[Content_Types].xml', ct.replace('</Types>',
          `<Override PartName="/${chartName}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`));
      }
    }
    const agendaSlots = spec.archetype === 'agenda' ? ((spec.chapters ?? []).length <= 4 ? 4 : 8) : 0;
    const useTemplateAgenda = agendaSlots > 0 && seedAgenda[agendaSlots] && spec.drawnAgenda !== true;
    setPictureDefaults({ focal: spec.focal ?? 'center', radius: spec.radius ?? 0 });
    const useTemplateCover = spec.archetype === 'cover' && seedCover && spec.drawnCover !== true;
    const page = useTemplateAgenda
      ? { name: 'Agenda (template)', xml: rewriteAgenda(seedAgenda[agendaSlots].xml, { ...spec, footerTitle: footerTitle ?? '' }), layoutTarget: seedAgenda[agendaSlots].layout }
      : useTemplateCover
      ? { name: 'Cover (template)', xml: rewriteCover(seedCover.xml, spec), layoutTarget: seedCover.layout }
      : renderPage(spec, { logoRid, footerTitle, page: i + 1, imageRid, cardRids, chartRid, imageFile: spec.image, cardFiles: (spec.cards || []).map((c) => c.image) });
    const info = addSlide(doc, page.xml, { layoutTarget: page.layoutTarget ?? layoutTarget, images: slideImages, charts: slideCharts, watermarkId: 255 });

    // speaker notes: provenance the audience should not see but the presenter needs
    const note = noteFor(spec);
    if (note) {
      const n = Number(/slide(\d+)\.xml$/.exec(info.name ?? info.slideName ?? '')?.[1] ?? 0);
      const slideNo = n || built.length + 1;
      if (seedNotesMaster) {
        if (!doc.has('ppt/notesMasters/notesMaster1.xml')) {
          doc.setPart('ppt/notesMasters/notesMaster1.xml', seedNotesMaster.xml);
          if (seedNotesMaster.rels) doc.setPart('ppt/notesMasters/_rels/notesMaster1.xml.rels', seedNotesMaster.rels);
          const ct = doc.part('[Content_Types].xml');
          if (!ct.includes('/ppt/notesMasters/notesMaster1.xml')) {
            doc.setPart('[Content_Types].xml', ct.replace('</Types>',
              '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/></Types>'));
          }
        }
        attachNotes(doc, slideNo, note);
      }
    }

    built.push({ page: i + 1, archetype: spec.archetype, ...info });
  });

  // three gates: OPC structure, package integrity, and the drawing XML PowerPoint actually parses
  const problems = [
    ...checkPackageIntegrity(doc.parts),
    ...checkStructure(doc.parts),
    ...validatePackage(doc),
  ];
  applyPalette(DEFAULT_PALETTE);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  doc.save(out);

  // rhythm is advisory: it never blocks a build, but a deck that ignores it will read flat
  // provenance: every slide that carries a photo must say where it came from.
  // Walks nested specs too — cards[].image, avatar1..3, screenshot — not just the top-level image.
  const IMAGE_KEYS = /^(image|screenshot|avatar\d|photo|img)$/i;
  const imagesOf = (node, out = []) => {
    if (!node || typeof node !== 'object') return out;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && IMAGE_KEYS.test(k)) out.push(v);
      else if (v && typeof v === 'object') imagesOf(v, out);
    }
    return out;
  };
  const credits = expandedSlides.flatMap((spec, i) => {
    const files = imagesOf(spec);
    const credited = Boolean(spec.imageCredit || spec.credit);
    return files.map((f) => ({ page: i + 1, file: f, credited }));
  }).filter((x) => !x.credited).map((x) => `第 ${x.page} 页用了图片但没有来源（给 imageCredit）: ${String(x.file).split(/[\\/]/).pop()}`);

  const rhythm = checkRhythm(expandedSlides);
  const lint = lintPackage(doc);
  // 封面副标题过长时，哪怕缩到最小字号也放不进色带：明确提示，别让它默默挤成两行
  const coverSpec = slides.find((s) => s.archetype === 'cover');
  if (coverSpec && String(coverSpec.subtitle ?? "").length > 44) {
    lint.warnings.push(`封面副标题 ${coverSpec.subtitle.length} 字偏长：色带里放不下，建议压到 44 字以内，或把后半句移到 meta`);
  }

  return {
    out,
    layoutTarget,
    slides: built,
    problems,
    rhythm,
    lint,
    credits,
    grid: { columns: GRID.cols, colWidth: +GRID.colWidth.toFixed(3), gutter: GRID.gutter },
  };
}
