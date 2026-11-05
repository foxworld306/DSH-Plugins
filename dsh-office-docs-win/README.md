# dsh-office-docs-win — 免 Python 的 Office 文档插件

给锁死权限的公司电脑用：**不需要 Python、不需要 pip、不需要管理员权限**。
装上以后，DSH 可以直接读结构、改内容、做质检、渲染成图片/PDF，产出 `.pptx` / `.docx` / `.xlsx` / `.pdf`。

## 一台新电脑怎么装（两种方式，选一种）

**方式 A：双击（推荐给不懂 IT 的同事）**

1. 把 `dsh-office-docs-win-1.0.0.zip` 拷到电脑上，解压到任意目录（例如桌面）。
2. 进目录，**双击 `install.cmd`**。
3. 看到「安装完成」就好了；然后新开一个 DSH 会话。

安装脚本会自己找 Node.js —— 就算电脑上没装 Node，也会用 DSH 桌面版自带的那个
（`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\...\node.exe`）。
它只写 `%USERPROFILE%\.dsh` 下的内容，不写注册表、不要管理员、不装服务；重复运行结果一样。

**方式 B：图形界面（双击失败时用）**

DSH 侧边栏 → **Plugins（插件）** → 安装 → 选择解压出来的这个文件夹。同样是一键。

**方式 C：官方插件命令（插件发布到 registry / npm 之后）**

```powershell
dsh plugin --profile web add dsh-office-docs-win
```

这是 DSH 官方的安装入口：它读包里的 `dsh.bundle.patch` 自动挂载，不需要你手改 `cordis.yml`。
兼容性由 `engines.dsh: >=0.2.0-rc.1 <0.3.0-0` 声明（DSH 0.2.x 全线可用，0.3 起会明确提示不兼容而不是崩）。

> 装完必须**重启 DSH 或新开一个会话**，插件才会加载。

## 为什么要重启一次

工具是热加载的，装完立刻能用。技能要重启一次才出现在技能列表里：宿主在会话启动时就收集过一次技能目录，
插件是之后才挂载的。装好重启一次之后，以后改文档（SKILL.md / *.md）不用再重启——技能正文有两条通道，
其中 provider 那条按需读盘；只有**重新安装插件**之后才需要再重启一次。

## 装完怎么确认成功

在会话里说一句「**用 office-docs-win 看一下这个 pptx**」。正常表现：

- 技能 `office-docs-win` 可用（描述里会写 no Python / 无管理员权限）；
- 工具 `office_docs_check`、`office_docs_dump`、`office_docs_render` 出现并可调用；
- 让它 dump 一个真实文件，能列出每页形状、位置（英寸）、文本、字体、颜色；
- 让它把某一页渲染成 PNG（`office_docs_render`），不需要任何审批弹窗。

## 它装了什么

| 组成 | 说明 |
|---|---|
| 技能 `office-docs-win` | 6 篇操作手册（总体 / pptx / docx / xlsx / ooxml / pdf），加载时自动附上本机 **绝对路径**（node 与脚本目录），模型不依赖 PATH |
| 工具 `office_docs_check` | 交付前必跑：`[Content_Types].xml` 三类致命问题（重复 Default / 重复 Override / 部件没声明）、每个部件 XML 是否合法、docx 的 paraId 是否撞车 |
| 工具 `office_docs_dump` | 改之前先看结构：形状类型/名称/位置尺寸（英寸）/文本/字体/颜色、docx 段落表格页眉页脚、xlsx 表名/行数/前 40 格（共享字符串与公式已解算） |
| 脚本 `scripts/ooxml.mjs` | OOXML 读写层：自实现 ZIP（仅 `node:zlib`）+ 部件读写 + 三项校验。等价于原 `ooxml.py`，**输出经差分测试逐字比对一致** |
| 脚本 `scripts/dump.mjs` | 结构导出，等价于原 `dump_pptx.py` |
| 脚本 `scripts/qa_render.ps1` | 渲染/导出 PDF：PowerShell + Office COM（唯一有真实保真度的引擎） |

渲染仍然要本机 Office 桌面版（Word/Excel/PowerPoint 已激活）；Office Online 没有 COM，不行。

## 配置

本插件**无配置项**（有意为之：不声明 `Config`）。渲染超时等参数通过工具参数按次控制
（如 `office_docs_render` 的 `timeoutSec`：默认自动 = pptx 180s / docx·xlsx 600s，`0` 关闭看门狗）；
OOXML 工具行为无开关。

## 出问题怎么办

