---
name: suez-office
description: SUEZ Office 工具箱：用故事板生成 SUEZ 品牌 PPTX（官方模板为种子，原型 + 英雄页 + 13 种原生图表），也能自由发挥手排；生成与编辑 Word / Excel / PDF，读写批注、清洗修订，全部走包门禁 + 真实渲染质检。触发词：做PPT、做幻灯片、按公司模板做、排版、deck、汇报材料、做Word、做表格、改PPT/Word/Excel、导出PDF、加批注、清修订。
---

## 种子模板（不用管）

SUEZ 官方模板随插件一起安装，路径 `assets/suez-office/seed/suez-template.pptx`。
`mode: "suez"` 时**不传 `seed`** 就用它；只有在用户明确要换模板时才传 `seed`。
不要问用户"模板文件在哪"——默认就有。

## 第 0 步：先问模式（不可跳过）

**在做任何一页之前**，必须让用户二选一：

> A）**SUEZ 模板**：走底座 23 个原型 + 6 个英雄页，品牌合规，对外材料用这套。
> B）**完全自由发挥**：不看模板、不用原型，我按你的 prompt 自己设计版面（每页单独排版）。

规则：
- 用户没选之前**不要开始写 storyboard、不要建任何文件**。
- 选定后 `suez_build_deck` 必须带 `mode`：`"suez"` 或 `"free"`；不传会被工具直接拒绝。
- `mode: "free"` 时每一页都是 `heroHtml`（给 `html` 或 `template`），自由发挥**不复用原型版式**，也不要求种子模板。
- 同一主题一旦选定模式，中途不要偷偷切换；要换先跟用户说。
- 自由发挥**不要固化成模板**：每次按内容重新设计，这正是它的价值。


# SUEZ Office 版式系统

给这台机器上的公司汇报做 PPT。**不要从零画形状**，也不要手改 XML——用 `suez_build_deck` 把内容写成故事板，它负责版式、字体、网格、间距和质检。

## 一句话流程

```
写故事板 JSON  →  suez_build_deck  →  看返回的 lint / rhythm  →  suez_render_page 出图看  →  改内容再跑
```

## 故事板长什么样

```json
{
  "seed": "C:/.../SUEZ new PPT template_SCN&EN.pptx",
  "footerTitle": "2026 上半年复盘",
  "slides": [
    { "archetype": "cover",    "title": "把审批链从五环砍到两环", "subtitle": "2026 上半年复盘", "meta": "运营中台 · 2026 年 7 月" },
    { "archetype": "hero",     "eyebrow": "关键结论", "title": "把判断前置，比把节点砍掉更值钱。", "body": "……", "stat": "−34%", "statLabel": "平均交付周期" },
    { "archetype": "assertion","eyebrow": "关键结果", "title": "……", "lede": "……", "kpis": [{"value":"−34%","label":"周期","tone":"dark"},{"value":"5 → 2","label":"节点"}] },
    { "archetype": "chart",    "title": "……", "chart": {"categories":["A","B"],"series":[{"name":"天数","values":[17,19]}],"format":"0\"天\""}, "takeaways":["……"] },
    { "archetype": "closing",  "title": "谢谢", "subtitle": "Thank you" }
  ]
}
```

## 19 个原型与必备字段

