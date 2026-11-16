/**
 * DSH-SUEZ-Office · DOCX housekeeping: accept tracked revisions, strip comments.
 *
 * Both are "delivery hygiene": a deck or contract that still carries someone's tracked changes or
 * comment balloons is not finished. office-docs-win documented this as a manual step ("assert
 * <w:ins>/<w:del> count is 0 after AcceptAllRevisions"); here it is one operation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ZipDoc, checkPackageIntegrity, checkStructure } from './ooxml.mjs';

const TEXT_PARTS = (parts) =>
  [...parts.keys()].filter((k) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(k));

/** Flatten <w:ins>, drop <w:del>, remove *PrChange records. */
export function acceptRevisionsXml(xml) {
  let out = xml;
  let removed = 0;
  let flattened = 0;

  // deleted content goes away entirely (requires the closing tag to match the same id)
  out = out.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, () => {
    removed += 1;
    return '';
  });
  out = out.replace(/<w:moveFrom\b[^>]*>[\s\S]*?<\/w:moveFrom>/g, () => {
    removed += 1;
    return '';
  });
  // inserted content stays, the wrapper does not
  out = out.replace(/<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>/g, (_m, inner) => {
    flattened += 1;
    return inner;
  });
  out = out.replace(/<w:moveTo\b[^>]*>([\s\S]*?)<\/w:moveTo>/g, (_m, inner) => {
    flattened += 1;
    return inner;
  });
  // property-change records hold the OLD formatting; drop them
  for (const tag of ['rPrChange', 'pPrChange', 'trPrChange', 'tcPrChange', 'sectPrChange', 'tblPrChange']) {
    const re = new RegExp(`<w:${tag}\\b[^>]*>[\\s\\S]*?</w:${tag}>|<w:${tag}\\b[^>]*/>`, 'g');
    out = out.replace(re, '');
  }
  out = out.replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, '');
  return { xml: out, removed, flattened };
}

/** Remove comment anchors, the comment runs, and the comment parts themselves. */
export function stripCommentsXml(xml) {
  let out = xml;
  let count = 0;
  out = out.replace(/<w:commentRangeStart\b[^>]*\/>/g, () => { count += 1; return ''; });
  out = out.replace(/<w:commentRangeEnd\b[^>]*\/>/g, () => { count += 1; return ''; });
  out = out.replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\b[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, () => {
    count += 1;
    return '';
  });
  return { xml: out, count };
}

export function cleanDocx({ input, out, acceptRevisions = false, stripComments = false }) {
  if (path.resolve(input) === path.resolve(out)) throw new Error('cleanDocx: 输出必须是新路径');
  const doc = new ZipDoc(input);
  const report = [];

  if (acceptRevisions) {
    let removed = 0;
    let flattened = 0;
    for (const part of TEXT_PARTS(doc.parts)) {
      const r = acceptRevisionsXml(doc.part(part));
      removed += r.removed;
      flattened += r.flattened;
      if (r.xml !== doc.part(part)) doc.setPart(part, r.xml);
    }
    for (const part of ['word/settings.xml'].filter((p) => doc.has(p))) {
      doc.setPart(part, doc.part(part).replace(/<w:trackChanges\b[^>]*\/>/g, ''));
    }
    report.push(`接受修订：展平 ${flattened} 处插入、删除 ${removed} 处删除`);
  }

  if (stripComments) {
    let anchors = 0;
    for (const part of TEXT_PARTS(doc.parts)) {
      const r = stripCommentsXml(doc.part(part));
      anchors += r.count;
      if (r.xml !== doc.part(part)) doc.setPart(part, r.xml);
    }

    const removedParts = [];
    for (const name of [...doc.parts.keys()]) {
      if (/^word\/comments[A-Za-z]*\.xml$/.test(name)) {
        doc.parts.delete(name);
        doc.parts.delete(name.replace('word/', 'word/_rels/') + '.rels');
        removedParts.push(name);
      }
    }
    if (doc.has('word/_rels/document.xml.rels')) {
      let rels = doc.part('word/_rels/document.xml.rels');
      for (const name of removedParts) {
        const base = path.basename(name);
        rels = rels.replace(new RegExp(`<Relationship [^>]*Target="${base}"[^>]*/>`, 'g'), '');
      }
      doc.setPart('word/_rels/document.xml.rels', rels);
    }
    if (doc.has('[Content_Types].xml')) {
      let types = doc.part('[Content_Types].xml');
      for (const name of removedParts) types = types.replace(new RegExp(`<Override PartName="/${name}"[^>]*/>`, 'g'), '');
      doc.setPart('[Content_Types].xml', types);
    }
    report.push(`清除批注：锚点 ${anchors} 处，部件 ${removedParts.length} 个`);
  }

  const problems = [...checkPackageIntegrity(doc.parts, { checkXml: true }), ...checkStructure(doc.parts)];
  if (problems.length) return { out: null, report, problems };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  doc.save(out);
  return { out, report, problems: [] };
}
