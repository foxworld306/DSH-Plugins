import { textWidthEm } from './tokens.mjs';
/**
 * DSH-SUEZ-Office · cover page, taken from the template itself.
 *
 * The cover is the one page a company actually polices: it must be the official one, not a
 * designer's interpretation. So instead of drawing a cover, we take the seed's own cover slide —
 * which carries the layout's navy band, the barcode motif and the logo — and only rewrite the two
 * text placeholders, keeping their run properties (48/40 pt display, 24 pt subtitle, 方正粗圆/准圆).
 *
 * Everything else on that slide (position, placeholder identity, layout relationship) is the
 * template's, so "reset the layout" in PowerPoint still behaves normally.
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** First run property of a shape, chosen by script: the CJK run for Chinese text, else the Latin one. */
function pickRPr(shapeXml, wantCjk) {
  const runs = [...shapeXml.matchAll(/<a:rPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:rPr>)/g)].map((m) => m[0]);
  if (!runs.length) return '<a:rPr lang="zh-CN" dirty="0"/>';
  const isCjk = (r) => /<a:ea\b/.test(r) || /lang="zh-CN"/.test(r);
  const cjk = runs.find(isCjk);
  const latin = runs.find((r) => !isCjk(r));
  return (wantCjk ? (cjk ?? latin) : (latin ?? cjk)) ?? runs[0];
}

const hasCjk = (s) => /[\u2e80-\u9fff\uff00-\uff60]/.test(s);

/** One paragraph of styled runs; `\n` and `<br>` become real line breaks like the template's. */
function paragraphs(rPr, text) {
  const lines = String(text)
    .split(/\r?\n|<br\s*\/?>/i)
    .filter((line) => line !== '');
  // A txBody must contain at least one paragraph: emptying a placeholder has to leave <a:p/>, not
  // nothing at all — PowerPoint refuses the whole file otherwise.
  if (!lines.length) return '<a:p><a:endParaRPr lang="zh-CN"/></a:p>';
  return lines.map((line) => `<a:p><a:r>${rPr}<a:t>${esc(line)}</a:t></a:r></a:p>`).join('');
}

function rewriteShape(xml, name, buildTxBody) {
  const re = new RegExp(`<p:sp>(?:(?!</p:sp>)[\\s\\S])*?name="${name}"[\\s\\S]*?</p:sp>`);
  const m = re.exec(xml);
  if (!m) return xml;
  const shape = m[0];
  const body = shape.replace(/<p:txBody>[\s\S]*?<\/p:txBody>/, buildTxBody(shape));
  return xml.replace(shape, body);
}

/**
 * @param {string} coverXml  the seed's own cover slide XML
 * @param {object} spec      { title, subtitle, meta }
 * @returns {string} a slide part identical to the template's cover, with our text
 */