- **日志**：`%LOCALAPPDATA%\dsh-office-docs-win\plugin.log`
  里面有插件启动时的自检（技能/工具是否注册成功、失败原因与堆栈）。
- **双击窗口一闪而过**：右击 `install.cmd` → 以其他方式打开 → 用记事本，把末尾 `pause` 保留（默认就有），再从 PowerShell 里运行它，能看到完整报错。
- **提示没找到 dsh 命令**：改用上面的方式 B（图形界面安装）。
- **提示 profile 里的副本不完整**：删掉 `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-office-docs-win` 再装一次（pnpm 会缓存旧副本）。

## 卸载

```
dsh plugin --profile web remove dsh-office-docs-win
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\skills\office-docs-win"
```

或图形界面 Plugins 页里移除。插件不改你自己的 `cordis.patch.yml`（挂载条目在包内自带），所以卸载后配置保持干净。

第二条命令只在当初用 `--copy-skill` 装过时才需要（技能副本 `~/.dsh/skills/office-docs-win`，带 `.installed-by-plugin` 标记）。1.0.0 起插件自己用 `register()` + `registerProvider()` 两条官方通道注册技能，**不再需要副本**：重启后主会话和子代理都能从 `profiles/web/node_modules/dsh-office-docs-win/assets/office-docs-win` 加载（2026-11-05 实测，把副本移走后仍然可用）。

## 开发者信息

- 渲染是异步的：`renderDocument()` 用 `spawn` 起 PowerShell，转发 `exec.signal`（取消时 `taskkill /T /F` 杀进程树），15 分钟兜底；旧版 `spawnSync` 会把整个宿主进程卡住。
- 依赖：**零**（不 import `@deepseek-ai/dsh-tools` —— 那会把框架第二份副本拉进用户 profile，导致 `reading 'prepare'` 之类的报错；`parameters` 直接写 JSON Schema）。
- 技能注册走**两条官方通道**：`ctx.skills.register()`（运行时定义，会失效目录缓存，rank 250）与 `ctx.skills.registerProvider()`（按需读盘，rank 600，官方 `dsh-skill-office` 同款）。两条都由 `ctx.effect` 持有，重载时自动替换而不是叠加。只注册 provider 时实测宿主目录里查不到（见 `docs/OFFICIAL-ALIGNMENT.md` 第五节 B16）。
- 安装器**默认不写** `~/.dsh/skills` 副本：那份副本 rank 400，会盖住插件内置的 600，两份文档容易漂移。只有宿主版本早于 1.0.0 时才加 `--copy-skill`。
- 重新生成 `assets/`：`node build_assets.mjs`（从 `../office-docs-win` 的文档与 `../office-docs-win-js/scripts` 的脚本合成，并把 Python 教学改成 Node）。
- 自测：`node test/mock_apply.mjs <pptx> <docx> <xlsx>`（用假 ctx 验证注册契约 + 重复 apply 幂等 + 真实文件跑三个工具 + 相对路径解析）。
- 差分测试（与 Python 实现逐字对拍）：`../office-docs-win-js/test/diff_test.ps1`。

## 自测（改过代码就把这三条都跑一遍）

| 命令 | 覆盖什么 |
| --- | --- |
| `node test/format_suite.mjs` | 33 项：pptx/docx/xlsx 生成、dump、改一个 run/段落/单元格、roundtrip 字节一致、5 个负例（截断包、缺 Content_Types、重复 Default、孤立 part、坏 XML）、4 个结构闸（空 `<p:sp/>`、重复 `cNvPr id`、悬空关系目标、xlsx 断裂 `r:id`）、非 ASCII 路径、`ZipDoc.blank()`。`--keep` 保留夹具 |
| `node test/mock_apply.mjs` | 注册契约、重复 apply 幂等、三个工具对真实文件、相对路径解析（不传参数时用 `.office-docs-render/suite` 的夹具） |
| `powershell -File test/com_normalize.ps1` | 用真实 Word/Excel/PowerPoint 打开产物 + 导出 PDF，报页数。需要交互桌面、非沙箱；脚本自带僵尸清理 |

渲染侧的硬性检查不再靠"文件存在"：`qa_render.ps1` 会读文件头（`%PDF-` / `\x89PNG`）并回报页数，格式不对直接报错——Excel 分支曾经把 `.xlsm` 存成 `.pdf` 一整年没人发现。

## 规范与变更

- 与 DSH 官方插件规范的逐条对照（清单字段、Cordis 形状、工具/技能契约、官方校验器实测）：`docs/OFFICIAL-ALIGNMENT.md`
- 版本变更：`CHANGELOG.md`　许可证：`LICENSE`（MIT）
