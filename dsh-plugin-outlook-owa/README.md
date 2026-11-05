# dsh-plugin-outlook-owa

在 **禁止 Microsoft Graph** 的 Microsoft 365 租户里，让 DeepSeek Harness 读写 Outlook 邮件与日历。

做法：通过 Chrome DevTools Protocol 附着到你本机已登录的 Outlook Web（OWA）标签页，在页面上下文里复用它的会话与访问令牌，调用 `/owa/service.svc` 的 EWS 动作。**不需要 Azure 应用注册、不需要管理员授权、不需要 Graph API。**

## 为什么是这个方案

- 条件访问把第三方客户端应用拦在门外时，网页端通常仍可用；
- 令牌只存在当前标签页的 `sessionStorage`，不写磁盘、不经过第三方服务器；
- 每台机器、每个账号各自登录，没有共享凭据。

## 前置条件

- Windows
- 任意一个 Chromium 内核浏览器：Chrome / Edge / Brave / Vivaldi / Opera / Chromium。
  插件**自动跟随你的默认浏览器**，不用配置；默认浏览器若是 Firefox 这类非 Chromium 内核，
  会自动改用已装的 Chrome/Edge（Firefox 本身的远程调试协议不同，无法驱动）。
- 首次使用手工登录一次 OWA，并在登录页勾选“保持登录状态”

## 安装（每台机器一次）

**双击 `install.cmd` 即可。** 它会：

1. 探测可用浏览器（默认浏览器优先），打印最终会拉起哪个窗口；
2. 把本目录装进 DSH 的 `web` profile；
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 里补上 `outlook-owa` 条目（已有则跳过，改动前备份为 `.bak`）——
   **不需要手工编辑 YAML**；
4. 如果登录窗口还没开，顺手打开一个，当场登录。

装完重启 DSH，会话里就会出现 `outlook_*` 系列工具。重复双击是安全的（装包幂等、条目已存在就跳过、浏览器在跑就不重开）。

<details>
<summary>等价的手工命令（排障用）</summary>

```powershell
dsh plugin --profile web add file:C:\path\to\dsh-plugin-outlook-owa
# 然后在 ~/.dsh/profiles/web/cordis.patch.yml 末尾追加：
# - insert:
#     - id: outlook-owa
#       name: dsh-plugin-outlook-owa
```

</details>

## 以官方 bundle 方式安装（发布后）

本包遵循 DSH 官方 bundle 规范（`package.json` 里的 `dsh.bundle` 清单 +
`cordis.patch.yml`），装进 profile 即自动激活，不需要再手工补 YAML：

```powershell
# 发布到 npm 后
dsh plugin --profile web add dsh-plugin-outlook-owa

# 或不走 npm，直接打 tarball 分发
pnpm pack                      # 生成 dsh-plugin-outlook-owa-0.5.2.tgz
dsh plugin --profile web add ./dsh-plugin-outlook-owa-0.5.2.tgz
```

装完重启 DSH 即可。要在 profile 层覆盖配置的话，在本机
`~/.dsh/profiles/web/cordis.patch.yml` 里按相同 `id: outlook-owa` 写一行
（profile 层在 bundle 层之后应用、按 id 整行替换，见「配置」一节）。

## 首次使用

1. 随便说一句“看看今天的邮件”，插件会自动启动一个专用浏览器窗口
   （用你的默认浏览器内核，配置目录 `%LOCALAPPDATA%\dsh-outlook-owa\profile`）；
2. 在打开的窗口里用公司账号登录，勾选“保持登录状态”；
3. 回到 DSH 再说一次即可。

登录状态会长期保留；只有换机器、清缓存或租户强制重新认证时才需要再登一次。

## 工具一览

| 工具 | 作用 | 注意事项 |
|---|---|---|
| `outlook_owa_now` | 本机时间、时区、常用区间的绝对起止 | 处理“昨天/本周/今年”前先调用它 |
| `outlook_owa_list_mail` | 按时间范围列邮件 | 支持 `今天/昨天/本周/上月/今年/last_7d`，可加 `上午/下午/晚上` |
| `outlook_owa_search_mail` | 关键词搜索，可叠加时间范围 | 见下文“已知限制” |
| `outlook_owa_read_mail` | 读单封邮件全文 | id 来自列表结果 |
| `outlook_owa_draft_mail` | 存草稿 | 不会发送 |
| `outlook_owa_send_mail` | 真正发送 | 必须显式 `confirm: true` |
| `outlook_owa_delete` | 删除邮件/日程 | 必须显式 `confirm: true` |
| `outlook_owa_list_events` | 按时间范围列日程 | 含地点、组织者、暂定/取消标记 |
| `outlook_owa_create_event` | 创建日程 | `invite: true` 且给了参会人才发邀请 |

## 技能（SKILL.md）

0.5.2 起包内自带 `SKILL.md`（SUEZ 邮箱硬规则、工具速查、已知坑），插件安装后自动双通道注册，agent 开箱即用——无需再手动复制 `~/.dsh/skills/outlook-owa` 独立副本（旧副本可删，包注册优先）。

## 时间语义：两条路径

**路径 1（便捷词表）** `range: "昨天下午"` / `"本周"` / `"本季度"` / `"last_7d"`。
只覆盖常见说法：今天/昨天/明天/本周/上周/本月/上月/本季度/上季度/今年/去年/last_7d/last_30d/last_24h，
可加 上午/下午/晚上 后缀。插件用本机时钟解析，零歧义。

