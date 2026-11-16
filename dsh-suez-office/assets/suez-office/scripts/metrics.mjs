/**
 * DSH-SUEZ-Office · real font metrics.
 *
 * The layout used to estimate text width with per-character heuristics (CJK 1.0em, latin 0.52em).
 * That is close enough to place a box, and wrong enough that a line occasionally overflowed its
 * frame or broke with a single character on the last line. This module reads the actual advance
 * widths out of the installed font files, so line counts and auto-shrink decisions are exact.
 *
 * No dependencies: TrueType/OpenType tables are parsed by hand (cmap 4/12, hmtx, hhea, head, name).
 * The brand fonts live in the per-user font directory on this host, which is why a plain
 * `C:\Windows\Fonts` scan is not enough.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const be16 = (b, o) => b.readUInt16BE(o);
const be32 = (b, o) => b.readUInt32BE(o);
const be16s = (b, o) => b.readInt16BE(o);

/** family / postscript name → file, built once per process. */
let index = null;

function readTables(buf) {
  const numTables = be16(buf, 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = buf.toString('ascii', rec, rec + 4);
    tables[tag] = { offset: be32(buf, rec + 8), length: be32(buf, rec + 12) };
  }
  return tables;
}

function readName(buf, t) {
  if (!t) return {};
  const count = be16(buf, t.offset + 2);
  const strings = t.offset + be16(buf, t.offset + 4);
  const out = {};
  for (let i = 0; i < count; i++) {
    const rec = t.offset + 6 + i * 12;
    const platform = be16(buf, rec);
    const nameId = be16(buf, rec + 6);
    const length = be16(buf, rec + 8);
    const offset = be16(buf, rec + 10);
    if (nameId !== 1 && nameId !== 6) continue;          // 1 = family, 6 = postscript
    if (platform !== 3 && platform !== 0) continue;       // Windows / Unicode
    const raw = buf.subarray(strings + offset, strings + offset + length);
    const text = platform === 3
      ? Buffer.from(raw).swap16().toString('utf16le')
      : raw.toString('latin1');
    if (!out[nameId]) out[nameId] = text;
  }
  return { family: out[1], postscript: out[6] };
}

function readCmap(buf, t) {
  const map = new Map();
  if (!t) return map;
  const count = be16(buf, t.offset + 2);
  const subtables = [];
  for (let i = 0; i < count; i++) {
    const rec = t.offset + 4 + i * 8;
    subtables.push({ platform: be16(buf, rec), encoding: be16(buf, rec + 2), offset: t.offset + be32(buf, rec + 4) });
  }
  // prefer a full Unicode subtable, then BMP
  const pick = subtables.find((s) => s.platform === 3 && s.encoding === 10)
    ?? subtables.find((s) => s.platform === 3 && s.encoding === 1)
    ?? subtables.find((s) => s.platform === 0);

  if (!pick) return map;
  const format = be16(buf, pick.offset);

  if (format === 4) {
    const segX2 = be16(buf, pick.offset + 6);
    const ends = pick.offset + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let s = 0; s < segX2; s += 2) {
      const end = be16(buf, ends + s);
      const start = be16(buf, starts + s);
      const delta = be16s(buf, deltas + s);
      const rangeOffset = be16(buf, ranges + s);
      if (start === 0xffff) continue;
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let glyph;
        if (rangeOffset === 0) {
          glyph = (c + delta) & 0xffff;
        } else {
          const gidAddr = ranges + s + rangeOffset + (c - start) * 2;
          if (gidAddr + 1 >= buf.length) continue;
          glyph = be16(buf, gidAddr);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph) map.set(c, glyph);
      }
    }
    return map;
  }

  if (format === 12) {
    const groups = be32(buf, pick.offset + 12);
    let p = pick.offset + 16;
    for (let g = 0; g < groups; g++, p += 12) {
      const start = be32(buf, p);
      const end = be32(buf, p + 4);
      const glyph = be32(buf, p + 8);
      for (let c = start; c <= end; c++) map.set(c, glyph + (c - start));
    }
  }
  return map;
}

