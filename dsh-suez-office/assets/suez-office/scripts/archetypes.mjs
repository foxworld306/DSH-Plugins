/**
 * DSH-SUEZ-Office · page archetypes.
 *
 * Each one is a pure function: spec in, shapes out. Geometry comes from tokens, never from
 * numbers written at the call site — that is what keeps 20 pages on the same grid.

 */
import { chartFrame } from './charts.mjs';
import { wrapCjk } from './tokens.mjs';
import {
  COLOR, GRID, PAGE, TYPE, V, card, col, fitSize, pageFooter, pageHeader, picture, rect, rule, slide, text,
  textHeight, wrapSlide, runXml, takeId, inch, scrim, segment,
} from './layout.mjs';

/* ------------------------------------------------------------------- cover --- */
function cover(spec, ctx) {
  const s = slide('Cover');
  rect(s, { name: 'Cover band', x: 0, y: 2.45, w: GRID.right + 1.13, h: 2.5, fill: COLOR.navy });


  const titleSize = fitSize(spec.title, 7.9, 1.5, [TYPE.stat, TYPE.display, TYPE.h1], 1.15);
  text(s, { name: 'Cover title', x: GRID.left, y: 2.82, w: 7.9, text: spec.title, size: titleSize,
    color: COLOR.white, bold: true, lineRatio: 1.15 });
  if (spec.subtitle) {
    text(s, { name: 'Cover subtitle', x: GRID.left, y: 2.82 + textHeight(spec.title, titleSize, 7.9, 1.15) + 0.22,
      w: 7.9, text: spec.subtitle, size: TYPE.h2, color: COLOR.lime, lineRatio: 1.25 });
  }
  if (spec.meta) {
    text(s, { name: 'Cover meta', x: GRID.left, y: 6.55, w: 8.0, text: spec.meta, size: TYPE.small,
      color: COLOR.mid, wrap: false });
  }
  return { name: 'Cover', xml: wrapSlide(s) };
}

/* ----------------------------------------------------------------- section --- */
function section(spec, ctx) {
  const s = slide('Section');
  rect(s, { name: 'Section bg', x: 0, y: 0, w: GRID.right + 1.13, h: 7.5, fill: COLOR.navy });

  // optional photograph on the right: a chapter page with a picture sets the scene, but the text
  // column has to shrink so nothing lands on top of the image
  const hasPhoto = Boolean(ctx.imageRid);
  const photoW = 5.1;
  if (hasPhoto) {
    picture(s, { name: 'Section photo', x: PAGE.w - photoW, y: 0, w: photoW, h: PAGE.h,
      rId: ctx.imageRid, source: spec.image, crop: 'cover' });
  }
  const textW = hasPhoto ? PAGE.w - photoW - GRID.left - 0.5 : 9.6;

  text(s, { name: 'Section number', x: GRID.left, y: 1.78, w: 3.0, text: spec.number ?? '01',
    size: 96, color: COLOR.lime, bold: true, wrap: false, spc: -2 });
  text(s, { name: 'Section title', x: GRID.left, y: 3.78, w: textW,
    text: wrapCjk(String(spec.title ?? ''), TYPE.display, textW, { bold: true }),
    size: TYPE.display, color: COLOR.white, bold: true, lineRatio: 1.15 });
  if (spec.subtitle) {
    text(s, { name: 'Section subtitle', x: GRID.left, y: 5.32, w: textW,
      text: wrapCjk(spec.subtitle, TYPE.h3, textW),
      size: TYPE.h3, color: COLOR.tint, lineRatio: 1.35 });
  }
  return { name: 'Section', xml: wrapSlide(s) };
}

/* --------------------------------------------------------------- assertion --- */
/**
 * The workhorse page: one sentence that states the point, the evidence on the left, the
 * numbers on the right. Modelled on the strongest page in the reference library (a consulting
 * KPI page), re-cut on the SUEZ grid.
 */
