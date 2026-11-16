/**
 * DSH-SUEZ-Office · suez_edit_pptx.
 *
 * Edits a file the user already has: only the named shapes change, everything else (layout, fonts,
 * pictures, hand-dragged positions) stays exactly as it was. The output is always a new path.
 */
import path from 'node:path';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

export function registerPptxEditTool(ctx, deps) {
  const { scriptsDir, resolveFrom, sessionCwd, log } = deps;

  ctx.tools.register({
    name: 'suez_edit_pptx',
    description:
      'Edit an existing .pptx in place-style: change the text of a named shape, swap a picture, ' +
      'rewrite a chart series, duplicate or delete a slide — everything else in the file is left ' +
      'untouched. Always writes a NEW file (never overwrites the input). Run suez_dump first to ' +
      'learn the shape names on each slide.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Existing .pptx (absolute, or relative to the session cwd).' },
        out: { type: 'string', description: 'New .pptx to write. Must differ from input.' },
        ops: {
          type: 'string',
          description:
            'JSON array of operations: ' +
            '[{"op":"setText","slide":3,"shape":"Title","text":"新标题"},' +
            '{"op":"setImage","slide":2,"shape":"Photo","file":"img.jpg"},' +
            '{"op":"setChartValues","slide":4,"series":1,"values":[1,2,3],"format":"0.0"},' +
            '{"op":"duplicateSlide","slide":1},{"op":"removeSlide","slide":9}]',
        },
      },
      required: ['input', 'out', 'ops'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const input = resolveFrom(cwd, args.input);
      const out = resolveFrom(cwd, args.out);
      const ops = typeof args.ops === 'string' ? JSON.parse(args.ops) : args.ops;
      if (!Array.isArray(ops) || !ops.length) throw new Error('ops must be a non-empty array');
      for (const op of ops) if (op.file) op.file = resolveFrom(cwd, op.file);

      const mod = await import(path.join(scriptsDir, 'edit-pptx.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
      const r = mod.editPptx({ input, out, ops });
      log('edit-pptx', `${path.basename(input)} ops=${ops.length} problems=${r.problems.length}`);

      if (r.problems.length) {
        return [
          '编辑没有落盘：改完之后包校验不过（宁可不写，也不给你一个打不开的文件）。',
          `  - ${r.problems.join('\n  - ')}`,
          '已应用的操作：',
          `  - ${r.applied.join('\n  - ')}`,
        ].join('\n');
      }
      return [
        `edited ${input}`,
        `  → ${r.out}`,
        `  ops: ${ops.length}（${r.applied.length} 条生效）`,
        ...r.applied.map((a) => '  - ' + a),
        '  package: CLEAN（Content_Types + rels + XML 良构）',
        '',
        '下一步建议：suez_render_page 看一眼改动页，确认没有溢出或错位。',
      ].join('\n');
    },
  });
}