| archetype | 用途 | 必填 | 视觉重量 |
|---|---|---|---|
| `cover` | 封面（**直接取模板自带的封面页**，只换文字） | title, subtitle, meta | 深色 |
| `agenda` | 目录 / Summary（**取模板自带那页**，4 或 8 章） | title, chapters[] | 深色 |
| `section` | 章节页 | number, title | 深色 |
| `hero` | 整页色场 + 大字 + 一个数字 | title | **anchor** |
| `bigNumber` | 一个 140pt 数字独占一页 | value, title | **anchor** |
| `imageFull` | 满版图 + 渐变罩 + 压字 | image, title | **anchor** |
| `imageSplit` | 半版图 + 半版文（`side:"left"` 镜像） | image, title | **anchor** |
| `bento` | 大小不等的磁贴 | tiles[{value,label}] | **anchor** |
| `statement` | 一句话结论 | text | **anchor** |
| `quote` | 超大引号 + 引文 | text, attribution | **anchor** |
| `assertion` | 断言标题 + 左论述 + 右 KPI | title, kpis[] | 内容 |
| `cards` | 2–4 张卡片 | title, cards[] | 内容 |
| `imageCard` | 图 + 标题 + 说明的卡片组 | title, cards[{image,title,body}] | 内容 |
| `photoStrip` | 标题下一条照片带 + 正文/要点 | image, caption, body, points | 深色 |
| `quotePhoto` | 圆形肖像 + 大引文 + 署名 | image, text, attribution, role | 深色 |
| `bentoMix` | 深蓝面板两个数字 + 一块图 | tiles[2], image, caption | 深色 |
| `portrait` | 左满版人物照 + 右姓名/职务/履历/引语 | image, name, role, credentials[], quote | 深色 |
| `chart` | 原生图表（11 种，可改数据）+ 右侧读法 | chart, title | 内容 |
| `bars` | 横向对比条 | title, bars[] | 内容 |
| `matrix` | 2×2 分诊 + 右侧结论 | title, items[], takeaways[] | 内容 |
| `timeline` | 横向里程碑 | title, items[] | 内容 |
| `bullets` | 2–3 栏要点 | title, columns[] | 内容 |
| `table` | 口径/责任表 | title, columns[], rows[][] | 内容 |
| `closing` | 结尾 | title | 深色 |
| `heroHtml` | **英雄页**：HTML 画，底图 + 真文本框 | template / html | **anchor** |

## 图表：13 种原生类型

```json
{ "archetype": "chart", "title": "…",
  "chart": { "type": "column", "categories": ["A","B"],
             "series": [{ "name": "天数", "values": [17,19] }], "format": "0\"天\"" },
  "takeaways": ["…"] }
```

| type | 说明 | 数据约定 |
|---|---|---|
| `column` | 竖向柱（默认） | 分类 + 每个系列一组数值 |
| `bar` | 横向条形（品类名长时用） | 同上 |
| `line` | 折线（带圆点） | 同上，适合时间序列 |
| `area` | 面积 | 同上，适合累计量 |
| `stacked` | 堆叠柱 | 多系列，看结构 |
| `stacked100` | 百分比堆叠 | 多系列，`format` 用 `0.0%` |
| `pie` | 饼图（取第一个系列） | 分类即扇区 |
| `doughnut` | 环形（取第一个系列） | 同上 |
| `radar` | 雷达（多维对比） | 分类即维度，2 组以上做对比 |
| `waterfall` | 瀑布（归因分解） | **`values` 是每一步之后的水平值，另给 `start` 起始值**，不是增量 |
| `combo` | 柱＋线双轴 | 第 1 个系列画柱，其余画线，走次轴 |
| `gantt` | 甘特（横条时间轴） | 用 `tasks: [{name,start,end}]`，不写 series |
| `funnel` | 漏斗（按值排序的横条） | 原生 funnelChart 在本机 PowerPoint 打不开，改装成排序横条 |

`format` 是数字格式：`0"天"`、`0.0%`、`#,##0`。图表是原生部件，**用户在 PowerPoint 里能直接改数**。



## 英雄页（heroHtml）

需要"设计感"的少数几页（封面、章节、流程图解）用 HTML 画，其余页仍走普通原型。

```json
{ "archetype": "heroHtml", "template": "cover",
  "eyebrow": "SUEZ · 运营中台", "title": "把审批链压到两环，<br>周期缩短 34%。",
  "subtitle": "2026 年上半年复盘", "meta": "2026 年 11 月" }
```

