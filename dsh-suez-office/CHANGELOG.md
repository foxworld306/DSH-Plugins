## 1.0.2 — 2026-11-16

- 修 1.0.1 漏掉的一半：`deck.mjs` 与两个测试脚本（`test/run.mjs`、`test/hero.mjs`）现在也默认用内置模板，`node test/run.mjs` 不带 `--seed` 就能跑。
- 顺带修 `test/run.mjs` 在没有 `--seed` 时把当前目录当模板路径读（EISDIR）。
## 1.0.1 — 2026-11-16

- **SUEZ 模板内置进安装包**：`assets/suez-office/seed/suez-template.pptx`（0.9 MB，含 162 个版式与母版）。`mode: "suez"` 不传 `seed` 时自动用它——新用户不必自己找模板文件。
- README 与 SKILL 都写清楚"模板随插件安装"；缺种子时的报错文案改成指向内置路径。
- 测试新增 2 条：不传 seed 能建、且母版仍在。
## 1.0.0 — 2026-11-16 · 首个对外发布版

这一版把 0.1.0 → 0.5.5 的全部能力收拢成一个可发布的状态，并把元数据改成"Office 工具箱"而不是"PPT 生成器"。

**能力范围**：PPT（模板模式 / 自由发挥）、Word、Excel、PDF；建、改、读、检、导出五类共 14 个工具。

**相对 0.5.5 的变化**
- `package.json` 的 description / keywords 改为覆盖 pptx / docx / xlsx / pdf（此前只写 PPT，插件列表里看不出还支持 Word 与 Excel）
- README 重写：14 个工具表、两条 PPT 路线、三种格式的 spec 示例、改文件的用法、质检链、已知限制
- `docs/` 纳入发布包（含 `CHANGELOG-SUMMARY.md` 变更总览）
- 版本号定为 1.0.0：0.1–0.5 期间的功能面已稳定，测试 112 + 25 + 18 全绿

**0.5.x 的修复一并进入本版**：英雄页颜色变黑、`bento` 长数值压标签、`bigNumber` 数字压说明行、`matrix` 标签溢出、`timeline` 缺趋势线、lint 页码错位、同图跨页检查、封面副标题挤出日期、`<a:off y>` 负坐标。
## 0.5.5 — 未发布

- **封面副标题换行把日期挤出画面**：模板的副标题框只有 0.62 英寸高，两行副标题会把 meta（日期/来源）推出色带。现在按「标题下沿到色带下沿」的可用高度逐档试字号（24→14），把副标题 + meta 作为一个整体放进这段空间；实在放不下时不再硬塞，而是在 lint 里提示“副标题偏长，建议压到 44 字以内”。
- 修 `<a:off y>` 解析不接受负数的问题（模板里占位符坐标可以是负的，之前被当成 0）。
## 0.5.4 — 未发布

- **lint 页码错位**：幻灯片列表用了字典序排序（slide10 排在 slide2 前面），凡是超过 9 页的 deck，报错页码全错。改成按数字排序。
- **新增「同一张图片跨页复用」检查**：同媒体出现在 2 页以上会给出警告（`第 X、Y 页用了同一张图片`）；母版/logo 这类装饰图（出现在 ≥80% 的页面）自动豁免。
- 测试补 2 条（页码顺序、重复图片），并修正一处因新警告而失效的旧断言。
## 0.5.3 — 未发布

### 修掉的真 bug（来自特斯拉 deck 评审）
- **英雄页颜色全变黑**：调色板存的是不带 `#` 的十六进制，注入 CSS 时没补 `#`，浏览器丢掉整条声明 → 回退成黑色。现在统一补 `#`。
- **bigNumber 数字压住说明行**：单位位置按 `size/72` 算，但字形墨高约 1.36×，76pt 的数字会盖住下一行。改成按墨高推算，rule 与 label 也跟着走。
- **matrix 标签溢出到另一半象限**：靠近右边缘的标签改为放到圆点左侧并右对齐，宽度收到象限的一半。
- **timeline 读起来像没做完**：补 `series` 支持，按数值画趋势折线（用旋转矩形实现，不需要自定义几何）+ 数值标注；空值表示"还没数据"，折线到此为止。

### 新增能力
- `layout.rect` 支持 `rot`；新增 `layout.segment`（两点间画线）
- `timeline` 支持 `series` / `seriesLabel`
- `matrix` 支持 `items: [{u,v,label,tone}]`
## 0.5.2 — 未发布

- 修 `bento` 原型：数值较长时（"280.5 亿"、"13.7 GWh"）在 64pt 下会折成 2–3 行，文本框高度撑到 1.8–2.4 英寸压住标签。现在用与渲染同一个 `textHeight()` 逐档试算，保证数值单行，位置按选中的字号计算。
## 0.5.1 — 未发布

