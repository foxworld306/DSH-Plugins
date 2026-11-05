# office-docs-win 全格式验证报告（2026-11-04）

环境：Windows 11 + Office C2R x64 16.0.20430 + PowerShell 5.1 + node 24.21。
方法：能生成的就生成，生成完**用真实 Office 打开**；改过的每条路径都要有正例 + 负例；
渲染产物读文件头核对格式，不靠"文件存在"。

## 一、结论先说

修了 8 个真 bug，其中 1 个是**用户会直接踩到的交付事故**（Excel 导出的"PDF"其实是 .xlsm）。
现在三条自测：

- `test/format_suite.mjs` — **40/40 全绿**（含 PDF 读路径与 4 条错误路径）
- `test/mock_apply.mjs` — **全绿**（注册契约 + 真实文件跑三个工具 + PDF 与"改名成 pdf 的 xlsx"）
- `test/com_normalize.ps1` — **ALL GREEN**：Word/Excel/PowerPoint 各自打开 + 导出 PDF，三份 PDF 头部校验通过

## 二、这轮找到的问题

### B1（严重）Excel → PDF 导出的是 .xlsm，只是改名成 .pdf
`qa_render.ps1` 的 xlsx 分支写 `$wb.SaveAs($dest, 52)`，注释写 "52 = xlPDF"。
52 实际是 `xlOpenXMLWorkbookMacroEnabled`，PDF 要么用 `ExportAsFixedFormat(0, ...)`，要么 `SaveAs(..., 57)`。
证据：导出文件头是 `PK\x03\x04`，解包后是标准 xlsx（含 `xl/calcChain.xml`、`docMetadata/LabelInfo.xml`）。
同事拿到的"PDF"用 Adobe 打不开、用 Excel 打开还提示格式与扩展名不符。
**修复**：改用 `ExportAsFixedFormat(0, $dest)`；实测 31,560 字节、文件头 `%PDF-1.7`。

### B2（严重）渲染成功与否只看"文件在不在"
上面那个 bug 能活一整年，就是因为验收只 `Test-Path`。
**修复**：`qa_render.ps1` 收尾读文件头 + 体积下限——PDF 必须 `%PDF-` 且 ≥512 B，PNG 必须 `\x89PNG` 且 ≥2 KB，
否则抛错带上实际首字节。以后任何"格式存错/被截断"都当场暴露。

### B3（严重）体检闸对包结构完全失明
`checkPackageIntegrity` 只查 Content_Types + XML 良构。而 PowerPoint 拒开的那些包，XML 往往完全良构。
**修复**：新增 `checkStructure()`（随 `checkPackageIntegrity` 默认执行）：
- 空的 `<p:sp/>`（形状必须有 `p:nvSpPr`/`p:spPr`，图片还要 `p:blipFill`，graphicFrame 要有 `p:nvGraphicFramePr`/`p:xfrm`）
- 同页重复的 `<p:cNvPr id>`
- 关系目标指向不存在的 part
- `r:id` 引用了 .rels 里没有的 Id（Excel 的 `<sheet r:id>` 断裂就是这一类）
- docx `<w:tbl>` 缺 `<w:tblGrid>`、xlsx worksheet 缺 `<sheetData>`、根元素不对
误报实测：14 份真实 deck（含 29 MB 用户手改稿、python-pptx 模板、我自己 8 页排版稿）全部 CLEAN。

### B4 渲染失败的报错把人带偏
原来只会说 "Office installed? file corrupt?"，把真实 HRESULT 吞了。
**修复**：捕获并回传最后一次 COM 错误原文，提示里加"先跑 office_docs_check 验证包结构"。

### B5 PDF 页数的文档说法不可靠
文档让人数 `/Page` 近似。**修复**：渲染时直接问应用——Word `ComputeStatistics(2)`、Excel `PageSetup.Pages.Count`、
PPT `Slides.Count`，输出 `rendered: … (16166 bytes, pages 3, magic ok)`。实测 3 页文档报 pages 3。

### B6 pptx 渲染的提示会误导
只导第 1 张 PNG，却写 "pages 2"（其实是总页数）。**修复**：改成 `slide 1 of 2`。

### B7 文档里的错误配方
`xlsx.md` 标题写着"SaveAs 52/xlPDF 已验证成功"（就是 B1 的来源）、`pdf.md` 的页数建议、`ooxml.md` 说"关系目标缺失刻意不报"——
全部按实测改写，并补了 `checkStructure` 的说明和 "跳过办法"。

### B8 COM 三个坑（写进 SKILL.md 的 gotcha）
1. **上次被中断留下的 WINWORD/EXCEL 会让后续每次调用挂起**（不是报错）。必须先 `Stop-Process`。
2. **源文件在 OneDrive 目录里时导出会卡死**，哪怕目标是 %TEMP%。先拷到 %TEMP% 再开（qa_render.ps1 本来就这么做）。
3. `Documents.SaveAs2(...,16)` / `Workbook.SaveAs(...,51)` 无人值守会卡在格式转换对话框；QA 只需要"打开 + 导 PDF"。

