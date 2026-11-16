/**
 * DSH-SUEZ-Office · schema-level validation.
 *
 * `checkPackageIntegrity()` answers "is the OPC package well-formed"; this answers "would
 * PowerPoint accept the drawing XML". They are different questions, and the gap between them
 * already cost us a deck: `<a:pPr algn="c">` is well-formed XML, passes every structural check,
 * and makes PowerPoint refuse the whole file because ST_TextAlignType only allows l|ctr|r|just|dist.
 *
 * Everything here is a rule we have actually been bitten by, or the immediate neighbour of one.
 */

const TEXT_ALIGN = new Set(['l', 'ctr', 'r', 'just', 'justLow', 'dist', 'thaiDist']);
const VERT_ANCHOR = new Set(['t', 'ctr', 'b', 'just', 'dist']);
const WRAP = new Set(['none', 'square']);
const PRST = new Set([
  'rect', 'roundRect', 'ellipse', 'line', 'triangle', 'rtTriangle', 'diamond', 'chevron',
  'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'homePlate', 'pentagon', 'hexagon',
]);
const FILL_TYPES = ['solidFill', 'noFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill'];

const ANGLE = (s) => /\b(?:NaN|Infinity|undefined|null)\b/.test(s);

/** Every `<tag attr="value">` in order, as [tag, attrs] pairs — enough to audit a slide. */
function tags(xml, name) {
  const out = [];
  const re = new RegExp(`<a:${name}\\b([^>]*)>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

const attr = (s, k) => {
  const m = new RegExp(`${k}="([^"]*)"`).exec(s);
  return m ? m[1] : undefined;
};

/** Validate one slide's drawing XML. Returns human-readable problems. */
export function validateSlide(partName, xml) {
  const p = [];

  for (const a of tags(xml, 'pPr')) {
    const algn = attr(a, 'algn');
    if (algn !== undefined && !TEXT_ALIGN.has(algn)) {
      p.push(`${partName}: illegal algn="${algn}" (allowed: ${[...TEXT_ALIGN].join('|')})`);
    }
  }
  for (const a of tags(xml, 'bodyPr')) {
    const anchor = attr(a, 'anchor');
    if (anchor !== undefined && !VERT_ANCHOR.has(anchor)) {
      p.push(`${partName}: illegal anchor="${anchor}" (allowed: ${[...VERT_ANCHOR].join('|')})`);
    }
    const wrap = attr(a, 'wrap');
    if (wrap !== undefined && !WRAP.has(wrap)) {
      p.push(`${partName}: illegal wrap="${wrap}" (allowed: none|square)`);
    }
  }
  for (const a of tags(xml, 'prstGeom')) {
    const prst = attr(a, 'prst');
    if (prst !== undefined && !PRST.has(prst)) {
      p.push(`${partName}: unexpected prstGeom prst="${prst}"`);
    }
  }
  for (const a of tags(xml, 'tcPr')) {
    const anchor = attr(a, 'anchor');
    if (anchor !== undefined && !VERT_ANCHOR.has(anchor)) {
      p.push(`${partName}: illegal tcPr anchor="${anchor}"`);
    }
  }

  // geometry must be integer EMU inside a sane range (2^31 is the schema limit).
  // The empty group (<p:grpSpPr>) carries cx=0/cy=0 by design, so it is excluded.
  const geomXml = xml.replace(/<p:grpSpPr>[\s\S]*?<\/p:grpSpPr>/g, '');
  for (const m of geomXml.matchAll(/<a:(?:off|ext)\b([^/>]*)\/?>/g)) {
    for (const k of ['x', 'y', 'cx', 'cy']) {
      const v = attr(m[1], k);
      if (v === undefined) continue;
      if (!/^-?\d+$/.test(v)) p.push(`${partName}: non-integer ${k}="${v}"`);
      else if (Math.abs(Number(v)) > 2147483647) p.push(`${partName}: ${k}="${v}" exceeds schema limit`);
    }
    const cx = attr(m[1], 'cx'), cy = attr(m[1], 'cy');
    if (cx !== undefined && Number(cx) <= 0) p.push(`${partName}: non-positive width cx="${cx}"`);
    if (cy !== undefined && Number(cy) <= 0) p.push(`${partName}: non-positive height cy="${cy}"`);
  }

  // run properties: point size range and any leftover template literals
  for (const a of tags(xml, 'rPr')) {
    const sz = attr(a, 'sz');
    if (sz !== undefined) {
      if (!/^\d+$/.test(sz)) p.push(`${partName}: non-integer run size sz="${sz}"`);
      else if (Number(sz) < 100 || Number(sz) > 400000) p.push(`${partName}: run size sz="${sz}" outside 1–4000 pt`);
    }
  }
  if (ANGLE(xml)) p.push(`${partName}: contains NaN/Infinity/undefined in the XML`);

  // a shape must have exactly one fill declaration inside spPr
  for (const sp of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []) {
    const spPr = (sp.match(/<p:spPr>[\s\S]*?<\/p:spPr>/)?.[0] ?? '').replace(/<a:ln>[\s\S]*?<\/a:ln>/g, '');
    const fills = FILL_TYPES.filter((f) => spPr.includes('<' + 'a:' + f));
    if (fills.length > 1) p.push(`${partName}: shape declares ${fills.length} fills (${fills.join(', ')})`);
  }

  // shape ids must be unique within the slide
  const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  if (dupes.length) p.push(`${partName}: duplicate shape ids ${[...new Set(dupes)].join(',')}`);

  return p;
}

/** Validate the whole package: every slide, plus Content_Types coverage and relationship targets. */
export function validatePackage(doc) {
  const problems = [];
  const slides = [...doc.parts.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  if (!slides.length) problems.push('package has no slides');

  for (const name of slides) problems.push(...validateSlide(name, doc.part(name)));

  // every part's extension must be declared, or PowerPoint reports 0x80CB8002
  const types = doc.part('[Content_Types].xml');
  const defaults = new Set([...types.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const overrides = new Set([...types.matchAll(/<Override PartName="\/([^"]+)"/g)].map((m) => m[1]));
  for (const name of doc.parts.keys()) {
    if (name === '[Content_Types].xml' || name.endsWith('/')) continue;
    const ext = name.split('.').pop().toLowerCase();
    if (!overrides.has(name) && !defaults.has(ext)) {
      problems.push(`no content type for ${name} (extension .${ext})`);
    }
  }

  // relationships must point at parts that exist; ../ is a path, not a string to strip
  const resolve = (baseDir, target) => {
    const stack = [];
    for (const seg of (baseDir + '/' + target).split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') stack.pop();
      else stack.push(seg);
    }
    return stack.join('/');
  };
  for (const name of [...doc.parts.keys()].filter((n) => n.endsWith('.rels'))) {
    const baseDir = name.replace(/_rels\/[^/]*$/, '').replace(/\/$/, '');
    for (const m of doc.part(name).matchAll(/Target="([^"]+)"([^>]*)>/g)) {
      if (/TargetMode="External"/.test(m[2])) continue;
      const target = m[1];
      if (target.startsWith('http') || target.startsWith('#')) continue;
      const resolved = target.startsWith('/') ? target.slice(1) : resolve(baseDir, target);
      if (!doc.parts.has(resolved)) problems.push(`${name}: relationship target missing -> ${resolved}`);
    }
  }

  return [...new Set(problems)];
}