- 修 `suez_dump` 的 pptx 批注块被插了两次、且插在幻灯片循环里：指定 `slide` 时会重复打印。现在每次只输出一份，且不带 `slide` 时也会列出来。
## 0.5.0 — 重命名为 dsh-suez-office

- 插件包名：`dsh-suez-docgen` → **`dsh-suez-office`**；技能 id：`suez-docgen` → `suez-office`
- 资源目录：`assets/suez-docgen/` → `assets/suez-office/`
- 范围说明更新：不再只是"做 PPT"，而是 SUEZ 的 Office 工具箱（PPT / Word / Excel / PDF，含编辑、批注、修订）
- 新增 `test/e2e.mjs`：18 步端到端冒烟（每个工具都真调一次，产出过门禁 + 真实渲染）
## 0.4.1 — 未发布 · 细粒度能力

### Excel 公式
- `suez_build_xlsx`：单元格写 `"=SUM(B2:B4)"` 即成为真公式；workbook 带 `calcPr fullCalcOnLoad="1"`，打开即重算
- `suez_edit_xlsx`：`setCell` 支持 `formula`；新建行也走同一路径
- 共享公式主单元格被改写时直接报错（否则同组 si 悬空，Excel 打不开）

### 批注
- `suez_dump`：docx 的 `word/comments*.xml` 会列出作者、日期、正文
- `suez_add_comment`：按段落（文字匹配或序号）写入批注，结构与 Word 自己写的完全一致（含 CommentText / CommentReference 样式）

### 修订清洗
- `suez_clean_docx`：`acceptRevisions`（展平 w:ins、删 w:del、清 *PrChange）与 `stripComments`（删锚点与批注部件）

### 修掉的坑
- 新建行的 `cellXml` 调用漏传 formula → 公式退化成 0
- 手写的修订/批注样本本身不合 schema（锚点跨段），改用 Word 生成的 XML 结构反推
## 0.4.0 — 未发布 · 一个插件覆盖 Office

目标：取代 office-docs-win，只保留 suez-docgen。

### 新增工具
- `suez_dump`：读 pptx / docx / xlsx / pdf 结构
- `suez_check`：任意 Office 文件的包门禁（Content_Types + rels + XML 良构）
- `suez_edit_pptx`：setText / setImage / setChartValues / duplicateSlide / removeSlide
- `suez_build_docx`：标题、章节、段落、列表、表格、页眉页脚、A4
- `suez_edit_docx`：setParagraph（匹配或序号）、setTableCell
- `suez_build_xlsx`：多表、冻结表头、text/number/int/percent、列宽、筛选、适宽打印
- `suez_edit_xlsx`：setCell（保留数字格式，新格继承列样式）
- `suez_export_pdf`：pptx/docx/xlsx → PDF

### 硬规则
- 编辑永远写新文件，拒绝覆盖输入
- 包校验不过就不落盘

### 修掉的坑
- xlsx 的 `sheetPr` 必须放在 `dimension` 之前，否则 Excel 打不开（"Unable to get the Open property"）
- xlsx 表头要用 header 样式（深蓝底白字），不是 bold 样式
- `ZipDoc.save()` 要 Buffer，字符串会让成员长度对不上
- 种子文件封面：只有纯文字第 1 页才克隆，否则自绘
## 0.3.1 — 未发布

### 规则固化：动手前必须先选模式
- `suez_build_deck` 新增**必填**参数 `mode`：`"suez"` 或 `"free"`，不传直接拒绝，并在错误里给出要问用户的原话
- `mode: "free"` 要求每页都是 `heroHtml`（手写 HTML），**不复用原型版式**；不给种子时自动用中性空白母版（8 KB）
- `mode: "suez"` 仍走官方模板 + 23 原型 + 6 英雄页
- SKILL.md 顶部新增「第 0 步：先问模式（不可跳过）」；自由发挥**不固化成模板**

### 修复
- 自绘目录页编号在浅底上用深底强调色（对比度 1.8:1）→ 改用 limeInk
- 英雄页模板里的硬编码 SUEZ 色值改为 `{{c_*}}` 变量，皮肤调色板现在能进到 HTML 页面
## 0.3.0 — 未发布

### 自由发挥模式
- 三套皮肤 `editorial` / `tech` / `minimal`：自带母版与主题（`assets/suez-office/seeds/`），不需要 SUEZ 种子模板
- `style` 参数切换皮肤；页面原型完全共用，换 skin 不换版面
- 配色由 `styles.mjs` 统一定义，构建结束后自动还原 SUEZ 调色板

### 表格
- 单元格 `colspan` 合并（分组行）
- 数字列自动右对齐，也可用 `align` 指定
- 按列/按格 `wrap: "nowrap"` 控制换行策略

