/**
 * DSH-SUEZ-Office · layout lint.
 *
 * `validate.mjs` asks "will PowerPoint open this". This asks "will a human be able to read it".
 * Every rule below maps to something that actually shipped wrong in this project: text running
 * past the page edge, two text boxes landing on each other, 10pt body copy nobody can read from
 * the back of a room, and pages with more prose than a memo.
 *
 * It reads the built package, not the source objects — a lint that trusts the same data the
 * builder used cannot see builder bugs.
 */

const EMU = 914400;
const PAGE = { w: 13.333, h: 7.5 };
const inches = (emu) => emu / EMU;

const attr = (s, k) => {
  const m = new RegExp(`${k}="([^"]*)"`).exec(s);
  return m ? m[1] : undefined;
};

function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

/** Every shape on a slide with the few properties lint needs. */
function shapesOf(xml) {
  const out = [];
  const re = /<p:(sp|pic|graphicFrame)>[\s\S]*?<\/p:\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[0];
    const off = block.match(/<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>/);
    const ext = block.match(/<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/);
    if (!off || !ext) continue;
    const texts = [...block.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]);
    const sizes = [...block.matchAll(/sz="(\d+)"/g)].map((s) => Number(s[1]) / 100);
    const spPr = block.match(/<p:spPr>[\s\S]*?<\/p:spPr>/)?.[0] ?? '';
    const solid = spPr.match(/<a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/);
    const runFill = block.match(/<a:rPr[^>]*>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/);
    out.push({
      kind: m[1],
      name: attr(block, 'name') ?? '',
      x: inches(Number(off[1])), y: inches(Number(off[2])),
      w: inches(Number(ext[1])), h: inches(Number(ext[2])),
      text: texts.join('').trim(),
      textColor: runFill ? runFill[1] : undefined,
      size: sizes.length ? Math.max(...sizes) : 0,
      fill: solid ? solid[1] : null,
      order: out.length,
    });
  }
  return out;
}

const overlapArea = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/** The colour actually behind a point: the topmost filled shape containing it, else white. */
function backgroundAt(shapes, point) {
  let bg = 'FFFFFF';
  for (const s of shapes) {
    if (!s.fill) continue;
    if (point.x >= s.x && point.x <= s.x + s.w && point.y >= s.y && point.y <= s.y + s.h) bg = s.fill;
  }
  return bg;
}

/**
 * @returns {{errors: string[], warnings: string[], stats: object}}
 */
