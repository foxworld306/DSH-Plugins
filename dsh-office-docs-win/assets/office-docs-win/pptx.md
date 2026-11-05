> **This build has no Python.** Every toolkit call uses Node:
> `node <scripts>/dump.mjs <file>` (structure dump) and `node <scripts>/ooxml.mjs check <file>`
> (integrity gate). `ooxml.mjs` is a line-by-line port of the original `ooxml.py` — same class
> and method names (`ZipDoc`, `part`, `setPart`, `save`, `checkPackageIntegrity`,
> `duplicateParaIds`) — and its output is verified byte-identical by a differential test suite.
> Where a recipe below still shows Python, write the equivalent `.mjs` instead:
> `import { ZipDoc, checkPackageIntegrity } from '<scripts>/ooxml.mjs'`. This host has no
> `python.exe`; a `python` command will simply fail.
# PPTX 细节（OOXML zip + PowerPoint COM）

> 要从零生成一个完整文件：拷 `examples/build_deck.mjs`，改里面的内容数组即可（已跑通、含完整性检查）。

## 包结构
- `ppt/slides/slideN.xml` — shape 树；`ppt/slides/_rels/slideN.xml.rels` — 图片关系
- `ppt/media/` — 媒体；`ppt/theme/theme1.xml` — 主题字体/色；`ppt/presentation.xml` — 页面尺寸（`sldSz cx/cy`，EMU；16:9 = 12192000×6858000 = 13.33×7.5"）
- slide XML 单位：EMU（914400/英寸）。`EM = lambda v: str(int(round(v*914400)))`

## 字体（SUEZ 标准，逐字复制）
每个 run 带三段式字体块（latin 西文 / ea 中文 / cs 复杂文种）。缺 panose/pitchFamily/charset 会被 Office 替换字体：

    <a:latin typeface="poppins" panose="00000500000000000000" pitchFamily="2" charset="0"/>
    <a:ea typeface="方正准圆_GBK" panose="02000500000000000000" pitchFamily="2" charset="-122"/>
    <a:cs typeface="poppins" panose="00000500000000000000" pitchFamily="2" charset="0"/>

Run 模板（sz = 1/100 pt，800 = 8pt；粗体加 b="1"）：

    <a:r><a:rPr lang="en-US" altLang="zh-CN" sz="{sz}"{b} dirty="0">
      <a:solidFill><a:srgbClr val="{color}"/></a:solidFill>{字体三段}
    </a:rPr><a:t>{text}</a:t></a:r>

## Shape 模板
矩形（填充、无边框）：

    <p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="{EM(x)}" y="{EM(y)}"/><a:ext cx="{EM(w)}" cy="{EM(h)}"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    <a:solidFill><a:srgbClr val="{fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>
    <p:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/><a:lstStyle/>
    <a:p><a:endParaRPr lang="en-US" sz="900"/></a:p></p:txBody></p:sp>

文本框（paras = [([run...], spcAft_pts), ...]；参数为单对 `[[run...], spc]` 时先包一层再迭代，否则 unpack 报错——生产踩过）：

    <p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
    <p:spPr>（同矩形，但 <a:noFill/>）</p:spPr>
    <p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/><a:lstStyle/>{PARAS}</p:txBody></p:sp>

    段落: <a:p><a:pPr><a:spcAft><a:spcPts val="{pts}"/></a:spcAft></a:pPr>{RUNS}</a:p>

图片（2026-10-29 在本机 PowerPoint COM 双向验证：含图基础包 ✅ / 无图基础包 ✅——前提是先过下面的预检）：
1. PNG 拷入 `ppt/media/`（用不重名的新文件名，如 image3.png）
2. 在**该 slide 的** rels 里加 Relationship：`ppt/slides/_rels/slideN.xml.rels`，新 rId（查该文件已有 rId 取唯一值），`Target="../media/xxx.png"`（**必须带 `../`**）
3. **Content_Types 预检（血泪教训，必做）**：读 `[Content_Types].xml`，若已有 `<Default Extension="png">` **就不要再加**——重复的 Default 条目违反 OPC（extension 必须唯一），PowerPoint 直接拒绝打开整个包（HRESULT 0x80CB8000，报 "could not open"），而 Univer 等宽松渲染器能打开，会造成"包合法但 PowerPoint 打不开"的假象。只有完全不存在该条目时才加一条 `<Default Extension="png" ContentType="image/png"/>`（或改用该 part 的 Override）。
4. slide XML 里插 `<p:pic>`（slide 根元素必须已声明 `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`——含图 deck 都有，新建 deck 没有就先补）：

    <p:pic><p:nvPicPr><p:cNvPr id="{id}" name="{name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
    <p:blipFill><a:blip r:embed="{rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
    <p:spPr><a:xfrm>...</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>

5. **交付前两道验证，缺一不可**：
   a. `checkPackageIntegrity(parts)` 返回空列表（查 Content_Types 完整性：重复 Default / part 无覆盖——两类问题都会让 PowerPoint 直接拒开，而 Univer 等宽松渲染器照样能打开，**"别的渲染器能开"不是有效的信号**）。
   b. COM 打开 + 渲染（`qa_render.ps1`）。
   若 (a) 干净但 (b) 无窗口打开报 "could not open"：先怀疑会话环境（非交互会话 + 含图 deck 的 WithWindow 问题，见 COM 节），不要反复改包。

备选（PowerPoint 原生写 rels/media，零手工）：COM `Shapes.AddPicture(path, $false, $true, left, top, width, height)`——先清僵尸进程（qa_render.ps1 内置），交互式桌面会话下最稳。

