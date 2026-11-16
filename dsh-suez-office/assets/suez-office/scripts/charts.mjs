import fs from 'node:fs';
import path from 'node:path';
/**
 * DSH-SUEZ-Office · native charts.
 *
 * Eleven types, all as real `c:chartSpace` parts — the numbers stay editable in PowerPoint,
 * nothing is a picture, and no rendering step is needed to see the chart.
 *
 *   column · bar · line · area · stacked · stacked100 · pie · doughnut · radar · waterfall · combo
 *
 * Two rules learned the hard way:
 *   - `c:ser` children are ORDERED by the schema (idx, order, tx, spPr, invertIfNegative, dPt,
 *     dLbls, cat, val). Getting it wrong makes PowerPoint declare the file corrupt, not the chart.
 *   - axes must come after every chart group inside `c:plotArea`.
 */

const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const PALETTE = ['030F40', 'AADC14', '77B7FC', 'F67536', 'FFC229', '80B1E0', '5900B1', '333F55'];

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Label / axis typography, in the brand pair. */
const txPr = (size = 900, color = '5A6B8C') =>
  `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}">` +
  `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
  `<a:latin typeface="Poppins" panose="020B0604020202020204" pitchFamily="34" charset="0"/>` +
  `<a:ea typeface="方正准圆_GBK" panose="02010600030101010101" pitchFamily="18" charset="-122"/>` +
  `</a:defRPr></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr>`;

const strCache = (cats) =>
  `<c:strCache><c:ptCount val="${cats.length}"/>` +
  cats.map((c, i) => `<c:pt idx="${i}"><c:v>${esc(c)}</c:v></c:pt>`).join('') +
  `</c:strCache>`;

const numCache = (values, format) =>
  `<c:numCache><c:formatCode>${esc(format)}</c:formatCode><c:ptCount val="${values.length}"/>` +
  values.map((v, i) => `<c:pt idx="${i}"><c:v>${Number(v)}</c:v></c:pt>`).join('') +
  `</c:numCache>`;

const catRef = (cats, col = 'A') => `<c:cat><c:strRef><c:f>Sheet1!$${col}$2:$${col}$${cats.length + 1}</c:f>${strCache(cats)}</c:strRef></c:cat>`;
const valRef = (values, col, format) => `<c:val><c:numRef><c:f>Sheet1!$${col}$2:$${col}$${values.length + 1}</c:f>${numCache(values, format)}</c:numRef></c:val>`;

const serHead = (i, name, color, txCol, { stroke = false, fill = true } = {}) =>
  `<c:idx val="${i}"/><c:order val="${i}"/>` +
  `<c:tx><c:strRef><c:f>Sheet1!${txCol}$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
  `<c:spPr>` +
  (fill ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : '<a:noFill/>') +
  (stroke ? `<a:ln w="28575"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>') +
  `</c:spPr>`;

const dLbls = (format, { position = 'outEnd', percent = false } = {}) =>
  `<c:dLbls><c:numFmt formatCode="${esc(format)}" sourceLinked="0"/>` +
  `<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900, '030F40')}` +
  `<c:dLblPos val="${position}"/><c:showLegendKey val="0"/><c:showVal val="${percent ? 0 : 1}"/>` +
  `<c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="${percent ? 1 : 0}"/>` +
  `<c:showBubbleSize val="0"/></c:dLbls>`;

const catAx = (id, crossId, { hidden = false, crosses = null } = {}) =>
  `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
  `<c:delete val="${hidden ? 1 : 0}"/><c:axPos val="b"/>` +
  `<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
  `${txPr()}<c:crossAx val="${crossId}"/>${crosses ? `<c:crosses val="${crosses}"/>` : ''}</c:catAx>`;

const valAx = (id, crossId, { format = 'General', gridlines = true, hidden = false, secondary = false, crosses = null, zero = false, crossBetween = 'between' } = {}) =>
  `<c:valAx><c:axId val="${id}"/><c:scaling>${zero ? '<c:min val="0"/>' : ''}<c:orientation val="minMax"/></c:scaling>` +
  `<c:delete val="${hidden ? 1 : 0}"/><c:axPos val="${secondary ? 'r' : 'l'}"/>` +
  (gridlines
    ? `<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9E0EA"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>`
    : '') +
  `<c:numFmt formatCode="${esc(format)}" sourceLinked="0"/>` +
  `<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
  `${txPr()}<c:crossAx val="${crossId}"/>${crosses ? `<c:crosses val="${crosses}"/>` : ''}${crossBetween ? `<c:crossBetween val="${crossBetween}"/>` : ''}</c:valAx>`;

const legend = (pos = 'b') => `<c:legend><c:legendPos val="${pos}"/><c:overlay val="0"/>${txPr()}</c:legend>`;

/* --------------------------------------------------------------- chart groups --- */

function barGroup({ type, categories, series, format }) {
  const dir = type === 'bar' ? 'bar' : 'col';
  const grouping = type === 'stacked' ? 'stacked' : type === 'stacked100' ? 'percentStacked' : 'clustered';
  const sers = series.map((s, i) => {
    const color = s.color ?? PALETTE[i % PALETTE.length];
    return `<c:ser>${serHead(i, s.name, color, String.fromCharCode(66 + i))}<c:invertIfNegative val="0"/>` +
      (type === 'stacked100' || type === 'stacked' ? dLbls(format, { position: 'ctr' }) : dLbls(format)) +
      `${catRef(categories)}${valRef(s.values, String.fromCharCode(66 + i), format)}</c:ser>`;
  }).join('');
  return `<c:barChart><c:barDir val="${dir}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>` +
    sers + `<c:gapWidth val="60"/>` + (grouping === 'stacked' || grouping === 'percentStacked' ? '<c:overlap val="100"/>' : '') +
    `<c:axId val="1"/><c:axId val="2"/></c:barChart>`;
}

