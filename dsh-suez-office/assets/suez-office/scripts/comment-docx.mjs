/**
 * DSH-SUEZ-Office · add comments to a DOCX.
 *
 * Structure copied from what Word itself writes (verified by letting Word add a comment and dumping
 * the result): a range start after the paragraph properties, the paragraph runs, a range end, then a
 * reference run carrying <w:commentReference>. The comment body lives in word/comments.xml and uses
 * the CommentText / CommentReference styles, so those styles must exist in styles.xml.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ZipDoc, checkPackageIntegrity, checkStructure } from './ooxml.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const COMMENT_STYLES = '<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/>' +
  '<w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
  '<w:style w:type="character" w:default="1" w:styleId="CommentReference"><w:name w:val="annotation reference"/>' +
  '<w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>';

function ensureStyles(doc) {
  if (!doc.has('word/styles.xml')) return;
  const styles = doc.part('word/styles.xml');
  if (styles.includes('styleId="CommentText"')) return;
  doc.setPart('word/styles.xml', styles.replace('</w:styles>', COMMENT_STYLES + '</w:styles>'));
}

function ensureCommentsPart(doc) {
  if (!doc.has('word/comments.xml')) {
    doc.setPart('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="${W}"></w:comments>`);
  }
  if (doc.has('word/_rels/document.xml.rels')) {
    const rels = doc.part('word/_rels/document.xml.rels');
    if (!rels.includes('comments.xml')) {
      doc.setPart('word/_rels/document.xml.rels', rels.replace('</Relationships>',
        `<Relationship Id="rIdComments" Type="${R}/comments" Target="comments.xml"/></Relationships>`));
    }
  }
  const types = doc.part('[Content_Types].xml');
  if (!types.includes('/word/comments.xml')) {
    doc.setPart('[Content_Types].xml', types.replace('</Types>',
      '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>'));
  }
}

/** Highest comment id already in the file. */
function nextId(doc) {
  const ids = [...doc.part('word/comments.xml').matchAll(/<w:comment w:id="(\d+)"/g)].map((m) => Number(m[1]));
  const anchors = [...doc.part('word/document.xml').matchAll(/<w:commentRangeStart w:id="(\d+)"/g)].map((m) => Number(m[1]));
  return Math.max(-1, ...ids, ...anchors) + 1;
}

export function addDocxComment({ input, out, match, index, text, author = 'DSH', initials = 'DSH' }) {
  if (path.resolve(input) === path.resolve(out)) throw new Error('addComment: 输出必须是新路径');
  const doc = new ZipDoc(input);
  ensureStyles(doc);
  ensureCommentsPart(doc);

  const xml = doc.part('word/document.xml');
  const paras = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)];
  let target = null;
  if (typeof index === 'number') target = paras[index - 1];
  else if (match) target = paras.find((p) => [...p[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('').includes(match));
  if (!target) throw new Error(match ? `no paragraph contains "${match}"` : `paragraph ${index} not found`);

  const id = nextId(doc);
  const pXml = target[0];
  const open = /^<w:p(?:\s[^>]*)?>/.exec(pXml)[0];
  const pPr = /^<w:pPr[\s\S]*?<\/w:pPr>/.exec(pXml.slice(open.length))?.[0] ?? '';
  const inner = pXml.slice(open.length + pPr.length, -'</w:p>'.length);

  const newP = `${open}${pPr}<w:commentRangeStart w:id="${id}"/>${inner}<w:commentRangeEnd w:id="${id}"/>` +
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r></w:p>`;
  doc.setPart('word/document.xml', xml.slice(0, target.index) + newP + xml.slice(target.index + pXml.length));

  const date = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const comment = `<w:comment w:id="${id}" w:author="${esc(author)}" w:date="${date}" w:initials="${esc(initials)}">` +
    `<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>` +
    `<w:annotationRef/></w:r><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:comment>`;
  doc.setPart('word/comments.xml', doc.part('word/comments.xml').replace('</w:comments>', comment + '</w:comments>'));

  const problems = [...checkPackageIntegrity(doc.parts, { checkXml: true }), ...checkStructure(doc.parts)];
  if (problems.length) return { out: null, problems, id };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  doc.save(out);
  return { out, problems: [], id };
}
