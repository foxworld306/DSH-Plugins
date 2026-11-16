/**
 * Read-only tools ported from office-docs-win, so one plugin can inspect any Office file:
 *   · suez_dump  — structure of pptx / docx / xlsx / pdf
 *   · suez_check — package integrity (Content_Types + rels + XML well-formedness) for any file
 */
import fs from 'node:fs';
import path from 'node:path';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

export function registerInspectTools(ctx, deps) {
  const { scriptsDir, resolveFrom, sessionCwd, log } = deps;
  const load = (name) =>
    import(path.join(scriptsDir, name).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));

  ctx.tools.register({
    name: 'suez_dump',
    description:
      'Dump the structure of an Office file so you can plan an edit: pptx (shapes per slide: type, ' +
      'name, position/size in inches, text, fonts, colours), docx (paragraph/table inventory + ' +
      'header/footer), xlsx (sheet names, row counts, first cells), pdf (page count, text runs). ' +
      'Read-only. Always dump before editing a file the user handed you.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.pptx / .docx / .xlsx / .pdf path (absolute or relative to the session cwd).' },
        slide: { type: 'number', description: 'pptx only: dump just this slide number (1-based).' },
      },
      required: ['file'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const file = resolveFrom(cwd, args.file);
      if (!fs.existsSync(file)) throw new Error('file not found: ' + file);
      const ext = path.extname(file).toLowerCase();
      const dump = await load('dump.mjs');
      let text;
      if (ext === '.pptx') text = dump.dumpPptx(file, args.slide ?? null);
      else if (ext === '.docx') text = dump.dumpDocx(file);
      else if (ext === '.xlsx' || ext === '.xlsm') text = dump.dumpXlsx(file);
      else if (ext === '.pdf') text = dump.dumpPdf(file);
      else throw new Error('unsupported format: ' + ext + ' (pptx / docx / xlsx / pdf)');
      log('dump', `${path.basename(file)} ${String(text).split('\n').length} lines`);
      return text;
    },
  });

  ctx.tools.register({
    name: 'suez_check',
    description:
      'Run the package gates on any Office file: Content_Types coverage, relationship targets, and ' +
      'XML well-formedness of every part. Use it after editing a file by hand — the three fatal ' +
      'Content_Types modes and a mismatched tag both surface as "the file cannot be opened".',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string', description: '.pptx / .docx / .xlsx path.' } },
      required: ['file'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const file = resolveFrom(cwd, args.file);
      if (!fs.existsSync(file)) throw new Error('file not found: ' + file);
      const { ZipDoc, checkPackageIntegrity, checkStructure } = await load('ooxml.mjs');
      const doc = new ZipDoc(file);
      const problems = [...checkPackageIntegrity(doc.parts, { checkXml: true }), ...checkStructure(doc.parts)];
      log('check', `${path.basename(file)} problems=${problems.length}`);
      return problems.length
        ? `${path.basename(file)}: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`
        : `${path.basename(file)}: CLEAN (${doc.parts.size} parts, Content_Types + rels + XML all well-formed)`;
    },
  });
}