function lineGroup({ categories, series, format, area = false }) {
  const sers = series.map((s, i) => {
    const color = s.color ?? PALETTE[i % PALETTE.length];
    return `<c:ser>${serHead(i, s.name, color, String.fromCharCode(66 + i), { stroke: true, fill: area })}<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr></c:marker>` +
      dLbls(format, { position: area ? 'ctr' : 't' }) +
      `${catRef(categories)}${valRef(s.values, String.fromCharCode(66 + i), format)}` +
      `<c:smooth val="0"/></c:ser>`;
  }).join('');
  if (area) {
    // CT_AreaSer has no marker and no smooth: including either makes PowerPoint reject the chart,
    // and a rejected chart takes the whole file with it ("could not open").
    const areaSers = series.map((s, i) => {
      const color = s.color ?? PALETTE[i % PALETTE.length];
      return `<c:ser>${serHead(i, s.name, color, String.fromCharCode(66 + i), { fill: true })}` +
        `${catRef(categories)}${valRef(s.values, String.fromCharCode(66 + i), format)}</c:ser>`;
    }).join('');
    return `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>` + areaSers +
      `<c:axId val="1"/><c:axId val="2"/></c:areaChart>`;
  }
  return `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>` + sers +
    `<c:marker val="1"/><c:axId val="1"/><c:axId val="2"/></c:lineChart>`;
}

