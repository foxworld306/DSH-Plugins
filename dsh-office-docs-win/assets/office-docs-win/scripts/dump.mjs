/**
 * Dump Office file structure for template replication / pre-edit inspection.
 * Port of scripts/dump_pptx.py (2026-10-30). Output text must stay byte-identical to
 * the Python version, which test/diff_test.ps1 enforces on real files.
 *
 *   node dump.mjs <file.pptx|docx|xlsx|pdf> [slide_num]
 *   pptx: shapes per slide (type, name, position/size in inches, text, fonts, colors)
 *   docx: paragraph/table inventory (+ headers/footers)
 *   xlsx: sheet tab names, row counts, first 40 cells (shared strings, inline strings,
 *         plain and shared formulas resolved)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipDoc } from './ooxml.mjs';

/** Normalize no-break spaces (U+00A0, common in pasted shape names) to plain spaces. */
function clean(s) {
  return s.replace(/\u00a0/g, ' ');
}

/** Python's round() is half-to-even; JS Math.round is not. */
function pyRound(value, digits) {
  const m = 10 ** digits;
  const x = value * m;
  const floor = Math.floor(x);
  const diff = x - floor;
  const rounded = Math.abs(diff - 0.5) < 1e-9 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(x);
  return rounded / m;
}

/** Python's round(x, 2) then str(): shortest round-trip representation. */
function inch(v) {
  return String(pyRound(Number(v) / 914400, 2));
}

/** Python slices by code point; JS slice() counts UTF-16 units. */
function cut(s, n) {
  const points = [...s];
  return points.length <= n ? s : points.slice(0, n).join('');
}

const padEnd = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** (start, end) spans of <tag ...>...</tag> and self-closing <tag .../>, nesting-aware. */
function tagSpans(xml, tag) {
  const spans = [];
  const stack = [];
  const re = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[0].startsWith('</')) {
      if (stack.length) spans.push([stack.pop(), m.index + m[0].length]);
    } else if (m[1] === '/') {
      spans.push([m.index, m.index + m[0].length]);
    } else {
      stack.push(m.index);
    }
  }
  return spans;
}

const inside = (pos, spans) => spans.some(([a, b]) => a <= pos && pos < b);

/* ------------------------------------------------------------------- pptx --- */

