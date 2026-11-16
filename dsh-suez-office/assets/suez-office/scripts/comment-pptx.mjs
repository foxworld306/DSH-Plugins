/**
 * DSH-SUEZ-Office · add a comment to a PPTX slide.
 *
 * PowerPoint stores slide comments as their own part: the slide points at a comment list through its
 * relationships, and a shared commentAuthors.xml names the authors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ZipDoc, checkPackageIntegrity, checkStructure } from './ooxml.mjs';

const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slideParts = (doc) =>
  [...doc.parts.keys()]
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));

function authorId(doc, name, initials) {
  const part = 'ppt/commentAuthors.xml';
  if (!doc.has(part)) {
    doc.setPart(part, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmAuthorLst xmlns:p="${NS_P}">` +
      `<p:cmAuthor id="0" name="${esc(name)}" initials="${esc(initials)}" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`);
    const pres = doc.part('ppt/_rels/presentation.xml.rels');
    if (!pres.includes('commentAuthors.xml')) {
      doc.setPart('ppt/_rels/presentation.xml.rels', pres.replace('</Relationships>',
        `<Relationship Id="rIdCommentAuthors" Type="${R}/commentAuthors" Target="commentAuthors.xml"/></Relationships>`));
    }
    const types = doc.part('[Content_Types].xml');
    if (!types.includes('/ppt/commentAuthors.xml')) {
      doc.setPart('[Content_Types].xml', types.replace('</Types>',
        '<Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"/></Types>'));
    }
    return 0;
  }
  const existing = [...doc.part(part).matchAll(/<p:cmAuthor\b([^>]*)\/>/g)]
    .map((m) => ({ id: Number(/id="(\d+)"/.exec(m[1])?.[1] ?? -1), name: /name="([^"]*)"/.exec(m[1])?.[1] }));
  const hit = existing.find((a) => a.name === name);
  if (hit) return hit.id;
  const id = Math.max(0, ...existing.map((a) => a.id)) + 1;
  doc.setPart(part, doc.part(part).replace('</p:cmAuthorLst>',
    `<p:cmAuthor id="${id}" name="${esc(name)}" initials="${esc(initials)}" lastIdx="1" clrIdx="${id}"/></p:cmAuthorLst>`));
  return id;
}

export function addPptxComment({ input, out, slide = 1, text, author = 'DSH', initials = 'DSH' }) {
  if (path.resolve(input) === path.resolve(out)) throw new Error('addComment: 输出必须是新路径');
  const doc = new ZipDoc(input);
  const parts = slideParts(doc);
  const slidePart = parts[slide - 1];
  if (!slidePart) throw new Error(`slide ${slide} out of range (deck has ${parts.length})`);

  const aid = authorId(doc, author, initials);
  const date = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const relsPart = slidePart.replace('slides/', 'slides/_rels/') + '.rels';
  let rels = doc.part(relsPart);
  // 一张幻灯片只挂一个批注部件：第二次加批注要追加到同一个 <p:cmLst> 里
  const existingRel = /Target="(\.\.\/comments\/comment\d+\.xml)"/.exec(rels)?.[1];
  let commentPart;
  let idx;
  if (existingRel) {
    commentPart = 'ppt/' + existingRel.replace('../', '');
    const current = doc.part(commentPart);
    const used = [...current.matchAll(/<p:cm\b[^>]*idx="(\d+)"/g)].map((m) => Number(m[1]));
    idx = Math.max(0, ...used) + 1;
  } else {
    const n = [...doc.parts.keys()].filter((k) => /^ppt\/comments\/comment\d+\.xml$/.test(k)).length + 1;
    commentPart = `ppt/comments/comment${n}.xml`;
    idx = 1;
    doc.setPart(commentPart, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmLst xmlns:p="${NS_P}"></p:cmLst>`);
  }

  doc.setPart(commentPart, doc.part(commentPart).replace('</p:cmLst>',
    `<p:cm authorId="${aid}" dt="${date}" idx="${idx}"><p:pos x="1828800" y="914400"/>` +
    `<p:text>${esc(text)}</p:text></p:cm></p:cmLst>`));

  if (!existingRel) {
    rels = doc.part(relsPart);
    const usedRid = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
    const rid = `rId${Math.max(0, ...usedRid) + 1}`;
    doc.setPart(relsPart, rels.replace('</Relationships>',
      `<Relationship Id="${rid}" Type="${R}/comments" Target="../comments/${commentPart.split('/').pop()}"/></Relationships>`));
  }

  const types = doc.part('[Content_Types].xml');
  if (!types.includes(`/${commentPart}`)) {
    doc.setPart('[Content_Types].xml', types.replace('</Types>',
      `<Override PartName="/${commentPart}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/></Types>`));
  }

  const problems = [...checkPackageIntegrity(doc.parts, { checkXml: true }), ...checkStructure(doc.parts)];
  if (problems.length) return { out: null, problems, part: commentPart };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  doc.save(out);
  return { out, problems: [], part: commentPart };
}