function assertion(spec, ctx) {
  const s = slide('Assertion');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const kpis = (spec.kpis || []).slice(0, 3);
  const rightX = col(3, 3).x;
  const rightW = col(3, 3).w;
  const tileW = (rightW - 0.22) / 2;
  const tileH = 1.78;
  const wideH = 0.98;
  const tilesH = kpis.length >= 3 ? tileH + 0.22 + wideH : tileH;

  const ledeW = col(0, 3).w;
  const ledeH = spec.lede ? textHeight(spec.lede, TYPE.body, ledeW, 1.55) : 0;

  // A page that carries less than the band allows is centred in it: content glued to the top
  // with 3" of dead air underneath is the single most common "unfinished" look.
  const bandH = V.bodyBottom - V.bodyTop;
  const blockH = Math.max(ledeH, tilesH);
  const top = V.bodyTop + Math.max(0, (bandH - blockH) / 2);

  if (spec.lede) {
    text(s, { name: 'Lede', x: GRID.left, y: top, w: ledeW, text: wrapCjk(spec.lede, TYPE.body, ledeW),
      size: TYPE.body, color: COLOR.ink, lineRatio: 1.55, spaceAfter: 5 });
  }

  kpis.slice(0, 2).forEach((k, i) => {
    const x = rightX + i * (tileW + 0.22);
    const dark = (k.tone ?? (i === 0 ? 'dark' : 'light')) === 'dark';
    rect(s, { name: `KPI ${i + 1}`, x, y: top, w: tileW, h: tileH, fill: dark ? COLOR.navy : COLOR.panel });
    if (dark) rect(s, { name: `KPI ${i + 1} accent`, x, y: top, w: tileW, h: 0.035, fill: COLOR.lime });
    const valueSize = fitSize(k.value, tileW - 0.5, 0.9, [TYPE.stat, 38, 32], 1.0);
    text(s, { name: `KPI ${i + 1} value`, x: x + 0.26, y: top + 0.26, w: tileW - 0.5, h: valueSize / 72,
      text: k.value, size: valueSize, bold: true, color: dark ? COLOR.lime : COLOR.navy, wrap: false });
    text(s, { name: `KPI ${i + 1} label`, x: x + 0.26, y: top + 0.26 + valueSize / 72 + 0.16,
      w: tileW - 0.5, text: wrapCjk(k.label, TYPE.small, tileW - 0.5), size: TYPE.small, color: dark ? COLOR.white : COLOR.mid, lineRatio: 1.4 });
  });

  const wide = kpis[2];
  if (wide) {
    const y = top + tileH + 0.22;
    rect(s, { name: 'KPI 3', x: rightX, y, w: rightW, h: wideH, fill: COLOR.panel });
    const valueSize = fitSize(wide.value, rightW * 0.45, wideH - 0.3, [TYPE.stat, 38, 32], 1.0);
    text(s, { name: 'KPI 3 value', x: rightX + 0.26, y: y + (wideH - valueSize / 72) / 2 - 0.02, w: rightW * 0.45,
      h: valueSize / 72, text: wide.value, size: valueSize, bold: true, color: COLOR.navy, wrap: false });
    text(s, { name: 'KPI 3 label', x: rightX + 0.26 + rightW * 0.46, y: y + 0.22, w: rightW * 0.5,
      text: wide.label, size: TYPE.small, color: COLOR.mid, lineRatio: 1.4 });
  }

  if (spec.source) {
    text(s, { name: 'Source', x: GRID.left, y: V.footerRule - 0.34, w: col(0, 4).w, text: spec.source,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Assertion', xml: wrapSlide(s) };
}

/* ------------------------------------------------------------------- cards --- */
function cards(spec, ctx) {
  const s = slide('Cards');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const items = spec.cards || [];
  const n = Math.max(1, Math.min(items.length, 4));
  const gap = n === 4 ? 0.30 : 0.39;
  const each = (GRID.width - gap * (n - 1)) / n;
  const y = Math.max(V.bodyTop, 2.25);
  // Height from content, not from a constant: a fixed 4" panel with 1.4" of text is the
  // single most common "looks broken" symptom in generated decks.
  const pad = 0.26;
  const inner = each - pad * 2;
  const needed = items.slice(0, n).map((c) =>
    pad * 2 + 0.30 +
    textHeight(c.title ?? '', TYPE.h3, inner, 1.2) + 0.10 +
    textHeight(c.body ?? '', TYPE.small, inner, 1.45));
  const bandH = V.bodyBottom - y;
  const h = Math.min(spec.cardHeight ?? bandH, Math.max(3.05, ...needed));   // cards fill the band
  // Short content centres in the band instead of leaving a dead 2" strip under it.
  const rowY = y;   // top-aligned, same reason

  items.slice(0, n).forEach((c, i) => {
    const x = GRID.left + i * (each + gap);
    card(s, {
      x, y: rowY, w: each, h,
      fill: c.tone === 'navy' ? COLOR.navy : (c.tone === 'lime' ? COLOR.lime : COLOR.panel),
      accent: c.accent ?? (c.tone === 'navy' ? COLOR.lime : undefined),
      index: c.index ?? String(i + 1).padStart(2, '0'),
      indexColor: c.tone === 'navy' ? COLOR.tint : COLOR.mid,
      title: c.title,
      titleColor: c.tone === 'navy' ? COLOR.white : COLOR.navy,
      body: c.body,
      bodyColor: c.tone === 'navy' ? COLOR.tint : COLOR.ink,
      titleSize: TYPE.h3,
      bodySize: TYPE.small,
    });
  });

  if (spec.source) {
    text(s, { name: 'Source', x: GRID.left, y: V.footerRule - 0.34, w: col(0, 4).w, text: spec.source,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Cards', xml: wrapSlide(s) };
}

/* ----------------------------------------------------------------- bullets --- */
function bullets(spec, ctx) {
  const s = slide('Bullets');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const cols = spec.columns || [];
  const n = Math.max(1, Math.min(cols.length, 3));
  const span = n === 3 ? 2 : 3;
  const baseY = Math.max(V.bodyTop, 2.25);

  // Estimate the tallest column first, then place the block: short content centres in the band
  // instead of hugging the title with 2" of dead space underneath.
  const gapBetween = 0.22;
  const heightOf = (c) => {
    const g = col(0, span);
    let hgt = c.heading ? 0.56 : 0;
    for (const item of c.items || []) {
      const both = typeof item === 'object' ? item : { text: item };
      if (both.lead) hgt += textHeight(both.lead, TYPE.body, g.w, 1.3) + 0.04;
      if (both.text) hgt += textHeight(both.text, TYPE.small, g.w, 1.5) + gapBetween;
    }
    return hgt;
  };
  const tallest = Math.max(...cols.slice(0, n).map(heightOf));
  const bandH = V.bodyBottom - baseY;
  const y = baseY;   // top-aligned: a short 3-column page must still share the deck baseline

  cols.slice(0, n).forEach((c, i) => {
    const g = col(i * span, span);
    let cursor = y;
    if (c.heading) {
      text(s, { name: `Column ${i + 1} heading`, x: g.x, y: cursor, w: g.w, text: c.heading,
        size: TYPE.h3, color: COLOR.navy, bold: true, wrap: false });
        cursor += 0.56;
    }
    for (const item of c.items || []) {
      const both = typeof item === 'object' ? item : { text: item };
      if (both.lead) {
        text(s, { name: 'Item lead', x: g.x, y: cursor, w: g.w, text: wrapCjk(both.lead, TYPE.h3, g.w),
          size: TYPE.body, color: COLOR.navy, bold: true, lineRatio: 1.3 });
        cursor += textHeight(both.lead, TYPE.body, g.w, 1.3) + 0.04;
      }
      const t = both.text;
      if (t) {
        const hh = textHeight(t, TYPE.small, g.w, 1.5);
        text(s, { name: 'Item body', x: g.x, y: cursor, w: g.w, text: wrapCjk(t, TYPE.body, g.w),
          size: TYPE.small, color: COLOR.ink, lineRatio: 1.5 });
        cursor += hh + gapBetween;
      }
    }
  });

  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Bullets', xml: wrapSlide(s) };
}

/* ----------------------------------------------------------------- closing --- */
function closing(spec, ctx) {
  const s = slide('Closing');
  rect(s, { name: 'Closing bg', x: 0, y: 0, w: GRID.right + 1.13, h: 7.5, fill: COLOR.navy });
  text(s, { name: 'Closing title', x: GRID.left, y: 2.9, w: 9.0, text: spec.title ?? '谢谢', size: 60,
    color: COLOR.white, bold: true, wrap: false });
  if (spec.subtitle) {
    text(s, { name: 'Closing subtitle', x: GRID.left, y: 4.05, w: 9.0, text: spec.subtitle,
      size: TYPE.h2, color: COLOR.lime, wrap: false });
  }
  if (spec.meta) {
    text(s, { name: 'Closing meta', x: GRID.left, y: 5.0, w: 9.0, text: spec.meta,
      size: TYPE.small, color: COLOR.tint, lineRatio: 1.5 });
  }
  return { name: 'Closing', xml: wrapSlide(s) };
}

/* --------------------------------------------------------------- statement --- */
/** One sentence, no chrome. The page that forces the author to actually decide what the point is. */
function statement(spec, ctx) {
  const s = slide('Statement');
  const w = 10.4;
  const size = fitSize(spec.text, w, 2.6, [52, 44, 36, 32], 1.25, true);
  const h = textHeight(spec.text, size, w, 1.25);
  const y = 2.05 + Math.max(0, (3.6 - h) / 2);
  if (spec.eyebrow) {
    text(s, { name: 'Eyebrow', x: GRID.left, y: 1.62, w: 8, text: spec.eyebrow, size: TYPE.eyebrow,
      color: COLOR.limeInk, bold: true, spc: 1.6, wrap: false });
  }
  text(s, { name: 'Statement', x: GRID.left, y, w, text: wrapCjk(spec.text, size, w, { bold: true }), size,
    color: COLOR.navy, bold: true, lineRatio: 1.25 });
  if (spec.attribution) {
    text(s, { name: 'Attribution', x: GRID.left, y: y + h + 0.55, w, text: spec.attribution,
      size: TYPE.small, color: COLOR.mid, wrap: false });
  }
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Statement', xml: wrapSlide(s) };
}

/* ------------------------------------------------------------------ matrix --- */
/** 2×2: the quadrant page. Axis labels + quadrant captions + plotted items. */
function matrix(spec, ctx) {
  const s = slide('Matrix');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const x0 = GRID.left + 0.3, y0 = 2.60, side = 3.62;
  const midX = x0 + side / 2, midY = y0 + side / 2;
  rect(s, { name: 'Matrix bg', x: x0, y: y0, w: side, h: side, fill: COLOR.panel });
  rule(s, { name: 'Matrix v', x: midX - 0.006, y: y0, w: 0.012, h: side, fill: COLOR.grid });
  rule(s, { name: 'Matrix h', x: x0, y: midY - 0.006, w: side, h: 0.012, fill: COLOR.grid });

  // axis captions sit outside the plot: X under it, Y above it (a vertical axis has no room
  // for a long label at this slide size, and rotated text is the first thing that breaks in Office)
  text(s, { name: 'Axis X', x: x0, y: y0 + side + 0.12, w: side, text: spec.xLabel ?? '',
    size: TYPE.small, color: COLOR.mid, align: 'c', wrap: false });
  if (spec.yLabel) {
    text(s, { name: 'Axis Y', x: x0, y: y0 - 0.34, w: side, text: spec.yLabel,
      size: TYPE.small, color: COLOR.mid, wrap: false });
  }

  (spec.quadrants || []).slice(0, 4).forEach((q, i) => {
    const right = i % 2 === 1;
    const bottom = i > 1;
    const qx = right ? midX + 0.22 : x0 + 0.22;
    const qy = bottom ? midY + 0.20 : y0 + 0.20;
    text(s, { name: `Quadrant ${i + 1}`, x: qx, y: qy, w: side / 2 - 0.44, text: q,
      size: TYPE.micro, color: COLOR.mid, bold: true, spc: 0.8, wrap: false });
  });

  // items: u/v are 0–1 inside the plot; labels sit to the right of the dot
  (spec.items || []).forEach((it, i) => {
    const px = x0 + it.u * side, py = y0 + (1 - it.v) * side;
    rect(s, { name: `Item dot ${i + 1}`, x: px - 0.075, y: py - 0.075, w: 0.15, h: 0.15,
      fill: it.tone === 'navy' ? COLOR.navy : COLOR.lime });
    // a label near the right edge goes to the LEFT of the dot, otherwise it runs over the next quadrant
    const labelW = Math.min(1.9, side / 2 - 0.24);
    const toLeft = px + 0.14 + labelW > x0 + side - 0.06;
    text(s, { name: `Item label ${i + 1}`, x: toLeft ? px - 0.14 - labelW : px + 0.14, y: py - 0.10,
      w: labelW, text: it.label, size: TYPE.micro, color: COLOR.ink, align: toLeft ? 'r' : 'l', wrap: true });
  });

  (spec.takeaways || []).slice(0, 3).forEach((t, i) => {
    const g = col(3, 3);
    const ty = y0 + i * 1.28;
    text(s, { name: `Takeaway ${i + 1} num`, x: g.x, y: ty, w: 0.5, text: String(i + 1).padStart(2, '0'),
      size: TYPE.micro, color: COLOR.limeInk, bold: true, wrap: false });
    text(s, { name: `Takeaway ${i + 1}`, x: g.x, y: ty + 0.24, w: g.w - 0.3, text: t,
      size: TYPE.small, color: COLOR.ink, lineRatio: 1.45 });
  });

  if (spec.note) {
    text(s, { name: 'Note', x: GRID.left, y: V.footerRule - 0.34, w: col(0, 4).w, text: spec.note,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Matrix', xml: wrapSlide(s) };
}

/* ---------------------------------------------------------------- timeline --- */
function timeline(spec, ctx) {
  const s = slide('Timeline');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const items = (spec.items || []).slice(0, 5);
  const blockH = 1.55;
  const lineY = V.bodyTop + (V.bodyBottom - V.bodyTop - blockH) / 2 + blockH / 2;
  const x0 = GRID.left + 0.2;
  const usable = GRID.width - 0.4;
  const step = items.length > 1 ? usable / (items.length - 1) : 0;

  rule(s, { name: 'Timeline line', x: x0, y: lineY, w: usable, h: 0.014, fill: COLOR.grid });

  items.forEach((it, i) => {
    const cx = x0 + i * step;
    const done = it.tone !== 'pending';
    rect(s, { name: `Node ${i + 1}`, x: cx - 0.085, y: lineY - 0.075, w: 0.17, h: 0.17,
      prst: 'ellipse', fill: done ? COLOR.lime : COLOR.white });
    if (!done) rect(s, { name: `Node ring ${i + 1}`, x: cx - 0.085, y: lineY - 0.075, w: 0.17, h: 0.17,
      prst: 'ellipse', fill: COLOR.grid });
    text(s, { name: `Date ${i + 1}`, x: cx - 0.9, y: lineY - 0.62, w: 1.8, text: it.date ?? '',
      size: TYPE.micro, color: COLOR.mid, align: 'c', wrap: false });
    text(s, { name: `Label ${i + 1}`, x: cx - 0.95, y: lineY + 0.22, w: 1.9, text: it.title ?? '',
      size: TYPE.h3, color: COLOR.navy, bold: true, align: 'c', lineRatio: 1.2 });
    if (it.note) {
      text(s, { name: `Note ${i + 1}`, x: cx - 0.95, y: lineY + 0.22 + textHeight(it.title ?? '', TYPE.h3, 1.9, 1.2) + 0.10,
        w: 1.9, text: it.note, size: TYPE.micro, color: COLOR.mid, align: 'c', lineRatio: 1.4 });
    }
  });

  // optional trend: values map into a band above the axis, drawn as sloped segments + dots
  // null entries mean "no value yet" (a pending quarter): the line stops there
  if (Array.isArray(spec.series) && spec.series.length === items.length && items.length > 1) {
    const vals = spec.series.map((v) => (v === null || v === undefined || v === '' ? null : Number(v)));
    const defined = vals.filter((v) => v !== null);
    const lo = Math.min(...defined);
    const hi = Math.max(...defined);
    const span = hi - lo || 1;
    const bandTop = lineY - 2.55;
    const bandH = 1.35;
    const yOf = (v) => bandTop + (1 - (v - lo) / span) * bandH;
    if (spec.seriesLabel) {
      text(s, { name: 'Trend label', x: x0, y: bandTop - 0.46, w: 6, text: spec.seriesLabel,
        size: TYPE.micro, color: COLOR.mid, wrap: false });
    }
    for (let i = 0; i < items.length - 1; i += 1) {
      if (vals[i] === null || vals[i + 1] === null) continue;
      segment(s, { name: `Trend ${i + 1}`, x1: x0 + i * step, y1: yOf(vals[i]),
        x2: x0 + (i + 1) * step, y2: yOf(vals[i + 1]), fill: COLOR.navy, h: 0.045 });
    }
    vals.forEach((v, i) => {
      if (v === null) return;
      rect(s, { name: `Trend dot ${i + 1}`, x: x0 + i * step - 0.07, y: yOf(v) - 0.07, w: 0.14, h: 0.14,
        prst: 'ellipse', fill: COLOR.navy });
      text(s, { name: `Trend value ${i + 1}`, x: x0 + i * step - 0.6, y: yOf(v) - 0.42, w: 1.2,
        text: String(v), size: TYPE.micro, color: COLOR.navy, bold: true, align: 'c', wrap: false });
    });
  }

  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Timeline', xml: wrapSlide(s) };
}

/* ------------------------------------------------------------------- bars --- */
/** Horizontal comparison. One accent for the series that carries the argument. */
function bars(spec, ctx) {
  const s = slide('Bars');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const rows = (spec.bars || []).slice(0, 6);
  const labelW = 2.5;
  const valueW = 1.0;
  const x0 = GRID.left;
  const trackX = x0 + labelW;
  const trackW = GRID.right - trackX - valueW;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const rowH = Math.min(0.62, 3.4 / Math.max(1, rows.length));
  const top = 2.55;

  rows.forEach((r, i) => {
    const y = top + i * rowH;
    text(s, { name: `Bar label ${i + 1}`, x: x0, y: y + rowH / 2 - 0.14, w: labelW - 0.2, text: r.label,
      size: TYPE.small, color: COLOR.ink, wrap: false });
    rect(s, { name: `Bar track ${i + 1}`, x: trackX, y: y + rowH / 2 - 0.11, w: trackW, h: 0.22,
      fill: COLOR.panel });
    rect(s, { name: `Bar fill ${i + 1}`, x: trackX, y: y + rowH / 2 - 0.11, w: Math.max(0.04, (r.value / max) * trackW), h: 0.22,
      fill: r.tone === 'navy' ? COLOR.navy : COLOR.lime });
    text(s, { name: `Bar value ${i + 1}`, x: GRID.right - valueW + 0.16, y: y + rowH / 2 - 0.15, w: valueW,
      text: r.display ?? String(r.value), size: TYPE.small, color: COLOR.navy, bold: true, wrap: false });
  });

  if (spec.source) {
    text(s, { name: 'Source', x: GRID.left, y: V.footerRule - 0.34, w: col(0, 4).w, text: spec.source,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Bars', xml: wrapSlide(s) };
}

/* ------------------------------------------------------------------ table --- */
/** Drawn table: header band, zebra rows, hairline separators. No a:tbl, no surprises. */
function table(spec, ctx) {
  const s = slide('Table');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const cols = spec.columns || [];
  const rows = (spec.rows || []).slice(0, 9);
  const pad = 0.14;
  const weights = Array.isArray(spec.widths) && spec.widths.length === cols.length
    ? spec.widths
    : cols.map(() => 1 / cols.length);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / totalWeight) * GRID.width);
  const xs = widths.map((_, i) => GRID.left + widths.slice(0, i).reduce((a, b) => a + b, 0));

  const cellOf = (cell) => (cell && typeof cell === 'object' ? cell : { text: cell });
  const isNumeric = (t) => /^[-−+]?[\d.,]+\s*(%|‰|万|亿|千|天|周|月|年|美元|元|GWh|GW|kWh|MW|单|人|次)?$/.test(String(t).trim());
  const alignOf = (cell, j) => {
    if (cell.align) return cell.align === 'right' ? 'r' : cell.align === 'center' ? 'c' : 'l';
    if (spec.align?.[j]) return spec.align[j] === 'right' ? 'r' : spec.align[j] === 'center' ? 'c' : 'l';
    return isNumeric(cell.text) ? 'r' : 'l';
  };

  // --- occupancy map: which cells a rowspan/colspan already covers -----------------------------
  const layout = rows.map(() => ({ spans: [], used: new Set() }));
  rows.forEach((r, i) => {
    let j = 0;
    for (const raw of r) {
      while (layout[i].used.has(j)) j += 1;
      if (j >= widths.length) break;
      const cell = cellOf(raw);
      const colspan = Math.max(1, Math.min(cell.colspan ?? 1, widths.length - j));
      const rowspan = Math.max(1, Math.min(cell.rowspan ?? 1, rows.length - i));
      layout[i].spans.push({ cell, j, colspan, rowspan });
      for (let ri = i; ri < i + rowspan; ri++) {
        if (!layout[ri]) continue;
        for (let cj = j; cj < j + colspan; cj++) layout[ri].used.add(cj);
      }
      j += colspan;
    }
  });

  const headSize = TYPE.micro;
  const cellSize = TYPE.small;
  const lineRatio = 1.35;
  const headH = Math.max(0.42, textHeight(cols.join(''), headSize, widths[0] - pad * 2, 1.2) + 0.26);

  const spanW = (j, colspan) => widths.slice(j, j + colspan).reduce((a, b) => a + b, 0) - pad * 2;
  const need = (cell, j, colspan) => {
    const w = spanW(j, colspan);
    const nowrap = (spec.wrap?.[j] ?? cell.wrap) === 'nowrap';
    return nowrap ? cellSize / 72 + 0.26 : textHeight(String(cell.text ?? ''), cellSize, w, lineRatio) + 0.22;
  };

  const rowHeights = rows.map((r, i) => {
    let hgt = 0.42;
    for (const sp of layout[i].spans) if (sp.rowspan === 1) hgt = Math.max(hgt, need(sp.cell, sp.j, sp.colspan));
    return hgt;
  });
  // a rowspan cell that does not fit the rows it covers stretches the last row it touches
  for (let i = 0; i < rows.length; i++) {
    for (const sp of layout[i].spans) {
      if (sp.rowspan === 1) continue;
      const covered = rowHeights.slice(i, i + sp.rowspan).reduce((a, b) => a + b, 0);
      const want = need(sp.cell, sp.j, sp.colspan);
      if (want > covered) rowHeights[i + sp.rowspan - 1] += want - covered;
    }
  }

  const bodyH = headH + rowHeights.reduce((a, b) => a + b, 0);
  const bandH = V.bodyBottom - V.bodyTop;
  let y = V.bodyTop + Math.max(0, (bandH - bodyH) / 2);
  const yOf = [];
  {
    let cursor = y + headH;   // body rows start under the header band
    for (const h of rowHeights) { yOf.push(cursor); cursor += h; }
  }

  rect(s, { name: 'Table head', x: GRID.left, y, w: GRID.width, h: headH, fill: COLOR.navy });
  cols.forEach((c, j) => {
    text(s, { name: 'Head ' + (j + 1), x: xs[j] + pad, y: y + headH / 2 - headSize / 72 / 2,
      w: widths[j] - pad * 2, text: c, size: headSize, color: COLOR.white, bold: true, wrap: false });
  });
  y += headH;

  // row tints + rules, with each rule split around any cell that spans that boundary
  rows.forEach((r, i) => {
    const h = rowHeights[i];
    if (i % 2 === 1) rect(s, { name: 'Row tint ' + (i + 1), x: GRID.left, y: yOf[i], w: GRID.width, h, fill: 'FAFBFD' });

    const boundary = yOf[i] + h;
    const cuts = [];
    for (let ri = 0; ri < rows.length; ri++) {
      for (const sp of layout[ri].spans) {
        if (sp.rowspan > 1 && ri < i + 1 && i + 1 < ri + sp.rowspan) {
          cuts.push({ from: xs[sp.j], to: xs[sp.j] + widths.slice(sp.j, sp.j + sp.colspan).reduce((a, b) => a + b, 0) });
        }
      }
    }
    cuts.sort((a, b) => a.from - b.from);
    let cursor = GRID.left;
    const right = GRID.left + GRID.width;
    for (const cut of cuts) {
      if (cut.from > cursor) rule(s, { name: 'Row rule ' + (i + 1), x: cursor, y: boundary, w: cut.from - cursor, fill: COLOR.grid });
      cursor = Math.max(cursor, cut.to);
    }
    if (cursor < right) rule(s, { name: 'Row rule ' + (i + 1), x: cursor, y: boundary, w: right - cursor, fill: COLOR.grid });
  });

  // cells
  rows.forEach((r, i) => {
    for (const sp of layout[i].spans) {
      const { cell, j, colspan, rowspan } = sp;
      const h = rowHeights.slice(i, i + rowspan).reduce((a, b) => a + b, 0);
      const w = spanW(j, colspan);
      const nowrap = (spec.wrap?.[j] ?? cell.wrap) === 'nowrap';
      const t = String(cell.text ?? '');
      // the frame covers every row the cell spans and PowerPoint centres the text inside it, so a
      // rowspan label stays centred when the user edits it later
      text(s, { name: 'Cell ' + (i + 1) + '-' + (j + 1), x: xs[j] + pad, y: yOf[i] + 0.02,
        w, h: Math.max(cellSize / 72, h - 0.04), text: t, size: cellSize, lineRatio, align: alignOf(cell, j),
        anchor: cell.rowspan > 1 ? 'ctr' : 't',
        color: j === 0 ? COLOR.navy : COLOR.ink, bold: j === 0 || cell.bold === true, wrap: !nowrap });
    }
  });

  if (spec.source) {
    text(s, { name: 'Source', x: GRID.left, y: V.footerRule - 0.34, w: col(0, 4).w, text: spec.source,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Table', xml: wrapSlide(s) };
}


/* -------------------------------------------------------------------- hero --- */
/**
 * Poster page: one colour field, one sentence, one number. This is the page that makes a deck
 * feel designed rather than assembled — used sparingly (opening, key message, chapter break).
 */
function hero(spec, ctx) {
  const s = slide('Hero');
  rect(s, { name: 'Hero field', x: 0, y: 0, w: GRID.right + 1.13, h: 7.5, fill: spec.field ?? COLOR.navy });
  rect(s, { name: 'Hero accent bar', x: 12.96, y: 0, w: 0.37, h: 7.5, fill: COLOR.lime });

  const onDark = (spec.field ?? COLOR.navy) === COLOR.navy;
  const ink = onDark ? COLOR.white : COLOR.navy;
  if (spec.eyebrow) {
    text(s, { name: 'Hero eyebrow', x: GRID.left, y: 1.25, w: 8, text: spec.eyebrow, size: TYPE.eyebrow,
      color: onDark ? COLOR.lime : COLOR.navy, bold: true, spc: 1.8, wrap: false });
  }
  const size = fitSize(spec.title, 9.7, 2.6, [TYPE.hero, TYPE.poster, 52, 44], 1.12, true);
  const titleH = textHeight(spec.title, size, 9.7, 1.12);
  text(s, { name: 'Hero title', x: GRID.left, y: 1.72, w: 9.7, text: spec.title, size, color: ink, bold: true, lineRatio: 1.12 });
  rule(s, { name: 'Hero rule', x: GRID.left, y: 1.72 + titleH + 0.30, w: 1.2, fill: COLOR.lime });

  if (spec.body) {
    text(s, { name: 'Hero body', x: GRID.left, y: 1.72 + titleH + 0.62, w: 6.6, text: spec.body,
      size: TYPE.body, color: onDark ? COLOR.tint : COLOR.ink, lineRatio: 1.55 });
  }
  if (spec.stat) {
    text(s, { name: 'Hero stat', x: 8.9, y: 5.05, w: 4.0, text: spec.stat, size: TYPE.statLg,
      color: COLOR.lime, bold: true, wrap: false, spc: -1 });
    if (spec.statLabel) {
      text(s, { name: 'Hero stat label', x: 8.9, y: 6.30, w: 3.9, text: spec.statLabel,
        size: TYPE.small, color: onDark ? COLOR.white : COLOR.navy, lineRatio: 1.35 });
    }
  }
  return { name: 'Hero', xml: wrapSlide(s) };
}

/* --------------------------------------------------------------- bigNumber --- */
/** A single number at 140pt: the fastest way to make one fact unforgettable. */
function bigNumber(spec, ctx) {
  const s = slide('Big number');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title, rule: false });

  const numY = 2.30;
  // the ink of a 76pt numeral is ~1.35x its point size: place the unit from the measured height
  const numH = (TYPE.giant / 72) * 1.36;   // glyph ink of a display numeral, not its em box
  text(s, { name: 'Big number', x: GRID.left - 0.06, y: numY, w: 6.4, h: numH, text: spec.value,
    size: TYPE.giant, color: COLOR.navy, bold: true, wrap: false, spc: -4 });
  if (spec.unit) {
    text(s, { name: 'Unit', x: GRID.left + 0.05, y: numY + numH + 0.16, w: 6.4, text: spec.unit, size: TYPE.h2,
      color: COLOR.mid, wrap: true });
  }
  const unitH = spec.unit ? textHeight(spec.unit, TYPE.h2, 6.4, 1.30) : 0;
  const ruleY = numY + numH + (spec.unit ? unitH + 0.34 : 0.24);
  rule(s, { name: 'Number rule', x: GRID.left, y: ruleY, w: GRID.width, fill: COLOR.grid });
  if (spec.label) {
    text(s, { name: 'Number label', x: GRID.left, y: ruleY + 0.18, w: 6.4, text: spec.label,
      size: TYPE.body, color: COLOR.ink, lineRatio: 1.5 });
  }
  (spec.points || []).slice(0, 3).forEach((p, i) => {
    const g = col(4, 2);
    const y = numY + 0.1 + i * 1.15;
    text(s, { name: `Point ${i + 1}`, x: g.x, y, w: g.w, text: p, size: TYPE.small, color: COLOR.ink, lineRatio: 1.5 });
    rule(s, { name: `Point rule ${i + 1}`, x: g.x, y: y + 0.86, w: g.w, fill: COLOR.grid });
  });
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'BigNumber', xml: wrapSlide(s) };
}

/* ------------------------------------------------------------------- bento --- */
/** Mixed-size panels: one dominant tile plus smaller ones. Adds rhythm without adding content. */
function bento(spec, ctx) {
  const s = slide('Bento');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const top = 2.42, gap = 0.22, h = 3.85;
  const c2 = col(0, 2).w;
  const c3 = col(0, 3).w;
  const x0 = GRID.left;

  const tiles = [
    { x: x0, y: top, w: c2, h, fill: COLOR.navy, ink: COLOR.white, accent: COLOR.lime, ...(spec.tiles?.[0] ?? {}) },
    { x: x0 + c2 + gap, y: top, w: c2, h: (h - gap) / 2, fill: COLOR.lime, ink: COLOR.navy, ...(spec.tiles?.[1] ?? {}) },
    { x: x0 + c2 + gap, y: top + (h - gap) / 2 + gap, w: c2, h: (h - gap) / 2, fill: COLOR.panel, ink: COLOR.navy, ...(spec.tiles?.[2] ?? {}) },
    { x: x0 + (c2 + gap) * 2, y: top, w: c2, h, fill: COLOR.panel, ink: COLOR.navy, ...(spec.tiles?.[3] ?? {}) },
  ];

  tiles.forEach((t, i) => {
    if (!t.value) return;
    rect(s, { name: `Tile ${i + 1}`, x: t.x, y: t.y, w: t.w, h: t.h, fill: t.fill });
    if (t.accent) rect(s, { name: `Tile ${i + 1} accent`, x: t.x, y: t.y, w: t.w, h: 0.04, fill: t.accent });
    const big = t.h > 2.5;
    const padX = 0.28;
    const innerW = t.w - padX * 2;
    const labelText = String(t.label ?? '');
    const labelH = textHeight(labelText, TYPE.small, innerW, 1.45);
    const labelY = t.y + t.h - 0.32 - labelH;
    // keep the value on ONE line: measure with the same textHeight() the renderer uses
    const valueText = String(t.value);
    const oneLine = (cand) => textHeight(valueText, cand, innerW, 1.0, true) <= (cand / 72) * 1.05;
    let size = big ? 64 : 44;
    for (const cand of big ? [64, 56, 48, 40, 34, 28] : [44, 38, 32, 28, 24]) {
      size = cand;
      if (oneLine(cand)) break;
    }
    // a CJK line box is ~1.3× the point size (ascent + leading), so the gap must be computed
    // from that, not from size/72 — otherwise the number's ink lands on the label.
    const numY = labelY - (size / 72) * 1.32 - 0.06;
    if (t.kicker) {
      text(s, { name: `Tile ${i + 1} kicker`, x: t.x + padX, y: t.y + 0.30, w: t.w - padX * 2,
        text: t.kicker, size: TYPE.micro, color: t.ink, bold: true, spc: 1.2, wrap: false });
    }
    text(s, { name: `Tile ${i + 1} value`, x: t.x + padX, y: numY, w: t.w - padX * 2,
      text: t.value, size, color: t.ink, bold: true, wrap: false, spc: -1 });
    text(s, { name: `Tile ${i + 1} label`, x: t.x + padX, y: labelY, w: t.w - padX * 2,
      text: labelText, size: TYPE.small, color: t.ink, lineRatio: 1.45 });
  });

  if (spec.source) {
    text(s, { name: 'Source', x: GRID.left, y: V.footerRule - 0.34, w: col(0, 4).w, text: spec.source,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Bento', xml: wrapSlide(s) };
}

/* ------------------------------------------------------------------- quote --- */
function quote(spec, ctx) {
  const s = slide('Quote');
  rect(s, { name: 'Quote field', x: 0, y: 0, w: GRID.right + 1.13, h: 7.5, fill: COLOR.panel });
  text(s, { name: 'Deco quote mark', x: GRID.left - 0.12, y: 0.45, w: 2.4, h: 1.5, text: '“', size: 200,
    color: COLOR.lime, bold: true, wrap: false });

  const size = fitSize(spec.text, 9.8, 2.6, [40, 36, 32, 28], 1.3, true);
  const h = textHeight(spec.text, size, 9.8, 1.3);
  const y = 2.55 + Math.max(0, (2.9 - h) / 2);
  text(s, { name: 'Quote text', x: GRID.left, y, w: 9.8, text: spec.text, size, color: COLOR.navy,
    bold: true, lineRatio: 1.3 });
  rule(s, { name: 'Quote rule', x: GRID.left, y: y + h + 0.38, w: 1.0, fill: COLOR.lime });
  if (spec.attribution) {
    text(s, { name: 'Attribution', x: GRID.left, y: y + h + 0.62, w: 9.8, text: spec.attribution,
      size: TYPE.small, color: COLOR.mid, wrap: false });
  }
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Quote', xml: wrapSlide(s) };
}

/* --------------------------------------------------------------- imageFull --- */
/** Full-bleed photograph + scrim + type. The page that makes a deck look like a magazine. */
function imageFull(spec, ctx) {
  const s = slide('Image full');
  if (ctx.imageRid) {
    picture(s, { name: 'Photo', x: 0, y: 0, w: GRID.right + 1.13, h: 7.5, rId: ctx.imageRid, crop: 'cover', source: ctx.imageFile });
  } else {
    rect(s, { name: 'Photo placeholder', x: 0, y: 0, w: GRID.right + 1.13, h: 7.5, fill: COLOR.navy });
  }
  scrim(s, { name: 'Scrim', x: 0, y: 1.6, w: GRID.right + 1.13, h: 5.9, color: COLOR.navy, from: 0.05, toAlpha: 0.96 });

  if (spec.eyebrow) {
    text(s, { name: 'Eyebrow', x: GRID.left, y: 4.42, w: 8, text: spec.eyebrow, size: TYPE.eyebrow,
      color: COLOR.lime, bold: true, spc: 1.8, wrap: false });
  }
  const size = fitSize(spec.title, 9.8, 1.7, [56, 48, 40, 34], 1.16, true);
  text(s, { name: 'Title', x: GRID.left, y: 4.78, w: 9.8, text: spec.title, size, color: COLOR.white,
    bold: true, lineRatio: 1.16 });
  if (spec.caption) {
    text(s, { name: 'Caption', x: GRID.left, y: 6.95, w: 8.4, text: spec.caption, size: TYPE.micro,
      color: COLOR.tint, wrap: false });
  }
  return { name: 'ImageFull', xml: wrapSlide(s) };
}


/* --------------------------------------------------------------- imageSplit --- */
/** Half-bleed photo, half text. The workhorse for case studies and product pages. */
function imageSplit(spec, ctx) {
  const s = slide('Image split');
  const right = spec.side !== 'left';                 // photo on the right by default
  const half = 6.72;
  const px = right ? GRID.right + 1.13 - half : 0;
  if (ctx.imageRid) {
    picture(s, { name: 'Photo', x: px, y: 0, w: half, h: 7.5, rId: ctx.imageRid, crop: 'cover', source: ctx.imageFile });
  } else {
    rect(s, { name: 'Photo placeholder', x: px, y: 0, w: half, h: 7.5, fill: COLOR.panel });
  }

  const tx = right ? GRID.left : half + 0.55;
  const tw = right ? half - GRID.left - 0.6 : GRID.right - half - 0.55;
  let y = 1.15;

  if (spec.eyebrow) {
    text(s, { name: 'Eyebrow', x: tx, y, w: tw, text: spec.eyebrow, size: TYPE.eyebrow,
      color: COLOR.limeInk, bold: true, spc: 1.6, wrap: false });
    y += 0.42;
  }
  const size = fitSize(spec.title, tw, 2.0, [TYPE.h1, 28, 24], 1.18, true);
  const titleH = textHeight(spec.title, size, tw, 1.18);
  text(s, { name: 'Title', x: tx, y, w: tw, text: spec.title, size, color: COLOR.navy, bold: true, lineRatio: 1.18 });
  y += titleH + 0.26;
  y += 0.30;

  if (spec.body) {
    const bodyH = textHeight(spec.body, TYPE.body, tw, 1.55);
    text(s, { name: 'Body', x: tx, y, w: tw, text: spec.body, size: TYPE.body, color: COLOR.ink, lineRatio: 1.55 });
    y += bodyH + 0.30;
  }

  (spec.points || []).slice(0, 3).forEach((pt, i) => {
    text(s, { name: `Point ${i + 1} num`, x: tx, y, w: 0.42, text: String(i + 1).padStart(2, '0'),
      size: TYPE.micro, color: COLOR.limeInk, bold: true, wrap: false });
    const lh = textHeight(pt, TYPE.small, tw - 0.5, 1.45);
    text(s, { name: `Point ${i + 1}`, x: tx + 0.46, y: y - 0.02, w: tw - 0.46, text: wrapCjk(pt, TYPE.small, tw - 0.46),
      size: TYPE.small, color: COLOR.ink, lineRatio: 1.45 });
    y += Math.max(0.34, lh) + 0.16;
  });

  if (spec.caption) {
    text(s, { name: 'Caption', x: tx, y: V.footerRule - 0.30, w: tw, text: spec.caption,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }
  return { name: 'ImageSplit', xml: wrapSlide(s) };
}

/* ---------------------------------------------------------------- imageCard --- */
/** Two or three cards, each led by a photo. Case studies, references, product line-ups. */
function imageCard(spec, ctx) {
  const s = slide('Image cards');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const items = (spec.cards || []).slice(0, 3);
  const n = Math.max(1, items.length);
  const gap = 0.39;
  const w = (GRID.width - gap * (n - 1)) / n;
  const y = Math.max(V.bodyTop, 2.3);
  const imgH = spec.imageHeight ?? 1.75;
  const cardH = Math.min(V.bodyBottom - y, imgH + 1.55);

  items.forEach((c, i) => {
    const x = GRID.left + i * (w + gap);
    rect(s, { name: `Card bg ${i + 1}`, x, y, w, h: cardH, fill: COLOR.panel });
    const rId = ctx.cardRids?.[i];
    if (rId) picture(s, { name: `Card photo ${i + 1}`, x, y, w, h: imgH, rId, crop: 'cover', source: ctx.cardFiles?.[i] });
    else rect(s, { name: `Card photo placeholder ${i + 1}`, x, y, w, h: imgH, fill: COLOR.grid });
    text(s, { name: `Card title ${i + 1}`, x: x + 0.24, y: y + imgH + 0.22, w: w - 0.48,
      text: c.title ?? '', size: TYPE.h3, color: COLOR.navy, bold: true, lineRatio: 1.2, wrap: false });
    text(s, { name: `Card body ${i + 1}`, x: x + 0.24, y: y + imgH + 0.62, w: w - 0.48,
      text: wrapCjk(c.body ?? '', TYPE.small, w - 0.48), size: TYPE.small, color: COLOR.ink, lineRatio: 1.45 });
  });

  if (spec.source) {
    text(s, { name: 'Source', x: GRID.left, y: V.footerRule - 0.34, w: col(0, 4).w, text: spec.source,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'ImageCard', xml: wrapSlide(s) };
}


/* ------------------------------------------------------------------- chart --- */
/** Native chart + the reading. The chart is editable; the right column says what it means. */
function chart(spec, ctx) {
  const s = slide('Chart');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const chartW = spec.wide ? GRID.width : col(0, 4).w;
  const chartH = Math.min(4.1, V.bodyBottom - V.bodyTop);
  if (ctx.chartRid) {
    s.shapes.push(chartFrame(takeId(s), 'Chart', { x: GRID.left, y: V.bodyTop, w: chartW, h: chartH, rId: ctx.chartRid }));
  } else {
    rect(s, { name: 'Chart placeholder', x: GRID.left, y: V.bodyTop, w: chartW, h: chartH, fill: COLOR.panel });
  }

  if (!spec.wide) {
    const g = col(4, 2);
    (spec.takeaways || []).slice(0, 3).forEach((t, i) => {
      const y = V.bodyTop + 0.1 + i * 1.15;
      text(s, { name: `Takeaway ${i + 1} num`, x: g.x, y, w: 0.5, text: String(i + 1).padStart(2, '0'),
        size: TYPE.micro, color: COLOR.limeInk, bold: true, wrap: false });
      text(s, { name: `Takeaway ${i + 1}`, x: g.x, y: y + 0.24, w: g.w, text: t,
        size: TYPE.small, color: COLOR.ink, lineRatio: 1.45 });
      rule(s, { name: `Takeaway rule ${i + 1}`, x: g.x, y: y + 0.86, w: g.w, fill: COLOR.grid });
    });
  }

  if (spec.source) {
    text(s, { name: 'Source', x: GRID.left, y: V.footerRule - 0.34, w: col(0, 4).w, text: spec.source,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }
  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'Chart', xml: wrapSlide(s) };
}


/* ----------------------------------------------------------------- heroHtml --- */
/**
 * L2 hero page: the decoration is one 2× PNG, every word is a real text box measured from the
 * rendered HTML (hero.mjs). Callers normally hand us `background` + `boxes`; the plugin fills
 * them by rendering a template, so the builder itself stays synchronous.
 */
function heroHtml(spec, ctx) {
  const s = slide('Hero (HTML)');
  if (ctx.imageRid) {
    picture(s, { name: 'Hero background', x: 0, y: 0, w: 13.333, h: 7.5, rId: ctx.imageRid });
  } else {
    rect(s, { name: 'Hero background', x: 0, y: 0, w: 13.333, h: 7.5, fill: spec.field ?? COLOR.navy });

  // hero pages normally arrive with a rendered background and measured boxes; used without that
  // preparation step, fall back to a readable title instead of a bare rectangle
  if (!ctx.imageRid && !(spec.boxes ?? []).length) {
    text(s, { name: 'Hero fallback title', x: GRID.left, y: 2.6, w: GRID.width,
      text: wrapCjk(String(spec.title ?? ''), 44, GRID.width, { bold: true }),
      size: 44, color: COLOR.white, bold: true, lineRatio: 1.2 });
    if (spec.body) {
      text(s, { name: 'Hero fallback body', x: GRID.left, y: 4.6, w: GRID.width,
        text: wrapCjk(String(spec.body), TYPE.h3, GRID.width), size: TYPE.h3, color: COLOR.tint });
    }
    return { name: 'HeroHtml', xml: wrapSlide(s) };
  }
  }

  const PX = 144;   // 1920 px canvas across 13.333 in
  for (const b of spec.boxes ?? []) {
    const size = b.fontSize / 2;                       // 1920 px canvas == 960 pt
    const bold = (b.weight ?? 400) >= 700;
    const spc = Math.round((b.letterSpacing ?? 0) * 50);
    const wrapped = Boolean(b.wrapped);
    const lineRatio = wrapped ? (b.lineHeight / b.fontSize) : 1.22;
    const paras = (b.paragraphs ?? [b.text ?? '']).filter((t) => t !== '');
    const align = b.align === 'right' ? 'r' : b.align === 'center' ? 'c' : 'l';
    // one box per element: layout.text turns \n into real paragraphs, so a <br> stays a line break
    // inside the same frame instead of two frames landing on top of each other
    const gap = (b.paragraphs ?? []).length > paras.length ? 1.2 * size : 0;
    text(s, {
      name: b.name,
      x: b.x / PX, y: b.y / PX,
      w: b.w / PX, h: b.h / PX,
      text: paras.join('\n'), size, color: b.color, bold, spc, lineRatio, align, wrap: wrapped,
      spaceAfter: gap,
    });
  }

  return { name: 'HeroHtml', xml: wrapSlide(s) };
}


/* ---------------------------------------------------------- photoStrip --- */
/** A full-width photo band under the header, with the reading text below it. */
function photoStrip(spec, ctx) {
  const s = slide('Photo strip');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const w = GRID.width;
  // pageHeader already owns the top of the page (eyebrow + title), so the band starts at the body
  // top — adding the title height again would double-count and leave a hole.
  const bandY = V.bodyTop + 0.10;
  const bandH = Math.min(spec.bandHeight ?? 2.2, Math.max(1.4, V.bodyBottom - bandY - 1.05));

  if (ctx.imageRid) {
    picture(s, {
      name: 'Photo band', x: GRID.left, y: bandY, w, h: bandH,
      rId: ctx.imageRid, source: spec.image, crop: 'cover',
    });
  } else {
    rect(s, { name: 'Photo band placeholder', x: GRID.left, y: bandY, w, h: bandH, fill: COLOR.panel });
  }

  if (spec.caption) {
    text(s, { name: 'Caption', x: GRID.left, y: bandY + bandH + 0.10, w, text: spec.caption,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }

  let y = bandY + bandH + (spec.caption ? 0.40 : 0.30);
  const room = V.bodyBottom - y;
  if (spec.body && room > 0.6) {
    const size = fitSize(spec.body, w, Math.min(room, 1.2), [TYPE.h3, 22, 18], 1.5);
    text(s, { name: 'Body', x: GRID.left, y, w, text: spec.body, size, color: COLOR.ink, lineRatio: 1.5 });
    y += textHeight(spec.body, size, w, 1.5) + 0.24;
  }
  const pts = (spec.points ?? []).slice(0, 3);
  if (pts.length && V.bodyBottom - y > 0.4) {
    const gap = 0.34;
    const cw = (w - gap * (pts.length - 1)) / pts.length;
    pts.forEach((pt, i) => {
      text(s, { name: `Point ${i + 1}`, x: GRID.left + i * (cw + gap), y, w: cw, text: pt,
        size: TYPE.small, color: COLOR.ink, lineRatio: 1.45, wrap: true });
    });
  }

  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'PhotoStrip', xml: wrapSlide(s) };
}

/* ---------------------------------------------------------- quotePhoto --- */
/** A large quote next to a round portrait: the page for a real person's words. */
function quotePhoto(spec, ctx) {
  const s = slide('Quote (photo)');
  const d = spec.portraitSize ?? 2.7;
  const px = GRID.left;
  const py = V.bodyTop + 0.55;

  if (ctx.imageRid) {
    picture(s, { name: 'Portrait', x: px, y: py, w: d, h: d, rId: ctx.imageRid, source: spec.image, crop: 'cover', shape: 'ellipse' });
  } else {
    rect(s, { name: 'Portrait placeholder', x: px, y: py, w: d, h: d, fill: COLOR.panel });
  }

  const tx = px + d + 0.70;
  const tw = GRID.right - tx;
  if (spec.eyebrow) {
    text(s, { name: 'Eyebrow', x: tx, y: V.bodyTop + 0.10, w: tw, text: spec.eyebrow,
      size: TYPE.eyebrow, color: COLOR.mid, bold: true, spc: 1.2, wrap: false });
  }
  const quoteY = V.bodyTop + 0.55;
  const quoteSize = fitSize(spec.text, tw, 2.9, [40, 34, 28], 1.38, true);
  text(s, { name: 'Quote', x: tx, y: quoteY, w: tw, text: spec.text, size: quoteSize,
    color: COLOR.navy, lineRatio: 1.38, wrap: true });

  // the signature follows the quote instead of sitting at a fixed inch value
  const quoteH = textHeight(spec.text, quoteSize, tw, 1.38, true);
  const sigY = quoteY + quoteH + 0.45;
  if (spec.attribution) {
    text(s, { name: 'Attribution', x: tx, y: sigY, w: tw, text: spec.attribution,
      size: TYPE.h3, color: COLOR.navy, bold: true, wrap: false });
  }
  if (spec.role) {
    text(s, { name: 'Role', x: tx, y: sigY + 0.34, w: tw, text: spec.role,
      size: TYPE.small, color: COLOR.mid, wrap: false });
  }

  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'QuotePhoto', xml: wrapSlide(s) };
}

/* ------------------------------------------------------------ bentoMix --- */
/**
 * Two numbers in one dark panel on the left, one photo filling the right half.
 * The numbers share a single panel (instead of two tiles) because two stacked tiles at this height
 * cannot hold a 60pt figure plus a two-line label without the boxes colliding.
 */
function bentoMix(spec, ctx) {
  const s = slide('Bento (mixed)');
  pageHeader(s, { eyebrow: spec.eyebrow, title: spec.title });

  const top = V.bodyTop + 0.45;
  const h = V.bodyBottom - top;
  const panelW = col(0, 4).w;
  const rightX = col(4).x;
  const rightW = GRID.right - rightX;

  rect(s, { name: 'Number panel', x: GRID.left, y: top, w: panelW, h, fill: COLOR.navy });

  const tiles = (spec.tiles ?? []).slice(0, 2);
  const inner = h - 0.7;
  const slotH = inner / Math.max(1, tiles.length);
  tiles.forEach((t2, i) => {
    const y = top + 0.35 + i * slotH;
    // label first, number second: at this width the label reads better as a kicker than a caption
    text(s, { name: `Tile ${i + 1} label`, x: GRID.left + 0.4, y, w: panelW - 0.8,
      text: String(t2.label ?? ''), size: TYPE.small, color: COLOR.tint, lineRatio: 1.35, wrap: true });
    const valueSize = fitSize(String(t2.value ?? ''), panelW - 0.8, slotH - 0.55, [56, 48, 40, 34], 1.1);
    text(s, { name: `Tile ${i + 1} value`, x: GRID.left + 0.4, y: y + 0.44, w: panelW - 0.8,
      text: String(t2.value ?? ''), size: valueSize, bold: true, color: COLOR.lime, wrap: false });
    if (i === 0 && tiles.length > 1) {
      rule(s, { name: 'Panel rule', x: GRID.left + 0.4, y: top + 0.35 + slotH - 0.14, w: panelW - 0.8, fill: '1E2A4E' });
    }
  });

  if (ctx.imageRid) {
    picture(s, { name: 'Photo tile', x: rightX, y: top, w: rightW, h, rId: ctx.imageRid, source: spec.image, crop: 'cover' });
  } else {
    rect(s, { name: 'Photo tile placeholder', x: rightX, y: top, w: rightW, h, fill: COLOR.panel });
  }
  if (spec.caption) {
    text(s, { name: 'Caption', x: rightX, y: top + h + 0.08, w: rightW, text: spec.caption,
      size: TYPE.micro, color: COLOR.mid, wrap: false });
  }

  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'BentoMix', xml: wrapSlide(s) };
}


/* ------------------------------------------------------------ portrait --- */
/**
 * One person, one page: a full-bleed portrait on the left, a card on the right.
 * Not a variant of imageSplit — that one is for "a photo and a paragraph", this one carries a
 * person's hierarchy (name / role / credentials / quote) which imageSplit's body area cannot hold.
 */
function portrait(spec, ctx) {
  const s = slide('Portrait');
  const photoW = spec.photoWidth ?? 7.55;

  if (ctx.imageRid) {
    picture(s, { name: 'Portrait', x: 0, y: 0, w: photoW, h: PAGE.h, rId: ctx.imageRid, source: spec.image, crop: 'cover' });
  } else {
    rect(s, { name: 'Portrait placeholder', x: 0, y: 0, w: photoW, h: PAGE.h, fill: COLOR.panel });
  }

  const x = photoW + 0.85;
  const w = GRID.right - x;
  let y = 1.30;

  if (spec.eyebrow) {
    text(s, { name: 'Eyebrow', x, y, w, text: spec.eyebrow, size: TYPE.eyebrow, color: COLOR.mid,
      bold: true, spc: 1.2, wrap: false });
    y += 0.42;
  }

  const nameSize = fitSize(spec.name ?? '', w, 1.3, [46, 40, 34], 1.14, true, true);
  text(s, { name: 'Name', x, y, w, text: spec.name ?? '', size: nameSize, color: COLOR.navy,
    bold: true, lineRatio: 1.14, wrap: true });
  y += textHeight(spec.name ?? '', nameSize, w, 1.14, true) + 0.14;

  if (spec.role) {
    text(s, { name: 'Role', x, y, w, text: spec.role, size: TYPE.h2 - 6, color: COLOR.mid, wrap: true });
    y += textHeight(spec.role, TYPE.h2 - 6, w, 1.3) + 0.24;
  }

  rule(s, { name: 'Hairline', x, y, w: 1.0, fill: COLOR.navy });
  y += 0.42;

  const creds = (spec.credentials ?? []).slice(0, 4);
  creds.forEach((c, i) => {
    text(s, { name: `Credential ${i + 1}`, x, y, w, text: c, size: TYPE.body, color: COLOR.ink,
      lineRatio: 1.55, wrap: true });
    y += textHeight(c, TYPE.body, w, 1.55) + 0.17;
  });

  if (spec.quote) {
    const qy = Math.max(y + 0.24, V.bodyBottom - 1.30);
    text(s, { name: 'Quote', x, y: qy, w, text: spec.quote, size: TYPE.h3 - 2, color: COLOR.navy,
      lineRatio: 1.45, wrap: true });
  }

  // no footer rule here: it would cut across the full-bleed portrait
  return { name: 'Portrait', xml: wrapSlide(s) };
}


/* --------------------------------------------------------------- agendaDrawn --- */
/**
 * The SUEZ template ships a "Summary - 4/8 chapters" slide we clone; the free-style seeds are built
 * from scratch and have no such slide, so this draws the same idea: big chapter numbers on the left
 * column, names on the right, one hairline per row.
 */
function agendaDrawn(spec, ctx) {
  const s = slide('Agenda');
  const chapters = (spec.chapters ?? []).slice(0, 8);
  pageHeader(s, { eyebrow: spec.eyebrow ?? 'CONTENTS', title: spec.title ?? '目录' });

  const twoCol = chapters.length > 4;
  const perCol = twoCol ? Math.ceil(chapters.length / 2) : chapters.length;
  const colW = twoCol ? (GRID.width - 0.6) / 2 : GRID.width;
  const rowH = Math.min(1.05, (V.bodyBottom - V.bodyTop - 0.4) / Math.max(perCol, 1));

  chapters.forEach((ch, i) => {
    const colIndex = twoCol ? Math.floor(i / perCol) : 0;
    const rowIndex = twoCol ? i % perCol : i;
    const x = GRID.left + colIndex * (colW + 0.6);
    const y = V.bodyTop + 0.2 + rowIndex * rowH;
    const label = typeof ch === 'string' ? ch : ch.title ?? '';
    const number = String(i + 1).padStart(2, '0');

    // on a light page the accent has to be the *ink* variant, or 40pt numbers land at 1.8:1
    text(s, { name: 'Agenda number ' + (i + 1), x, y, w: 0.9,
      text: number, size: 40, color: COLOR.limeInk, bold: true, wrap: false });
    text(s, { name: 'Agenda chapter ' + (i + 1), x: x + 1.0, y: y + 0.10, w: colW - 1.05,
      text: wrapCjk(label, TYPE.h2, colW - 1.05), size: TYPE.h2, color: COLOR.navy, bold: true, lineRatio: 1.25 });
    if (typeof ch === 'object' && ch.note) {
      text(s, { name: 'Agenda note ' + (i + 1), x: x + 1.0, y: y + 0.52, w: colW - 1.05,
        text: wrapCjk(ch.note, TYPE.small, colW - 1.05), size: TYPE.small, color: COLOR.mid, lineRatio: 1.4 });
    }
    rule(s, { name: 'Agenda rule ' + (i + 1), x, y: y + rowH - 0.12, w: colW, fill: COLOR.grid });
  });

  pageFooter(s, { title: ctx.footerTitle, page: ctx.page });
  return { name: 'AgendaDrawn', xml: wrapSlide(s) };
}

export const ARCHETYPES = { cover, section, assertion, cards, bullets, closing, statement, matrix, timeline, bars, table,
  hero, bigNumber, bento, quote, imageFull, imageSplit, imageCard, chart, heroHtml,
  photoStrip, quotePhoto, bentoMix, portrait, agenda: agendaDrawn };

/** Compose one page from a spec object: { archetype: 'assertion', ... }. */
export function renderPage(spec, ctx) {
  const fn = ARCHETYPES[spec.archetype];
  if (!fn) throw new Error(`unknown archetype "${spec.archetype}" (have: ${Object.keys(ARCHETYPES).join(', ')})`);
  return fn(spec, ctx);
}
