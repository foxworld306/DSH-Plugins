/**
 * DSH-SUEZ-Office · regression suite.
 *
 *   node test/run.mjs [--seed <template.pptx>] [--render]
 *
 * No rendering by default (each render is ~10 s and needs interactive Office); the gates and the
 * structural assertions below are what actually broke in the past. `--render` adds one smoke page.
 *
 * Why these cases: every assertion here corresponds to a bug that shipped once.
 *   · a deck that passes our own gates but PowerPoint refuses  → validate: illegal enum
 *   · a chart type PowerPoint rejects (area marker, holeSize)  → charts: element per type
 *   · text on text after a layout change                       → lint: overlap
 *   · the seed's own slides / charts leaking into the output   → seed: counts + no seed charts
 *   · a storyboard with no anchor page                         → rhythm: flat vs compliant
 */
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const SCRIPTS = path.join(here, '..', 'assets', 'suez-office', 'scripts');
const LOGO = path.join(here, '..', 'assets', 'suez-office', 'assets', 'suez-logo.png');
const OUT = path.join(here, '.out');

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BUNDLED = path.join(import.meta.dirname, '..', 'assets', 'suez-office', 'seed', 'suez-template.pptx');
const SEED = path.resolve(arg('--seed', process.env.SUEZ_TEMPLATE ?? BUNDLED));
const RENDER = process.argv.includes('--render');

