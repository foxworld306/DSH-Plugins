/**
 * DSH-SUEZ-Office · suez_fetch_image tool.
 *
 * Downloads one image by URL and records its provenance next to it (credits.json). The split is
 * deliberate: the model can search (it has network), the plugin can fetch (the host has network
 * where a sandboxed shell does not) — but the file and its licence always land together.
 */
import path from 'node:path';

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

export function registerImageTool(ctx, deps) {
  const { scriptsDir, resolveFrom, sessionCwd, log } = deps;

  ctx.tools.register({
    name: 'suez_fetch_image',
    description:
      'Download one image by URL into the deck\'s asset folder and record where it came from ' +
      '(url, retrieved date, licence, author) in credits.json. Use it for photos from a stock CDN ' +
      '(images.unsplash.com / images.pexels.com) or a vendor page; the model finds the URL, this ' +
      'tool does the fetch. Returns the local path plus the credit line to put in the caption.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Direct image URL (http/https), not a page URL.' },
        out: { type: 'string', description: 'Target folder. Default: <cwd>/assets/images' },
        name: { type: 'string', description: 'File stem, e.g. "apple-watch".' },
        license: { type: 'string', description: 'e.g. "Unsplash License", "CC BY 4.0", "internal".' },
        author: { type: 'string', description: 'Photographer or rights holder.' },
        source: { type: 'string', description: 'Human page the image came from (not the raw file URL).' },
      },
      required: ['url'],
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const cwd = await sessionCwd(ctx, exec);
      const outDir = resolveFrom(cwd, args.out ?? 'assets/images');
      const mod = await import(path.join(scriptsDir, 'images.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
      const r = await mod.fetchImage({
        url: args.url,
        outDir,
        name: args.name,
        license: args.license ?? '',
        author: args.author ?? '',
        source: args.source ?? '',
        signal: exec?.signal,
      });
      log('image', `${r.fileName} ${r.width}x${r.height} ${Math.round(r.bytes / 1024)}KB`);

      const credit = mod.creditFor(outDir, r.fileName);
      return [
        `fetched ${r.file}`,
        `  ${r.width}×${r.height} ${r.format} ${Math.round(r.bytes / 1024)} KB`,
        `  credits: ${r.credits}`,
        credit ? `  credit line: ${mod.creditLine(credit)}` : '',
        r.warnings.length ? `  warnings:\n   - ${r.warnings.join('\n   - ')}` : '',
        '',
        `在 storyboard 里引用：{ "image": "${r.file.replace(/\\/g, '/')}", "imageCredit": "${(credit?.author ?? '')} · ${(credit?.license ?? '')}" }`,
      ].filter(Boolean).join('\n');
    },
  });
}

