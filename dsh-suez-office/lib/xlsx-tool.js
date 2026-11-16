/**
 * DSH-SUEZ-Office · suez_build_xlsx and suez_export_pdf.
 *
 * xlsx: sheets from a JSON spec (frozen navy header row, typed cells, widths, autofilter,
 * fit-to-width printing).
 * pdf:  any office file → PDF through Office COM, using the same render script the deck QA uses.
 */
import path from 'node:path';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

const SAMPLE = {
  title: '工作簿标题',
  sheets: [
    {
      name: 'Sheet1',
      header: ['指标', 'Q3', 'Q2'],
      columns: [{ width: 28 }, { width: 14, type: 'number' }, { width: 14, type: 'percent' }],
      rows: [['营收', 28.05, 0.196]],
      autofilter: true,
    },
  ],
};

const loadFrom = (dir, name) =>
  import(path.join(dir, name).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));

export function registerXlsxTool(ctx, deps) {
  const { scriptsDir, resolveFrom, sessionCwd, log } = deps;

  ctx.tools.register({
    name: 'suez_build_xlsx',
    description:
      'Build a .xlsx from a JSON spec: several sheets, frozen navy header row, typed cells ' +
      '(text / number / int / percent), column widths, autofilter, fit-to-width printing. ' +
      'Package gates run before the file is written.',
    parameters: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: `JSON: ${JSON.stringify(SAMPLE)}` },
        out: { type: 'string', description: 'Output .xlsx path.' },
      },
      required: ['spec', 'out'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const spec = typeof args.spec === 'string' ? JSON.parse(args.spec) : args.spec;
      const out = resolveFrom(cwd, args.out);
      const xlsx = await loadFrom(scriptsDir, 'build-xlsx.mjs');
      const { ZipDoc, checkPackageIntegrity, checkStructure } = await loadFrom(scriptsDir, 'ooxml.mjs');

      const r = xlsx.buildXlsx({ out, ...spec });
      const doc = new ZipDoc(r.out);
      const problems = [...checkPackageIntegrity(doc.parts, { checkXml: true }), ...checkStructure(doc.parts)];
      const sheets = spec.sheets ?? [];
      const rows = sheets.reduce((n, s) => n + (s.rows?.length ?? 0), 0);
      log('build-xlsx', `${path.basename(r.out)} sheets=${r.sheets.length} rows=${rows} problems=${problems.length}`);
      return [
        `built ${r.out}`,
        `  sheets: ${r.sheets.join(', ')}`,
        `  rows: ${rows}（每表含表头一行）`,
        `  package: ${problems.length ? 'PROBLEMS — ' + problems.slice(0, 2).join(' | ') : 'CLEAN'}`,
        '',
        '下一步：suez_export_pdf 出一份 PDF 快照。',
      ].join('\n');
    },
  });

  ctx.tools.register({
    name: 'suez_export_pdf',
    description:
      'Export an existing .pptx / .docx / .xlsx to PDF through Office COM (no Python, no LibreOffice). ' +
      'Use it to deliver a read-only copy or to eyeball a Word/Excel file.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Source .pptx / .docx / .xlsx.' },
        out: { type: 'string', description: 'Target .pdf path.' },
      },
      required: ['file', 'out'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const file = resolveFrom(cwd, args.file);
      const out = resolveFrom(cwd, args.out);
      const renderMod = await import(
        path.join(import.meta.dirname, 'render.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:')
      );
      const r = await renderMod.renderPage({ script: path.join(scriptsDir, 'qa_render.ps1'), file, out, timeoutSec: 300 });
      log('export-pdf', `${path.basename(file)} → ${path.basename(out)}`);
      return `exported ${path.basename(file)} → ${out}\n  ${Math.round(r.bytes / 1024)} KB`;
    },
  });
}