### B9 测试自身的两个坑（会让人误以为插件坏了）
- 沙箱禁止命名管道，`child_process` 用 `stdio:'pipe'` 一律 EPERM、`status=null` → 改成给子进程一个真实文件句柄。
  **这条对使用者也有意义**：任何在 DSH 沙箱里跑 node 子进程的脚本都会踩，不是插件问题。
- `mock_apply.mjs` 不传参数直接崩（`path.resolve(undefined)`），而 `format_suite` 默认会清掉夹具 → 现在自动找夹具。

## 三、这轮之前（做那份 8 页 PPT 时）修的 4 个

1. `pPr` 里把 `<a:spcBef>` 写成 XML 属性 → 段落 XML 崩，整包被拒。
2. 往 `spTree` 里拼了裸 `<p:sp/>` → XML 良构、体检 CLEAN、PowerPoint 报 "could not open"（就是 B3 的动机）。
3. Logo 右半在深色底上消失（深蓝 wordmark = 背景色）→ `a:clrChange` 换白色，不加新素材。
4. 圆点画成方块（`rect()` 把调用方的 `prst:'ellipse'` 覆盖了）。

## 四、验证矩阵

| 格式 | 生成 | 读(dump) | 改 | roundtrip | 真实 Office 打开 | 导出 | 负例 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pptx | ✅ 2 页示例 | ✅ 翻页/文本/字体/色 | ✅ 按 shape 名替换 run | ✅ 字节一致 | ✅ 41 parts, 13.33in | ✅ PNG 11 KB | ✅ 6 类 |
| docx | ✅ 含表格 | ✅ 段落/表格 | ✅ sectPr 前插段落 | ✅ | ✅ 17 段 1 表 48 词 | ✅ PDF 27 KB, pages 1 | ✅ |
| xlsx | ✅ 含公式 | ✅ 表名/公式/共享串 | ✅ 改单元格 + 缓存值 | ✅ | ✅ 表名"预算汇总", B5=2,980, D5=19.30% | ✅ PDF 31 KB, pages 1 | ✅ |
| pdf | — | 不支持（明确报 `unsupported: pdf`） | — | — | ✅ 三种来源都能打开 | — | — |

## 五、仍然存在的风险（没条件在这里验证）

1. 真正干净的机器上第一次跑 COM（注册表/激活/打印机驱动）——这台机器已被预热过。
2. GUI Plugins 页接受 `file:` 形式的本地包（命令行 `dsh plugin add` 已验证）。
3. 打包机上没有 pnpm（`dsh plugin add` 依赖它）。
4. Excel 的 `PageSetup.Pages.Count` 需要打印机驱动，没有时页数为 0（已做 try/catch，不阻断渲染）。
5. ~~本轮改的 `lib/index.js` 要重启 DSH 才生效~~ **已推翻**：重启后一测，之后又改的两处 `lib/index.js` 守卫
   在**没有再重启**的情况下就生效了（宿主会热重载插件模块）。技能目录是否同样热更新没有单独验证。
   技能目录同理。

## 六、复现

```
node office-docs-win-plugin/test/format_suite.mjs --keep
node office-docs-win-plugin/test/mock_apply.mjs
powershell -File office-docs-win-plugin/test/com_normalize.ps1
```

## 七、第二轮补充（2026-11-05）

### B11（严重）COM 的 `SaveAs` 必须按 `[ref]` 调用，按值调用会静默挂死
这一轮我在自测脚本里写 `$doc.SaveAs2($pdf, 17)`，结果：日志停在 "opened fine"，进程活着、没有对话框、CPU 为 0，
300 秒超时。换成 `$doc.SaveAs([ref]$pdf, [ref]17)` 后同样的文件 1 秒返回。
Excel 是例外：`ExportAsFixedFormat(0, $dest)` 按值可用。
之前误判成"OneDrive 同步锁"，实际跟路径无关——**已经写进 SKILL.md 的 gotcha，并撤掉了那条错判**。

### B12 之前不支持 PDF 读取，但技能描述声称支持
`dump.mjs` 对 `.pdf` 直接报 `unsupported: pdf`，而插件描述写着 "read .pptx, .docx, .xlsx, .pdf"。
现在补上 `dumpPdf()`：版本、页数（优先页树 `/Count`，退化到数 `/Type /Page`，再不行明说"未知"）、
Title/Author/Producer/Creator（UTF-16BE/LE/BOM 都解）、字体与图片对象数；还能识别加密与线性化。
并且能当场抓出"扩展名 .pdf、内容其实是 zip"——正是 B1 那类事故的检测手段。
`office_docs_dump` 工具层同步放行 `.pdf`。

### B13 错误路径的措辞
- 传目录进去原来报 `unsupported: suite`（把目录名当扩展名）→ 现在 `is a directory, not a file`。
- 空文件、docx 改名成 .pptx、截断 zip —— 都有明确报错，且都进了自测（4 条新用例）。

### 本轮最终数据
| 项 | 结果 |
| --- | --- |
| format_suite | 40/40 全绿 |
| mock_apply | 全绿（含 PDF 正反例） |
| com_normalize | ALL GREEN：word.pdf 27,572 B / excel.pdf 31,560 B / ppt.pdf 26,846 B，全部 `%PDF-` |
| 安装同步 | 技能副本 0 个文件不同步；profile `lib/index.js` MATCH |
| 分发包 | 22 条目、106.8 KB，含 `lib/index.js`，不含 `test/` |