export function dumpPptx(file, only = null) {
  const doc = new ZipDoc(file);
  const out = [];
  const names = [...doc.parts.keys()];
  const slides = names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  const pres = doc.part('ppt/presentation.xml');
  const sz = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(pres);
  if (sz) out.push(`slide size: ${inch(sz[1])}x${inch(sz[2])} in`);
  const media = names.filter((n) => n.startsWith('ppt/media/')).sort();
  out.push(`media: ${media.join(', ')}`);

  for (const slide of slides) {
    const num = Number(/\d+/.exec(slide)[0]);
    if (only && num !== only) continue;
    const xml = doc.part(slide);
    out.push(`===== ${slide} =====`);
    // <mc:AlternateContent> carries the same shape twice (Choice + Fallback); the
    // Fallback branch is legacy-only, not real content.
    const fallback = tagSpans(xml, 'mc:Fallback');
    const re = /<p:(sp|pic|cxnSp|graphicFrame)\b.*?<\/p:\1>/gs;
    let m;
    while ((m = re.exec(xml)) !== null) {
      if (inside(m.index, fallback)) continue;
      const blk = m[0];
      const nm = /name="([^"]*)"/.exec(blk);
      const off = /<a:off x="(-?\d+)" y="(-?\d+)"/.exec(blk);
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(blk);
      const pos = off && ext
        ? `${(Number(off[1]) / 914400).toFixed(2)},${(Number(off[2]) / 914400).toFixed(2)} ${(Number(ext[1]) / 914400).toFixed(2)}x${(Number(ext[2]) / 914400).toFixed(2)}`
        : '?';
      const texts = [...blk.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((x) => x[1]);
      const fonts = [...new Set([...blk.matchAll(/typeface="([^"]+)"/g)].map((x) => x[1]))].sort();
      const colors = [...new Set([...blk.matchAll(/srgbClr val="([0-9A-Fa-f]{6})"/g)].map((x) => x[1]))].sort();
      const name = clean(nm ? nm[1] : '?');
      out.push(`  ${padEnd(m[1], 14)} ${padEnd(cut(name, 20), 20)} [${pos}]`);
      if (texts.length) out.push(`    text: ${cut(clean(texts.join(' | ')), 160)}`);
      if (fonts.length) out.push(`    fonts: ${cut(clean(fonts.join(', ')), 120)}`);
      if (colors.length) out.push(`    colors: ${cut(colors.join(', '), 120)}`);
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------- docx --- */

/** Shared paragraph dumper for document.xml / headerN.xml / footerN.xml. */
function dumpPartParas(xml, label, insideTbl = [], limit = 200) {
  const out = [];
  const paras = [...xml.matchAll(/<w:p\b[^>]*>.*?<\/w:p>|<w:p\b[^>]*\/>/gs)].map((m) => [m.index, m[0]]);
  // regex-based paragraph matching truncates a paragraph at the first nested </w:p>
  // (text-box content) — flag those instead of silently mis-splitting.
  const spans = tagSpans(xml, 'w:txbxContent');
  const fallback = tagSpans(xml, 'mc:Fallback');
  let shown = 0;
  for (let i = 0; i < paras.length; i++) {
    const [pos, blk] = paras[i];
    if (inside(pos, fallback)) continue;
    const texts = [...blk.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
    if (!texts.length) continue;
    if (shown >= limit) {
      out.push(`  ... (truncated at ${limit} paragraphs)`);
      break;
    }
    shown++;
    // only <w:rFonts ...> may supply font names — matching w:(ascii|hAnsi|eastAsia)
    // across the paragraph would also catch <w:lang w:eastAsia="zh-CN"/>.
    const fonts = new Set();
    for (const rf of blk.match(/<w:rFonts\b[^>]*>/g) ?? []) {
      for (const m of rf.matchAll(/w:(?:ascii|hAnsi|eastAsia|cs)="([^"]+)"/g)) fonts.add(m[1]);
    }
    const fontList = [...fonts].sort();
    const szs = [...new Set([...blk.matchAll(/<w:sz w:val="(\d+)"/g)].map((m) => m[1]))].sort();
    const tags = [];
    if (inside(pos, insideTbl)) tags.push('tbl');
    if (inside(pos, spans)) tags.push('textbox');
    let extra = '';
    if (fontList.length || szs.length) {
      extra = `  [fonts: ${fontList.join(', ')}${szs.length ? '; sz(half-pt): ' + szs.join(',') : ''}]`;
    }
    const tagStr = tags.length ? `[${tags.join('+')}] ` : '';
    const idx = String(i).padStart(3, '0');
    out.push(`  ${label}${idx}: ${tagStr}${cut(clean(texts.join(' ')), 120)}${extra}`);
  }
  return out;
}

export function dumpDocx(file) {
  const doc = new ZipDoc(file);
  const out = [];
  const xml = doc.part('word/document.xml');
  out.push(`===== word/document.xml (${[...xml].length} chars) =====`);
  const tblSpans = tagSpans(xml, 'w:tbl');
  out.push(`  tables: ${tblSpans.length}`);
  out.push(...dumpPartParas(xml, 'p', tblSpans));
  // headers/footers are where submission templates carry their title and page numbers
  const hf = [...doc.parts.keys()]
    .filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))
    .sort();
  for (const n of hf) {
    const hxml = doc.part(n);
    if (!/<w:t[^>]*>[^<]*[^<\s]/.test(hxml)) continue;
    out.push(`===== ${n} =====`);
    out.push(...dumpPartParas(hxml, 'h', [], 30));
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------- xlsx --- */

export function dumpXlsx(file) {
  const doc = new ZipDoc(file);
  const out = [];
  const names = [...doc.parts.keys()];
  let shared = [];
  if (doc.has('xl/sharedStrings.xml')) {
    const sxml = doc.part('xl/sharedStrings.xml');
    shared = [...sxml.matchAll(/<si>.*?<\/si>/gs)].map((m) =>
      [...m[0].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(''));
  }
  // resolve sheet TAB NAMES (workbook.xml + its rels) — editing a sheet blind to its
  // name is how you format the wrong tab during template replication.
  const rid2target = new Map();
  const sheetNames = new Map();
  if (doc.has('xl/_rels/workbook.xml.rels')) {
    const rxml = doc.part('xl/_rels/workbook.xml.rels');
    for (const m of rxml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      const t = m[2].replace(/^\//, '');
      rid2target.set(m[1], t.startsWith('xl/') ? t : 'xl/' + t);
    }
  }
  if (doc.has('xl/workbook.xml')) {
    const wxml = doc.part('xl/workbook.xml');
    for (const m of wxml.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
      sheetNames.set(rid2target.get(m[2]) ?? '?', m[1]);
    }
  }
  const sheets = names.filter((n) => n.startsWith('xl/worksheets/sheet') && n.endsWith('.xml')).sort();
  for (const n of sheets) {
    const xml = doc.part(n);
    const rows = [...xml.matchAll(/<row[^>]*>/g)];
    const label = sheetNames.has(n) ? `"${clean(sheetNames.get(n))}"` : '(unnamed)';
    out.push(`===== ${n} — sheet ${label}: ${rows.length} rows =====`);
    let shown = 0;
    // parse the full <c>...</c> body so inlineStr (<is><t>) and formula cells survive
    for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      if (shown >= 40) break;
      const ref = m[1];
      const attrs = m[2];
      const body = m[3] ?? '';
      let v = '';
      const mv = /<v>([^<]*)<\/v>/.exec(body);
      if (mv) v = mv[1];
      if (attrs.includes('t="s"') && /^\d+$/.test(v)) {
        const i = Number(v);
        v = i < shared.length ? shared[i] : `${v} (unresolved shared#${v})`;
      } else if (attrs.includes('t="inlineStr"')) {
        v = [...body.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join('');
      }
      const mf = /<f([^>]*)>([^<]*)<\/f>/.exec(body);
      if (mf) {
        // attributes matter: Excel writes <f t="shared" ref="B2:B6" si="0"> for the
        // master cell of a filled-down formula and <f t="array" ref=...> for arrays
        v = `${v} =${mf[2]}`;
      } else {
        const msh = /<f([^>]*)\/>/.exec(body);
        if (msh) {
          const si = /si="(\d+)"/.exec(msh[1]);
          v = `${v} [shared formula si=${si ? si[1] : '?'}]`;
        }
      }
      shown++;
      out.push(`  ${ref}: ${cut(clean(v), 60)}`);
    }
    out.push(`  (first ${Math.min(40, shown)} cells shown)`);
  }
  return out.join('\n');
}

/* --------------------------------------------------------------------- pdf --- */

/**
 * PDF has no zip container, so "dump" here means: verify the header, report the page count and the
 * document-level facts that are readable without a full parser.
 *
 * Page count comes from the page tree (/Type /Pages ... /Count) when it is visible, otherwise from
 * counting /Type /Page objects. Office exports both of these in plain objects; PDFs that keep the
 * page tree inside a compressed object stream can only be counted as "unknown" - we say so instead
 * of inventing a number.
 */
export function dumpPdf(file) {
  const buf = fs.readFileSync(file);
  const head = buf.subarray(0, 1024).toString('latin1');
  if (!head.startsWith('%PDF-')) {
    throw new Error('not a PDF: header is ' + JSON.stringify(head.slice(0, 8)) + ' (a .pdf that opens in Excel is usually an xlsx renamed)');
  }
  const s = buf.toString('latin1');
  const version = (head.match(/%PDF-(\d+\.\d+)/) || [])[1] || '?';
  const out = [];
  out.push('pdf: ' + path.basename(file) + '  version ' + version + '  ' + (buf.length / 1024).toFixed(1) + ' KB');
  if (/\/Encrypt\b/.test(s)) {
    out.push('  encrypted: yes - page count and metadata are not readable without the password');
    return out.join('\n');
  }
  out.push('  linearized: ' + (/\/Linearized\b/.test(s) ? 'yes' : 'no'));

  const objectStreams = (s.match(/\/Type\s*\/ObjStm\b/g) || []).length;
  const pageObjects = (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  const treeCounts = [...s.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,400}?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const rootCount = treeCounts.length ? Math.max(...treeCounts) : 0;
  if (rootCount > 0) {
    out.push('  pages: ' + rootCount + ' (page tree /Count)');
  } else if (pageObjects > 0) {
    out.push('  pages: ' + pageObjects + ' (counted /Type /Page objects)');
  } else {
    out.push('  pages: unknown - page tree sits in ' + objectStreams + ' compressed object stream(s); open it in a viewer to count');
  }

  // PDF strings are either literal "(...)" or hex "<...>"; Word writes UTF-16BE with a BOM, other
  // producers use UTF-16LE or plain ASCII. Decode all three instead of showing raw bytes.
  const decode = (raw) => {
    if (raw.length > 1 && raw[0] === 0xfe && raw[1] === 0xff) return Buffer.from(raw.subarray(2)).swap16().toString('utf16le');
    if (raw.length > 1 && raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
    if (raw.includes(0)) return Buffer.from(raw.subarray(0, raw.length - (raw.length % 2))).swap16().toString('utf16le');
    return raw.toString('latin1');
  };
  const info = (key) => {
    const lit = s.match(new RegExp('/' + key + '\\s*\\(((?:\\\\.|[^()\\\\])*)\\)'));
    if (lit) {
      const bytes = [];
      const v = lit[1];
      for (let i = 0; i < v.length; i++) {
        if (v[i] === '\\') {
          const oct = v.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
          if (oct) { bytes.push(parseInt(oct[0], 8)); i += oct[0].length; }
          else { const n = v[i + 1]; bytes.push(n === 'n' ? 10 : n === 'r' ? 13 : n === 't' ? 9 : n.charCodeAt(0)); i++; }
        } else bytes.push(v.charCodeAt(i) & 0xff);
      }
      return decode(Buffer.from(bytes));
    }
    const hex = s.match(new RegExp('/' + key + '\\s*<([0-9A-Fa-f\\s]{4,400})>'));
    if (hex) return decode(Buffer.from(hex[1].replace(/\\s+/g, ''), 'hex'));
    return null;
  };  for (const key of ['Title', 'Author', 'Producer', 'Creator']) {
    const v = info(key);
    if (v) out.push('  ' + key.toLowerCase() + ': ' + clean(v.trim()));
  }
  const fonts = (s.match(/\/Type\s*\/Font\b/g) || []).length;
  const images = (s.match(/\/Subtype\s*\/Image\b/g) || []).length;
  out.push('  fonts: ' + fonts + '   images: ' + images + '   object streams: ' + objectStreams);
  return out.join('\n');
}
/* -------------------------------------------------------------------- CLI --- */

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const [file, slide] = process.argv.slice(2);
  if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    console.error('is a directory, not a file: ' + file);
    process.exitCode = 1;
  } else if (!file) {
    console.error('usage: node dump.mjs <file.pptx|docx|xlsx|pdf> [slide_num]');
    process.exitCode = 1;
  } else {
    const ext = file.toLowerCase().split('.').pop();
    try {
      const only = slide ? Number(slide) : null;
      const text = ext === 'pptx' ? dumpPptx(file, only)
        : ext === 'docx' ? dumpDocx(file)
        : ext === 'xlsx' ? dumpXlsx(file)
        : ext === 'pdf' ? dumpPdf(file)
        : null;
      if (text === null) {
        console.error('unsupported: ' + ext);
        process.exitCode = 1;
      } else {
        process.stdout.write(text + '\n');
      }
    } catch (err) {
      console.error('ERROR  ' + err.message);
      process.exitCode = 1;
    }
  }
}
