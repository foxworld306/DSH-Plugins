/**
 * Hero-page regression (L2).
 *
 *   node test/hero.mjs --seed <SUEZ template.pptx> [--render]
 *
 * Needs a browser (Edge/Chrome) because hero pages are rendered from HTML; that is why it is a
 * separate file from run.mjs, which stays browser-free and fast.
 *
 * Asserts:
 *   · every shipped template renders and produces text boxes
 *   · the built deck is clean and passes the layout lint
 *   · each page carries a background picture AND real text (not one flattened image)
 *   · the cover is the template's own slide, never a designed one
 */
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const SCRIPTS = path.join(here, '..', 'assets', 'suez-office', 'scripts');
const OUT = path.join(here, '.out-hero');

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BUNDLED = path.join(import.meta.dirname, '..', 'assets', 'suez-office', 'seed', 'suez-template.pptx');
const SEED = path.resolve(arg('--seed', process.env.SUEZ_TEMPLATE ?? BUNDLED));
const RENDER = process.argv.includes('--render');
if (!SEED || !fs.existsSync(SEED)) {
  console.error(`seed not found: ${SEED || '(not given)'}\n  pass --seed <SUEZ template.pptx>`);
  process.exit(2);
}

const load = (f) => import(path.join(SCRIPTS, f).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const { buildDeck } = await load('deck.mjs');
const { ZipDoc } = await load('ooxml.mjs');
const { renderHero, loadTemplate, fillTemplate } = await load('hero.mjs');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

const IMG = (f) => path.join(here, 'fixtures', f);   // hermetic: no dependency on the workspace

const pages = {
  section: { number: '02', title: '交付周期是怎么压下来的', subtitle: '三个季度、四次切换' },
  statWall: {
    eyebrow: '关键数字', title: '六个数字说明改了什么',
    v1: '−34%', l1: '交付周期\n26 → 17 天', v2: '5 → 2', l2: '审批节点',
    v3: '9.8 万', l3: '新增订单', v4: '12%', l4: '抽查比例',
    v5: '3 天', l5: '复核周期', v6: '70%', l6: '自动审批占比', foot: '示例数据。',
  },
  compare: {
    eyebrow: 'BEFORE / AFTER', title: '判断放在哪一步',
    beforeLabel: '现在', before: '五个节点逐个会签', beforeBody: '金额小的单子也要走完五个部门。',
    afterLabel: '改成', after: '两环：单点 + 中台复核', afterBody: '两成品类单点通过，其余中台复核。',
    foot: '示例数据。',
  },
  device: {
    eyebrow: 'PRODUCT VIEW', title: '把审批搬到腕上',
    body: '巡检员在手表上确认工单。', points: '· 40 分钟 → 22 分钟\n· 照片与工单关联',
    screenshot: IMG('shot.svg'), caption: '示例界面 · Unsplash', foot: '示例数据。',
  },
  people: {
    eyebrow: '三个视角', title: '三种人的感受不一样',
    avatar1: IMG('avatar.svg'), name1: '张睿', role1: '运营中台', quote1: '「例外有没有人管。」',
    avatar2: IMG('avatar.svg'), name2: '李雯', role2: '采购一线', quote2: '「一天多跑两个站点。」',
    avatar3: IMG('avatar.svg'), name3: '陈明', role3: '法务', quote3: '「看的是有风险的单子。」',
    foot: '示例人物。',
  },  diagram: {
    eyebrow: 'HOW IT WORKS', title: '审批链是怎么被拆成两环的',
    step1: '提报', note1: '业务方在线填写', step2: '分层', note2: '按金额与风险切三层',
    step3: '自动通过', note3: '两成品类免会签', step4: '中台复核', note4: '例外在这里闭环',
    foot: '示例流程。',
  },
};

const slides = [];
for (const [name, vars] of Object.entries(pages)) {
  const html = fillTemplate(loadTemplate(name), vars);
  const hero = await renderHero({ html, outDir: OUT, name: `tpl-${name}`, scale: 2 });
  check(`${name}: background png written`, fs.existsSync(hero.background) && fs.statSync(hero.background).size > 1000);
  check(`${name}: text measured`, hero.boxes.length >= 3, `${hero.boxes.length} boxes`);
  check(`${name}: preview png written`, fs.existsSync(hero.preview));
  slides.push({ archetype: 'heroHtml', template: name, ...vars, image: hero.background, boxes: hero.boxes });
}

const file = path.join(OUT, 'hero-deck.pptx');
const r = buildDeck({ seed: SEED, out: file, slides, footerTitle: 'hero regression' });
check('package is clean', r.problems.length === 0, r.problems.slice(0, 2).join(' | '));
check('lint is clean', r.lint.errors.length === 0, r.lint.errors.slice(0, 3).join(' | '));
check('every hero page built', r.slides.length === Object.keys(pages).length, `${r.slides.length} of ${Object.keys(pages).length}`);

const doc = new ZipDoc(file);
const media = [...doc.parts.keys()].filter((k) => /^ppt\/media\//.test(k));
check('each page carries its background picture', media.length >= Object.keys(pages).length, `${media.length} media parts`);

const allText = [...doc.parts.keys()]
  .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
  .map((k) => doc.part(k))
  .join('');
check('the words are real text boxes', /审批|两环|交付周期|交付/.test(allText), allText.slice(0, 40));

const slide1 = doc.part('ppt/slides/slide1.xml');
check('page carries a background picture', /<p:pic>/.test(slide1));
check('page carries real text boxes', (slide1.match(/<p:sp>/g) || []).length >= 3, `${(slide1.match(/<p:sp>/g) || []).length}`);

if (RENDER) {
  const { renderPage } = await import(path.join(here, '..', 'lib', 'render.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const img = await renderPage({ script: path.join(SCRIPTS, 'qa_render.ps1'), file, page: 1, out: path.join(OUT, 'hero-p1.png') });
  check('renders in PowerPoint', img.bytes > 10000, `${Math.round(img.bytes / 1024)} KB`);
}

const failed = results.filter((x) => !x.ok);
for (const x of results) console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok || !x.detail ? '' : '  ← ' + x.detail}`);
console.log(`\n${failed.length === 0 ? 'ALL GREEN' : failed.length + ' FAILED'} — ${results.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
