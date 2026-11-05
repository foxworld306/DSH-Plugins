> **This build has no Python.** Every toolkit call uses Node:
> `node <scripts>/dump.mjs <file>` (structure dump) and `node <scripts>/ooxml.mjs check <file>`
> (integrity gate). `ooxml.mjs` is a line-by-line port of the original `ooxml.py` — same class
> and method names (`ZipDoc`, `part`, `setPart`, `save`, `checkPackageIntegrity`,
> `duplicateParaIds`) — and its output is verified byte-identical by a differential test suite.
> Where a recipe below still shows Python, write the equivalent `.mjs` instead:
> `import { ZipDoc, checkPackageIntegrity } from '<scripts>/ooxml.mjs'`. This host has no
> `python.exe`; a `python` command will simply fail.
# OOXML zip 助手（scripts/ooxml.mjs）

三个格式都是 zip 包，改法统一：**读 part → 改 XML 字符串 → 其余 part 原样复制 → 原子写出**。

```python
import ooxml
doc = ooxml.ZipDoc('deck.pptx')              # 载入所有 part（bytes）
xml = doc.part('ppt/slides/slide2.xml')      # utf-8 解码取 part
doc.setPart('ppt/slides/slide2.xml', xml)   # str/bytes 均可
doc.save('out.pptx')                         # .tmp + os.replace
max_id = doc.max_cnvpr_id('ppt/slides/slide2.xml')   # 新 shape id 起点
problems = checkPackageIntegrity(doc.parts)  # 交付前必查，必须为 []
```

## checkPackageIntegrity()（2026-10-29 生产事故后新增，交付前必跑）
检查 `[Content_Types].xml` 与包内 part 的一致性，返回问题列表（空 = 干净）。抓三类 PowerPoint 整体拒开的问题（Univer 等宽松渲染器照样能打开——**"别的渲染器能渲染"不是有效信号**）：
1. **重复的 `<Default Extension="...">` 条目**（OPC 要求 extension 唯一）→ PowerPoint 报 "could not open"（0x80CB8000）。典型场景：deck 已有 png Default（出过 PNG 就留），照"加一个 Default"的配方再加一条。
2. **重复的 `<Override PartName="...">` 条目**（OPC 要求 part name 唯一）→ **0x80CB8001**（2026-10-29 受控 COM 实验证实：给能正常打开的 deck 加一条完全相同的 slide1 Override 后立即被拒）。典型场景：拼装/合并包时把某个 part 的 Override 抄了两遍。
3. **无 Default/Override 覆盖的 part**（0x80CB8002）。典型场景：删媒体时把 jpeg Default 一并删了，但 `docProps/thumbnail.jpeg` 还在。

## 结构闸（2026-11-04 新增：`checkStructure`，`checkPackageIntegrity` 默认一并跑）

XML 良构 ≠ Office 能打开。以下四条都是"能通过 XML 校验、PowerPoint 照样拒开/弹修复"的：

1. **空的 `<p:sp/>`**——真的踩过：它被拼进 `spTree` 后，包体检全绿，PowerPoint 说 "could not open the file"。
2. **同一页里重复的 `<p:cNvPr id="N">`**——PPT 会修复或拒开（形状 id 必须唯一，连 `spTree` 自带的 id=1 也算）。
3. **关系目标不存在**：`ppt/slides/_rels/slide1.xml.rels` 指向 `../slideLayouts/does-not-exist.xml`。
4. **`r:id` 引用了不存在的 rel**：`xl/workbook.xml` 的 `<sheet r:id="rId1">` 在 `xl/_rels/workbook.xml.rels` 里没有对应项——Excel 直接打不开。

另外按格式查：`<p:sld>` 根 + `<p:spTree>`；`p:sp` 必须有 `p:nvSpPr`/`p:spPr`，`p:pic` 还要 `p:blipFill`，`p:graphicFrame` 要有 `p:nvGraphicFramePr`/`p:xfrm`；docx 的 `<w:tbl>` 必须有 `<w:tblGrid>`；xlsx 的 worksheet 必须有 `<sheetData>`。

跳过办法：`{ checkXml: false }` 只关 XML 良构检查（结构检查照跑）；`{ checkStructure: false }` 只关结构检查；两者都关 = 只查 Content_Types。
谎报风险已实测：14 份真实 deck（含 29 MB 用户手改稿、python-pptx 模板）全部 CLEAN，不误报。

## 常用正则
- shape 块（非嵌套、不跨块）：
  `r'<p:sp>(?:(?!</p:sp>).)*?name="X"(?:(?!</p:sp>).)*?</p:sp>'`（re.S）
  docx 段落：`r'<w:p\b[^>]*>.*?</w:p>|<w:p\b[^>]*/>'`（re.S）
  ⚠️ **不要用旧版 `r'<w:p\b.*?(?:</w:p>|/>)'`**：它在段落内部第一个自闭合标签（如 pPr 里的 `<w:spcAft/>`）处就截断，**静默丢掉所有带 pPr 的段落**（dumper 输出看似"空文档"）——2026-10-29 生产踩坑，dumper 已修。
- shape 定位四件套：`name`、`<a:off x/y>`、`<a:ext cx/cy>`、`<a:t>` 文本
- 颜色：`srgbClr val="([0-9A-Fa-f]{6})"`；字体：`typeface="([^"]+)"`

## 纪律
1. 改之前先 dump（`scripts/dump.mjs`）确认形状/文本现状——用户可能在会话间隙改过文件。
2. 每次替换都 assert 命中数（通常 ==1），命中 0 或 >1 立即停，先查原因。
3. 其余 part 逐字节透传（zipfile 复制），只换改过的。
4. 写出走 `.tmp` + `os.replace`；OneDrive 上的源文件先重新读一遍再写目标。
5. 目标文件名用版本号递增（v10 → v11），不覆盖用户正在编辑的文件。
