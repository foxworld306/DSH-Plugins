/**
 * Local photos can be oversized too. Anything big is re-encoded into a cache folder next to the
 * output and the storyboard is rewritten to point at the small copy, so the reviewer never opens a
 * 40 MB deck.
 */
import fs from 'node:fs';
import path from 'node:path';

const loadResize = (scriptsDir) =>
  import(path.join(scriptsDir, 'resize.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));

export async function shrinkLocalImages(slides, outDir, { scriptsDir, log = () => {}, maxWidth = 1800 } = {}) {
  const { resizeImage } = await loadResize(scriptsDir);
  const cacheDir = path.join(outDir, '.suez-img');
  const seen = new Map();

  const shrink = async (p) => {
    if (typeof p !== 'string' || !/\.(png|jpe?g)$/i.test(p)) return p;
    if (seen.has(p)) return seen.get(p);
    if (!fs.existsSync(p)) return p;
    try {
      const r = await resizeImage(p, { maxWidth });
      let next = p;
      if (r.resized) {
        fs.mkdirSync(cacheDir, { recursive: true });
        next = path.join(cacheDir, path.basename(r.file));
        fs.copyFileSync(r.file, next);
        log('resize', `${path.basename(p)} ${Math.round(r.bytesBefore / 1024)}KB → ${Math.round(r.bytesAfter / 1024)}KB`);
      }
      seen.set(p, next);
      return next;
    } catch {
      return p;
    }
  };

  for (const s of slides ?? []) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.image === 'string') s.image = await shrink(s.image);
    if (typeof s.screenshot === 'string') s.screenshot = await shrink(s.screenshot);
    for (const c of s.cards ?? []) if (c && typeof c.image === 'string') c.image = await shrink(c.image);
    for (const key of ['avatar1', 'avatar2', 'avatar3']) if (typeof s[key] === 'string') s[key] = await shrink(s[key]);
  }
  return slides;
}