const load = (f) => import(path.join(SCRIPTS, f).replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const { buildDeck } = await load('deck.mjs');
const { ZipDoc, checkPackageIntegrity, checkStructure } = await load('ooxml.mjs');
const { validatePackage } = await load('validate.mjs');
const { lintPackage } = await load('lint.mjs');
const { checkRhythm } = await load('rhythm.mjs');

/* ------------------------------------------------------------------ harness --- */
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
const section = (title) => results.push({ section: title });

if (!SEED || !fs.existsSync(SEED)) {
  console.error(`seed not found: ${SEED || '(not given)'}\n  pass --seed <SUEZ template.pptx> or set SUEZ_TEMPLATE`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let n = 0;
const buildDeckFile = (slides, label = 'deck') => {
  const out = path.join(OUT, `${label}-${++n}.pptx`);
  const r = buildDeck({ seed: SEED, out, slides, footerTitle: 'regression' });
  return { ...r, out, doc: new ZipDoc(out) };
};
const parts = (doc, re) => [...doc.parts.keys()].filter((k) => re.test(k));

/* ------------------------------------------------------------- 1. seed contract --- */
section('seed');
{
  const { problems, slides, doc } = buildDeckFile([{ archetype: 'statement', text: '种子契约' }], 'seed');
  const masters = parts(doc, /^ppt\/slideMasters\/slideMaster\d+\.xml$/).length;
  const layouts = parts(doc, /^ppt\/slideLayouts\/slideLayout\d+\.xml$/).length;
  const themes = parts(doc, /^ppt\/theme\/theme\d+\.xml$/).length;
  const seedCharts = parts(doc, /^ppt\/charts\//).length;

  check('package is clean', problems.length === 0, problems.slice(0, 2).join(' | '));
  check('exactly our slides remain', slides.length === 1, `${slides.length} slides`);
  check('masters survived', masters >= 1, `${masters} masters`);
  check('layouts survived', layouts >= 20, `${layouts} layouts`);
  check('theme survived', themes >= 1, `${themes} themes`);
  check("seed's own charts were stripped", seedCharts === 0, `${seedCharts} chart parts`);
}

/* -------------------------------------------------- 1b. the cover is the company's --- */
section('cover');
{
  const { problems, doc, out } = buildDeckFile([
    { archetype: 'cover', title: '把审批链压到两环', subtitle: '2026 年上半年复盘', meta: '2026 年 11 月' },
  ], 'cover');
  const slide = doc.part('ppt/slides/slide1.xml');
  const rels = doc.part('ppt/slides/_rels/slide1.xml.rels');
  check('package is clean', problems.length === 0, problems.slice(0, 2).join(' | '));
  check('cover keeps the template placeholders', /name="Titre 1"/.test(slide) || /name="Title 1"/.test(slide));
  check('cover keeps the template layout', /slideLayout1\.xml/.test(rels), rels.slice(0, 80));
  check('cover text was replaced', slide.includes('把审批链压到两环') && !slide.includes('Presentation title'));
  check('no designed cover slipped in', !doc.part('ppt/slides/slide1.xml').includes('Hero background'));
  void out;
}
/* --------------------------------------------------------- 2. every archetype --- */
section('archetypes');
{
  const all = [
    { archetype: 'cover', title: '封面', subtitle: '副标题', meta: 'meta' },
    { archetype: 'section', number: '01', title: '章节', subtitle: '说明' },
    { archetype: 'hero', eyebrow: 'E', title: '一句主线。', body: '说明。', stat: '28.9 万亿', statLabel: '标签' },
    { archetype: 'bigNumber', eyebrow: 'E', title: '数字页', value: '12%', unit: '比例', label: '说明' },
    { archetype: 'bento', eyebrow: 'E', title: '磁贴', tiles: [{ value: '11', label: 'a' }, { value: '2 成', label: 'b' }, { value: '9.8 万', label: 'c' }, { value: '3 天', label: 'd' }] },
    { archetype: 'statement', text: '一句话结论。', attribution: '来源' },
    { archetype: 'quote', text: '引文内容。', attribution: '出处' },
    { archetype: 'assertion', eyebrow: 'E', title: '断言标题。', lede: '论述。', kpis: [{ value: '−34%', label: 'a', tone: 'dark' }, { value: '5 → 2', label: 'b' }, { value: '17 天', label: 'c' }] },
    { archetype: 'cards', eyebrow: 'E', title: '卡片', cards: [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }, { title: 'C', body: 'c' }] },
    { archetype: 'bullets', eyebrow: 'E', title: '要点', columns: [{ heading: 'A', items: [{ lead: 'l', text: 't' }] }, { heading: 'B', items: [{ text: 't2' }] }] },
    { archetype: 'table', eyebrow: 'E', title: '表格', columns: ['时间', '事件', '维度', '意义'], widths: [1.1, 4.4, 1.6, 2.4],
      rows: [['5/24', '中国—东盟人工智能产业创新中心成立（北京）', '政策合作', '跨境合作机制化'], ['本周', 'OpenAI 基金会首批投入 2.5 亿美元', '社会责任', '关注就业转型']] },
    { archetype: 'bars', eyebrow: 'E', title: '对比', bars: [{ label: 'A', value: 17, display: '17 天', tone: 'navy' }, { label: 'B', value: 9, display: '9 天' }] },
    { archetype: 'matrix', eyebrow: 'E', title: '分诊', xLabel: '风险 →', yLabel: '↑ 金额', quadrants: ['q1', 'q2', 'q3', 'q4'],
      items: [{ u: 0.3, v: 0.7, label: 'X' }], takeaways: ['读法一'] },
    { archetype: 'timeline', eyebrow: 'E', title: '节奏', items: [{ date: 'Q1', title: '试点', note: 'n' }, { date: 'Q2', title: '铺开' }] },
    { archetype: 'imageSplit', eyebrow: 'E', title: '半版图', body: '说明。', points: ['一', '二'], image: LOGO },
    { archetype: 'imageCard', eyebrow: 'E', title: '图卡', cards: [{ image: LOGO, title: 'A', body: 'a' }, { title: 'B', body: 'b' }] },
    { archetype: 'imageFull', eyebrow: 'E', title: '满版图', caption: '图注', image: LOGO },
    { archetype: 'chart', eyebrow: 'E', title: '图表', chart: { type: 'column', categories: ['A', 'B'], series: [{ name: 's', values: [1, 2] }] }, takeaways: ['读法'] },
    { archetype: 'photoStrip', eyebrow: 'E', title: '照片带', image: LOGO, imageCredit: 'test',
      caption: '图注', body: '正文。', points: ['一', '二', '三'] },
    { archetype: 'quotePhoto', eyebrow: 'E', text: '引文。', attribution: '某人', role: '职务', image: LOGO, imageCredit: 'test' },
    { archetype: 'bentoMix', eyebrow: 'E', title: '数字 + 图', tiles: [{ value: '−34%', label: 'a' }, { value: '9.8 万', label: 'b' }],
      image: LOGO, imageCredit: 'test', caption: '图注' },
    { archetype: 'portrait', eyebrow: 'E', name: '李雯', role: '职务', credentials: ['一', '二', '三'], quote: '引文。', image: LOGO, imageCredit: 'test' },
    { archetype: 'closing', title: '谢谢', subtitle: 'Thank you' },
  ];
  const { problems, slides, lint } = buildDeckFile(all, 'all-archetypes');
  check('package is clean', problems.length === 0, problems.slice(0, 2).join(' | '));
  check('all 23 pages built', slides.length === 23, String(slides.length));
  check('no lint errors', lint.errors.length === 0, lint.errors.slice(0, 3).join(' | '));
    const otherWarnings = lint.warnings.filter((w) => !/同一张图片/.test(w));
    check('no lint warnings', otherWarnings.length === 0, otherWarnings.slice(0, 3).join(' | '));
  check("smallest type at or above 10pt", lint.stats.smallestText >= 10, lint.stats.smallestText + "pt");
}

/* ------------------------------------------------------------- 3. every chart --- */
section('charts');
{
  const types = {
    column: 'barChart', bar: 'barChart', line: 'lineChart', area: 'areaChart',
    stacked: 'barChart', stacked100: 'barChart', pie: 'pieChart', doughnut: 'doughnutChart',
    radar: 'radarChart', waterfall: 'barChart', combo: 'lineChart',
  };
  const slides = Object.keys(types).map((type) => ({
    archetype: 'chart', eyebrow: type, title: `图表 ${type}`,
    chart: type === 'waterfall'
      ? { type, start: 26, categories: ['A', 'B'], series: [{ name: 's', values: [22, 19] }], format: '0' }
      : type === 'pie' || type === 'doughnut'
        ? { type, categories: ['A', 'B'], series: [{ name: 's', values: [3, 5] }] }
        : type === 'combo'
          ? { type, categories: ['A', 'B'], series: [{ name: 'c', values: [3, 5] }, { name: 'l', values: [9, 7] }], format: '0' }
          : { type, categories: ['A', 'B'], series: [{ name: 's', values: [3, 5] }], format: '0' },
  }));
  const { problems, doc, lint } = buildDeckFile(slides, 'all-charts');
  const charts = parts(doc, /^ppt\/charts\/chart\d+\.xml$/);
  check('package is clean', problems.length === 0, problems.slice(0, 2).join(' | '));
  check('11 chart parts emitted', charts.length === 11, `${charts.length} parts`);
  check('no lint errors', lint.errors.length === 0, lint.errors.slice(0, 2).join(' | '));

  for (const [type, element] of Object.entries(types)) {
    const xml = doc.part(`ppt/charts/chart${Object.keys(types).indexOf(type) + 1}.xml`);
    check(`${type} → <c:${element}>`, xml.includes(`<c:${element}>`), 'element missing');
  }
  const waterfall = doc.part('ppt/charts/chart10.xml');
  check('waterfall uses a stacked bar + invisible base', waterfall.includes('<c:grouping val="stacked"/>') && waterfall.includes('<a:noFill/>'));
  check('doughnut omits the rejected holeSize element', !doc.part('ppt/charts/chart8.xml').includes('holeSize'));
}

/* ------------------------------------------------------------------ 4. images --- */
section('images');
{
  const { problems, doc, lint } = buildDeckFile([
    { archetype: 'imageFull', title: '满版', image: LOGO },
    { archetype: 'imageSplit', title: '半版', image: LOGO, body: '说明', points: ['一'] },
    { archetype: 'imageCard', title: '卡片', cards: [{ image: LOGO, title: 'A', body: 'a' }] },
  ], 'images');
  const media = parts(doc, /^ppt\/media\//);
  const crops = [...doc.parts.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .filter((k) => doc.part(k).includes('<a:srcRect')).length;
  check('package is clean', problems.length === 0, problems.slice(0, 2).join(' | '));
  check('one media part per distinct file (dedupe)', media.length === 1, media.length + ' parts');
  check('photos are cover-cropped, not stretched', crops >= 3, `${crops} slides with srcRect`);
  check('no lint errors', lint.errors.length === 0, lint.errors.slice(0, 2).join(' | '));
}

/* ------------------------------------------------------------ 4b. provenance --- */
section('provenance');
{
  const withCredit = buildDeckFile([{ archetype: 'imageFull', title: 'a', image: LOGO, imageCredit: 'test · internal' }], 'prov-ok');
  const without = buildDeckFile([{ archetype: 'imageFull', title: 'b', image: LOGO }], 'prov-missing');
  check('image with a credit passes', withCredit.credits.length === 0, withCredit.credits.join(' | '));
  check('image without a credit is flagged', without.credits.length === 1, without.credits.join(' | '));
}

  // lead rotation: two anchor pages in a row must not spend the same kind of focal element
  const sameLead = [
    { archetype: 'cover', title: 'a' },
    { archetype: 'imageFull', title: 'b', image: LOGO, imageCredit: 'x' },
    { archetype: 'imageSplit', title: 'c', image: LOGO, imageCredit: 'x' },
    { archetype: 'closing', title: 'd' },
  ];
  check('lead rotation flags two image anchors', checkRhythm(sameLead).issues.some((i) => i.includes('型焦点')), checkRhythm(sameLead).issues.join(' | '));
  const mixedLead = [
    { archetype: 'cover', title: 'a' },
    { archetype: 'imageFull', title: 'b', image: LOGO, imageCredit: 'x' },
    { archetype: 'bigNumber', title: 'c', value: '1', label: 'l' },
    { archetype: 'closing', title: 'd' },
  ];
  check('lead rotation passes image → number', !checkRhythm(mixedLead).issues.some((i) => i.includes('型焦点')));

/* ------------------------------------------------------------- 4c. images --- */
section('images+');
{
  const { out: cropOut, doc: cropDoc } = buildDeckFile([
    { archetype: 'imageSplit', title: 'f', image: LOGO, imageCredit: 'x', focal: 'face', body: 'b', points: ['p'] },
    { archetype: 'imageCard', title: 'r', radius: 0.18, cards: [{ image: LOGO, title: 'a', body: 'b' }] },
  ], 'imgx');
  const slides = [...cropDoc.parts.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).map((k) => cropDoc.part(k));
  check('focal crop produces a srcRect', /<a:srcRect/.test(slides[0]), 'no srcRect');
  check('rounded corner produces roundRect', /prstGeom prst="roundRect"/.test(slides[1]), 'no roundRect');
  check('rounded corner carries an adj value', /name="adj" fmla="val \d+"/.test(slides[1]), 'no adj');
  void cropOut;

  // focal offsets differ: face crops higher than centre
  const { doc: faceDoc } = buildDeckFile([{ archetype: 'imageSplit', title: 'f', image: LOGO, imageCredit: 'x', focal: 'face', body: 'b' }], 'imgf');
  const { doc: midDoc } = buildDeckFile([{ archetype: 'imageSplit', title: 'm', image: LOGO, imageCredit: 'x', body: 'b' }], 'imgm');
  const tOf = (d) => Number(/<a:srcRect[^>]*t="(\d+)"/.exec(d.part('ppt/slides/slide1.xml'))?.[1] ?? -1);
  check('face focal crops higher than centre', tOf(faceDoc) <= tOf(midDoc), tOf(faceDoc) + ' vs ' + tOf(midDoc));
}

/* ----------------------------------------------------------------- 5. rhythm --- */
section('rhythm');
{
  const flat = [{ archetype: 'cover', title: '平铺' }];
  for (let i = 0; i < 10; i++) flat.push({ archetype: 'bullets', title: `第 ${i} 页`, columns: [{ heading: 'A', items: [{ text: 't' }] }] });
  flat.push({ archetype: 'closing', title: '谢谢' });
  const flatRhythm = checkRhythm(flat);
  check('flat deck is flagged', flatRhythm.issues.length >= 2, `${flatRhythm.issues.length} issues`);

  const good = [
    { archetype: 'cover', title: 'ok' },
    { archetype: 'agenda', title: '目录', chapters: ['a', 'b', 'c'] },
    { archetype: 'hero', title: '主线' },
    { archetype: 'assertion', title: 'a', lede: 'l', kpis: [{ value: '1', label: 'x' }] },
    { archetype: 'cards', title: 'c', cards: [{ title: 'A', body: 'a' }] },
    { archetype: 'bigNumber', title: 'n', value: '12%', unit: 'u', label: 'l' },
    { archetype: 'bullets', title: 'b', columns: [{ heading: 'A', items: [{ text: 't' }] }] },
    { archetype: 'section', number: '02', title: 's' },
    { archetype: 'table', title: 't', columns: ['a', 'b'], rows: [['1', '2']] },
    { archetype: 'closing', title: '谢谢' },
  ];
  check('compliant deck passes', checkRhythm(good).issues.length === 0, checkRhythm(good).issues.join(' | '));

  const short = [{ archetype: 'cover', title: 'ok' }, { archetype: 'hero', title: 'h' }, { archetype: 'cards', title: 'c', cards: [{ title: 'A', body: 'a' }] }, { archetype: 'statement', text: 's' }, { archetype: 'closing', title: '谢谢' }];
  check('a 5-page deck is not nagged about an agenda', !checkRhythm(short).issues.some((i) => i.includes('agenda')), checkRhythm(short).issues.join(' | '));

  const longNoAgenda = [{ archetype: 'cover', title: 'ok' }, { archetype: 'hero', title: 'h' },
    ...Array.from({ length: 5 }, (_, i) => ({ archetype: 'cards', title: 'c' + i, cards: [{ title: 'A', body: 'a' }] })),
    { archetype: 'closing', title: '谢谢' }];
  check('a 7-page deck without an agenda is warned', checkRhythm(longNoAgenda).issues.some((i) => i.includes('agenda')));
}

/* ------------------------------------------------------- 6. the gates still bite --- */
section('negative');
{
  // illegal enum: the exact bug that made PowerPoint refuse a deck while our own gates said CLEAN
  const { out } = buildDeckFile([{ archetype: 'assertion', title: '断言', lede: 'l', kpis: [{ value: '1', label: 'x' }] }], 'neg');
  const doc = new ZipDoc(out);
  const slide = doc.part('ppt/slides/slide1.xml')
    .replace('algn="l"', 'algn="c"')
    .replace('anchor="t"', 'anchor="top"');
  doc.setPart('ppt/slides/slide1.xml', slide);
  const problems = validatePackage(doc);
  check('validate catches an illegal algn', problems.some((p) => p.includes('algn="c"')), problems.slice(0, 2).join(' | '));
  check('validate catches an illegal anchor', problems.some((p) => p.includes('anchor="top"')));

  // two text boxes on top of each other: pick the first two shapes that actually carry text
  // (moving a text box onto a background rectangle is legal and proves nothing)
  const { out: coverOut } = buildDeckFile([{ archetype: 'cover', title: '标题', subtitle: '副标题' }], 'neg-cover');
  const doc2 = new ZipDoc(coverOut);
  const xml = doc2.part('ppt/slides/slide1.xml');
  const sps = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).filter((s) => s.includes('<a:t>'));
  check('cover has two text shapes to collide', sps.length >= 2, `${sps.length} text shapes`);
  const firstOff = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(sps[0]);
  const moved = xml.replace(sps[1], sps[1].replace(/<a:off x="-?\d+" y="-?\d+"\/>/, `<a:off x="${firstOff[1]}" y="${firstOff[2]}"/>`));
  doc2.setPart('ppt/slides/slide1.xml', moved);
  const lint = lintPackage(doc2);
  check('lint catches text on text', lint.errors.some((e) => e.includes('重叠')), lint.errors.slice(0, 2).join(' | '));
}


/* ------------------------------------------------------------- 6b. notes --- */
section('notes');
{
  const { out: notesOut } = buildDeckFile([
    { archetype: 'chart', title: 'n', chart: { type: 'column', categories: ['a'], series: [{ name: 's', values: [1] }] }, takeaways: ['t'], source: '测试来源 ABC' },
    { archetype: 'imageFull', title: 'm', image: LOGO, imageCredit: '测试许可 XYZ' },
  ], 'notes');
  const doc = new ZipDoc(notesOut);
  const notes = [...doc.parts.keys()].filter((k) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(k));
  check('speaker notes are written', notes.length === 2, notes.length + ' notes parts');
  const all = notes.map((k) => doc.part(k)).join('');
  check('notes carry the data source', all.includes('测试来源 ABC'));
  check('notes carry the image licence', all.includes('测试许可 XYZ'));
  check('notes master restored', doc.has('ppt/notesMasters/notesMaster1.xml'));
}

/* -------------------------------------------------------------- 7b. skins --- */
section('skins');
{
  const skinSlides = [
    { archetype: 'hero', eyebrow: 'E', title: 'sk', body: 'b', stat: '3', statLabel: 'l' },
    { archetype: 'cards', title: 'c', cards: [{ title: 'A', body: 'a' }] },
  ];
  for (const style of ['editorial', 'tech', 'minimal']) {
    const skinOut = path.join(OUT, `skin-${style}.pptx`);
    const sk = buildDeck({ out: skinOut, slides: skinSlides, footerTitle: style, style });
    check(`${style}: package is clean`, sk.problems.length === 0, sk.problems.slice(0, 2).join(' | '));
    check(`${style}: no lint errors`, sk.lint.errors.length === 0, sk.lint.errors.slice(0, 2).join(' | '));
  }
  const skinDoc = new ZipDoc(path.join(OUT, 'skin-editorial.pptx'));
  const layouts = [...skinDoc.parts.keys()].filter((k) => /^ppt\/slideLayouts\//.test(k)).map((k) => skinDoc.part(k)).join('');
  check('free-style layouts stay minimal (no motif)', layouts.length < 4000, layouts.length + ' bytes');
}


/* -------------------------------------------------------------- 7c. table+ --- */
section('table+');
{
  const spanTable = {
    archetype: 'table', title: 't',
    columns: ['业务', '指标', 'Q3', 'Q2'], widths: [1.6, 2.6, 2, 2],
    rows: [
      [{ text: '汽车', rowspan: 2, bold: true }, '营收', '28.05', '28.24'],
      ['毛利率', '18.1%', '16.3%'],
      [{ text: '收入', colspan: 4, bold: true }],
      ['能源', '部署', '13.7', '13.5'],
    ],
  };
  const rb = buildDeckFile([spanTable], 'table+');
  check('table+ builds cleanly', rb.problems.length === 0, rb.problems.slice(0, 2).join(' | '));
  check('table+ has no lint errors', rb.lint.errors.length === 0, rb.lint.errors.slice(0, 2).join(' | '));
  const tx = rb.doc.part('ppt/slides/slide1.xml');
  const cell = /name="Cell 1-1"[\s\S]*?<a:ext cx="\d+" cy="(\d+)"/.exec(tx);
  const cy = cell ? Number(cell[1]) : 0;
  check('rowspan cell spans two rows', cy > 600000, cy + ' EMU tall');
  check('colspan row is one wide cell', /name="Cell 3-1"/.test(tx) && !/name="Cell 3-2"/.test(tx));
}


/* ---------------------------------------------------------------- 8. mode --- */
section('mode');
{
  // the gate lives in lib/index.js (the tool); the library itself stays usable from tests
  const entry = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8');
  check("tool refuses without a mode", entry.includes("mode !== 'suez' && mode !== 'free'"));
  check('free mode demands hand-made pages', entry.includes('每一页都必须是 heroHtml'));
  check('mode is a required parameter', entry.includes("required: ['spec', 'out', 'mode']"));
}

/* ------------------------------------------------------------- 7d. editing --- */
section('editing');
{
  const built = buildDeckFile([
    { archetype: 'statement', text: '原始句子' },
    { archetype: 'bullets', title: '第二页', columns: [{ heading: 'A', items: [{ text: 'x' }] }] },
  ], 'edit-src');
  const editPath = path.join(SCRIPTS, 'edit-pptx.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:');
  const editMod = await import(editPath);
  const outEdit = path.join(OUT, 'edit-dst.pptx');
  const r = editMod.editPptx({
    input: built.out,
    out: outEdit,
    ops: [
      { op: 'setText', slide: 1, shape: 'Statement', text: '改过的句子' },
      { op: 'duplicateSlide', slide: 2 },
    ],
  });
  check('edit writes a new file', Boolean(r.out) && fs.existsSync(outEdit), r.problems.slice(0, 2).join(' | '));
  check('edit keeps the package clean', r.problems.length === 0, r.problems.slice(0, 2).join(' | '));
  const edited = new ZipDoc(outEdit);
  const editedSlides = [...edited.parts.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
  check('duplicateSlide adds a page', editedSlides.length === 3, editedSlides.length + ' slides');
  check('edit: text is replaced', edited.part('ppt/slides/slide1.xml').includes('改过的句子'));
  check('edit: original text is gone', !edited.part('ppt/slides/slide1.xml').includes('原始句子'));
  let refused = false;
  try { editMod.editPptx({ input: built.out, out: built.out, ops: [{ op: 'removeSlide', slide: 1 }] }); } catch { refused = true; }
  check('edit refuses to overwrite its input', refused);
}

const docxBuilder = await import(path.join(SCRIPTS, 'build-docx.mjs').replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const xlsxBuilder = await import(path.join(SCRIPTS, 'build-xlsx.mjs').replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const editDocxMod = await import(path.join(SCRIPTS, 'edit-docx.mjs').replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const editXlsxMod = await import(path.join(SCRIPTS, 'edit-xlsx.mjs').replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
/* ---------------------------------------------------------- 9. docx / xlsx --- */
section('docx+xlsx');
{
  const docxMod = await import(path.join(SCRIPTS, 'build-docx.mjs').replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const outDocx = path.join(OUT, 'docx-t.docx');
  const d = docxMod.buildDocx({
    out: outDocx,
    title: '标题', subtitle: '副标题', header: '页眉', footer: '页脚',
    sections: [{ heading: '一、章节', paragraphs: ['正文'], bullets: ['要点'], table: { columns: ['A', 'B'], rows: [['x', '1']] } }],
  });
  check('docx: builds a clean package', d.parts > 5, String(d.parts));
  const dx = new ZipDoc(outDocx);
  const px = [...checkPackageIntegrity(dx.parts, { checkXml: true }), ...checkStructure(dx.parts)];
  check('docx: package gates pass', px.length === 0, px.slice(0, 2).join(' | '));
  check('docx: body carries the text', dx.part('word/document.xml').includes('正文'));
  check('docx: table is a real table', dx.part('word/document.xml').includes('<w:tbl>'));
  check('docx: header part exists', dx.has('word/header1.xml'));

  const xlsxMod = await import(path.join(SCRIPTS, 'build-xlsx.mjs').replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const outXlsx = path.join(OUT, 'xlsx-t.xlsx');
  const x = xlsxMod.buildXlsx({ out: outXlsx, title: 't', sheets: [
    { name: 'S1', header: ['指标', '值'], columns: [{ width: 20 }, { width: 12, type: 'number' }], rows: [['营收', 28.05]] },
    { name: 'S2', header: ['说明'], rows: [['口径']] },
  ] });
  check('xlsx: builds two sheets', x.sheets.length === 2, x.sheets.join(','));
  const xx = new ZipDoc(outXlsx);
  const pxx = [...checkPackageIntegrity(xx.parts, { checkXml: true }), ...checkStructure(xx.parts)];
  check('xlsx: package gates pass', pxx.length === 0, pxx.slice(0, 2).join(' | '));
  check('xlsx: header row is styled navy', xx.part('xl/styles.xml').includes('FF030F40'));
  check('xlsx: the number lands in a numeric cell', xx.part('xl/worksheets/sheet1.xml').includes('<v>28.05</v>'));
}

/* ------------------------------------------------------- 10. edit docx/xlsx --- */
section('edit-docx+xlsx');
{
  const srcDocx = path.join(OUT, 'ed-src.docx');
  docxBuilder.buildDocx({ out: srcDocx, title: 'T', sections: [{ heading: '一、旧标题', paragraphs: ['旧正文'], table: { columns: ['A', 'B'], rows: [['x', '1']] } }] });
  const dstDocx = path.join(OUT, 'ed-dst.docx');
  const rd = editDocxMod.editDocx({ input: srcDocx, out: dstDocx, ops: [
    { op: 'setParagraph', match: '旧正文', text: '新正文' },
    { op: 'setTableCell', table: 1, row: 2, col: 2, text: '2' },
  ] });
  check('docx edit keeps the package clean', rd.problems.length === 0 && Boolean(rd.out), rd.problems.slice(0, 2).join(' | '));
  const dx2 = new ZipDoc(dstDocx);
  check('docx: paragraph text is replaced', dx2.part('word/document.xml').includes('新正文'));
  check('docx: old paragraph text is gone', !dx2.part('word/document.xml').includes('旧正文'));
  check('docx: table cell is replaced', dx2.part('word/document.xml').includes('>2</w:t>'));

  const srcXlsx = path.join(OUT, 'ed-src.xlsx');
  xlsxBuilder.buildXlsx({ out: srcXlsx, sheets: [{ name: 'S1', header: ['指标', '值'], columns: [{ width: 20 }, { width: 12, type: 'number' }], rows: [['营收', 28.05]] }] });
  const dstXlsx = path.join(OUT, 'ed-dst.xlsx');
  const rx = editXlsxMod.editXlsx({ input: srcXlsx, out: dstXlsx, ops: [
    { op: 'setCell', sheet: 'S1', cell: 'B2', value: 29.42 },
    { op: 'setCell', sheet: 'S1', cell: 'A3', value: '毛利率', type: 'text' },
  ] });
  check('xlsx edit keeps the package clean', rx.problems.length === 0 && Boolean(rx.out), rx.problems.slice(0, 2).join(' | '));
  const xx2 = new ZipDoc(dstXlsx);
  const sheet1 = xx2.part('xl/worksheets/sheet1.xml');
  check('xlsx: cell value is replaced', sheet1.includes('<v>29.42</v>'));
  check('xlsx: new row is added', sheet1.includes('A3'));
  check('xlsx: dimension grows with the sheet', sheet1.includes('A1:B3'));
}

/* --------------------------------------------------------- 11. revisions --- */
section('revisions');
{
  const cleanMod = await import(path.join(SCRIPTS, 'clean-docx.mjs').replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const dirty = '<w:p><w:pPr><w:pPrChange w:id="9"><w:pPr/></w:pPrChange></w:pPr>' +
    '<w:commentRangeStart w:id="0"/><w:ins w:id="1" w:author="A"><w:r><w:t>新增</w:t></w:r></w:ins>' +
    '<w:r><w:t>原文</w:t></w:r><w:del w:id="2" w:author="A"><w:r><w:delText>删除</w:delText></w:r></w:del>' +
    '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>';
  const acc = cleanMod.acceptRevisionsXml(dirty);
  check('revisions: insertions are flattened', acc.flattened === 1 && acc.xml.includes('新增'));
  check('revisions: deletions are dropped', acc.removed === 1 && !acc.xml.includes('删除'));
  check('revisions: PrChange records are gone', !acc.xml.includes('pPrChange'));
  const st = cleanMod.stripCommentsXml(acc.xml);
  check('comments: anchors and references are removed', st.count >= 3 && !/commentRange|commentReference/.test(st.xml));
  check('comments: body text survives', st.xml.includes('原文'));

  const outClean = path.join(OUT, 'clean-noop.docx');
  docxBuilder.buildDocx({ out: path.join(OUT, 'clean-src.docx'), title: 'T', sections: [{ heading: 'H', paragraphs: ['P'] }] });
  const rc = cleanMod.cleanDocx({ input: path.join(OUT, 'clean-src.docx'), out: outClean, acceptRevisions: true, stripComments: true });
  check('clean keeps a clean document valid', rc.problems.length === 0 && Boolean(rc.out), rc.problems.slice(0, 2).join(' | '));
}

const dumpMod = await import(path.join(SCRIPTS, 'dump.mjs').replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
/* ----------------------------------------------------------- 12. comments --- */
section('comments');
{
  const cmMod = await import(path.join(SCRIPTS, 'comment-docx.mjs').replace(/\\\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const commentSrc = path.join(OUT, 'cm-src.docx');
  docxBuilder.buildDocx({ out: commentSrc, title: 'T', sections: [{ heading: '一、锚点段落', paragraphs: ['正文'] }] });
  const commentOut = path.join(OUT, 'cm-out.docx');
  const cr = cmMod.addDocxComment({ input: commentSrc, out: commentOut, match: '一、锚点段落', text: '这里要确认', author: 'Rio' });
  check('comment: written cleanly', cr.problems.length === 0 && Boolean(cr.out), cr.problems.slice(0, 2).join(' | '));
  const cdoc = new ZipDoc(commentOut);
  check('comment: part exists', cdoc.has('word/comments.xml'));
  check('comment: anchor is in the document', cdoc.part('word/document.xml').includes('<w:commentRangeStart'));
  check('comment: body carries the text', cdoc.part('word/comments.xml').includes('这里要确认'));
  const dumped = dumpMod.dumpDocx(commentOut);
  check('comment: written and readable back', dumped.includes('1 comments') && dumped.includes('这里要确认'));
}

/* ------------------------------------------------------------- 13. formulas --- */
section('formulas');
{
  const fx = path.join(OUT, 'fx.xlsx');
  xlsxBuilder.buildXlsx({ out: fx, sheets: [{ name: 'S1', header: ['A', 'B'], columns: [{ width: 20 }, { width: 12, type: 'number' }], rows: [['x', 1], ['y', 2], ['sum', '=SUM(B2:B3)']] }] });
  const fdoc = new ZipDoc(fx);
  check('xlsx: formula cells are written', fdoc.part('xl/worksheets/sheet1.xml').includes('<f>SUM(B2:B3)</f>'));
  check('xlsx: workbook asks for a recalc on load', fdoc.part('xl/workbook.xml').includes('fullCalcOnLoad="1"'));
  const fx2 = path.join(OUT, 'fx2.xlsx');
  const rx2 = editXlsxMod.editXlsx({ input: fx, out: fx2, ops: [{ op: 'setCell', sheet: 'S1', cell: 'B4', value: 0, formula: '=SUM(B2:B3)' }] });
  check('xlsx: edit can write a formula into a new row', rx2.problems.length === 0 && new ZipDoc(fx2).part('xl/worksheets/sheet1.xml').includes('<f>SUM(B2:B3)</f>'), rx2.problems.slice(0, 2).join(' | '));
}

/* --------------------------------------------------------------- 15. lint --- */
section('lint-pages');
{
  // 12 slides, the crowded one is #11: the warning must say 第 11 页 (a lexicographic sort said 第 3 页)
  const long = '这是一段很长的正文。'.repeat(80);
  const many = [];
  for (let i = 1; i <= 12; i += 1) {
    many.push(i === 11 ? { archetype: 'bullets', title: 'p11', columns: [{ heading: 'A', items: [{ text: long }] }] } : { archetype: 'statement', text: 'p' + i });
  }
  const r = buildDeck({ seed: SEED, out: path.join(OUT, 'lint-pages.pptx'), footerTitle: 'x', slides: many });
  const msg = r.lint.warnings.find((w) => /文字/.test(w)) ?? '';
  check('lint: page numbers follow slide order', msg.includes('第 11 页'), msg.slice(0, 30));

  const dup = buildDeck({ seed: SEED, out: path.join(OUT, 'lint-dup.pptx'), footerTitle: 'x', slides: [
    { archetype: 'imageSplit', title: 'a', image: LOGO, imageCredit: 'x', body: 'b', points: ['p'] },
    { archetype: 'imageFull', title: 'b', image: LOGO, imageCredit: 'x', caption: 'c' },
  ] });
  const dupMsg = dup.lint.warnings.find((w) => /同一张图片/.test(w)) ?? '';
  check('lint: the same picture on two slides is flagged', dupMsg.includes('第 1、2 页'), dupMsg.slice(0, 40));
}

section('cover-fitting');
{
  const longSub = '特斯拉 2026 年第三季度财报速读：毛利在修复，费用在膨胀，而且这句副标题足够长到必须换行';
  const out = path.join(OUT, 'cover-long.pptx');
  const built = buildDeck({ seed: SEED, out, footerTitle: 'x', slides: [{ archetype: 'cover', title: '营收持平，利润腰斩', subtitle: longSub, meta: '2026 年 10 月 21 日盘后发布 · 来源：Tesla IR' }] });
  const cd = new ZipDoc(out);
  const s1 = cd.part('ppt/slides/slide1.xml');
  const i = s1.indexOf('Sous-titre 2');
  const blk = s1.slice(i, i + 900);
  const off = /<a:off x="-?\d+" y="(-?\d+)"\/>/.exec(blk);
  const ext = /<a:ext cx="-?\d+" cy="(-?\d+)"\/>/.exec(blk);
  const y = Number(off[1]) / 914400;
  const h = Number(ext[1]) / 914400;
  check('cover: subtitle box grows for two lines', h >= 0.55, h.toFixed(2) + 'in tall');
  check('cover: the block stays on the slide', y >= 0 && y + h <= 5.2, y.toFixed(2) + '+' + h.toFixed(2));
  check('cover: a too-long subtitle is called out', /副标题 .* 字偏长/.test(built.lint.warnings.join(' ')), built.lint.warnings.join(' ').slice(0, 40));
}

section('built-in-seed');
{
  const out = path.join(OUT, 'builtin-seed.pptx');
  const r = buildDeck({ out, footerTitle: 'x', slides: [{ archetype: 'statement', text: '不传 seed' }] });
  check('built-in seed is used when none is passed', r.problems.length === 0 && fs.existsSync(out), r.problems.slice(0, 2).join(' | '));
  const d = new ZipDoc(out);
  check('built-in seed keeps the SUEZ masters', [...d.parts.keys()].filter((k) => /slideMasters\/slideMaster\d+\.xml$/.test(k)).length >= 3);
}
/* -------------------------------------------------------------------- report --- */
const failed = results.filter((r) => r.ok === false);
for (const r of results) {
  if (r.section) console.log(`\n${r.section}`);
  else if (r.ok) console.log(`  PASS  ${r.name}`);
  else console.log(`  FAIL  ${r.name}${r.detail ? '  ← ' + r.detail : ''}`);
}

if (RENDER) {
  const { renderPage } = await import(path.join(here, '..', 'lib', 'render.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
  const file = path.join(OUT, 'all-charts-2.pptx');
  const img = await renderPage({ script: path.join(SCRIPTS, 'qa_render.ps1'), file, page: 1, out: path.join(OUT, 'smoke.png') });
  console.log(`\nrender smoke: ${Math.round(img.bytes / 1024)} KB in ${(img.elapsedMs / 1000).toFixed(1)} s`);
}

console.log(`\n${failed.length === 0 ? 'ALL GREEN' : failed.length + ' FAILED'} — ${results.filter((r) => !r.section).length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
