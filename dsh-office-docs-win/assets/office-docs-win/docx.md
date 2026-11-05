> **This build has no Python.** Every toolkit call uses Node:
> `node <scripts>/dump.mjs <file>` (structure dump) and `node <scripts>/ooxml.mjs check <file>`
> (integrity gate). `ooxml.mjs` is a line-by-line port of the original `ooxml.py` — same class
> and method names (`ZipDoc`, `part`, `setPart`, `save`, `checkPackageIntegrity`,
> `duplicateParaIds`) — and its output is verified byte-identical by a differential test suite.
> Where a recipe below still shows Python, write the equivalent `.mjs` instead:
> `import { ZipDoc, checkPackageIntegrity } from '<scripts>/ooxml.mjs'`. This host has no
> `python.exe`; a `python` command will simply fail.
# DOCX 细节（本机能力边界如实标注）

> 要从零生成一个完整文件：拷 `examples/build_docx.mjs`，改里面的内容数组即可（已跑通、含完整性检查）。

## 包结构
- `word/document.xml` — 正文：`<w:body>` 下 `<w:p>` 段落 / `<w:tbl>` 表格；run = `<w:r><w:rPr>...</w:rPr><w:t>text</w:t></w:r>`
- `word/styles.xml` — 样式；`word/media/` — 图片；`word/_rels/document.xml.rels` — 图片关系
- SUEZ 字体（docx 不需要 panose，写名字即可）：
  `<w:rFonts w:ascii="poppins" w:hAnsi="poppins" w:eastAsia="方正准圆_GBK"/>`
- 字号：`<w:sz w:val="半磅"/>`（28 = 14pt）；颜色 `<w:color w:val="RRGGBB"/>`；粗体 `<w:b/>`

## 手术式文本替换（首选）
- 先 `dump_docx` 定位 → 把替换范围限定在目标段落/表格内 → assert 旧串在范围内恰好出现 1 次 → 替换。
- `dump_docx` 输出（2026-10-29 增强）：`tables: N` 总表数；段落行首 `[tbl]` = 该段在表格内、`[textbox]` = 在文本框内（这些段落的换行会被正则拆开，别当成两个段落）；随后按 `word/header*.xml` / `footer*.xml` 逐段输出页眉页脚内容（含字体/字号）——模板复刻要改页眉页脚前先看这里。
- 全局替换会误伤页眉/页脚/其他 section——禁止无范围替换。
- 插入段落：在锚点 `</w:p>` 前拼新 `<w:p>`，pPr 复制相邻段落的样式（`<w:pStyle w:val="..."/>`）保持一致。

## Word COM — 渲染成 PDF（2026-10-29 已验证：SaveAs wdFormatPDF 一次成功，qa_render.ps1 内置）
    $w = New-Object -ComObject Word.Application
    $w.Visible = $false
    $src = [string](Join-Path $env:TEMP 'qa.docx')              # 用 $env:TEMP；[string] 强转见下
    $doc = $w.Documents.Open($src, $false, $true)               # 第3参 ReadOnly
    try { $pdf = [string]($src -replace '\.docx$','.pdf')
          $doc.SaveAs([ref]$pdf, [ref]17) }                     # 17 = wdFormatPDF
    finally { $doc.Close($false); $w.Quit() }
- **`[ref]` 参数必须传"真 string"，否则报 `Cannot convert ... psobject to Object`**（2026-10-30 在 PS 5.1 + `powershell -File` 下复现）：`Join-Path` 等管道结果可能带 PSObject 包装。**修法：变量声明成 `[string]` 或调用前 `[string]` 强转**（实测 A=不强转 FAIL、B=强转 OK，docx/PDF 两种格式都通过）。
  ⚠️ **不要改用 by-value `SaveAs2($path, 16)` 作后备**：实测会**挂起**（>120 s，无桌面会话下必卡）。`[ref]` + 强转才是正确写法。
- **耗时基准（2026-10-30 本机实测）**：21 页 / 3.4 MB 中文文档 → 打开 1.8 s、导出 PDF **23.1 s**（2.33 MB），约 **1.1 s/页**；1 页小文档 1–1.5 s。**导出慢/卡住不是能力问题**：先杀 headless WINWORD（`Get-Process WINWORD | ? { $_.MainWindowHandle -eq 0 } | Stop-Process -Force`）→ 全新实例重试一次；重试前不得判定"文件损坏/不能导出"。`qa_render.ps1` 已内置看门狗：docx/xlsx 默认 600 s（约 500 页余量）、pptx 180 s，超时会杀掉子进程和 headless Office 并给出明确提示（`-TimeoutSec` 可调，0 = 关闭）。
- 视觉质检：PDF 若无法直接转图（本机无 poppler），用结构质检兜底：XML 断言（替换命中数、段落顺序、字体属性）+ dump 文本复核，并在交付说明里注明"未经视觉渲染验证"。
- 若 Edge CDP（端口 9333，OWA 用途）当时开着：可开 PDF tab 截图再 read_image（可选增强，不可依赖）。

## 修订 / 目录字段（2026-10-30 实测教训）
- **属性名是 `TrackRevisions`，不是 `TrackChanges`**：`$doc.TrackRevisions = $true` 可用（实测设置后插入文本 → `$doc.Revisions.Count = 1`）。PS COM 适配器里 `TrackChanges` 会报 property not found——别据此下"只能改 settings.xml"的结论。
- **更新目录（TOC）/任何字段更新后必须清修订**：即使 `settings.xml` 里没有 `<w:trackChanges/>`，Word 会话状态仍可能把字段更新记成 tracked change（实测 19 处、作者为当前用户），交付前要：
  1. `$doc.Fields.Update()` 之后 `$doc.AcceptAllRevisions()`（或 `$doc.Revisions.AcceptAll()`）；
  2. 保存后再断言 XML 里 `<w:ins ` / `<w:del ` 计数为 0（`dump` 或直接扫 document.xml）——`AcceptAllRevisions` 后仍要验证，不能想当然。
- **克隆段落/表格会带走 `w14:paraId`**：复制块后要清掉或重生成 `w14:paraId`/`w14:textId`，否则 commentsExtended 与修订引用会指向错误段落（Word 保存时会自动修复，但修复前是坏的）。交付前用 `duplicateParaIds(doc.parts)` 查，正常文档应返回空（`mc:Fallback` 里的重复是合法的，检查已排除）。

## 模板复刻（docx 版）
1. dump 源文档：段落样式链（pStyle）、字体、字号、行距（`<w:spacing>`）、页边距（`sectPr/pgMar`）、页眉页脚。
2. 新建内容沿用源文档的 style id 与字体设置，不引入新 style。
3. 页眉/页脚/页码：改 `word/headerN.xml` / `footerN.xml`（logo 位置跟模板）。
