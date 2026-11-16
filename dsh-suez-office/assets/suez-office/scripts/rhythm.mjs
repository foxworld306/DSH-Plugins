/**
 * DSH-SUEZ-Office · deck rhythm.
 *
 * A deck is not a set of pages, it is a sequence. The single most common reason a generated
 * deck reads as "a table stretched over slides" is that every page has the same density and
 * the same focal size — no accents, nothing to look at first.
 *
 * This module is a policy check over the *storyboard* (before anything is drawn): it measures
 * where the eye gets a rest, where it gets an anchor, and how often the deck changes temperature.
 */

/** What each page type gives the eye. `size` is the largest type on the page, in points. */
export const PAGE_META = {
  // anchor: true = the page carries the deck visually (a field, a photo, a number that owns the page).
  // Structural pages (cover/section/closing) are dark by nature and do not count as anchors.
  cover: { focus: 'type', size: 44, tone: 'dark' },
  section: { focus: 'type', size: 40, tone: 'dark' },
  closing: { focus: 'type', size: 60, tone: 'dark' },
  hero: { focus: 'field', size: 88, tone: 'dark', anchor: true },
  heroHtml: { focus: 'field', size: 88, tone: 'dark', anchor: true },
  bigNumber: { focus: 'number', size: 140, tone: 'light', anchor: true },
  imageFull: { focus: 'image', size: 56, tone: 'dark', anchor: true },
  imageSplit: { focus: 'image', size: 32, tone: 'light', anchor: true },
  imageCard: { focus: 'layout', size: 16, tone: 'light' },
  bento: { focus: 'field', size: 64, tone: 'light', anchor: true },
  statement: { focus: 'type', size: 52, tone: 'light', anchor: true },
  quote: { focus: 'type', size: 40, tone: 'light', anchor: true },
  assertion: { focus: 'number', size: 44, tone: 'light' },
  bars: { focus: 'data', size: 15, tone: 'light' },
  matrix: { focus: 'data', size: 15, tone: 'light' },
  cards: { focus: 'layout', size: 16, tone: 'light' },
  timeline: { focus: 'layout', size: 17, tone: 'light' },
  bullets: { focus: 'text', size: 16, tone: 'light' },
  table: { focus: 'text', size: 15, tone: 'light' },
};


/** What kind of thing owns the page. Two anchors in a row with the same lead reads as a repeat. */
const LEAD_OF_FOCUS = {
  image: 'image',
  number: 'number',
  field: 'field',
  type: 'type',
  data: 'chart',
  layout: 'list',
  text: 'list',
};

/** heroHtml pages vary by template, so read the lead from the template name. */
const LEAD_OF_HERO = {
  section: 'field',
  compare: 'field',
  statWall: 'number',
  device: 'image',
  people: 'image',
  diagram: 'diagram',
};

export function leadOf(spec) {
  if (spec?.archetype === 'heroHtml') return LEAD_OF_HERO[spec.template ?? 'section'] ?? 'field';
  const focus = PAGE_META[spec?.archetype]?.focus ?? 'text';
  return LEAD_OF_FOCUS[focus] ?? 'list';
}

export const DEFAULTS = {
  focusEvery: 5,        // at most this many pages between two anchor pages
  minFocusSize: 44,     // a "visual" page has a focal element at least this big (or an image/field)
  darkRatio: [0.12, 0.30],
  maxSameArchetypeRun: 2,
};

const isVisual = (spec) => PAGE_META[spec.archetype]?.anchor === true;

/**
 * Check a storyboard. Returns { issues, stats } — issues are advisory strings that name the
 * page range and one concrete fix.
 */
