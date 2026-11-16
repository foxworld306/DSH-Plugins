/**
 * DSH-SUEZ-Office · suez_build_docx.
 *
 * Word from a JSON spec: title block, headings, paragraphs, bullets, tables, header/footer.
 * A4 (or A4 landscape); brand fonts by default; every run carries explicit CJK + latin faces so
 * PowerPoint-style fallback surprises do not appear in Word.
 */
import fs from 'node:fs';
import path from 'node:path';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

const SAMPLE = {
  title: '标题',
  subtitle: '副标题',
  meta: '日期 · 来源',
  header: '页眉文字',
  footer: '页脚文字',
  sections: [
    { heading: '一、章节', paragraphs: ['正文段落'], bullets: ['要点一'] },
    { heading: '二、表格', table: { columns: ['列 A', '列 B'], rows: [['a', '1']], caption: '来源' } },
  ],
};

export function registerDocxTool(ctx, deps) {
  const { scriptsDir, resolveFrom, sessionCwd, log } = deps;

  ctx.tools.register({
    name: 'suez_build_docx',
    description:
      'Build a .docx from a JSON spec: title/subtitle/meta, sections with headings, paragraphs, ' +
      'bullet lists and tables (header row shaded navy, numeric columns right-aligned), optional ' +
      'header/footer, A4 or A4-landscape. Brand fonts by default. Package gates run before the ' +
      'file is written.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: `JSON: ${JSON.stringify(SAMPLE)}` },
        out: { type: 'string', description: 'Output .docx path.' },
      },
      required: ['spec', 'out'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const spec = typeof args.spec === 'string' ? JSON.parse(args.spec) : args.spec;
      const out = resolveFrom(cwd, args.out);
      const mod = await import(path.join(scriptsDir, 'build-docx.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
      const { ZipDoc, checkPackageIntegrity, checkStructure } = await import(
        path.join(scriptsDir, 'ooxml.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:')
      );

      const r = mod.buildDocx({ out, ...spec });
      const doc = new ZipDoc(r.out);
      const problems = [...checkPackageIntegrity(doc.parts, { checkXml: true }), ...checkStructure(doc.parts)];
      log('build-docx', `${path.basename(r.out)} parts=${r.parts} problems=${problems.length}`);

      const sections = spec.sections ?? [];
      const tables = sections.filter((s) => s.table).length;
      const bullets = sections.reduce((n, s) => n + (s.bullets?.length ?? 0), 0);
      return [
        `built ${r.out}`,
        `  parts: ${r.parts}（document / styles / numbering / header / footer / core）`,
        `  sections: ${sections.length}  tables: ${tables}  bullets: ${bullets}`,
        `  page: ${spec.pageSize ?? 'A4'}`,
        `  package: ${problems.length ? 'PROBLEMS — ' + problems.slice(0, 2).join(' | ') : 'CLEAN'}`,
        '',
        '下一步：suez_render_page { file, out } 导出 PDF 看一眼（docx 会转成 PDF）。',
      ].join('\n');
    },
  });
}

export { SAMPLE as DOCX_SAMPLE };
void fs;
