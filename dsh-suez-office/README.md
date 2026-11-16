# dsh-suez-office

**给 DeepSeek Harness 用的 Office 工具箱**（Windows，无 Python）：生成与修改 **PPT / Word / Excel / PDF**，并且每一份产出都过包校验 + 真实 Office 渲染质检。

不是"从零画形状"，也不是"手改 XML 到能打开为止"。两条主线：

- **PPT**：以公司官方模板为种子——母版、版式、主题、内嵌字体子集全部保留，只替换页面内容；也可以完全不看模板，一页一稿自由排版。
- **Word / Excel / PDF**：声明式 spec 生成，或者对**已有的文件**做定点手术（改文字、换图、改公式、加批注），不动其余部分。

## 装

```powershell
# 本机目录（开发态，改代码即时生效）
dsh plugin --profile web add "C:\...\dsh-suez-office"
# 或从打包产物
dsh plugin --profile web add "C:\...\dsh-suez-office-local.tgz"
```

装完**重启一次** DSH：技能与工具在启动时构建。

> **模板已随插件一起装。** SUEZ 官方模板（0.9 MB，162 个版式与母版）打包在 `assets/suez-office/seed/suez-template.pptx`，
> `mode: "suez"` 不传 `seed` 就用它。要换模板时才需要传 `seed`。

## 14 个工具

| 建 | 改 | 读 / 检 | 交付 |
| --- | --- | --- | --- |
| `suez_build_deck` | `suez_edit_pptx` | `suez_dump` | `suez_export_pdf` |
| `suez_build_docx` | `suez_edit_docx` | `suez_check` | |
| `suez_build_xlsx` | `suez_edit_xlsx` | `suez_lint_deck` | |
| | `suez_add_comment` | `suez_render_page` | |
| | `suez_clean_docx` | `suez_fetch_image` | |

**统一硬规则**：改文件永远另存新路径，拒绝覆盖输入；包校验不过就不落盘。

## PPT：两条路

### A. SUEZ 模板模式（`mode: "suez"`）

```json
{ "mode": "suez", "seed": "SUEZ new PPT template_SCN&EN.pptx", "out": "deck.pptx",
  "slides": [ { "archetype": "statement", "text": "一句话结论。" } ] }
```

- 29 个页面原型（23 底座 + 6 英雄页）、13 种原生图表
- 表格支持 `colspan` / `rowspan`、数字右对齐、换行策略
- 目录页克隆模板 Summary 版式：>4 章双列，>8 章续页并连续编号
- 每页自动写演讲者备注（来源 / 图注 / 许可 / 图表类型）

### B. 自由发挥模式（`mode: "free"`）

```json
{ "mode": "free", "out": "deck.pptx",
  "slides": [ { "archetype": "heroHtml", "html": "pages/01-cover.html" } ] }
```

每页手写 1920×1080 HTML → 渲染成 2× 底图 + **真文本框**（文字在 PowerPoint 里仍可编辑）。不需要种子模板。

## Word / Excel / PDF

```json
// suez_build_docx
{ "title": "标题", "subtitle": "副标题", "header": "页眉", "footer": "页脚",
  "sections": [
    { "heading": "一、章节", "paragraphs": ["正文"], "bullets": ["要点"] },
    { "heading": "二、表格", "table": { "columns": ["A","B"], "rows": [["x","1"]] } }
  ] }
```

```json
// suez_build_xlsx（单元格写 "=SUM(B2:B4)" 就是真公式）
{ "sheets": [ { "name": "Sheet1", "header": ["项目","Q3"],
  "columns": [{ "width": 24 }, { "width": 14, "type": "number" }],
  "rows": [["营收", 28.05], ["合计", "=SUM(B2:B2)"]] } ] }
```

## 改已有文件

| 文件 | 操作 |
| --- | --- |
| PPTX | `setText`（保字号/字体/颜色）、`setImage`、`setChartValues`、`duplicateSlide`、`removeSlide` |
| DOCX | `setParagraph`（文字匹配或序号）、`setTableCell`；`suez_add_comment` 加批注；`suez_clean_docx` 清修订/批注 |
| XLSX | `setCell`（保数字格式，新格继承列样式），支持 `formula` |

先 `suez_dump` 看清形状名/段落/单元格，再动手；名字写错时报错会列出可用项。

## 质检（每次构建自动跑）

1. `checkPackageIntegrity` / `checkStructure` —— OPC 结构、XML 良构、Content_Types、悬空关系
2. `validate.mjs` —— PowerPoint 真会解析的 drawing XML：枚举白名单（`algn`/`anchor`/`wrap`/`prstGeom`）、EMU 范围、字号区间、形状 id 唯一
3. `lint.mjs` —— 越界、文字重叠、字号下限、对比度（4.5:1）、单页字数、**页码定位**、**同图跨页**
4. `rhythm.mjs` —— anchor 间隔、深色占比、同页型连排、首尾页型
5. `suez_render_page` —— 真实 Office 渲染成 PNG / PDF，用眼睛确认

## 测试

```powershell
node test/run.mjs  --seed "<SUEZ template>.pptx"   # 112 项单元/集成断言
node test/hero.mjs --seed "<SUEZ template>.pptx"   # 25 项英雄页渲染
node test/e2e.mjs  --seed "<SUEZ template>.pptx"   # 18 步端到端，每个工具真调一次
```

## 已知限制

- **图表**：散点 / 气泡未支持（改写数据缓存会被 PowerPoint 拒绝，需 embedded workbook）
- **Word / Excel 原生图表**：不支持编辑
- **PDF 文本抽取**：不做（本机无 PDF 文本库）；页数/元信息可读
- **图片**：不内置语义搜索，需要给 URL 或指定本地文件夹；许可证由调用方记录
- **字体**：只用本机已装的（方正粗圆/准圆 + Poppins），换机器前先确认字体存在
- **母版**：绑定这一个 SUEZ 模板；换模板要重验版式

## 许可

MIT。
