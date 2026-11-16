/**
 * DSH-SUEZ-Office · layout primitives.
 *
 * Shapes are built from tokens, never from hand-typed inch values. Two rules are baked in
 * because breaking them is what makes generated decks look "off":
 *   1. every text box is sized from `textHeight()` (PowerPoint does not clip — it spills);
 *   2. boldness is expressed by FAMILY (Poppins ExtraBold / 方正粗圆_GBK), never by `b="1"`,
 *      which only synthesises a fake weight on an already-heavy face.
 */
import fs from 'node:fs';
import { COLOR, FONT, GRID, PAGE, TYPE, V, breakLines, col, fitSize, textHeight } from './tokens.mjs';

export { COLOR, FONT, GRID, PAGE, TYPE, V, col, fitSize, textHeight, runXml, takeId };

export const EMU = 914400;
export const inch = (v) => Math.round(v * EMU);
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A new slide accumulator. Shape ids start at 10: the group is 1, layouts use 2–9. */
export function slide(name = '') {
  return { name, shapes: [], id: 10 };
}
const takeId = (s) => s.id++;

function runXml(text, o = {}) {
  const size = o.size ?? TYPE.body;
  const color = o.color ?? COLOR.ink;
  const latin = o.latin ?? (o.bold ? FONT.latinBold : FONT.latin);
  const ea = o.ea ?? (o.bold ? FONT.eaDisplay : FONT.eaBody);
  const spc = o.spc ? ` spc="${Math.round(o.spc)}"` : '';
  return (
    `<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${Math.round(size * 100)}"${spc} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    `<a:latin typeface="${latin}" panose="020B0604020202020204" pitchFamily="34" charset="0"/>` +
    `<a:ea typeface="${ea}" panose="02010600030101010101" pitchFamily="18" charset="-122"/>` +
    `</a:rPr><a:t>${esc(text)}</a:t></a:r>`
  );
}

/** ST_TextAlignType is l | ctr | r | just | dist — c is NOT a legal value and makes PowerPoint refuse the file. */
const ALIGN = { l: 'l', c: 'ctr', center: 'ctr', ctr: 'ctr', r: 'r', j: 'just', just: 'just' };

function paraXml(runs, o = {}) {
  const ln = o.lineRatio ? `<a:lnSpc><a:spcPct val="${Math.round(o.lineRatio * 100000)}"/></a:lnSpc>` : '';
  const aft = o.spaceAfter ? `<a:spcAft><a:spcPts val="${Math.round(o.spaceAfter * 100)}"/></a:spcAft>` : '';
  return `<a:p><a:pPr algn="${ALIGN[o.align ?? 'l'] ?? 'l'}">${ln}${aft}</a:pPr>${runs}</a:p>`;
}

/**
 * Append a text box.
 * `text` may contain \n for paragraphs; `segments` lets one line carry several colours
 * ([{ t: '把审批链', color: COLOR.navy }, { t: '从五环砍到两环', color: COLOR.lime }]).
 */
export function text(s, o) {
  const x = o.x, y = o.y, w = o.w;
  const size = o.size ?? TYPE.body;
  const lineRatio = o.lineRatio ?? 1.32;

  let paragraphs;
  if (o.segments) {
    paragraphs = [paraXml(o.segments.map((seg) => runXml(seg.t, { ...o, ...seg })).join(''), { ...o, lineRatio })];
  } else {
    const lines = String(o.text ?? '').split(/\r?\n/);
    paragraphs = lines.map((line, i) =>
      paraXml(line ? runXml(line, o) : '', {
        ...o,
        lineRatio,
        spaceAfter: i < lines.length - 1 ? (o.spaceAfter ?? 0) : 0,
      }),
    );
  }

  const h = o.h ?? textHeight(o.text ?? (o.segments || []).map((g) => g.t).join(''), size, w, lineRatio) + 0.02;
  const wrap = o.wrap === false ? 'none' : 'square';
  s.shapes.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="${takeId(s)}" name="${esc(o.name ?? 'Text')}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${inch(x)}" y="${inch(y)}"/><a:ext cx="${inch(w)}" cy="${inch(h)}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>` +
      `<p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="${o.anchor ?? 't'}" wrap="${wrap}"/>` +
      `<a:lstStyle/>${paragraphs.join('')}</p:txBody></p:sp>`,
  );
  return { x, y, w, h };
}