### 图片
- 超大图自动重编码：构建时压到 1800px 宽（实测 603 KB → 118 KB），下载时同样处理
- 裁切焦点 `focal: face | top | center`：人像向上偏裁，不再切掉下巴
- 统一圆角 `radius: 0.18`（roundRect + adj）

### 修掉的坑
- 封面长标题会挤到副标题：现在优先缩到单行（40→36→32→28→24）
- 同版本重打包装不上（pnpm 认版本+完整性）：改用固定包名 + 升版本

# Changelog

## 0.2.0 — 未发布

### 新增
- **图片管线**：`suez_fetch_image` 按 URL 下载 + 记录来历（url / 日期 / 许可 / 作者 → `credits.json`）；用了图却没写 `imageCredit` 时构建会报警
- **英雄页模板**：新增 `compare` / `statWall` / `device` / `people`
- 组合图次轴移到右侧；柱状图强制从 0 起；瀑布图颜色可配置（`upColor` / `downColor`）
- **带图底座页**：新增 `photoStrip` / `quotePhoto` / `bentoMix` / `portrait`；`agenda`（目录，克隆模板 Summary 版式，>4 章自动双列、>8 章续页并连续编号）
- **演讲者备注**：每页自动写 notesSlide（来源 / 图注 / 许可 / 图表类型），备注母版取自模板
- **节奏轮换**：相邻 anchor 页不能同一种主角类型
- **section 图片版**：`section` 传 `image` 即变左文右图
- **中文排版**：`breakLines()` 避头尾断行，标题行首不出现「。，、」、行尾不留「（「『」
- **图片处理**：图库 URL 自动加 `w=1800`；>2.5 MB 告警；同一张图多页复用只存一份（实测 1.75 MB → 1.07 MB）
- 标题下不再画绿色短线（模板没有这个元素）
- **英雄页（heroHtml）**：HTML → 2× 底图 + 真文本框，三个模板 cover / section / diagram；零依赖驱动 Edge CDP
- 原生图表 13 种：column / bar / line / area / stacked / stacked100 / pie / doughnut / radar / waterfall / combo / gantt / funnel
- 表格支持列宽权重 `widths` 与单元格换行，行高按内容自动计算
- 回归测试 `test/run.mjs`：37 项断言，含两个负向用例
- 真实字体度量 `metrics.mjs`：解析 cmap/hmtx/hhea/head/name，索引本机 573 个字体
- 卡片页 / 要点页改为顶部对齐，短内容页不再垂直居中

### 修掉的坑
- 面积图带 marker/smooth → PowerPoint 判文件损坏
- 堆叠柱（stacked / stacked100）标签位置只允许 `ctr`
- 本机 PowerPoint 拒绝 `c:holeSize`（`55` 与 `50%` 两种写法都报 0x80070570）
- 瀑布图改为「每步水平值 + 起始值」输入，负值不再堆叠错位
- 瀑布图合计柱标签深蓝压深蓝 → 改白色
- 表格四列等宽导致事件列溢出并撞上下一列
- 条形图分类顺序（自下而上绘制）
- 封面 / 章节满版背景高度 8.13″ 超出页高

## 0.1.0 — 2026-11-11

第一版。以官方 SUEZ 模板为种子的故事板生成器。

### 能力
- 19 个页面原型，全部走 6 栏网格与令牌化字号
- 图片满版 / 半版 / 卡片，自动 `srcRect` cover 裁切（读 PNG/JPEG 头，不依赖图像库）
- 每次构建自动跑：包完整性、schema 层校验、版式 lint、节奏检查
- 三个工具：`suez_build_deck` / `suez_render_page` / `suez_lint_deck`

### 这一版修掉的坑（都实测过）
- `algn="c"` 非法枚举 → PowerPoint 整包打不开，而结构校验是 CLEAN；`validate.mjs` 现在拦它
- jpg 缺 `Content_Types` 默认项 → 0x80CB8002
- 模板版式自带 logo，再画一遍会叠成双影（`sueᵉ2`）
- 标题宽度按 11.41″ 会伸到右上条码母题下 → 固定 10.0″
- 页码右对齐到 12.20″ 会被 logo 压住
- 卡片固定 4″ 高会在内容下方留 2.6″ 死白 → 按内容算高
- KPI 数值与标签的盒子重叠 → 数值盒按 ink 高度
- 浅绿（AADC14）11pt 对比度只有 1.6:1 → 小字改用次级墨色
- 图表 y 轴刻度线拥挤 → `majorTickMark/minorTickMark = none`
- 标题末行两个字孤行 → 末行不足 4em 自动降一档字号

### 已知限制
- 图片下载不内置：需要模型给 URL 或用户提供文件（这台机器的 shell 无外网）
- 母版来自种子模板：换模板要重新验一遍版式
- 英雄页（HTML → 底图 + 文本框）尚未产品化
