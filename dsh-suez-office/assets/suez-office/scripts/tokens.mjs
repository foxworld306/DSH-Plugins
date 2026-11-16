/** Wrap a short paragraph into "\n"-joined lines using the kinsoku breaker. */
export function wrapCjk(text, sizePt, widthIn, opts = {}) {
  if (!/[\u3400-\u9fff]/.test(String(text))) return String(text);
  return breakLines(text, sizePt, widthIn, opts).join(String.fromCharCode(10));
}

/**
 * DSH-SUEZ-Office · design tokens.
 *
 * Every number here was measured from the official template
 * (`SUEZ new PPT template_SCN&EN.pptx`), not guessed:
 *   - content band 1.14" → 12.20" (11.06" wide) resolved as a 6-column grid with 0.39" gutters
 *   - 3-column layouts use 2 grid columns (3.43"), 2-column layouts use 3 (5.34")
 *   - titles hang 0.35" left of the body (0.79" vs 1.14")
 *   - page title band 0.39–1.12", lede 1.52", body from 2.40", footer rule 6.93"
 */


import { measureMixedEm } from './metrics.mjs';
export const PAGE = { w: 13.333, h: 7.5 };

export const GRID = {
  left: 1.14,
  right: 12.2,
  cols: 6,
  gutter: 0.39,
  titleHang: 0.79,
};
GRID.width = GRID.right - GRID.left;                       // 11.06
GRID.colWidth = (GRID.width - GRID.gutter * (GRID.cols - 1)) / GRID.cols;  // 1.518

/** Vertical rhythm. Names are roles, not pixels. */
export const V = {
  titleTop: 0.39,
  titleBottom: 1.12,
  rule: 1.30,
  lede: 1.52,
  bodyTop: 2.4,
  bodyBottom: 6.6,
  footerRule: 6.93,
  footerText: 7.02,
  logoY: 6.88,
};

/** Overwrite the colour tokens in place (skins switch the whole palette per build). */
export function applyPalette(palette = {}) {
  const before = { ...COLOR };
  for (const [k, v] of Object.entries(palette)) if (k in COLOR) COLOR[k] = v;
  return before;
}

export const COLOR = {
  navy: '030F40',
  lime: 'AADC14',
  limeInk: '6B7C00',   // lime for TEXT on light: 4.6:1 instead of 1.6:1
  blue: '77B7FC',
  tint: '80B1E0',
  amber: 'FFC229',
  orange: 'F67536',
  panel: 'F2F5FA',
  grid: 'D9E0EA',
  ink: '333F55',
  mid: '5A6B8C',
  muted: '7A87A0',
  white: 'FFFFFF',
};

/**
 * Type scale in POINTS. The template itself only had 13pt body, which reads as ~9pt on A4 —
 * this ramp is the deliberate correction: body 15, never below 12 for anything a viewer must read.
 */
export const TYPE = {
  giant: 140,      // one number owns the page
  hero: 88,        // poster-scale headline on a colour field
  poster: 64,
  statLg: 60,
  stat: 44,
  display: 40,
  h1: 32,
  h2: 22,
  h3: 16,
  body: 15,
  small: 12,
  micro: 10,
  eyebrow: 11,
};

export const FONT = {
  latin: 'Poppins',
  latinBold: 'Poppins ExtraBold',
  latinSemi: 'Poppins SemiBold',
  eaDisplay: '方正粗圆_GBK',
  eaBody: '方正准圆_GBK',
};

/**
 * Font-family aliases: the pptx writes the Chinese brand names, the installed faces report
 * FZ****-M0x. Needed the moment we measure real glyph widths (P1) or verify a render.
 */
export const FONT_ALIAS = {
  方正粗圆_GBK: 'FZCuYuan-M03',
  方正准圆_GBK: 'FZZhunYuan-M02',
  方正细圆: 'FZXiYuan-M01',
};

/** Column x for grid column `i` (0-based); `span` columns are that many columns wide. */
export const col = (i, span = 1) => ({
  x: GRID.left + i * (GRID.colWidth + GRID.gutter),
  w: span * GRID.colWidth + (span - 1) * GRID.gutter,
});

/**
 * Text extent estimate, in line counts.
 *
 * Deliberately conservative (over-estimates rather than under): PowerPoint does not clip a text
 * box, it lets the text spill and cover whatever sits below, so an under-estimate ships as a
 * collision. CJK ≈ 1.0em, Latin letters ≈ 0.52em, digits ≈ 0.56em, space ≈ 0.28em.
 */
const charEm = (ch) => {
  const c = ch.codePointAt(0);
  if (c === 32) return 0.28;
  if (c >= 0x2e80 && c <= 0x9fff) return 1.0;      // CJK
  if (c >= 0xff00 && c <= 0xff60) return 1.0;      // full-width forms
  if (c >= 0x30 && c <= 0x39) return 0.56;         // digits
  if (c >= 0x41 && c <= 0x5a) return 0.62;         // uppercase Latin
  if ('iljtfr.,:;!|\'`'.includes(ch)) return 0.28;
  if ('mwMW'.includes(ch)) return 0.82;
  return 0.52;
};

/**
 * Width in em. Uses the installed font files when they can be read (metrics.mjs) and falls back to
 * the per-character heuristic when they cannot — the fallback is what makes this module usable on
 * a machine where the brand fonts are not installed yet.
 */