/** Solid rectangle (no line). `alpha` is 0–1. */
export function rect(s, o) {
  const fill = o.fill ?? COLOR.panel;
  const alphaXml = o.alpha !== undefined ? `<a:alpha val="${Math.round(o.alpha * 100000)}"/>` : '';
  s.shapes.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="${takeId(s)}" name="${esc(o.name ?? 'Rect')}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm${o.rot ? ` rot="${Math.round(o.rot * 60000)}"` : ''}><a:off x="${inch(o.x)}" y="${inch(o.y)}"/><a:ext cx="${inch(o.w)}" cy="${inch(o.h)}"/></a:xfrm>` +
      `<a:prstGeom prst="${o.prst ?? 'rect'}"><a:avLst/></a:prstGeom>` +
      `<a:solidFill><a:srgbClr val="${fill}">${alphaXml}</a:srgbClr></a:solidFill>` +
      `<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`,
  );
}

/** A line from (x1,y1) to (x2,y2): a thin rotated rectangle, so no freeform geometry is needed. */
export function segment(s, o) {
  const dx = o.x2 - o.x1;
  const dy = o.y2 - o.y1;
  const len = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const th = o.h ?? 0.03;
  rect(s, {
    name: o.name ?? 'Segment',
    x: (o.x1 + o.x2) / 2 - len / 2,
    y: (o.y1 + o.y2) / 2 - th / 2,
    w: len, h: th, fill: o.fill, alpha: o.alpha, rot: angle,
  });
}

/** Vertical gradient fill (transparent → colour). Used as a scrim over full-bleed images. */
export function scrim(s, o) {
  const color = o.color ?? COLOR.navy;
  const gs = [
    [0, 0], [Math.round((o.from ?? 0.35) * 100000), Math.round((o.fromAlpha ?? 0) * 100000)],
    [100000, Math.round((o.toAlpha ?? 0.92) * 100000)],
  ].map(([pos, alpha]) => `<a:gs pos="${pos}"><a:srgbClr val="${color}"><a:alpha val="${alpha}"/></a:srgbClr></a:gs>`).join('');
  s.shapes.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="${takeId(s)}" name="${esc(o.name ?? 'Scrim')}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="${inch(o.x)}" y="${inch(o.y)}"/><a:ext cx="${inch(o.w)}" cy="${inch(o.h)}"/></a:xfrm>` +
      `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
      `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>` +
      `<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`,
  );
}

/** Intrinsic pixel size of a PNG/JPEG, read from the header — no image library needed. */
export function imageSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * srcRect for an object-fit: cover crop. Stretching a 3:2 photo into a 6.7x7.5 box makes a watch
 * look wide — the fix is to crop the source, not to scale it.
 */
export function coverCrop(file, targetW, targetH) {
  const size = imageSize(file);
  if (!size || !size.w || !size.h) return null;
  const target = targetW / targetH;
  const source = size.w / size.h;
  const pct = (v) => Math.round(v * 100000);
  if (source > target) {
    const keep = target / source;
    const side = (1 - keep) / 2;
    return { l: pct(side), r: pct(side), t: 0, b: 0 };
  }
  const keep = source / target;
  const side = (1 - keep) / 2;
  return { l: 0, r: 0, t: pct(side), b: pct(side) };
}

/** Hairline rule (a 1pt-flat rectangle: renders identically and needs no dash maths). */
export const rule = (s, o) => rect(s, { ...o, h: o.h ?? 0.012, name: o.name ?? 'Rule' });

/** Per-build picture defaults (the deck sets these from the slide spec before drawing). */
const PIC = { focal: 'center', radius: 0 };
export const setPictureDefaults = (o = {}) => {
  PIC.focal = o.focal ?? 'center';
  PIC.radius = o.radius ?? 0;
};

export const picture = (s, o) => {
  o = { focal: PIC.focal, radius: PIC.radius, ...o };
  const crop = o.crop === 'cover' ? coverCrop(o.source, o.w, o.h, o.focal ?? 'center') : null;
  const src = crop ? `<a:srcRect l="${crop.l}" t="${crop.t}" r="${crop.r}" b="${crop.b}"/>` : '';
  // rounded corners: roundRect's adj is a share of half the short side (50000 = a semicircle)
  const geom = o.shape === 'ellipse'
    ? '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>'
    : o.radius
      ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.min(50000, Math.round((o.radius / (Math.min(o.w, o.h) / 2)) * 50000))}"/></a:avLst></a:prstGeom>`
      : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  s.shapes.push(
    `<p:pic><p:nvPicPr><p:cNvPr id="${takeId(s)}" name="${esc(o.name ?? 'Picture')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${o.rId}"/>${src}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr><a:xfrm><a:off x="${inch(o.x)}" y="${inch(o.y)}"/><a:ext cx="${inch(o.w)}" cy="${inch(o.h)}"/></a:xfrm>` +
      geom + `</p:spPr></p:pic>`,
  );
}

/** Wrap the accumulated shapes into a slide part. */
export const wrapSlide = (s) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<p:sld ` +
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
  `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
  `<p:cSld name="${esc(s.name)}"><p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  s.shapes.join('') +
  `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;

/* ------------------------------------------------------------------ page chrome --- */