## Logo（SUEZ 默认）
`assets/suez-logo.png` 放**每页内容页右下角**：16:9 → x=11.9", y=6.85", w≈1.25"（h≈0.32"）。模板复刻时跟模板里的位置走（模板优先）。

## PowerPoint COM（渲染质检）— 2026-10-29 复核：可用，但有环境敏感点
- `PageSetup.SlideWidth/SlideHeight` 单位是 **point**（16:9 = 960×540），不是 EMU；`SlideSize` 属性不存在（传 EMU 会报 out of range）。
- **无窗口打开（WithWindow=$false）在部分非交互会话下对含图 deck 必失败**（"could not open"，即使包完全合法——2026-10-29 在另一台机器受控实验证实：同一 deck 改用 WithWindow=$true 即成功，无图 deck 无窗口正常；连从未改过的 deck 也无窗口打不开）。这是会话环境问题，不是包问题：包过了 `checkPackageIntegrity` 且无窗口打开失败时，先怀疑环境，不要反复改包。`qa_render.ps1` 已内置兜底：headless 失败后自动改用 `WithWindow=$true` 重试（会闪一个短暂的 PowerPoint 窗口）；纯无桌面环境传 `-NoWindow` 关闭兜底。
- **僵尸 COM 进程是头号杀手**：之前崩溃留下的无窗口 POWERPNT 会让后续 Open 报 "could not open"、Shapes.AddPicture 恒定 E_FAIL、Export 触发 RPC 0x800706BE（进程被杀）。开 COM 前先清：`Get-Process POWERPNT -ErrorAction SilentlyContinue | ? { $_.MainWindowHandle -eq 0 } | Stop-Process`（只杀无主窗口的 headless 实例，不碰用户可见的 PowerPoint）。`qa_render.ps1` 已内置此清理 + 失败自动重试一次。
- **临时文件必须保留原扩展名**：`GetRandomFileName()` 是 8.3 形态（qa_xxxxxxxx.yyy），PowerPoint 认不出格式 → "could not open"。用 `[guid]::NewGuid().ToString('N') + 原扩展名`。
- 标准序列（已验证可跑）：

    $stage = Join-Path $env:TEMP 'qa.pptx'         # 用 $env:TEMP（沙箱可写）；OneDrive 文件必须先拷
    Copy-Item deck.pptx $stage -Force
    $ppt = New-Object -ComObject PowerPoint.Application
    $pres = $ppt.Presentations.Open($stage, $true, $false, $false)
    $pres.Slides.Item($n).Export((Join-Path $env:TEMP 'slide.png'), 'PNG', 1600, 900)
    $pres.Close(); $ppt.Quit()
    [Runtime.InteropServices.Marshal]::ReleaseComObject($ppt)

  之后 `read_image` 检查 PNG。注意：DSH 沙箱下 COM 需要一次 `danger-full-access` 审批，且要把整段 COM 操作放进同一个脚本（见 SKILL.md 环境事实）。
- SVG 栅格化（画图表）：开一个演示文稿 → `PageSetup.SlideWidth=960; SlideHeight=540`（point）→ `Slides.Add(1, 12)`（blank）→ `Shapes.AddPicture($svg, $false, $true, 0, 0, 960, 540)` → `Export('out.png','PNG',1920,1080)`。

## 图表（手写 SVG，无 matplotlib）
单调三次（Fritsch–Carlson）→ Hermite → Bézier，保证无过冲：
1. 段内差分 d[i] = (y[i+1]-y[i])/(x[i+1]-x[i])；切线 m 取相邻 d 调和平均；
2. d[i]==0 处 m[i]=m[i+1]=0；
3. 相邻段 d 异号处按 s²+t²≤9 限制 m[i],m[i+1]；
4. 每段控制点：c1 = p0 + (p1-p0)/3 * (1, m0)，c2 = p1 - (p1-p0)/3 * (1, m1)。
- y 轴用干净刻度（如 100M 一格），峰值点 + 标注，可选 7 日移动平均虚线；全英文标签（除非用户另要求）。
- 参考实现：本页的 SVG 模板 + PowerPoint COM 导出 PNG（本机没有 Python，不要调用 `.py` 脚本）

## SUEZ 色板
NAVY `030F40`（标题/色带）· GREEN `AADC14`（强调数字）· DARK `333F55`（正文）· MID `5A6B8C`（标签/次要）· PANEL `F2F5FA`（卡片底）· GRID `D9E0EA`（分隔线/网格）· LIGHT-BLUE `B8C4E0`（图表辅）· SLATE `8C9BB5`（图表第三色）。

## 注入/删除规则
- 新 shape 插到 `</p:spTree>` 前；id = 现有 `cNvPr id` 最大值 +1 起递增（重复 id 会导致 PowerPoint 修文件）。
- 按 name 删 shape 用正则 `<p:sp>(?:(?!</p:sp>).)*?name="X"(?:(?!</p:sp>).)*?</p:sp>`（re.S）；**name 可能重复**（用户会加同名 shape）→ 用 `<a:off y>` 区分，保留项按位置过滤。
- `<a:t>` 内 `&` → `&amp;`；`–` \u2013 / `—` \u2014 / `×` \u00d7 / `·` \u00b7 在 py 文件里写转义。
- zip 写出：逐 item 复制，只替换改过的 part；`.tmp` + `os.replace`。
- 行宽估算：8pt 西文在 2.4" 宽框里约 42–46 字符/行——图例/insight 措辞前先数长度，避免换行挤压（生产踩过多轮）。