| template | 变量 | 用在哪 |
|---|---|---|
| `cover` | eyebrow / title / subtitle / meta | 封面 |
| `agenda` | 目录 / Summary（**取模板自带那页**，4 或 8 章） | title, chapters[] | 深色 |
| `section` | number / title / subtitle | 章节页 |
| `diagram` | eyebrow / title / step1-4 / note1-4 / foot | 4 步流程图解 |
| `compare` | eyebrow / title / before·after（各含 label、heading、body）/ foot | 改造前后、新旧方案 |
| `statWall` | eyebrow / title / v1–v6 + l1–l6 / foot | 六个数字的墙 |
| `device` | eyebrow / title / body / points / screenshot / caption / foot | 界面或截图展示（图片嵌在设备框里） |
| `people` | eyebrow / title / name1-3 / role1-3 / quote1-3 / avatar1-3 / foot | 三个人的视角、用户见证 |

规则：
- 模板默认**只给装饰**（色块、纹理、渐变、流程条）；文字全部是可编辑文本框，位置由浏览器量出来。
- 需要自定义时给 `html`（路径或整段 HTML），文字元素加 `class="t"`，它就会被转成文本框。
- 底图是**死的**：用户挪动色块不会带着文字走。所以一册里最多 3–5 页，其余用普通原型。
- 图片类模板（`device` / `people`）的图**烘进底图**：换图要重跑模板，但排版稳定、不受用户拖动影响。变量值写成文件路径（`assets/images/x.jpg`）即可，插件会转成 `file://`。
- 依赖本机 Edge/Chrome（Windows 自带），不需要装 playwright。
- **封面不要用英雄页**：封面固定取模板自带的那一页（见 cover 原型），英雄页只用于正文/章节/图解。

## 图片

模型负责找图（它有网），插件负责下载并记账：

```json
{ "archetype": "imageFull", "image": "assets/images/apple-watch.jpg",
  "imageCredit": "作者 · 许可", "caption": "作者 · 许可 · 日期" }
```

- 先把图落盘：`suez_fetch_image({ url, out: "assets/images", name, license, author, source })`
  → 返回本地路径 + 可粘进 storyboard 的 `image` / `imageCredit`
- 每张图记进 `assets/images/credits.json`（url / 日期 / 许可 / 作者）
- **用了图但不写 `imageCredit`，构建时会报 IMAGE PROVENANCE 警告**——图可以借，出处必须留
- 本机能直连 `images.unsplash.com` / `images.pexels.com`；wikimedia 与图库搜索页不通，所以搜索交给模型，下载交给插件

## 演讲者备注

每页会自动写 `notesSlide`（PowerPoint 里"视图 → 备注页"可见），内容来自 storyboard：

| 字段 | 写进备注 |
|---|---|
| `source` | 数据来源：… |
| `caption` | 图注：… |
| `imageCredit` | 图片来源：… |
| `note` | 原样写入（口径、讲法、提醒） |
| `chart.type` | 图表类型（提醒可改数据） |

没有任何来源的页不写备注。备注母版取自种子模板。

## 节奏：主角轮换

相邻两个 anchor 页不能用同一种视觉主角，否则读起来像重复。
主角类型由页型推出：`image`（图）/ `number`（数字）/ `field`（色场）/ `chart`（图表/矩阵/时间轴）/ `list`（卡片/要点）/ `type`（纯文字）。
连续两张图片 anchor → 会提示"换一种主角"。

## 工具总表

| 工具 | 用途 | 只读 |
|---|---|---|
| `suez_build_deck` | 故事板 → PPTX（SUEZ 模板 / 自由发挥） | |
| `suez_edit_pptx` | 改已有 PPTX：文字 / 图片 / 图表数值 / 复制页 / 删页 | |
| `suez_build_docx` | JSON → Word（标题、章节、段落、列表、表格、页眉页脚） | |
| `suez_edit_docx` | 改已有 Word：段落文字、表格单元格 | |
| `suez_build_xlsx` | JSON → Excel（多表、冻结表头、数字格式、筛选） | |
| `suez_edit_xlsx` | 改已有 Excel：按坐标改单元格 | |
| `suez_export_pdf` | pptx/docx/xlsx → PDF | |
| `suez_dump` | 读结构：pptx / docx / xlsx / pdf | ✓ |
| `suez_check` | 包门禁：Content_Types + rels + XML 良构 | ✓ |
| `suez_render_page` | 渲染一页看图 | ✓ |
| `suez_lint_deck` | 版式 lint + 节奏检查（任意 pptx） | ✓ |
| `suez_fetch_image` | 下载图片 + 记许可 + 自动压缩 | |

