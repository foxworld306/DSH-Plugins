/**
 * DSH-SUEZ-Office · image fetching with provenance.
 *
 * The rule this exists for: a deck looks generic when its pages are only text, boxes and rules.
 * Real photos fix that — but only if you know where each one came from. So a fetched image always
 * lands with a record: url, retrieved date, licence, author. `credits.json` next to the images is
 * the deliverable, not a side effect.
 *
 * This machine reaches image CDNs (images.unsplash.com, images.pexels.com) but not Wikimedia and
 * not the stock search pages, so the split is: the model finds the URL, this module fetches it.
 */
import fs from 'node:fs';
import path from 'node:path';

const UA = 'dsh-suez-office/0.2 (+office docs skill; image fetch)';

/** Accepted by PowerPoint. WebP/AVIF are rejected early with a readable message instead of a broken slide. */
function sniff(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', ext: '.png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', ext: '.jpg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return { format: 'jpeg', ext: '.jpg', width: null, height: null };
  }
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
    throw new Error('got a WebP: PowerPoint does not accept it. Ask the source for a jpg/png (Unsplash: &fm=jpg)');
  }
  if (buf.slice(4, 8).toString() === 'ftyp') {
    throw new Error('got an AVIF/HEIC: PowerPoint does not accept it. Use a jpg/png URL');
  }
  throw new Error('not a PNG/JPEG (first bytes: ' + buf.slice(0, 8).toString('hex') + ')');
}

const safe = (s) => String(s).replace(/[^\w.\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';

/** Append (or replace) one record in <dir>/credits.json. */
function recordCredit(dir, entry) {
  const file = path.join(dir, 'credits.json');
  let list = [];
  if (fs.existsSync(file)) {
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
  }
  const i = list.findIndex((x) => x.file === entry.file);
  if (i >= 0) list[i] = entry; else list.push(entry);
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
  return file;
}

/**
 * Download one image and record where it came from.
 *
 * @param {object} o
 * @param {string} o.url
 * @param {string} o.outDir        directory for the file and credits.json
 * @param {string} [o.name]        file stem (defaults to the URL's last segment)
 * @param {string} [o.license]     e.g. 'Unsplash License', 'CC BY-SA 4.0', 'internal'
 * @param {string} [o.author]
 * @param {string} [o.source]      human page for the image (not the raw file URL)
 * @param {number} [o.minWidth]    warn below this (default 1200: 13.33in slide at ~90dpi)
 * @param {AbortSignal} [o.signal]
 */
/**
 * Stock CDNs resize on the fly, so ask for a page-sized image instead of the original:
 * a 6000px photo is 8 MB and gains nothing on a 13.3in slide (≈2500px at 190 dpi).
 */
export function normaliseImageUrl(url, width = 1800) {
  const u = new URL(url);
  if (/images\.pexels\.com$/.test(u.hostname) || /images\.unsplash\.com$/.test(u.hostname)) {
    if (!u.searchParams.has('w')) u.searchParams.set('w', String(width));
    if (/images\.unsplash\.com$/.test(u.hostname) && !u.searchParams.has('fm')) u.searchParams.set('fm', 'jpg');
  }
  return u.toString();
}
export async function fetchImage({ url: rawUrl, outDir, name, license = '', author = '', source = '', minWidth = 1200, signal }) {
  if (!/^https?:\/\//i.test(String(rawUrl))) throw new Error('fetchImage: url must be http(s)');
  let url = String(rawUrl);
  fs.mkdirSync(outDir, { recursive: true });

  url = normaliseImageUrl(url);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'image/*' }, signal });
  if (!res.ok) throw new Error(`fetchImage: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error(`fetchImage: only ${buf.length} bytes — probably an error page, not an image`);

  const info = sniff(buf);
  const stem = safe(name ?? path.basename(new URL(url).pathname).replace(/\.[^.]+$/, '') ?? 'image');
  const fileName = stem + info.ext;
  const file = path.join(outDir, fileName);
  fs.writeFileSync(file, buf);

  const warnings = [];
  if (info.width && info.width < minWidth) warnings.push(`only ${info.width}px wide (want ≥ ${minWidth} for a full-bleed page)`);
  if (buf.length > 2.5 * 1024 * 1024) warnings.push(`${(buf.length / 1048576).toFixed(1)} MB is heavy — ask the CDN for w=1800 (it resizes on the fly)`);
  if (!license) warnings.push('no licence recorded — say where it came from before it ships');

  const credits = recordCredit(outDir, {
    file: fileName,
    url,
    source: source || url,
    license: license || 'UNKNOWN',
    author: author || 'UNKNOWN',
    retrieved: new Date().toISOString().slice(0, 10),
    bytes: buf.length,
    width: info.width,
    height: info.height,
  });

  return {
    file,
    fileName,
    format: info.format,
    width: info.width,
    height: info.height,
    bytes: buf.length,
    credits,
    warnings,
  };
}

/** Read the credit record for one file, if it exists. */
export function creditFor(dir, fileName) {
  const file = path.join(dir, 'credits.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).find((x) => x.file === fileName) ?? null;
  } catch { return null; }
}

/** One-line provenance, for a caption or a speaker note. */
export function creditLine(credit) {
  if (!credit) return '';
  const bits = [credit.author && credit.author !== 'UNKNOWN' ? credit.author : null, credit.license, credit.retrieved].filter(Boolean);
  return `${bits.join(' · ')} · ${credit.source}`;
}

if (process.argv[1] && process.argv[1].endsWith('images.mjs')) {
  const [url, outDir] = process.argv.slice(2);
  if (!url) {
    console.log('usage: node images.mjs <url> [outDir]');
    process.exit(2);
  }
  const r = await fetchImage({ url, outDir: outDir ?? '.' });
  console.log(`  ${r.file}  ${r.width}x${r.height}  ${Math.round(r.bytes / 1024)} KB`);
  for (const w of r.warnings) console.log('  ! ' + w);
}
