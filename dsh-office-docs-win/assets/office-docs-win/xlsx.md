> **This build has no Python.** Every toolkit call uses Node:
> `node <scripts>/dump.mjs <file>` (structure dump) and `node <scripts>/ooxml.mjs check <file>`
> (integrity gate). `ooxml.mjs` is a line-by-line port of the original `ooxml.py` — same class
> and method names (`ZipDoc`, `part`, `setPart`, `save`, `checkPackageIntegrity`,
> `duplicateParaIds`) — and its output is verified byte-identical by a differential test suite.
> Where a recipe below still shows Python, write the equivalent `.mjs` instead:
> `import { ZipDoc, checkPackageIntegrity } from '<scripts>/ooxml.mjs'`. This host has no
> `python.exe`; a `python` command will simply fail.
# XLSX 细节（本机能力边界如实标注）

> 要从零生成一个完整文件：拷 `examples/build_xlsx.mjs`，改里面的内容数组即可（已跑通、含完整性检查）。

## 包结构
- `xl/worksheets/sheetN.xml` — `<sheetData>` 行/单元格；`<cols>` 列宽（字符单位）
- `xl/sharedStrings.xml` — 共享字符串表；单元格 `t="s"` 时 `<v>` 是索引
- `xl/styles.xml` — numFmts / fonts / fills / cellXfs（单元格样式引用 `s="idx"`）
- `xl/workbook.xml` — sheet 名与 rId 映射
- 内联字符串 `t="inlineStr"` + `<is><t>` 可绕过 sharedStrings 重排（改值时优先用它）

## 读
`dump_xlsx`（scripts/dump.mjs 的 xlsx 模式）：每个 sheet 的**标签名**（从 workbook.xml + rels 解析）+ 行数 + 前 40 个单元格值（自动解析 sharedStrings / inlineStr / 公式）。整表导出 CSV：逐行解析 `<c>`（注意空单元格无 `<c>` 节点，按 r 列号补齐）。
- 公式：普通 `<f>SUM(...)</f>` 显示为 `值 =SUM(...)`；**填充公式**（Excel 把下拉填充存成共享公式）主单元格是 `<f t="shared" ref="B2:B6" si="0">表达式</f>` → 正常显示表达式，从属单元格是 `<f t="shared" si="0"/>` → 显示 `[shared formula si=0]`（表达式在主单元格，不在从属格）。

## 改
- 单元格级手术：按 `r="A1"` 定位 `<c>`，替换 `<v>` 或改 `t` 属性；**不要按值匹配**（重值极多）。
- 改字符串值：sharedStrings 里原位替换 `<t>` 内容最稳（索引不变）；若原文本在多处共用，先查引用次数。
- 加列/加行：直接拼 `<col>` / `<row>` / `<c>` 节点；新单元格样式引用现有 cellXfs 的 `s` 值，别造新 style。
- 公式：`<c r="B2"><f>SUM(A1:A2)</f><v>缓存值</v></c>`——没有 Excel 重算时缓存值会过期，交付时提醒用户在 Excel 里打开会自动重算。

## Excel COM — 渲染成 PDF（2026-11-04 修正：必须用 ExportAsFixedFormat(0)，SaveAs 52 存出来的是 .xlsm）
    $e = New-Object -ComObject Excel.Application
    $e.Visible = $false; $e.DisplayAlerts = $false
    $stage = Join-Path $env:TEMP 'qa.xlsx'       # 用 $env:TEMP，不写死 C:\Temp
    $wb = $e.Workbooks.Open($stage)
    # 0 = xlTypePDF。不要写 SaveAs(..., 52)：52 是 xlOpenXMLWorkbookMacroEnabled，
    finally { $wb.Close($false); $e.Quit() }
- 未验证期间的质检兜底：dump 复核 + 列宽/数字格式断言，交付说明里注明。
- 挂起处理同 docx：先杀 headless EXCEL 再重试一次；`qa_render.ps1` 的看门狗默认 600 s 超时并自动清理。

## 模板复刻（xlsx 版）
1. dump 模板：表头行样式（cellXfs 索引对应的字体/填充/边框）、列宽、冻结窗格（`sheetView/pane`）、数字格式。
2. 新表沿用模板的 cellXfs 索引（`s="..."`）与列宽，不新增 styles。