/** Parse one font file into {family, postscript, unitsPerEm, advance(codepoint) in em}. */
export function loadFont(file) {
  const buf = fs.readFileSync(file);
  const tables = readTables(buf);
  const head = tables.head;
  const hhea = tables.hhea;
  const hmtx = tables.hmtx;
  if (!head || !hhea || !hmtx) return null;

  const unitsPerEm = be16(buf, head.offset + 18);
  const numH = be16(buf, hhea.offset + 34);
  const advances = new Array(numH);
  for (let i = 0; i < numH; i++) advances[i] = be16(buf, hmtx.offset + i * 4);

  const cmap = readCmap(buf, tables.cmap);
  const names = readName(buf, tables.name);
  const last = advances[numH - 1] ?? unitsPerEm;

  return {
    file,
    family: names.family,
    postscript: names.postscript,
    unitsPerEm,
    glyphOf: (cp) => cmap.get(cp) ?? 0,
    advanceEm(cp) {
      const g = cmap.get(cp);
      const w = g === undefined ? last : (advances[g] ?? last);
      return w / unitsPerEm;
    },
  };
}

/** Directories that hold fonts on this host: system, then per-user (where the brand fonts live). */
function fontDirs() {
  const dirs = [path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts')];
  const perUser = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts');
  if (perUser) dirs.push(perUser);
  return dirs.filter((d) => fs.existsSync(d));
}

/** Build (once) the family → file index. */
export function buildIndex(force = false) {
  if (index && !force) return index;
  index = new Map();
  for (const dir of fontDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!/\.(ttf|otf|ttc)$/i.test(name)) continue;
      try {
        const font = loadFont(path.join(dir, name));
        if (!font) continue;
        for (const key of [font.family, font.postscript]) {
          if (key && !index.has(key)) index.set(key, font);
        }
      } catch { /* a broken font must not break the layout */ }
    }
  }
  return index;
}

/** Resolve a family name (possibly the Chinese alias) to a parsed font, or null. */
export function fontFor(family, aliases = {}) {
  const idx = buildIndex();
  for (const key of [family, aliases[family]].filter(Boolean)) {
    if (idx.has(key)) return idx.get(key);
    // tolerate case/space differences ("FZCuYuan-M03" vs "fz-cuyuan m03")
    const norm = (s) => s.toLowerCase().replace(/[\s_-]/g, '');
    for (const [k, v] of idx) if (norm(k) === norm(key)) return v;
  }
  return null;
}

/**
 * Width of `text` in points, summed per code point. Returns null when the font is unknown so the
 * caller can fall back to the heuristic.
 */
export function measureWidthPt(text, family, sizePt, aliases = {}) {
  const font = fontFor(family, aliases);
  if (!font) return null;
  let em = 0;
  for (const ch of String(text)) em += font.advanceEm(ch.codePointAt(0));
  return em * sizePt;
}

/** Width in em units (font relative), for line-breaking arithmetic. */
export function measureEm(text, family, aliases = {}) {
  const font = fontFor(family, aliases);
  if (!font) return null;
  let em = 0;
  for (const ch of String(text)) em += font.advanceEm(ch.codePointAt(0));
  return em;
}

if (process.argv[1] && process.argv[1].endsWith('metrics.mjs')) {
  const idx = buildIndex();
  console.log(`fonts indexed: ${idx.size}`);
  for (const probe of ['方正粗圆_GBK', '方正准圆_GBK', 'Poppins', 'Poppins ExtraBold', 'Microsoft YaHei', 'Arial']) {
    const f = fontFor(probe, { 方正粗圆_GBK: 'FZCuYuan-M03', 方正准圆_GBK: 'FZZhunYuan-M02' });
    console.log(`  ${probe.padEnd(20)} ${f ? path.basename(f.file) + '  em=' + f.unitsPerEm : 'NOT FOUND'}`);
  }
  const sample = '把审批链从五环砍到两环，平均交付周期缩短 34%。';
  for (const fam of ['方正粗圆_GBK', 'Poppins']) {
    const pt = measureWidthPt(sample, fam, 24, { 方正粗圆_GBK: 'FZCuYuan-M03' });
    console.log(`  24pt ${fam}: ${pt === null ? 'n/a' : pt.toFixed(1) + ' pt  (' + (pt / 72).toFixed(2) + '" )'}`);
  }
}

/**
 * Width of mixed CJK/Latin text in em: ASCII goes through the Latin face, everything else through
 * the East-Asian face. That is how PowerPoint shapes a run that carries both a:latin and a:ea.
 */
export function measureMixedEm(text, { latin, ea, aliases = {} } = {}) {
  const latinFont = latin ? fontFor(latin, aliases) : null;
  const eaFont = ea ? fontFor(ea, aliases) : null;
  if (!latinFont && !eaFont) return null;
  let em = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const font = cp < 0x2e80 ? (latinFont ?? eaFont) : (eaFont ?? latinFont);
    em += font.advanceEm(cp);
  }
  return em;
}