function pieGroup({ type, categories, series, format }) {
  const s = series[0];
  const total = s.values.reduce((a, b) => a + Number(b), 0) || 1;
  const points = categories.map((c, i) => {
    const color = PALETTE[i % PALETTE.length];
    return `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
      `<a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`;
  }).join('');
  const ser = `<c:ser><c:idx val="0"/><c:order val="0"/>` +
    `<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(s.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
    points +
    `<c:dLbls><c:numFmt formatCode="0%" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900, 'FFFFFF')}` +
    `<c:dLblPos val="ctr"/><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="1"/>` +
    `<c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/></c:dLbls>` +
    `${catRef(categories)}${valRef(s.values, 'B', format)}</c:ser>`;
  void total;
  if (type === 'doughnut') {
    // No explicit <c:holeSize>: this PowerPoint build rejects the element ("file corrupted",
    // 0x80070570) in both the "55" and the "50%" spelling, while the default hole renders fine.
    return `<c:doughnutChart><c:varyColors val="1"/>${ser}</c:doughnutChart>`;
  }
  return `<c:pieChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/></c:pieChart>`;
}

function radarGroup({ categories, series, format }) {
  const sers = series.map((s, i) => {
    const color = s.color ?? PALETTE[i % PALETTE.length];
    return `<c:ser>${serHead(i, s.name, color, String.fromCharCode(66 + i), { stroke: true, fill: false })}<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr></c:marker>` +
      `${catRef(categories)}${valRef(s.values, String.fromCharCode(66 + i), format)}</c:ser>`;
  }).join('');
  return `<c:radarChart><c:radarStyle val="marker"/><c:varyColors val="0"/>${sers}<c:axId val="1"/><c:axId val="2"/></c:radarChart>`;
}

/**
 * Waterfall: a stacked bar with an invisible base series.
 *
 * Input is the **level after each step** plus the starting level, not the deltas. That is not a
 * stylistic choice: PowerPoint stacks upward from zero and separates the two signs, so a negative
 * base does not "hang" below a positive segment — it simply detaches. Levels keep every number
 * non-negative, which is the only shape that stacks correctly.
 *
 * Colours and labels are per point (dPt / rich dLbl) because one series carries drops and gains.
 */
function waterfallGroup({ categories, series, format, start = 0, upColor = '77B7FC', downColor = 'F67536' }) {
  const levels = series[0].values.map(Number);
  const cats = [...categories, '合计'];
  const base = [];
  const size = [];
  const dpts = [];
  const labels = [];
  let prev = Number(series[0].start ?? start ?? 0);

  // The total bar is navy, so its label has to be white — a navy label on a navy bar is an
  // invisible number, which is exactly how the first version shipped.
  const richLabel = (idx, text, color = '030F40') =>
    '<c:dLbl><c:idx val="' + idx + '"/><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr>' +
    '<a:defRPr sz="900"><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill></a:defRPr></a:pPr>' +
    '<a:r><a:rPr lang="zh-CN" sz="900"><a:solidFill><a:srgbClr val="' + color + '"/></a:solidFill></a:rPr><a:t>' +
    esc(text) +
    '</a:t></a:r></a:p></c:rich></c:tx><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
    '<c:dLblPos val="ctr"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/>' +
    '<c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbl>';

  levels.forEach((level, i) => {
    const delta = level - prev;
    base.push(Math.min(prev, level));
    size.push(Math.abs(delta) || 0.001);
    // a drop in days is the good outcome, so a decrease is lime and an increase is orange
    dpts.push(
      '<c:dPt><c:idx val="' + i + '"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="' +
        (delta <= 0 ? downColor : upColor) +
        '"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:dPt>',
    );
    labels.push(richLabel(i, (delta > 0 ? '+' : '−') + Math.abs(delta)));
    prev = level;
  });
  const final = levels.length ? levels[levels.length - 1] : prev;
  base.push(0);
  size.push(final);
  dpts.push(
    '<c:dPt><c:idx val="' + levels.length + '"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="030F40"/>' +
      '</a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:dPt>',
  );
  labels.push(richLabel(levels.length, String(final), 'FFFFFF'));

  const baseSer =
    '<c:ser><c:idx val="0"/><c:order val="0"/>' +
    '<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>base</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>' +
    catRef(cats) + valRef(base, 'B', format) + '</c:ser>';

  const deltaSer =
    '<c:ser><c:idx val="1"/><c:order val="1"/>' +
    '<c:tx><c:strRef><c:f>Sheet1!$C$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>变化</c:v></c:pt></c:strCache></c:strRef></c:tx>' +
    '<c:spPr><a:solidFill><a:srgbClr val="AADC14"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>' +
    '<c:invertIfNegative val="0"/>' +
    dpts.join('') +
    '<c:dLbls>' + labels.join('') + '</c:dLbls>' +
    catRef(cats) + valRef(size, 'C', format) + '</c:ser>';

  return (
    '<c:barChart><c:barDir val="col"/><c:grouping val="stacked"/><c:varyColors val="0"/>' +
    baseSer + deltaSer +
    '<c:gapWidth val="55"/><c:overlap val="100"/><c:axId val="1"/><c:axId val="2"/></c:barChart>'
  );
}

/** Column + line on a secondary axis. */
function comboGroup({ categories, series, format }) {
  const col = series[0];
  const lines = series.slice(1);
  const colSer = `<c:ser>${serHead(0, col.name, col.color ?? '030F40', 'B')}<c:invertIfNegative val="0"/>` +
    dLbls(format) + `${catRef(categories)}${valRef(col.values, 'B', format)}</c:ser>`;

  const lineSers = lines.map((s, i) => {
    const idx = i + 1;
    const color = s.color ?? PALETTE[(idx + 1) % PALETTE.length];
    const colLetter = String.fromCharCode(66 + idx);
    return `<c:ser>${serHead(idx, s.name, color, colLetter, { stroke: true, fill: false })}<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr></c:marker>` +
      `${catRef(categories)}${valRef(s.values, colLetter, format)}<c:smooth val="0"/></c:ser>`;
  }).join('');

  return (
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>` +
    colSer + `<c:gapWidth val="70"/><c:axId val="1"/><c:axId val="2"/></c:barChart>` +
    `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>` +
    lineSers + `<c:marker val="1"/><c:axId val="3"/><c:axId val="4"/></c:lineChart>`
  );
}

/* ------------------------------------------------------------------- public --- */

/**
 * @param {object} o
 * @param {string} [o.type]        column|bar|line|area|stacked|stacked100|pie|doughnut|radar|waterfall|combo
 * @param {string[]} o.categories
 * @param {Array<{name: string, values: number[], color?: string}>} o.series
 * @param {string} [o.format]      number format for values, e.g. '0"天"'
 * @param {boolean} [o.legend]     default: on when there is more than one series, or a pie
 */
export function chartXml(o) {
  const type = o.type ?? 'column';
  const categories = o.categories ?? [];
  const series = (o.series ?? []).filter((s) => Array.isArray(s.values) && s.values.length);
  const format = o.format ?? 'General';
  // gantt carries 	asks instead of series\n  if (!['gantt', 'scatter', 'bubble'].includes(type) && !series.length) throw new Error('chart series is empty');

  const multi = series.length > 1;
  const showLegend = o.legend ?? (multi || type === 'pie' || type === 'doughnut');

  let groups;
  let axes;
  switch (type) {
    case 'column':
    case 'bar':
    case 'stacked':
    case 'stacked100':
      groups = barGroup({ type, categories, series, format });
      axes = catAx(1, 2) + valAx(2, 1, { format });
      break;
    case 'line':
      groups = lineGroup({ categories, series, format });
      axes = catAx(1, 2) + valAx(2, 1, { format });
      break;
    case 'area':
      groups = lineGroup({ categories, series, format, area: true });
      axes = catAx(1, 2) + valAx(2, 1, { format });
      break;
    case 'pie':
    case 'doughnut':
      groups = pieGroup({ type, categories, series, format });
      axes = '';
      break;
    case 'radar':
      groups = radarGroup({ categories, series, format });
      axes = catAx(1, 2) + valAx(2, 1, { format, gridlines: false });
      break;
    case 'waterfall':
      groups = waterfallGroup({ categories, series, format, start: o.start ?? 0, upColor: o.upColor, downColor: o.downColor });
      axes = catAx(1, 2) + valAx(2, 1, { format });
      break;
      case 'gantt':
        groups = ganttGroup({ tasks: o.tasks ?? [], format });
        axes = catAx(1, 2) + valAx(2, 1, { format });
        break;
      case 'funnel':
        groups = funnelGroup({ categories, series, format });
        axes = catAx(1, 2) + valAx(2, 1, { format, zero: true });
        break;
    case 'combo':
      groups = comboGroup({ categories, series, format });
      // primary pair (1,2) + a hidden secondary category axis (3) and a visible secondary value axis (4)
      axes = catAx(1, 2) + valAx(2, 1, { format, zero: true }) + catAx(3, 4, { hidden: true, crosses: 'max' }) + valAx(4, 3, { format, gridlines: false, secondary: true, crosses: 'max' });
      break;
    default:
      throw new Error(`unknown chart type "${type}" (have: column|bar|line|area|stacked|stacked100|pie|doughnut|radar|waterfall|combo)`);
  }

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
    `<c:roundedCorners val="0"/><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/>` +
    groups + axes +
    `</c:plotArea>` + (showLegend ? legend(type === 'pie' || type === 'doughnut' ? 'r' : 'b') : '') +
    `<c:plotVisOnly val="1"/></c:chart></c:chartSpace>`
  );
}


/* ------------------------------------------------------- scatter / bubble --- */
/**
 * These two are not built by hand: PowerPoint silently drops a hand-written scatter/bubble plot.
 * The chart part comes from a PowerPoint-generated reference (assets/charts/*.xml) and only the
 * series cache is filled in, so axis ids, crosses and extLst stay exactly as PowerPoint wants them.
 */
function refChart(kind, series, format) {
  const tpl = fs.readFileSync(path.join(import.meta.dirname, '..', 'charts', kind + '.xml'), 'utf8');
  const s = series[0] ?? { points: [] };
  const pts = s.points ?? [];
  const fmt = format && format !== 'General' ? format : 'General';
  const caches = [pts.map((p) => p[0]), pts.map((p) => p[1]), pts.map((p) => p[2] ?? 10)];
  const cols = ['C', 'D', 'E'];

  // rewrite the numeric caches only, in document order: xVal, yVal, bubbleSize
  let i = 0;
  const xml = tpl.replace(/<c:numCache>[\s\S]*?<\/c:numCache>/g, () => {
    const values = caches[i] ?? caches[0];
    const col = cols[i] ?? 'C';
    i += 1;
    const pts2 = values.map((v, k) => `<c:pt idx="${k}"><c:v>${v}</c:v></c:pt>`).join('');
    return `<c:numCache><c:formatCode>${fmt}</c:formatCode><c:ptCount val="${values.length}"/>${pts2}</c:numCache>`;
  });

  // the formula ranges have to match the new counts
  let r = 0;
  const withRefs = xml.replace(/<c:f>Sheet1!\$[A-Z]\$\d+:\$[A-Z]\$\d+<\/c:f>/g, () => {
    const col = cols[r] ?? 'C';
    const len = (caches[r] ?? caches[0]).length;
    r += 1;
    return `<c:f>Sheet1!$${col}$2:$${col}$${len + 1}</c:f>`;
  });

  return withRefs.replace('<c:v>demo</c:v>', `<c:v>${String(s.name ?? 'series')}</c:v>`);
}
function scatterGroup({ series, format }) { return refChart('scatter', series, format); }
function bubbleGroup({ series, format }) { return refChart('bubble', series, format); }
/** Backwards-compatible alias (the first version only had columns). */
export const columnChartXml = chartXml;

/** The slide-side frame that points at a chart part. */
export function chartFrame(id, name, { x, y, w, h, rId }) {
  const inch = (v) => Math.round(v * 914400);
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(name)}"/>` +
    `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="${inch(x)}" y="${inch(y)}"/><a:ext cx="${inch(w)}" cy="${inch(h)}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart xmlns:c="${C_NS}" xmlns:r="${R_NS}" r:id="${rId}"/>` +
    `</a:graphicData></a:graphic></p:graphicFrame>`
  );
}