export function rewriteCover(coverXml, spec) {
  const title = String(spec.title ?? '');
  const subtitle = String(spec.subtitle ?? '');
  const meta = String(spec.meta ?? '');

  let xml = rewriteShape(coverXml, 'Titre 1', (shape) => {
    // the template title box is ~8.4in wide with room for two lines; a long title gets a smaller
    // size instead of a third line that would run into the subtitle
    const em = textWidthEm(title, true);
    const boxW = 8.4;
    // prefer a single line; only fall back to two lines at 32pt and above
    let size = 40;
    const fitsOne = [40, 36, 32, 28, 24].find((candidate) => (em * candidate) / 72 <= boxW);
    if (fitsOne) {
      size = fitsOne;
    } else {
      for (const candidate of [32, 28, 24]) {
        size = candidate;
        if ((em * candidate) / 72 <= boxW * 2) break;
      }
    }
    const rPr = pickRPr(shape, hasCjk(title)).replace(/sz="\d+"/, `sz="${size * 100}"`);
    return `<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs(rPr, title)}</p:txBody>`;
  });

  xml = rewriteShape(xml, 'Sous-titre 2', (shape) => {
    const rPr = pickRPr(shape, hasCjk(subtitle || meta));
    const subSz = Number(/sz="(\d+)"/.exec(rPr)?.[1] ?? 2000) / 100;
    const metaSz = Math.max(12, Math.round(subSz * 0.62 * 10) / 10);
    const boxW = Number(/<a:ext cx="(-?\d+)"/.exec(shape)?.[1] ?? 0) / 914400 || 8.4;
    const offY = Number(/<a:off x="-?\d+" y="(-?\d+)"/.exec(shape)?.[1] ?? 0) / 914400;
    const extCy = Number(/<a:ext cx="-?\d+" cy="(-?\d+)"/.exec(shape)?.[1] ?? 0) / 914400 || 0.62;

    // how tall the block really is (subtitle lines + a gap + the meta line)
    const subLines = Math.max(1, Math.ceil((textWidthEm(subtitle, hasCjk(subtitle)) * subSz) / 72 / boxW));
    const wantH = subLines * (subSz / 72) * 1.36 + (meta ? 0.10 + (metaSz / 72) * 1.36 : 0);

    // grow upward from the template's bottom edge so the block never leaves the band
    const bottom = offY + extCy;
    const newCy = Math.max(extCy, wantH);
    const newY = bottom - newCy;

    const fixXfrm = (body) => body
      .replace(/<a:off x="(\d+)" y="\d+"\/>/, (m, x) => '<a:off x="' + x + '" y="' + Math.round(newY * 914400) + '"/>')
      .replace(/<a:ext cx="(\d+)" cy="\d+"\/>/, (m, x) => '<a:ext cx="' + x + '" cy="' + Math.round(newCy * 914400) + '"/>');

    const lines = [];
    if (subtitle) lines.push(paragraphs(rPr, subtitle));
    if (meta) {
      // one step smaller than the subtitle: the template has no third level, so reuse its run
      const small = rPr.replace(/sz="(\d+)"/, (_, sz) => `sz="${Math.max(1200, Math.round((Number(sz) * 0.62) / 100) * 100)}"`);
      lines.push(paragraphs(small, meta));
    }
    return `<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${lines.join('')}</p:txBody>`;
  });

  // subtitle + meta must fit between the title's bottom and the band's bottom: pick the largest
  // size that fits, then place the box in that gap (shrinking beats overlapping)
  xml = (() => {
    const titleRe = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?name="Titre 1"[\s\S]*?<\/p:sp>/;
    const subRe = /<p:sp>(?:(?!<\/p:sp>)[\s\S])*?name="Sous-titre 2"[\s\S]*?<\/p:sp>/;
    const tm = titleRe.exec(xml);
    const sm = subRe.exec(xml);
    if (!tm || !sm) return xml;
    const geom = (shape) => ({
      y: Number(/<a:off x="-?\d+" y="(-?\d+)"/.exec(shape)?.[1] ?? 0) / 914400,
      h: Number(/<a:ext cx="-?\d+" cy="(-?\d+)"/.exec(shape)?.[1] ?? 0) / 914400,
      w: Number(/<a:ext cx="(-?\d+)"/.exec(shape)?.[1] ?? 0) / 914400 || 8.4,
    });
    const title = geom(tm[0]);
    const sub = geom(sm[0]);
    const baseline = sub.y + sub.h;                 // where the template put the block's bottom
    const avail = baseline - (title.y + title.h) - 0.05;
    const cjk = hasCjk(subtitle);

    const need = (size) => {
      const lines = Math.max(1, Math.ceil((textWidthEm(subtitle, cjk) * size) / 72 / sub.w));
      const metaH = meta ? 0.10 + (Math.max(12, size * 0.62) / 72) * 1.36 : 0;
      return { lines, h: lines * (size / 72) * 1.36 + metaH };
    };
    let size = 24;
    for (const candidate of [24, 22, 20, 18, 16, 14]) {
      size = candidate;
      if (need(candidate).h <= avail) break;
    }
    const fitH = Math.min(need(size).h, Math.max(0.6, avail));
    const newY = baseline - fitH;

    const fixed = sm[0]
      .replace(/(<a:off x="-?\d+" y=")-?\d+(")/, (_, a, b) => a + Math.round(Math.max(0, newY) * 914400) + b)
      .replace(/(<a:ext cx="-?\d+" cy=")-?\d+(")/, (_, a, b) => a + Math.round(fitH * 914400) + b)
      .replace(/<a:bodyPr[^>]*>(?:<a:normAutofit\/>|<a:noAutofit\/>)?/, '<a:bodyPr anchor="b"><a:noAutofit/>')
      // both paragraphs follow the chosen size; the meta stays one step smaller
      .replace(/sz="\d+"/g, () => `sz="${Math.round(size * 100)}"`)
      .replace(/(<a:p>[\s\S]*?<\/a:p>)$/, (whole) => whole.replace(/sz="\d+"/, `sz="${Math.round(Math.max(12, size * 0.62) * 100)}"`));
    return xml.replace(sm[0], fixed);
  })();

  return xml;
}