## 八、重启后的复验（2026-11-05 07:56 之后）

用户在重启后要求复验"没验成功的项"，结果：

| 项 | 结果 |
| --- | --- |
| `office_docs_dump` 读 PDF（上一轮唯一需要重启的功能） | ✅ 通过：`pages: 3 (page tree /Count)`、producer/creator 正确解码 |
| `office_docs_dump` 读 xlsx 导出的 PDF | ✅ `pages: 1`，Producer 为 Excel |
| `office_docs_check` 传 PDF | ✅ 新增守卫：`is a PDF, not an OOXML package … Use office_docs_dump` |
| `office_docs_check` 传目录 | ✅ `is a directory, not a file`（原来报 `EISDIR`） |
| `office_docs_check` 传 .cmd | ✅ `is not an OOXML package (expected .pptx/.docx/.xlsx, got .cmd)` |
| `office_docs_dump` 传目录 | ✅ 同上目录守卫（原来把整条路径当扩展名） |
| `office_docs_render` docx | ✅ 12.8 s，`(27528 bytes, pages 1, magic ok)` |
| `office_docs_dump` pptx 第 2 页 | ✅ 形状/字体/颜色正常 |
| 技能够可见 | ✅ 重启后会话的技能目录里出现 `office-docs-win` |
| GUI Plugins 页能否看到插件 | ⚠️ 独立标签页需要 `dsh web` 的令牌，无法在未登录标签里看；改从数据层核对：profile `package.json` 有 `dsh-office-docs-win: file:…`，模块 1.0.0 存在且带 `dsh.bundle.patch`，而用户的 `cordis.yml` 里没有这个插件的条目（说明确实没改用户配置） |
| 干净机器首次 COM / 无 pnpm / 无打印机驱动 | ❌ 仍然无法在本机验证 |

新增守卫后：`format_suite` 40/40、`mock_apply` 全绿（新增 3 条输入守卫用例）、分发包已重打（107.4 KB）。

## 九、发布前对齐官方规范（2026-11-05）

审计全文见 `docs/OFFICIAL-ALIGNMENT.md`；这里只记**实测**证据。

| 编号 | 做了什么 | 证据 |
| --- | --- | --- |
| B14 | `package.json` 补 `engines.dsh: >=0.2.0-rc.1 <0.3.0-0`、`engines.node: ^22.19.0 \|\| >=24.0.0`、`keywords`、`files`、LICENSE、CHANGELOG | 用官方 `evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.5')` 实测返回「compatible」；`bundlePatchFiles()` 解析为 `./cordis.patch.yml` |
| B15 | `renderDocument()` 由 `spawnSync` 改为异步 `spawn` + `exec.signal` → `taskkill /T /F` | 真实 docx 渲染 13.5 s 成功（27 KB PDF）；1.2 s 时 abort，1.8 s 内以 "render cancelled" 结束，无残留 PowerShell |
| B16 | 技能改为 `skills.register()` + `skills.registerProvider()` 双路注册 | 裸 registry 里实测：目录在插件挂载**之前**收集，挂载后立即出现 `office-docs-win`，`get()` 返回 18,961 字符、resourceBase 指向插件 assets；重复挂载后仍只有 1 条 |
| B17 | 技能注册改由 `ctx.effect` 持有，去掉 `globalThis` disposer | `test/mock_apply.mjs` 断言：一次 apply 恰好 2 个 effect，二次 apply 4 个，释放第一对后各剩 1 |
| B18 | 安装脚本加 `--no-copy-skill` | `install.mjs` 默认仍写副本（兜底），加参数可跳过；README 已说明 rank 400 会盖住插件内置的 600 |

回归：`format_suite.mjs` 40/40 通过；`mock_apply.mjs` ALL GREEN；assets 与 `~/.dsh/skills/office-docs-win` 逐文件哈希一致（0 漂移）；profile 内 `lib/index.js`、`lib/render.js`、`package.json`、`install.mjs` 与仓库一致；`dist/dsh-office-docs-win-1.0.0.zip` 23 个条目 / 105.8 KB。

**B16 最终验收：通过（2026-11-05 09:1x，重启后）**。重启日志显示两条注册都生效：

```
2026-11-05T01:05:33.494Z apply: has skills=true tools=true inject=function
2026-11-05T01:05:33.506Z skill registered via skills.register()
2026-11-05T01:05:33.509Z skill registered via skills.registerProvider()
```

把 `~/.dsh/skills/office-docs-win` 整个移出后再调用 `skill` 工具，技能正常加载，返回的基目录是
`~/.dsh/profiles/web/node_modules/dsh-office-docs-win/assets/office-docs-win`，
正文里的运行时路径也全部指向 `profiles\web\node_modules\dsh-office-docs-win\assets\...\scripts`。
即：**不再依赖 `~/.dsh/skills` 的副本**，副本从兜底降级为可选。