**路径 2（通用，任意说法都用它）** `since` / `until` 传绝对时间：

```
用户: "上季度收到的关于预算的邮件"
模型: 调 outlook_owa_now → 今天 2026-10-25，上季度 = 2026-07-01 ~ 2026-10-01
      调 outlook_owa_search_mail(query="预算", since="2026-07-01T00:00:00", until="2026-10-01T00:00:00")
```

词表之外的说法——法语 “le mois dernier”、越南语 “tuần trước”、“上个财年”、“国庆前那周”、
“最近三个工作日”——**都由模型换算成绝对区间**再传入。插件不猜语义。

分工：**模型负责“听懂”，插件负责“给基准 + 校验 + 回显”**。插件会拒绝非法区间
（`until <= since` 报错），并把最终区间回显在输出第一行：

```
时间范围（本机时区）：2026-10-24 12:00 ~ 2026-10-24 18:00（由「昨天下午」解析）
```

区间一律左闭右开。

## 已知限制

- **服务端日期过滤不可靠**：该租户的 OWA 端点对 `item:DateTimeReceived` 的 Restriction 时好时坏，所以时间过滤是“按页拉取 + 本地筛选”，扫描上限 6 页（每页 250 封）；跨度很大（如“今年”）时可能不完整，输出里会标注 `已到扫描上限`。
- **EWS 搜索文件夹异常**：若租户里残留 `EWS Search` 文件夹，服务端全文搜索会报错，插件会自动退化为本地子串匹配（只扫最近若干页），并在输出里标注。
- **只支持 Chromium 内核浏览器**：Firefox 的远程调试是 WebDriver BiDi / Marionette，协议不同，会话层无法复用。
- **非官方接口**：微软不承诺 `service.svc` 的兼容性，OWA 改版可能需要更新插件。
- **需要浏览器在线**：浏览器关闭或登出后，调用会失败并提示重新登录。
- **零框架依赖，故意为之**：插件不 `import @deepseek-ai/dsh-tools` 等任何 dsh-* 框架包，工具定义由自带的 `src/dsh.js` 生成。把框架包声明成依赖会被 pnpm 装进 profile，与宿主自带的一份形成双实例，运行期报 `Cannot read properties of undefined (reading 'prepare')`。唯一运行时依赖是 `@deepseek-ai/schemastery`（纯 schema 库、无宿主注册表共享，用于官方 `Config` 声明，与 dsh-kb-query 同款）。安装后 `profile/node_modules` 里只应有 `dsh-plugin-outlook-owa` 及其 schema 依赖。
- **装进 profile 的是副本，不是链接**：改完源码必须重新 `dsh plugin add` 才生效。这是刻意的——链接会让运行中的实例在编辑时被热重载，可能把注册表带崩。

## 配置

**一般不需要配置。** 默认值已经是“跟随默认浏览器 + 专用 profile + 端口 9333”。插件声明了官方 `Config` schema（schemastery/zod），profile 层的 `config` 在插件激活时按 schema 校验；下面列出的键即全部可配置项。

在 profile 里给这个 entry 加 `config` 可覆盖：

```yaml
- id: outlook-owa
  name: dsh-plugin-outlook-owa
  config:
    port: 9333
    profileDir: '%LOCALAPPDATA%\\dsh-outlook-owa\\profile'   # 留空用默认
    edgePath: auto                                           # auto = 跟随默认浏览器；也可写死 exe 路径
    timeZone: 'China Standard Time'
    requestTimeoutMs: 30000
```

`edgePath: auto` 的决策顺序：

1. 读 `HKCU\...\UrlAssociations\https\UserChoice` 拿到默认浏览器的 ProgId；
2. ProgId 是 Chromium 系（`ChromeHTML` / `MSEdgeHTM` / `BraveHTML` / `VivaldiHTM` / `Opera*` / `Chromium*`）
   → 用该浏览器的 exe；
3. 不是（如 `FirefoxURL`）或读不到 → 按 Chrome → Edge → Brave → Vivaldi → Opera → Chromium 找第一个装了的；
4. 都没有 → 报错并提示装 Chrome 或 Edge。

注意两点：

- **不会复用他平时那个浏览器窗口。** 一律另开一个带独立 `--user-data-dir` 的实例：Chrome 136 起禁止在默认
  profile 上开调试端口，而且在默认 profile 上带调试端口启动时，已运行的实例会把命令行转交出去后退出，端口不生效。
  首次要在这个窗口登录一次，之后 cookie 长期保留。
- 想让某台机器固定用某个浏览器，就把 `edgePath` 写成该 exe 的绝对路径；写错了也不致命——会自动回退到探测结果，
  并在错误信息/自测输出里说明。

`node test-browser.mjs` 会打印这台机器上最终选中的浏览器和决策依据。

## 开发与自测

```powershell
npm install                        # 首次运行自测前装依赖（schemastery）
node test-browser.mjs                     # 浏览器探测：默认浏览器 ProgId、选中的 exe、各配置下的解析结果
node test-smoke.mjs                       # 列出工具 + 时间解析
node test-smoke.mjs outlook_owa_list_events   # 单跑某个工具（参数放 $env:ARGS）
$env:ARGS='{"range":"this_week"}'; node test-smoke.mjs outlook_owa_list_events
node install.mjs                          # 跑一遍安装流程（等价于双击 install.cmd）
```