const TITLE_SIZES = [TYPE.display, TYPE.h1, 30, 28, 26];

/**
 * Eyebrow + assertion title + optional lede.
 * The title is auto-sized to fit two lines inside the title band; it never overflows into the body.
 */
export function pageHeader(s, o = {}) {
  let top = V.titleTop;
  if (o.eyebrow) {
    text(s, {
      name: 'Eyebrow',
      x: GRID.titleHang + 0.02, y: top, w: 8.0,
      // lime at 11pt on white is 1.6:1 — unreadable from the back of a room. Lime stays for
      // rules, blocks and numbers; small text uses the secondary ink.
      text: o.eyebrow, size: TYPE.eyebrow, color: o.eyebrowColor ?? COLOR.mid,
      bold: true, spc: 1.6, wrap: false,
    });
    top += 0.34;
  }
  if (!o.title) return;

  // 10.0", not 11.41": every SUEZ layout carries the barcode motif in the top-right ~3.3" of
  // the title band, and a title that runs under it reads as a collision even though nothing overlaps.
  const width = o.titleWidth ?? 10.0;
  const band = o.titleBandHeight ?? Math.max(0.7, V.titleBottom - top + 0.25);
  const size = fitSize(o.title, width, band, TITLE_SIZES, 1.2, true);
  // CJK titles: break with kinsoku ourselves, so a line never starts with "，。"
  const titleText = /[\u3400-\u9fff]/.test(String(o.title ?? ''))
    ? breakLines(o.title, size, width, { bold: true }).join(String.fromCharCode(10))
    : o.title;
  const lines = Math.max(1, Math.round((textHeight(o.title, size, width, 1.2) / size) * 72 / 1.2 / 72));
  text(s, {
    name: 'Title',
    x: GRID.titleHang, y: top, w: width,
    text: titleText, size, color: o.titleColor ?? COLOR.navy, bold: true, lineRatio: 1.2,
    segments: undefined,
  });
  const titleH = textHeight(o.title, size, width, 1.2);
  // The template has no rule under the title — the eyebrow + type size carry the hierarchy.
  if (o.rule === true) {
    rule(s, { name: 'Title rule', x: GRID.left, y: top + titleH + 0.18, w: 0.86, fill: o.ruleColor ?? COLOR.lime });
  }
  return { titleBottom: top + titleH, size, lines };
}

/** Footer: hairline, document title on the left, page number on the right. */
export function pageFooter(s, o = {}) {
  rule(s, { name: 'Footer rule', x: GRID.titleHang, y: V.footerRule, w: GRID.right - GRID.titleHang, fill: COLOR.grid });
  if (o.title) {
    text(s, {
      name: 'Footer title', x: GRID.left, y: V.footerText, w: 7.0,
      text: o.title, size: TYPE.micro, color: COLOR.mid, wrap: false,   // 4.5:1 on white
    });
  }
  if (o.page !== undefined) {
    // wrap="none" makes PowerPoint ignore algn (the run starts at the box edge), so the page
    // number gets a normal wrapped box that is right-aligned to the content edge.
    text(s, {
      name: 'Page number', x: GRID.right - 1.65, y: V.footerText, w: 1.0,
      text: String(o.page), size: TYPE.micro, color: COLOR.mid, align: 'r',
    });
  }
}

/** A card: panel + optional accent bar + heading + body. Returns its geometry. */
export function card(s, o) {
  const fill = o.fill ?? COLOR.panel;
  rect(s, { name: 'Card', x: o.x, y: o.y, w: o.w, h: o.h, fill });
  if (o.accent) rect(s, { name: 'Card accent', x: o.x, y: o.y, w: o.w, h: 0.035, fill: o.accent });

  const pad = o.pad ?? 0.26;
  let cursor = o.y + pad;
  if (o.index) {
    text(s, { name: 'Card index', x: o.x + pad, y: cursor, w: o.w - pad * 2, text: o.index,
      size: TYPE.small, color: o.indexColor ?? COLOR.mid, bold: true, spc: 1.2, wrap: false });
    cursor += 0.30;
  }
  if (o.title) {
    text(s, { name: 'Card title', x: o.x + pad, y: cursor, w: o.w - pad * 2, text: o.title,
      size: o.titleSize ?? TYPE.h3, color: o.titleColor ?? COLOR.navy, bold: true, lineRatio: 1.2 });
    cursor += textHeight(o.title, o.titleSize ?? TYPE.h3, o.w - pad * 2, 1.2) + 0.10;
  }
  if (o.body) {
    text(s, { name: 'Card body', x: o.x + pad, y: cursor, w: o.w - pad * 2, text: o.body,
      size: o.bodySize ?? TYPE.small, color: o.bodyColor ?? COLOR.ink, lineRatio: 1.45 });
  }
}