/** Characters that may not start a line (closing punctuation, brackets, units). */
export const NO_LINE_START = '\u3001\u3002\uFF0C\uFF0E\uFF1B\uFF1A\uFF1F\uFF01\uFF09\uFF5D\uFF3D\uFF63\u3009\u300B\u300D\u300F\u3011\u2026\u2025\u30FC\u301C\u30FB\uFF05\u2030\u2103,.;:!?)]}>';
/** Characters that may not end a line (opening brackets and quotes). */
export const NO_LINE_END = '\uFF08\u300C\u300E\u3010\u300A\u3008\u201C\u2018([{<';

/**
 * Break a paragraph into lines of at most `widthIn` inches, honouring kinsoku: a line never
 * starts with NO_LINE_START and never ends with NO_LINE_END.
 *
 * PowerPoint breaks CJK wherever the box runs out, which is how a title ends up starting a line
 * with "，" — OOXML has no kinsoku switch, so the break has to be ours and has to be emitted as a
 * real paragraph.
 */
export function breakLines(text, sizePt, widthIn, { bold = false } = {}) {
  const widthPt = widthIn * 72;
  const out = [];
  let line = '';
  const fits = (s) => textWidthEm(s, bold) * sizePt <= widthPt;

  for (const ch of String(text)) {
    if (ch === '\n') { if (line) out.push(line); line = ''; continue; }
    const candidate = line + ch;
    if (line === '' || fits(candidate)) { line = candidate; continue; }

    // a number and the unit that follows it ("9.8 万", "26 天") must not split across lines
    const prevChar = line.slice(-1);
    if (/[0-9.%]/.test(prevChar) && /[\u4e00-\u9fff]/.test(ch)) {
      const m = /([0-9][0-9.,]*%?|[0-9][0-9.,]*)\s*$/.exec(line);
      if (m) { carry = m[0] + ch; line = line.slice(0, m.index); out.push(line); line = carry; continue; }
    }

    let carry = ch;   // by default the character itself moves to the next line
    if (NO_LINE_START.includes(ch)) {
      carry = line.slice(-1) + ch;
      line = line.slice(0, -1);
    } else if (line && NO_LINE_END.includes(line.slice(-1))) {
      carry = line.slice(-1) + ch;
      line = line.slice(0, -1);
    }
    if (line === '') { line = carry; continue; }   // never emit an empty line
    out.push(line);
    line = carry;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}
export function textWidthEm(text, bold = false) {
  const em = measureMixedEm(String(text), {
    latin: bold ? FONT.latinBold : FONT.latin,
    ea: bold ? FONT.eaDisplay : FONT.eaBody,
    aliases: FONT_ALIAS,
  });
  if (em) return em;
  let fallback = 0;
  for (const ch of String(text)) fallback += charEm(ch);
  return fallback;
}

/** How many lines `text` needs at `sizePt` inside `widthIn`, honouring explicit line breaks. */
export function countLines(text, sizePt, widthIn, bold = false) {
  const perLine = (widthIn * 72) / sizePt;          // available em per line
  let lines = 0;
  for (const para of String(text).split(/\r?\n/)) {
    lines += Math.max(1, Math.ceil(textWidthEm(para, bold) / Math.max(0.5, perLine * 0.98)));
  }
  return lines;
}

/** Height in inches that `text` needs at `sizePt` inside `widthIn` (lineRatio = multiple of size). */
export function textHeight(text, sizePt, widthIn, lineRatio = 1.3, bold = false) {
  return (countLines(text, sizePt, widthIn, bold) * sizePt * lineRatio) / 72;
}

/**
 * Greedy line wrap in em units — enough to know how full the LAST line is.
 * A title that ends with "了。" on its own line is the most visible sign of automatic layout.
 */
export function wrapInfo(text, sizePt, widthIn, bold = false) {
  const perLine = ((widthIn * 72) / sizePt) * 0.98;
  const lines = [];
  for (const para of String(text).split(/\r?\n/)) {
    let line = 0;
    let count = 0;
    for (const ch of para) {
      const em = textWidthEm(ch, bold);
      if (line + em > perLine && line > 0) { lines.push(line); line = 0; }
      line += em;
      count += 1;
    }
    lines.push(line);
    void count;
  }
  return { lines: lines.length, lastEm: lines[lines.length - 1] ?? 0 };
}

/**
 * Largest size in `sizes` (descending) that keeps `text` within `heightIn`.
 * With `avoidOrphan`, a size whose last line would hold fewer than ~2 characters is skipped —
 * that is what turns "…跑通 / 了。" into "…跑 / 通了。" or a slightly smaller one-line title.
 */
export function fitSize(text, widthIn, heightIn, sizes, lineRatio = 1.25, avoidOrphan = false, bold = false) {
  for (const size of sizes) {
    if (textHeight(text, size, widthIn, lineRatio, bold) > heightIn) continue;
    if (avoidOrphan) {
      const info = wrapInfo(text, size, widthIn, bold);
      if (info.lines > 1 && info.lastEm < 4.0) continue;   // 4em ~= 4 CJK characters; fewer is an orphan
    }
    return size;
  }
  return sizes[sizes.length - 1];
}
