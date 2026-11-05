/**
 * Minimal OOXML zip document helper for Node (zero dependencies).
 *
 * Port of scripts/ooxml.py v2026-10-30 (Python stdlib) — behaviour must stay identical:
 *   - save() preserves each part's original compression type (STORED stays STORED) and
 *     entry order; parts added via setPart() are appended DEFLATED.
 *   - checkPackageIntegrity() catches the Content_Types failure modes that make
 *     PowerPoint refuse a package outright (duplicate Default -> 0x80CB8000, duplicate
 *     Override -> 0x80CB8001, part with no coverage -> 0x80CB8002) plus malformed XML in
 *     any .xml/.rels part.
 *   - duplicateParaIds() finds per-part w14:paraId collisions inside word/*.xml.
 *
 * CLI:
 *   node ooxml.mjs check  <file> [--no-xml]     integrity problems (exit 1 if any)
 *   node ooxml.mjs paraid <file.docx>           paraId collisions
 *   node ooxml.mjs parts  <file>                part list with sizes
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ zip layer */

const SIG_LFH = 0x04034b50;
const SIG_CDH = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
const UTF8_FLAG = 0x0800;

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

class ZipDoc {
  /** @param {string} file */
  /**
   * An empty package: build a docx/xlsx/pptx from nothing instead of editing a seed.
   * `save()` only needs `infos` (compression hints per part) and `parts`.
   */
  static blank() {
    const doc = Object.create(ZipDoc.prototype);
    doc.path = null;
    doc.infos = [];
    doc.parts = new Map();
    return doc;
  }
  constructor(file) {
    this.path = file;
    const buf = fs.readFileSync(file);
    const eocd = findEocd(buf);
    if (eocd < 0) throw new Error(`${file} is not a zip package (no end-of-central-directory record)`);
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    /** @type {Array<{name:string,method:number,crc:number,csize:number,usize:number,time:number,date:number}>} */
    this.infos = [];
    /** @type {Map<string, Buffer>} */
    this.parts = new Map();
    for (let i = 0; i < count; i++) {
      if (buf.readUInt32LE(p) !== SIG_CDH) throw new Error(`corrupt central directory at byte ${p} in ${file}`);
      const method = buf.readUInt16LE(p + 10);
      const time = buf.readUInt16LE(p + 12);
      const date = buf.readUInt16LE(p + 14);
      const crc = buf.readUInt32LE(p + 16);
      const csize = buf.readUInt32LE(p + 20);
      const usize = buf.readUInt32LE(p + 24);
      const nlen = buf.readUInt16LE(p + 28);
      const elen = buf.readUInt16LE(p + 30);
      const clen = buf.readUInt16LE(p + 32);
      const lho = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nlen);
      if (buf.readUInt32LE(lho) !== SIG_LFH) throw new Error(`corrupt local header for ${name} in ${file}`);
      const lnlen = buf.readUInt16LE(lho + 26);
      const lelen = buf.readUInt16LE(lho + 28);
      const start = lho + 30 + lnlen + lelen;
      const raw = buf.subarray(start, start + csize);
      let data;
      if (method === STORED) data = Buffer.from(raw);
      else if (method === DEFLATED) data = zlib.inflateRawSync(raw);
      else throw new Error(`unsupported compression method ${method} for ${name} in ${file}`);
      if (data.length !== usize) throw new Error(`size mismatch for ${name} in ${file}`);
      this.infos.push({ name, method, crc, csize, usize, time, date });
      this.parts.set(name, data);
      p += 46 + nlen + elen + clen;
    }
  }

  close() {
    /* parts are in memory; kept for API symmetry with the Python version */
  }

  /** @returns {string} utf-8 decoded part */
  part(name) {
    const data = this.parts.get(name);
    if (!data) throw new Error(`no such part: ${name}`);
    return data.toString('utf8');
  }

  has(name) {
    return this.parts.has(name);
  }

  /** @param {string|Buffer} value */
  setPart(name, value) {
    this.parts.set(name, Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
  }

  /** Highest p:cNvPr id in the given part, else across all parts, else 100. */
  maxCnvprId(partName = 'ppt/slides/slide1.xml') {
    const collect = (buf) => {
      const out = [];
      const re = /<(?:p|w|a):cNvPr id="(\d+)"/g;
      const text = buf.toString('latin1'); // byte-accurate, ids are ASCII
      let m;
      while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
      return out;
    };
    let ids = collect(this.parts.get(partName) ?? Buffer.alloc(0));
    if (ids.length === 0) {
      for (const buf of this.parts.values()) ids = ids.concat(collect(buf));
    }
    return ids.length ? Math.max(...ids) : 100;
  }

  /**
   * Write via .tmp + replace. Original parts keep their compress method and order;
   * parts that were not in the source are appended DEFLATED.
   */
  save(dst) {
    const known = new Map(this.infos.map((i) => [i.name, i]));
    const parent = path.dirname(path.resolve(dst));
    if (parent && !fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    const tmp = dst + '.tmp';
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const [name, data] of this.parts) {
      const info = known.get(name);
      const method = info ? info.method : DEFLATED;
      const { time, date } = info ?? dosDateTime(new Date());
      const crc = zlib.crc32(data);
      const body = method === STORED ? data : zlib.deflateRawSync(data, { level: 6 });
      const nameBuf = Buffer.from(name, 'utf8');
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(SIG_LFH, 0);
      lfh.writeUInt16LE(20, 4); // version needed
      lfh.writeUInt16LE(UTF8_FLAG, 6);
      lfh.writeUInt16LE(method, 8);
      lfh.writeUInt16LE(time, 10);
      lfh.writeUInt16LE(date, 12);
      lfh.writeUInt32LE(crc, 14);
      lfh.writeUInt32LE(body.length, 18);
      lfh.writeUInt32LE(data.length, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      lfh.writeUInt16LE(0, 28);
      chunks.push(lfh, nameBuf, body);
      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(SIG_CDH, 0);
      cdh.writeUInt16LE(20, 4); // version made by
      cdh.writeUInt16LE(20, 6); // version needed
      cdh.writeUInt16LE(UTF8_FLAG, 8);
      cdh.writeUInt16LE(method, 10);
      cdh.writeUInt16LE(time, 12);
      cdh.writeUInt16LE(date, 14);
      cdh.writeUInt32LE(crc, 16);
      cdh.writeUInt32LE(body.length, 20);
      cdh.writeUInt32LE(data.length, 24);
      cdh.writeUInt16LE(nameBuf.length, 28);
      cdh.writeUInt16LE(0, 30); // extra
      cdh.writeUInt16LE(0, 32); // comment
      cdh.writeUInt16LE(0, 34); // disk
      cdh.writeUInt16LE(0, 36); // internal attrs
      cdh.writeUInt32LE(0, 38); // external attrs
      cdh.writeUInt32LE(offset, 42);
      central.push(cdh, nameBuf);
      offset += 30 + nameBuf.length + body.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.parts.size, 8);
    eocd.writeUInt16LE(this.parts.size, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    fs.writeFileSync(tmp, Buffer.concat([...chunks, cdBuf, eocd]));
    fs.renameSync(tmp, dst); // NTFS rename replaces an existing file
  }
}

/* ------------------------------------------------------- XML well-formedness */

const ENTITY = /^&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/;

/**
 * Strict-enough well-formedness scan (the role xml.etree.ElementTree plays in the
 * Python version). Returns null when fine, else an ElementTree-style message.
 * @param {string} text
 * @returns {string|null}
 */
function xmlError(text) {
  // ElementTree reports "line N, column M" where M is the 0-based index (within the
  // line) of the token that failed; the column is cosmetic, the line is not.
  const at = (idx) => {
    let line = 1;
    let last = -1;
    for (let i = text.indexOf('\n'); i !== -1 && i < idx; i = text.indexOf('\n', i + 1)) {
      line++;
      last = i;
    }
    return `line ${line}, column ${idx - last}`;
  };
  const NAME = /[A-Za-z_:][-\w.:]*/y;
  const readName = (from) => {
    NAME.lastIndex = from;
    const m = NAME.exec(text);
    return m ? m[0] : '';
  };

  const stack = [];          // open element names
  const nsStack = [];        // parallel: Map of xmlns declarations, or null
  const prefixBound = (prefix) => {
    if (prefix === 'xml') return true;                       // built-in
    for (let k = nsStack.length - 1; k >= 0; k--) {
      const frame = nsStack[k];
      if (frame && frame.has(prefix)) return true;
    }
    return false;
  };
  let rootSeen = false;
  let i = 0;

  const textBetween = (from, to) => {
    const chunk = text.slice(from, to);
    if (chunk.trim() === '') return null;
    if (!rootSeen) return `not well-formed (invalid token): ${at(from)}`;
    if (stack.length === 0) return `junk after document element: ${at(from)}`;
    for (const amp of chunk.matchAll(/&[^;\s<]*;?/g)) {
      if (!ENTITY.test(amp[0])) return `not well-formed (invalid token): ${at(from + amp.index)}`;
    }
    return null;
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      const err = textBetween(i, text.length);
      if (err) return err;
      break;
    }
    const err = textBetween(i, lt);
    if (err) return err;

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) return `unclosed comment: ${at(lt)}`;
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) return `unclosed CDATA section: ${at(lt)}`;
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) return `unclosed processing instruction: ${at(lt)}`;
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end === -1) return `unclosed declaration: ${at(lt)}`;
      i = end + 1;
      continue;
    }

    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end === -1) return `unclosed end tag: ${at(lt)}`;
      const name = text.slice(lt + 2, end).trim();
      if (!/^[A-Za-z_:][-\w.:]*$/.test(name)) return `not well-formed (invalid token): ${at(lt)}`;
      const open = stack.pop();
      nsStack.pop();
      if (open === undefined || open !== name) return `mismatched tag: ${at(lt)}`;
      i = end + 1;
      continue;
    }

    /* start tag */
    let j = lt + 1;
    const name = readName(j);
    if (!name) return `not well-formed (invalid token): ${at(lt)}`;
    j += name.length;
    if (stack.length === 0) {
      if (rootSeen) return `junk after document element: ${at(lt)}`;
      rootSeen = true;
    }
    const attrs = new Set();
    const decls = new Map();
    const attrPrefixes = [];
    let selfClose = false;
    let closed = false;
    while (j < text.length) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j >= text.length) break;
      if (text[j] === '>') { closed = true; j++; break; }
      if (text[j] === '/' && text[j + 1] === '>') { selfClose = true; closed = true; j += 2; break; }
      const attr = readName(j);
      if (!attr) return `not well-formed (invalid token): ${at(j)}`;
      if (attrs.has(attr)) return `duplicate attribute: ${at(j)}`;
      attrs.add(attr);
      j += attr.length;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '=') return `not well-formed (invalid token): ${at(j)}`;
      j++;
      while (j < text.length && /\s/.test(text[j])) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") return `not well-formed (invalid token): ${at(j)}`;
      const closeQuote = text.indexOf(quote, j + 1);
      if (closeQuote === -1) return `unclosed token: ${at(j)}`;
      const value = text.slice(j + 1, closeQuote);
      j = closeQuote + 1;
      if (attr === 'xmlns') decls.set('', value);
      else if (attr.startsWith('xmlns:')) decls.set(attr.slice(6), value);
      else if (attr.includes(':')) attrPrefixes.push(attr.slice(0, attr.indexOf(':')));
    }
    if (!closed) return `unclosed token: ${at(lt)}`;

    if (selfClose) {
      if (decls.size) nsStack.push(decls);        // visible only to this element's own prefixes
    } else {
      stack.push(name);
      nsStack.push(decls.size ? decls : null);    // visible to this element and its children
    }
    const colon = name.indexOf(':');
    if (colon > 0 && !prefixBound(name.slice(0, colon))) return `unbound prefix: ${at(lt)}`;
    for (const prefix of attrPrefixes) {
      if (!prefixBound(prefix)) return `unbound prefix: ${at(lt)}`;
    }
    if (selfClose && decls.size) nsStack.pop();
    i = j;
  }
  if (stack.length) return `unclosed token: ${at(text.length - 1)}`;
  if (!rootSeen) return 'no element found';
  return null;
}