统一规矩：改文件永远另存新路径；包校验不过就不落盘。

## 做一份 Word / Excel

Word（`suez_build_docx`）的 spec：

```json
{ "title": "标题", "subtitle": "副标题", "header": "页眉", "footer": "页脚", "pageSize": "A4",
  "sections": [
    { "heading": "一、章节", "paragraphs": ["正文"], "bullets": ["要点"] },
    { "heading": "二、表格", "table": { "columns": ["A","B"], "widths": [3626,1800], "align": ["left","right"], "rows": [["x","1"]], "caption": "来源" } }
  ] }
```

Excel（`suez_build_xlsx`）的 spec：

```json
{ "sheets": [{ "name": "Sheet1", "header": ["指标","Q3"],
  "columns": [{ "width": 28 }, { "width": 14, "type": "number" }],
  "rows": [["营收", 28.05]], "autofilter": true }] }
```

单元格类型：`text` / `number` / `int` / `percent`。表头自动深蓝底、冻结、可按宽适配打印。

### 公式、批注、修订

| 需求 | 做法 |
|---|---|
| 表里要真公式 | `suez_build_xlsx` 单元格写 `"=SUM(B2:B4)"`；`suez_edit_xlsx` 的 `setCell` 加 `formula` |
| 看有没有批注 | `suez_dump`（docx 与 pptx 都列作者、日期、正文） |
| 加批注 | `suez_add_comment`：docx 用 `match`/`index` 锚段落，pptx 用 `index` 指定页 |
| 交付前清修订 | `suez_clean_docx { acceptRevisions: true }` |
| 交付前删批注 | `suez_clean_docx { stripComments: true }` |

注意事项：

- 公式单元格不留缓存值，靠 `calcPr fullCalcOnLoad` 让 Excel 打开时重算。
- 共享公式（下拉填充产生）的主单元格不能直接改，工具会报错让你重建该表。
- 一张幻灯片只有一个批注部件：第二条批注追加进同一个部件（拆成两个部件 PowerPoint 打不开）。
- 批注写入的结构是照 Word/PowerPoint 自己写出来的 XML 反推的。
## 改一份已有的 Word / Excel

- Word：`suez_edit_docx`，操作为 `setParagraph { match | index, text }` 与 `setTableCell { table, row, col, text }`。
- Excel：`suez_edit_xlsx`，操作为 `setCell { sheet, cell, value, type? }`；原有数字格式保留，新单元格继承同列样式。
## 改一份已有的文件（外科手术，不重建）

用户给了现成的 pptx 要改内容时，**不要重建**——重建会丢掉他手工拖过的位置、换过的图、母版改动。

1. `suez_dump { file }`：先看清每页有哪些形状、名字是什么
2. `suez_edit_pptx { input, out, ops }`：只改点名的形状，输出新文件
3. `suez_check { out }`：手工改过才需要；工具路径会自动跑
4. `suez_render_page { out, page }`：看图确认没崩

支持的 ops（JSON 数组）：

| op | 参数 | 说明 |
|---|---|---|
| `setText` | slide, shape, text | 替换文字，保留原字号/字体/颜色；换行用 \n |
| `setImage` | slide, shape, file | 换图，自动登记媒体部件与关系 |
| `setChartValues` | slide, chart?, series?, values, format? | 改某系列的值，同时修正公式区间 |
| `duplicateSlide` | slide | 复制该页，插在它后面 |
| `removeSlide` | slide | 删除该页及其关系 |

硬规则：

- 输出必须是新路径（如 `deck-v2.pptx`），工具拒绝覆盖输入文件。
- 形状名写错时，报错会列出该页所有可用形状名。
- 包校验不过就不落盘：宁可不出文件，也不给一个打不开的 PPT。
## 三条硬规则

