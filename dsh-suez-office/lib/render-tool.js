/**
 * DSH-SUEZ-Office · the render tool.
 *
 * Kept in its own module so the plugin entry stays readable, and because rendering is the one
 * capability that must also work when the general Office plugin is disabled.
 */
import fs from 'node:fs';
import path from 'node:path';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

/**
 * @param {object} ctx      cordis context (needs ctx.tools.register)
 * @param {object} deps
 * @param {string} deps.scriptsDir  absolute path to this plugin's scripts folder
 * @param {(cwdFile: string) => string} deps.resolveFrom  resolve a user path against the session cwd
 * @param {(ctx: any, exec: any) => Promise<string>} deps.sessionCwd
 * @param {(msg: string, detail?: string) => void} deps.log
 */
export function registerRenderTool(ctx, deps) {
  const { scriptsDir, resolveFrom, sessionCwd, log } = deps;

  ctx.tools.register({
    name: 'suez_render_page',
    description:
      'Render one slide of a .pptx to PNG with real Office fidelity and return the image path. ' +
      'Use it after every build: the lint can prove a deck is not broken, only a render proves it ' +
      'looks right. Runs Office COM from the plugin host, so it needs no sandbox approval.',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '.pptx path (absolute, or relative to the session cwd).' },
        page: { type: 'number', description: 'Slide number, 1-based. Default 1.' },
        out: { type: 'string', description: 'Output PNG path. Default: <cwd>/.suez-render/<name>-p<page>.png' },
      },
      required: ['file'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const file = resolveFrom(cwd, args.file);
      if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
      const page = typeof args.page === 'number' ? args.page : 1;
      const name = path.basename(file, path.extname(file));
      const out = args.out
        ? resolveFrom(cwd, args.out)
        : path.join(cwd, '.suez-render', `${name}-p${page}.png`);

      const mod = await import(path.join(import.meta.dirname, 'render.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
      const r = await mod.renderPage({
        script: path.join(scriptsDir, 'qa_render.ps1'),
        file,
        page,
        out,
        signal: exec?.signal,
      });
      log('render', `${file} p${page} -> ${r.out} (${Math.round(r.bytes / 1024)} KB)`);
      return `rendered ${r.out} (${Math.round(r.bytes / 1024)} KB) in ${(r.elapsedMs / 1000).toFixed(1)} s\n现在用 read_image 看这张图。`;
    },
  });
}