/* ------------------------------------------------------------- package rules */

/** Non-overlapping <p:sp> block matcher for a given cNvPr name (may match duplicates). */
function shapeBlockRegex(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<p:sp>(?:(?!</p:sp>).)*?name="${escaped}"(?:(?!</p:sp>).)*?</p:sp>`, 's');
}

/**
 * @param {Map<string,Buffer>|Record<string,Buffer|string>} parts
 * @param {{checkXml?: boolean}} [opts]
 * @returns {string[]} problems, empty = clean
 */
function checkPackageIntegrity(parts, opts = {}) {
  const checkXml = opts.checkXml !== false;
  const map = parts instanceof Map ? parts : new Map(Object.entries(parts));
  const ctRaw = map.get('[Content_Types].xml');
  if (ctRaw === undefined) throw new Error('package has no [Content_Types].xml part - not a valid OOXML package');
  const ct = Buffer.isBuffer(ctRaw) ? ctRaw.toString('utf8') : String(ctRaw);
  const problems = [];

  const exts = [...ct.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  for (const e of exts) {
    if (seen.has(e.toLowerCase())) problems.push(`duplicate <Default Extension="${e}"> -> PowerPoint 0x80CB8000`);
    seen.add(e.toLowerCase());
  }
  const defaults = new Set(exts.map((e) => e.toLowerCase()));

  const ovList = [...ct.matchAll(/<Override PartName="(\/[^"]+)"/g)].map((m) => m[1]);
  const seenOv = new Set();
  for (const p of ovList) {
    if (seenOv.has(p.toLowerCase())) problems.push(`duplicate <Override PartName="${p}"> -> PowerPoint 0x80CB8001`);
    seenOv.add(p.toLowerCase());
  }
  const overrides = new Set(ovList.map((p) => p.toLowerCase()));

  for (const name of map.keys()) {
    if (name === '[Content_Types].xml' || name.endsWith('/')) continue;
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (ext && defaults.has(ext)) continue;
    if (overrides.has(('/' + name).toLowerCase())) continue;
    problems.push(`part ${name} has no Default/Override content type -> PowerPoint 0x80CB8002`);
  }

  if (checkXml) {
    for (const [name, value] of map) {
      const low = name.toLowerCase();
      if (name.endsWith('/') || !(low.endsWith('.xml') || low.endsWith('.rels'))) continue;
      const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      const err = xmlError(text);
      if (err) problems.push(`malformed XML in ${name} (mismatched/unclosed tags): ${err}`);
    }
  }
  // structure runs independently: checkXml:false only silences the XML parser
  if (opts.checkStructure !== false) {
    problems.push(...checkStructure(map).filter((p) => !isDuplicateProblem(problems, p)));
  }
  return problems;
}

/** Skip a structural complaint when the same part already failed XML parsing (one error is enough). */
function isDuplicateProblem(existing, candidate) {
  const part = candidate.split(':')[0].trim();
  if (!part || !existing.length) return false;
  return existing.some((p) => p.includes(part) && /malformed XML/.test(p));
}

/* ------------------------------------------------------- structure checks ---- */

const toText = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
const posixDir = (name) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '');

/** Resolve a relationship Target against the source part's directory (.. and / supported). */
function resolveTarget(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const segs = base ? base.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segs.pop();
    else segs.push(seg);
  }
  return segs.join('/');
}

/** Every internal relationship must point at a part that exists. */
function checkRelationships(map) {
  const problems = [];
  for (const [name, value] of map) {
    if (!name.endsWith('.rels')) continue;
    const dir = posixDir(name);
    const base = dir === '_rels' ? '' : dir.replace(/\/_rels$/, '');
    for (const m of toText(value).matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      if (/TargetMode\s*=\s*"External"/i.test(tag)) continue;
      const id = (tag.match(/\bId="([^"]*)"/) || [])[1];
      const target = (tag.match(/\bTarget="([^"]*)"/) || [])[1];
      if (target === undefined) {
        problems.push(`${name}: relationship${id ? ' Id="' + id + '"' : ''} has no Target attribute`);
        continue;
      }
      const resolved = resolveTarget(base, target);
      if (!map.has(resolved)) {
        problems.push(`missing relationship target: ${name}${id ? ' Id="' + id + '"' : ''} -> "${target}" (no part ${resolved})`);
      }
    }
  }
  return problems;
}

/** Every r:id / r:embed reference in a part must exist in that part's .rels. */
function checkRidReferences(map) {
  const problems = [];
  for (const [name, value] of map) {
    if (name.endsWith('.rels') || name === '[Content_Types].xml' || !name.endsWith('.xml')) continue;
    const text = toText(value);
    const refs = [...new Set([...text.matchAll(/\br:(?:id|embed|link|pict)="([^"]+)"/g)].map((m) => m[1]))];
    if (!refs.length) continue;
    const dir = posixDir(name);
    const relsName = (dir ? dir + '/' : '') + '_rels/' + name.slice(name.lastIndexOf('/') + 1) + '.rels';
    const rels = map.has(relsName) ? toText(map.get(relsName)) : '';
    const ids = new Set([...rels.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]));
    const missing = refs.filter((r) => !ids.has(r));
    if (missing.length) {
      const list = missing.map((r) => 'r:id="' + r + '"').join(', ');
      problems.push(`${name}: ${list} not declared in ${relsName || '(no .rels part)'}`);
    }
  }
  return problems;
}

/**
 * Format-specific structure that is well-formed XML but still makes the app refuse the file.
 * This is the check that plain XML validation cannot give you: `<p:sp/>` parses fine and
 * PowerPoint still answers "could not open the file".
 */
function checkShapeStructure(map) {
  const problems = [];
  for (const [name, value] of map) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const text = toText(value);
    if (!/<p:sld[\s>]/.test(text)) problems.push(`${name}: root element is not <p:sld>`);
    if (!text.includes('<p:spTree>')) problems.push(`${name}: no <p:spTree> container`);

    for (const m of text.matchAll(/<p:(sp|pic|grpSp|graphicFrame|cxnSp)\/>/g)) {
      problems.push(`${name}: empty <p:${m[1]}/> in spTree - PowerPoint refuses such a package`);
    }

    const ids = new Map();
    for (const m of text.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g)) {
      ids.set(m[1], (ids.get(m[1]) || 0) + 1);
    }
    for (const [id, count] of ids) {
      if (count > 1) problems.push(`${name}: duplicate shape id ${id} (${count}x) - PowerPoint repairs or refuses the deck`);
    }

    const required = { 'p:sp': ['p:nvSpPr', 'p:spPr'], 'p:pic': ['p:nvPicPr', 'p:blipFill', 'p:spPr'], 'p:graphicFrame': ['p:nvGraphicFramePr', 'p:xfrm'] };
    for (const [tag, children] of Object.entries(required)) {
      const open = [...text.matchAll(new RegExp('<' + tag + '(?=[\\s>])', 'g'))];
      for (const hit of open) {
        const start = hit.index;
        const close = text.indexOf('</' + tag + '>', start);
        if (close === -1) {
          problems.push(`${name}: <${tag}> is never closed`);
          continue;
        }
        const block = text.slice(start, close);
        for (const child of children) {
          if (!block.includes('<' + child)) {
            problems.push(`${name}: <${tag}> without <${child}> - invalid shape, PowerPoint cannot open it`);
          }
        }
      }
    }
  }
  return problems;
}

/** Word/Excel have their own "parses fine but is broken" cases. */
function checkOfficeStructure(map) {
  const problems = [];
  const doc = map.get('word/document.xml');
  if (doc !== undefined) {
    const text = toText(doc);
    if (!/^<\?xml[\s\S]*?<w:document[\s>]/.test(text.trim())) problems.push('word/document.xml: root element is not <w:document>');
    if (!text.includes('<w:body>')) problems.push('word/document.xml: no <w:body>');
    for (const m of text.matchAll(/<w:tbl(?=[\s>])/g)) {
      const close = text.indexOf('</w:tbl>', m.index);
      const block = close === -1 ? text.slice(m.index) : text.slice(m.index, close);
      if (!block.includes('<w:tblGrid')) problems.push('word/document.xml: <w:tbl> without <w:tblGrid> - Word reports the table as corrupt');
    }
  }
  for (const [name, value] of map) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const text = toText(value);
    if (!text.includes('<sheetData')) problems.push(`${name}: no <sheetData> - Excel cannot open the sheet`);
    if (!/^<\?xml[\s\S]*?<worksheet[\s>]/.test(text.trim())) problems.push(`${name}: root element is not <worksheet>`);
  }
  return problems;
}

/** Run every structural check; returns problems (empty = OK). */
function checkStructure(parts) {
  const map = parts instanceof Map ? parts : new Map(Object.entries(parts));
  return [...checkRelationships(map), ...checkRidReferences(map), ...checkShapeStructure(map), ...checkOfficeStructure(map)];
}
/**
 * docx only: {'part': {paraId: count}} for w14:paraId collisions INSIDE one part.
 * Word repeats paraIds inside <mc:AlternateContent> (Choice + Fallback hold the same
 * paragraph), which is legal, so that branch is stripped before counting.
 */function duplicateParaIds(parts) {
  const map = parts instanceof Map ? parts : new Map(Object.entries(parts));
  const out = {};
  for (const [name, value] of map) {
    if (!(name.startsWith('word/') && name.endsWith('.xml'))) continue;
    let text = Buffer.isBuffer(value) ? value.toString('latin1') : String(value);
    text = text.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
    const counts = new Map();
    for (const m of text.matchAll(/w14:paraId="([0-9A-Fa-f]{8})"/g)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
    const dupes = {};
    for (const [k, v] of counts) if (v > 1) dupes[k] = v;
    if (Object.keys(dupes).length) out[name] = dupes;
  }
  return out;
}

/* ------------------------------------------------------------------- CLI ---- */

function usage() {
  console.log('usage:');
  console.log('  node ooxml.mjs check  <file.pptx|docx|xlsx> [--no-xml]');
  console.log('  node ooxml.mjs paraid <file.docx>');
  console.log('  node ooxml.mjs parts  <file>');
  process.exitCode = 2;
}

const [, , cmd, file, ...rest] = process.argv;
const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isEntry) { /* imported as a module: no CLI */ }
else if (!cmd || !file) usage();
else if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
  console.error('is a directory, not a file: ' + file);
  process.exitCode = 1;
}
else {
  try {
    const doc = new ZipDoc(file);
    if (cmd === 'check') {
      const problems = checkPackageIntegrity(doc.parts, { checkXml: !rest.includes('--no-xml') });
      if (problems.length === 0) console.log(`CLEAN  ${file}  (${doc.parts.size} parts)`);
      else {
        console.log(`PROBLEMS  ${file}  (${problems.length})`);
        for (const p of problems) console.log('  - ' + p);
        process.exitCode = 1;
      }
    } else if (cmd === 'paraid') {
      const dupes = duplicateParaIds(doc.parts);
      const names = Object.keys(dupes);
      if (names.length === 0) console.log(`CLEAN  ${file}  (no paraId collisions)`);
      else {
        console.log(`COLLISIONS  ${file}`);
        for (const n of names) {
          const ids = Object.entries(dupes[n]).map(([k, v]) => `${k}x${v}`).join(', ');
          console.log(`  - ${n}: ${ids}`);
        }
        process.exitCode = 1;
      }
    } else if (cmd === 'parts') {
      for (const i of doc.infos) {
        console.log(`${String(i.usize).padStart(9)}  ${i.method === STORED ? 'stored  ' : 'deflated'}  ${i.name}`);
      }
      console.log(`(${doc.infos.length} parts)`);
    } else usage();
  } catch (err) {
    // a .pdf is a legitimate input for dump, not for the package gate: say so instead of a zip error
    let msg = err.message;
    try {
      const fd = fs.openSync(file, 'r');
      const head = Buffer.alloc(5);
      fs.readSync(fd, head, 0, 5, 0);
      fs.closeSync(fd);
      if (head.toString('latin1') === '%PDF-') {
        msg += ' (this file is a PDF: it has no OOXML zip package. Use "node scripts/dump.mjs <file.pdf>" for page count and metadata.)';
      }
    } catch { /* keep the original message */ }
    console.error(`ERROR  ${msg}`);
    process.exitCode = 1;
  }
}

export { ZipDoc, checkPackageIntegrity, checkStructure, duplicateParaIds, shapeBlockRegex, xmlError };
