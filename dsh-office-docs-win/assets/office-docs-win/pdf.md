> **This build has no Python.** Every toolkit call uses Node:
> `node <scripts>/dump.mjs <file>` (structure dump) and `node <scripts>/ooxml.mjs check <file>`
> (integrity gate). `ooxml.mjs` is a line-by-line port of the original `ooxml.py` — same class
> and method names (`ZipDoc`, `part`, `setPart`, `save`, `checkPackageIntegrity`,
> `duplicateParaIds`) — and its output is verified byte-identical by a differential test suite.
> Where a recipe below still shows Python, write the equivalent `.mjs` instead:
> `import { ZipDoc, checkPackageIntegrity } from '<scripts>/ooxml.mjs'`. This host has no
> `python.exe`; a `python` command will simply fail.
# PDF — 本机真实能力边界（无 pip：pypdf/poppler/Pillow 都不可用）

## 生成 PDF（可行，走 Office COM）
- Word 文档 → `$doc.SaveAs([ref]$pdf, [ref]17)`（17 = wdFormatPDF）
- Excel 工作簿 → `$wb.SaveAs($pdf, 52)`（52 = xlPDF）
- PowerPoint → `$pres.SaveAs($pdf, 32)`（32 = ppSaveAsPDF）
- 手写 SVG/HTML 内容 → 先走 PowerPoint COM 栅格化出 PNG（见 pptx.md），再决定交付 PNG 还是嵌回 PPT。
- 组合/拆分/旋转/水印：本机无原生工具——如实告知用户，改走"重新生成"路线（从源 OOXML 重建）或请用户在本地工具里处理。

## 读取 PDF
`node scripts/dump.mjs x.pdf` — 版本、页数（优先读页树 `/Count`，读不到就数 `/Type /Page`）、Title/Author/Producer、字体与图片对象数。
遇到"扩展名是 .pdf、内容其实是 xlsx"的文件会直接报 `not a PDF`（这正是 Excel 导出常量写错时的情况）。
- 文本/表格抽取：本机没有可用的 PDF 文本抽取库（内容流是 Flate 压缩 + 字体编码）——**不做原始抽取**。
- 可用路径：
  1. 优先向用户要源文件（pptx/docx/xlsx），走 OOXML 直读；
  2. 视觉路径：若 Edge CDP（9333）在运行 → 开 PDF 标签页 → CDP 截图 → `read_image`（vision 读文字/表格）；
  3. 都不行：明说限制，不硬猜内容。
- 页数：**让渲染器报**。`qa_render.ps1` 打开文档时就问应用本身（Word `ComputeStatistics(2)`、Excel `PageSetup.Pages.Count`、PPT `Slides.Count`），输出 `rendered: … (N bytes, pages 3, magic ok)`。

## 质检
PDF 是交付物而非中间态：生成后用视觉路径抽 1–2 页检查（字体替换、溢出、编码乱码——中文字体缺字是最高频问题，交付前必须看一页含中文的）。