1. **节奏**：每 5 页内必须有一个 anchor 页（hero / bigNumber / imageFull / imageSplit / bento / statement / quote）。`suez_build_deck` 会算出来并给建议；不改也行，但整本会读起来平。
2. **一页一个焦点**：主元素 ≥44pt 或占版面 ≥40%，其余退到 12–15pt。正文低于 12pt 会被 lint 拦。
3. **别自己画**：需要新的页型时，先看现有 19 个能不能组合；确实缺了再加原型，不要在 spec 里塞坐标。

## 质检（每次构建自动跑，也可单独跑）

- `validate`：schema 层枚举与几何（`algn` 只允许 l/ctr/r/just/dist；宽高必须为正；字号 1–4000pt）——这类问题会让 PowerPoint 直接打不开。
- `lint`：越界、文本互相重叠、字号下限、对比度（正文 4.5:1）、单页字数。
- `rhythm`：anchor 间隔、深色占比、同页型连排、首尾页型。

出图后再看：`suez_render_page`（本插件自带，走 Office COM）把某一页渲成 PNG，再用 `read_image` 看。**必须看**——lint 只能证明"没坏"，证明不了"好看"。

## 常见返工原因

| 症状 | 原因 | 改法 |
|---|---|---|
| 页面显得空 | 内容太少而版面是固定网格 | 换 `bento` / `bigNumber`，或加一个图 |
| 整本很平 | 全是 `assertion`/`bullets` | 加 hero、bigNumber、imageSplit |
| 文字挤 | 单页字数超过 700 | 拆页；或把细节挪进演讲者备注 |
| 图片变形 | 忘了 `crop:"cover"`（默认已开） | 检查图片比例 |
| PowerPoint 打不开 | 包校验会先报，看返回的 PACKAGE PROBLEMS | 不要绕过 |
| 标题只剩一两个字换行 | 孤字 | 已内置：末行不足 4 个汉字会自动降一档字号 |

## 自由发挥模式（skin）

**开工前先问一句**：这册用 SUEZ 模板，还是自由发挥？

```json
{ "style": "editorial", "out": "out/deck.pptx", "slides": [ ... ] }
```

| style | 长相 | 用在哪 |
|---|---|---|
| `suez`（默认） | 官方模板：深蓝 + 亮绿、条码母题、内嵌品牌字体 | 对外、正式 |
| `editorial` | 暖纸底 + 深红强调 | 报告、白皮书 |
| `tech` | 近黑底 + 薄荷绿、卡片浅面 | 技术宣讲、内部分享 |
| `minimal` | 纯白、单一红色强调、大留白 | 极简汇报 |

- 自由发挥**不需要种子模板**：三套母版与主题由插件自带（`assets/suez-office/seeds/`）。
- 页面原型完全共用：同一份 storyboard 换个 `style` 就是另一套皮肤。
- 自由发挥**不代表 SUEZ 合规**：对外材料仍应用 SUEZ 模板。
- 字体仍只用本机已有的（方正粗圆/准圆 + Poppins）。

## 表格：合并与对齐

```json
{ "archetype": "table",
  "columns": ["业务", "指标", "Q3", "Q2"],
  "widths": [1.6, 2.6, 2, 2],
  "rows": [
    [{ "text": "汽车", "rowspan": 2, "bold": true }, "营收", "28.05", "28.24"],
    ["毛利率", "18.1%", "16.3%"],
    [{ "text": "收入", "colspan": 4, "bold": true }]
  ] }
```

- `colspan` / `rowspan`：单元格跨列、跨行（跨行的行分隔线会自动让开）
- **数字列自动右对齐**（识别 `28.05` / `19.6%` / `−1.09`），也可 `align` 强制
- 换行：按列 `"wrap": ["nowrap", "wrap", …]` 或按格 `"wrap": "nowrap"`
- 最多 9 行；行高按内容自动算，跨行单元格不够高时自动拉高最后一行
