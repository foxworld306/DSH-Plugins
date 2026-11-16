/**
 * DSH-SUEZ-Office · surgical XLSX editing.
 *
 * Change cell values without rebuilding the workbook: the cell keeps its own style (number format,
 * fill, border) when it already exists; new cells borrow the style of a neighbour in the same column
 * so a column of percentages does not become plain text. Row order and dimension are kept valid.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ZipDoc, checkPackageIntegrity, checkStructure } from './ooxml.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
const colName = (i) => {
  let n = i;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

const sheetPart = (doc, name) => {
  const wb = doc.part('xl/workbook.xml');
  const sheets = [...wb.matchAll(/<sheet name="([^"]+)" sheetId="\d+" r:id="(rId\d+)"\/>/g)].map((m) => ({ name: m[1], rid: m[2] }));
  const rels = doc.part('xl/_rels/workbook.xml.rels');
  const target = (rid) => new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1];
  const pick = name ? sheets.find((s) => s.name === name) : sheets[0];
  if (!pick) throw new Error(`sheet "${name}" not found (have ${sheets.map((s) => s.name).join(', ')})`);
  const t = target(pick.rid);
  return { part: 'xl/' + t.replace(/^\.\//, ''), sheets };
};

function cellXml(ref, value, style, type, formula) {
  // a formula replaces the cached value; Excel recalculates on open (calcPr fullCalcOnLoad)
  if (formula) return `<c r="${ref}"${style ? ` s="${style}"` : ''}><f>${String(formula).replace(/^=/, '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</f></c>`;
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${s}/>`;
  const numeric = type === 'number' || type === 'int' || type === 'percent' || typeof value === 'number';
  return numeric
    ? `<c r="${ref}"${s}><v>${Number(value)}</v></c>`
    : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/** Rebuild one row so cells stay sorted by column. */
function setRowCell(rowXml, rowNumber, column, value, type, formula) {
  const cells = [...rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((m) => ({
    col: m[1],
    attrs: m[2],
    inner: m[3] ?? '',
  }));
  const styleOf = (col) => /s="(\d+)"/.exec(cells.find((c) => c.col === col)?.attrs ?? '')?.[1];
  // borrow the style from another cell in the same column (keeps number formats consistent)
  const columnStyle = styleOf(column) ?? /s="(\d+)"/.exec(cells[0]?.attrs ?? "")?.[1];

  const map = new Map(cells.map((c) => [c.col, c]));
  map.set(column, { col: column, attrs: columnStyle ? ` s="${columnStyle}"` : '', inner: '' });

  const ordered = [...map.values()].sort((a, b) => colIndex(a.col) - colIndex(b.col));
  const rebuilt = ordered.map((c) => {
    if (c.col === column) return cellXml(`${column}${rowNumber}`, value, columnStyle, type, formula);
    return `<c r="${c.col}${rowNumber}"${c.attrs}${c.inner ? `>${c.inner}</c>` : '/>'}`;
  }).join('');
  return `<row r="${rowNumber}"${/spans="[^"]*"/.exec(rowXml)?.[0] ? ' ' + /spans="[^"]*"/.exec(rowXml)[0] : ''}>${rebuilt}</row>`;
}

function setCell(doc, { sheet, cell, value, type, formula }) {
  const { part } = sheetPart(doc, sheet);
  let xml = doc.part(part);
  const m = /^([A-Z]+)(\d+)$/.exec(String(cell).toUpperCase());
  if (!m) throw new Error(`cell must look like B2, got "${cell}"`);
  const [, column, rowNumber] = m;

  const rowRe = new RegExp(`<row r="${rowNumber}"[\\s\\S]*?</row>|<row r="${rowNumber}"[^>]*/>`);
  const rowXml = rowRe.exec(xml)?.[0];
  // 共享公式的主单元格被改写后，同组其它格子的 si 会指向不存在的主公式，Excel 直接报错
  if (rowXml && new RegExp(`<c r="${column}${rowNumber}"[^>]*>(?:(?!</c>)[\s\S])*<f t="shared"[^>]*ref=`).test(rowXml)) {
    throw new Error(`单元格 ${column}${rowNumber} 是共享公式的主单元格：整表重建，或先把它改成普通数值`);
  }

  if (rowXml) {
    xml = xml.replace(rowXml, setRowCell(rowXml, Number(rowNumber), column, value, type, formula));
  } else {
    // row missing: create it and insert in numeric order
    const newRow = `<row r="${rowNumber}">${cellXml(`${column}${rowNumber}`, value, undefined, type, formula)}</row>`;
    const rows = [...xml.matchAll(/<row r="(\d+)"/g)].map((x) => Number(x[1])).sort((a, b) => a - b);
    const after = rows.find((r) => r > Number(rowNumber));
    if (after) xml = xml.replace(new RegExp(`(<row r="${after}")`), `${newRow}$1`);
    else xml = xml.replace('</sheetData>', `${newRow}</sheetData>`);
  }

  // dimension must cover every written cell or Excel trims the sheet
  const all = [...xml.matchAll(/<c r="([A-Z]+)(\d+)"/g)];
  const maxCol = Math.max(...all.map((x) => colIndex(x[1])));
  const maxRow = Math.max(...all.map((x) => Number(x[2])));
  xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${colName(maxCol)}${maxRow}"/>`);

  doc.setPart(part, xml);
  return `${sheet ?? 'sheet1'} · ${cell.toUpperCase()} → ${JSON.stringify(value)}`;
}

export function editXlsx({ input, out, ops = [] }) {
  if (path.resolve(input) === path.resolve(out)) throw new Error('editXlsx: 输出必须是新路径');
  const doc = new ZipDoc(input);
  const applied = [];
  for (const op of ops) {
    if (op.op === 'setCell') applied.push(setCell(doc, op));
    else throw new Error(`unknown op "${op.op}" (setCell)`);
  }
  const problems = [...checkPackageIntegrity(doc.parts, { checkXml: true }), ...checkStructure(doc.parts)];
  if (problems.length) return { out: null, applied, problems };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  doc.save(out);
  return { out, applied, problems: [] };
}