/** Which layout the seed's cover slide points at (so our copy keeps the official chrome). */
export function coverLayoutTarget(coverRels) {
  return /Target="\.\.\/slideLayouts\/(slideLayout\d+\.xml)"/.exec(coverRels ?? '')?.[1] ?? null;
}

/**
 * Agenda / summary page, also taken from the template.
 *
 * The template ships two: "Summary - 4 chapters" and "Summary - 8 chapters", each with a title,
 * one placeholder per chapter and a "1." … "8." number beside it. We clone the right one and fill
 * the chapters; unused slots are removed instead of left as empty boxes.
 */
export function rewriteAgenda(agendaXml, { title, chapters = [], footerTitle = '', chapterSize = 0, startNumber = 1 }) {
  if (chapters.length > 8) {
    throw new Error('agenda: ' + chapters.length + ' chapters do not fit the summary page (max 8). Merge them or split into two agenda pages.');
  }

  let xml = agendaXml;
  const shapeOf = (re) => [...xml.matchAll(re)];
  const textOf = (s) => [...s.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('');
  const idxOf = (s) => /<p:ph[^>]*idx="(\d+)"/.exec(s)?.[1] ?? null;
  const setText = (shape, text, cjk) => shape.replace(/<p:txBody>[\s\S]*?<\/p:txBody>/,
    `<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs(pickRPr(shape, cjk), text)}</p:txBody>`);

  // 1. title
  xml = xml.replace(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph type="title"[^>]*\/>[\s\S]*?<\/p:sp>/,
    (shape) => setText(shape, title ?? '目录', hasCjk(title ?? '目录')));

  // 2. which placeholders hold chapter names and which hold the "1." numbers
  const shapes = shapeOf(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<\/p:sp>/g).map((m) => m[0]);
  const nameIdx = new Set(shapes.filter((s) => /Chapter name|章节标题/.test(textOf(s))).map(idxOf).filter(Boolean));
  const numIdx = new Set(shapes.filter((s) => /^\d+\.$/.test(textOf(s).trim())).map(idxOf).filter(Boolean));

  // 3. fill the names (in document order) and the numbers
  let nameCursor = 0;
  xml = xml.replace(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<\/p:sp>/g, (shape) => {
    const idx = idxOf(shape);
    if (!idx) return shape;
    if (nameIdx.has(idx)) {
      const ch = chapters[nameCursor++];
      if (!ch) return '';
      const label = typeof ch === 'string' ? ch : ch.title ?? '';
      const out = setText(shape, label, hasCjk(label));
      // the template's chapter name is 24pt; a caller may ask for more without touching the layout
      if (chapterSize > 0) return out.replace(/sz="\d+"/g, 'sz="' + Math.round(chapterSize * 100) + '"');
      return out;
    }
    if (numIdx.has(idx)) {
      const i = [...numIdx].indexOf(idx);
      const ch = chapters[i];
      if (!ch) return '';
      const label = (typeof ch === 'object' && ch.page) ? String(ch.page) : `${startNumber + i}.`;
      return setText(shape, label, false);
    }
    return shape;
  });

  // 3b. footer + date: the layout defaults say "presentation title 幻灯片标题" and 05/11/2026
  xml = xml.replace(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph type="ftr"[^>]*\/>[\s\S]*?<\/p:sp>/,
    (shape) => setText(shape, footerTitle, hasCjk(footerTitle)));
  xml = xml.replace(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<p:ph type="dt"[^>]*\/>[\s\S]*?<\/p:sp>/,
    (shape) => setText(shape, '', false));

  // 4. clear leftover body placeholders — the template leaves lorem text in them
  xml = xml.replace(/<p:sp>(?:(?!<\/p:sp>)[\s\S])*?<\/p:sp>/g, (shape) => {
    const idx = idxOf(shape);
    if (!idx || !/type="body"/.test(shape)) return shape;
    if (nameIdx.has(idx) || numIdx.has(idx)) return shape;
    if (!/<a:t>/.test(shape)) return shape;
    // A single space, not an empty body: an empty placeholder falls back to the layout's prompt text
    // ("Subchapter title"), while deleting the shape loses the hairline border it carries.
    return shape.replace(/<p:txBody>[\s\S]*?<\/p:txBody>/,
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr marL="0" indent="0"><a:buNone/></a:pPr><a:r><a:rPr lang="zh-CN"/><a:t> </a:t></a:r></a:p></p:txBody>');
  });

  return xml;
}