export function lintPackage(doc, options = {}) {
  const o = { minBodyPt: 12, minAnyPt: 8, minContrast: 4.5, maxCharsPerPage: 700, tolerance: 0.02, ...options };
  const errors = [];
  const warnings = [];
  const stats = { pages: 0, shapes: 0, smallestText: Infinity, chars: 0 };

  // sort numerically: a plain .sort() puts slide10 before slide2 and every page label above 9 lies
  const slides = [...doc.parts.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));
  const opaqueKinds = (xml) => {
    const regions = [];
    for (const m of xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)) {
      const off = m[0].match(/<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>/);
      const ext = m[0].match(/<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/);
      if (off && ext) regions.push({ x: inches(Number(off[1])), y: inches(Number(off[2])), w: inches(Number(ext[1])), h: inches(Number(ext[2])) });
    }
    for (const m of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
      if (!m[0].includes('<a:gradFill')) continue;
      const off = m[0].match(/<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>/);
      const ext = m[0].match(/<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/);
      if (off && ext) regions.push({ x: inches(Number(off[1])), y: inches(Number(off[2])), w: inches(Number(ext[1])), h: inches(Number(ext[2])) });
    }
    return regions;
  };
  // same picture on several slides: usually a copy-paste slip, so say it out loud
  const slidesUsing = new Map();
  for (const name of slides) {
    const relsName = name.replace('slides/', 'slides/_rels/') + '.rels';
    if (!doc.has(relsName)) continue;
    const rels = doc.part(relsName);
    const target = new Map([...rels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    const xml = doc.part(name);
    const used = new Set();
    for (const m of xml.matchAll(/r:embed="(rId\d+)"/g)) {
      const t = target.get(m[1]);
      if (t && t.indexOf('media/') >= 0) used.add(t.split('/').pop());
    }
    for (const media of used) {
      if (!slidesUsing.has(media)) slidesUsing.set(media, []);
      slidesUsing.get(media).push(name);
    }
  }
  const ignoreMedia = new Set((o.ignoreMedia || []).map((x) => String(x).toLowerCase()));
  const duplicateMedia = [];
  for (const [media, uses] of slidesUsing) {
    if (uses.length < 2) continue;
    if (ignoreMedia.has(media.toLowerCase())) continue;
    if (media.toLowerCase().indexOf("logo") >= 0) continue;
    // chrome (the logo, a corner motif) sits on nearly every slide and is not a copy-paste slip
    if (uses.length >= Math.max(3, Math.ceil(slides.length * 0.8))) continue;
    const pages = uses.map((n) => Number(/(\d+)/.exec(n)[1])).sort((a, b) => a - b);
    duplicateMedia.push({ media, pages });
    const pagesText = pages.join("、");
    warnings.push("第 " + pagesText + " 页用了同一张图片（" + media + "）：除非有意为之，否则换一张");
  }
  stats.duplicateMedia = duplicateMedia;

  stats.pages = slides.length;

  slides.forEach((name, pageIdx) => {
    const xml = doc.part(name);
    const shapes = shapesOf(xml);
    const opaque = opaqueKinds(xml);
    stats.shapes += shapes.length;
    const pageLabel = `第 ${pageIdx + 1} 页`;
    const texts = shapes.filter((s) => s.text);
    let pageChars = 0;

    for (const s of texts) pageChars += s.text.length;
    stats.chars += pageChars;
    if (pageChars > o.maxCharsPerPage) {
      warnings.push(`${pageLabel} 文字 ${pageChars} 字，超过 ${o.maxCharsPerPage}：删一段，或拆成两页`);
    }

    for (const s of shapes) {
      // 1. nothing may leave the page (bleeding to the edge is fine, going past it is not)
      if (s.x < -o.tolerance || s.y < -o.tolerance ||
          s.x + s.w > PAGE.w + o.tolerance || s.y + s.h > PAGE.h + o.tolerance) {
        errors.push(`${pageLabel} 「${s.name || s.kind}」越界：${s.x.toFixed(2)},${s.y.toFixed(2)} ${s.w.toFixed(2)}×${s.h.toFixed(2)}`);
      }
      // 2. sizes
      if (s.text && s.size > 0) {
        stats.smallestText = Math.min(stats.smallestText, s.size);
        if (s.size < o.minAnyPt) errors.push(`${pageLabel} 「${s.name}」字号 ${s.size}pt 低于 ${o.minAnyPt}pt`);
        else if (s.text.length > 40 && s.size < o.minBodyPt && !/^(Source|Caption|Foot|Note)/.test(s.name)) {
          warnings.push(`${pageLabel} 「${s.name}」正文 ${s.size}pt 低于 ${o.minBodyPt}pt`);
        }
      }
      // 3. contrast against whatever sits behind it (a Deco* shape is a graphic, not copy)
      const overOpaque = opaque.some((r) =>
        s.x + s.w / 2 >= r.x && s.x + s.w / 2 <= r.x + r.w && s.y + s.h / 2 >= r.y && s.y + s.h / 2 <= r.y + r.h);
      if (s.text && s.textColor && !s.name.startsWith('Deco') && !overOpaque) {
        const bg = s.fill ?? backgroundAt(shapes.filter((x) => x.order < s.order), { x: s.x + s.w / 2, y: s.y + s.h / 2 });
        const ratio = contrast(s.textColor, bg);
        const large = s.size >= 18;
        if (ratio < (large ? 3 : o.minContrast)) {
          errors.push(`${pageLabel} 「${s.name}」对比度 ${ratio.toFixed(1)}:1（${s.textColor} on ${bg}）低于 ${large ? 3 : o.minContrast}:1`);
        }
      }
    }

    // 4. text on text: the classic generated-deck bug
    const copy = texts.filter((s) => !s.name.startsWith('Deco'));
    for (let i = 0; i < copy.length; i++) {
      for (let j = i + 1; j < copy.length; j++) {
        const texts = copy;
        const area = overlapArea(texts[i], texts[j]);
        if (area > 0.01) {
          errors.push(`${pageLabel} 「${texts[i].name}」与「${texts[j].name}」重叠 ${area.toFixed(2)} in²`);
        }
      }
    }
  });

  if (!Number.isFinite(stats.smallestText)) stats.smallestText = 0;
  return { errors, warnings, stats };
}
