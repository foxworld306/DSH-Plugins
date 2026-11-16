/**
 * DSH-SUEZ-Office · suez_edit_docx and suez_edit_xlsx.
 *
 * Both are surgical: the file keeps its styles, headers, number formats and everything the user
 * changed by hand. Output is always a new path.
 */
import path from 'node:path';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

const loadFrom = (dir, name) =>
  import(path.join(dir, name).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));

export function registerDocxEditTools(ctx, deps) {
  const { scriptsDir, resolveFrom, sessionCwd, log } = deps;

  ctx.tools.register({
    name: 'suez_edit_docx',
    description:
      'Edit an existing .docx: replace a paragraph\'s text (by literal match or 1-based index) or a ' +
      'table cell. Keeps the paragraph style and the run font/size/colour. Writes a NEW file.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Existing .docx.' },
        out: { type: 'string', description: 'New .docx (must differ from input).' },
        ops: {
          type: 'string',
          description:
            'JSON array: [{"op":"setParagraph","match":"旧文字","text":"新文字"} or {"op":"setParagraph","index":3,"text":"…"}, ' +
            '{"op":"setTableCell","table":1,"row":2,"col":2,"text":"新值"}]',
        },
      },
      required: ['input', 'out', 'ops'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const mod = await loadFrom(scriptsDir, 'edit-docx.mjs');
      const ops = typeof args.ops === 'string' ? JSON.parse(args.ops) : args.ops;
      const r = mod.editDocx({ input: resolveFrom(cwd, args.input), out: resolveFrom(cwd, args.out), ops });
      log('edit-docx', `ops=${ops.length} problems=${r.problems.length}`);
      if (r.problems.length) return `没落盘：包校验不过\n  - ${r.problems.join('\n  - ')}`;
      return [`edited ${path.basename(args.input)} → ${r.out}`, ...r.applied.map((a) => '  - ' + a), '  package: CLEAN'].join('\n');
    },
  });

  ctx.tools.register({
    name: 'suez_edit_xlsx',
    description:
      'Edit an existing .xlsx: set a cell by coordinate (A1 style), keeping its number format; new ' +
      'cells/rows inherit the column style. Writes a NEW file.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Existing .xlsx.' },
        out: { type: 'string', description: 'New .xlsx (must differ from input).' },
        ops: {
          type: 'string',
          description:
            'JSON array: [{"op":"setCell","sheet":"Sheet1","cell":"B2","value":29.42}, ' +
            '{"op":"setCell","sheet":"Sheet1","cell":"A5","value":"新行标题","type":"text"}]',
        },
      },
      required: ['input', 'out', 'ops'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const mod = await loadFrom(scriptsDir, 'edit-xlsx.mjs');
      const ops = typeof args.ops === 'string' ? JSON.parse(args.ops) : args.ops;
      const r = mod.editXlsx({ input: resolveFrom(cwd, args.input), out: resolveFrom(cwd, args.out), ops });
      log('edit-xlsx', `ops=${ops.length} problems=${r.problems.length}`);
      if (r.problems.length) return `没落盘：包校验不过\n  - ${r.problems.join('\n  - ')}`;
      return [`edited ${path.basename(args.input)} → ${r.out}`, ...r.applied.map((a) => '  - ' + a), '  package: CLEAN'].join('\n');
    },
  });

  ctx.tools.register({
    name: 'suez_clean_docx',
    description:
      'Delivery hygiene for Word: accept all tracked revisions (flatten insertions, drop deletions, ' +
      'remove *PrChange records) and/or strip every comment (anchors + comment parts). Writes a NEW file. ' +
      'Use before delivering a document that has been through review.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Existing .docx.' },
        out: { type: 'string', description: 'New .docx (must differ from input).' },
        acceptRevisions: { type: 'boolean', description: 'Accept tracked changes (default true).' },
        stripComments: { type: 'boolean', description: 'Remove all comments (default false).' },
      },
      required: ['input', 'out'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const mod = await loadFrom(scriptsDir, 'clean-docx.mjs');
      const r = mod.cleanDocx({
        input: resolveFrom(cwd, args.input),
        out: resolveFrom(cwd, args.out),
        acceptRevisions: args.acceptRevisions !== false,
        stripComments: args.stripComments === true,
      });
      log('clean-docx', `problems=${r.problems.length}`);
      if (r.problems.length) return `没落盘：包校验不过\n  - ${r.problems.join('\n  - ')}`;
      return [`cleaned ${path.basename(args.input)} → ${r.out}`, ...r.report.map((x) => '  - ' + x), '  package: CLEAN'].join('\n');
    },
  });

  ctx.tools.register({
    name: 'suez_add_comment',
    description:
      'Add a comment: .docx anchors on a paragraph (match or index), .pptx on a slide number (index). ' +
      'Structure matches what Word writes; CommentText/CommentReference styles are added if missing. ' +
      'Writes a NEW file.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Existing .docx.' },
        out: { type: 'string', description: 'New .docx.' },
        match: { type: 'string', description: 'Anchor on the first paragraph containing this text.' },
        index: { type: 'number', description: 'Anchor on this paragraph number (1-based).' },
        text: { type: 'string', description: 'Comment body.' },
        author: { type: 'string', description: 'Author name (default DSH).' },
      },
      required: ['input', 'out', 'text'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const input = resolveFrom(cwd, args.input);
      const out = resolveFrom(cwd, args.out);
      const isPptx = /\.pptx$/i.test(input);
      const mod = await loadFrom(scriptsDir, isPptx ? 'comment-pptx.mjs' : 'comment-docx.mjs');
      const r = isPptx
        ? mod.addPptxComment({ input, out, slide: args.index ?? 1, text: args.text, author: args.author ?? 'DSH' })
        : mod.addDocxComment({ input, out, match: args.match, index: args.index, text: args.text, author: args.author ?? 'DSH' });
      log('add-comment', `id=${r.id} problems=${r.problems.length}`);
      if (r.problems.length) return `没落盘：包校验不过\n  - ${r.problems.join('\n  - ')}`;
      return [`commented ${path.basename(args.input)} → ${r.out}`, '  - 批注部件 ' + (r.part ?? ('id ' + r.id)), '  - package: CLEAN', '', '下一步：suez_dump 可以看到这条批注。'].join('\n');
    },
  });
}