export function checkRhythm(slides, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const issues = [];
  if (!slides.length) return { issues: ['故事板为空'], stats: {} };

  const visual = slides.map(isVisual);
  const tones = slides.map((s) => (PAGE_META[s.archetype]?.tone ?? 'light'));

  // 1. the eye needs an anchor at least every `focusEvery` pages
  const anchors = visual.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (!anchors.length) {
    if (slides.length >= 4) {
      issues.push(`全 ${slides.length} 页没有一处视觉焦点页：至少插入 hero / bigNumber / imageFull 各一页`);
    }
  } else {
    if (anchors[0] > o.focusEvery) {
      issues.push(`开头 ${anchors[0]} 页没有视觉焦点：第 1 页之后插一页 hero`);
    }
    for (let k = 1; k < anchors.length; k++) {
      const gap = anchors[k] - anchors[k - 1];
      if (gap > o.focusEvery) {
        issues.push(`第 ${anchors[k - 1] + 1}–${anchors[k] + 1} 页连续 ${gap - 1} 页没有视觉焦点：中间插一页 hero / bigNumber / imageFull`);
      }
    }
    const tailGap = slides.length - 1 - anchors[anchors.length - 1];
    if (tailGap > o.focusEvery) {
      issues.push(`结尾 ${tailGap} 页没有视觉焦点：最后一页换成 hero 或 closing`);
    }
  }

  // 2. temperature: a deck that never goes dark reads like a document.
  // Cover and closing are dark by nature, so the ratio is measured on the body only — otherwise
  // every short deck looks "too dark" and the warning becomes noise.
  const body = tones.slice(1, Math.max(1, tones.length - 1));
  const dark = body.filter((t) => t === 'dark').length;
  const ratio = body.length ? dark / body.length : 0;
  const [lo, hi] = o.darkRatio;
  if (body.length >= 6 && ratio < lo) {
    issues.push(`深色页只有 ${dark}/${slides.length}（${(ratio * 100).toFixed(0)}%）：把章节页或结论页改成深色，目标 12–30%`);
  }
  if (body.length >= 3 && ratio > hi) {
    issues.push(`正文深色页 ${(ratio * 100).toFixed(0)}% 偏多：连续深色超过 3 页会让人疲劳，中间插一页白底`);
  }

  // 3. identical neighbours: three cards/bullets in a row is a wall
  let run = 1;
  for (let i = 1; i < slides.length; i++) {
    run = slides[i].archetype === slides[i - 1].archetype ? run + 1 : 1;
    if (run === o.maxSameArchetypeRun + 1) {
      issues.push(`第 ${i - run + 2}–${i + 1} 页连续 ${run} 页都是 ${slides[i].archetype}：换一种页型，或中间插一页对比`);
    }
  }


  // 5. lead rotation: the anchor pages must take turns being a photo / a number / a field / a chart
  const anchorLeads = anchors.map((i) => ({ page: i + 1, lead: leadOf(slides[i]) }));
  for (let k = 1; k < anchorLeads.length; k++) {
    if (anchorLeads[k].lead === anchorLeads[k - 1].lead) {
      issues.push(
        `第 ${anchorLeads[k - 1].page} 页和第 ${anchorLeads[k].page} 页都是「${anchorLeads[k].lead}」型焦点：换一种主角（图片 / 数字 / 图表 / 色场）`,
      );
    }
  }

  // 4. opening and closing
  if (!['cover', 'hero', 'heroHtml'].includes(slides[0].archetype)) issues.push('第一页不是 cover：开场需要一个封面页');

  // A five-page update does not need a table of contents; a real report does. Warn from 6 pages up,
  // and only when no agenda page appears in the first three.
  if (slides.length >= 6 && !slides.slice(0, 3).some((s) => s.archetype === 'agenda')) {
    issues.push('6 页以上的册子建议在第 2–3 页放一页 agenda（目录），读者才知道后面有几块');
  }
  if (!['closing', 'hero', 'statement'].includes(slides[slides.length - 1].archetype)) {
    issues.push('最后一页建议用 closing 或 hero 收尾');
  }

  return {
    issues,
    stats: {
      pages: slides.length,
      visualPages: visual.filter(Boolean).length,
      darkRatio: +ratio.toFixed(2),   // body pages only (cover/closing excluded)
      longestGap: (() => {
        let max = 0, gap = 0;
        for (const v of visual) { gap = v ? 0 : gap + 1; max = Math.max(max, gap); }
        return max;
      })(),
    },
  };
}

/** Turn each issue into a suggested edit on the storyboard (advisory, never applied silently). */
export function planRhythm(slides, options = {}) {
  const { issues } = checkRhythm(slides, options);
  return issues.map((issue, i) => ({ id: i + 1, issue }));
}
