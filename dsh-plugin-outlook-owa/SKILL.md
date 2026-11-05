---
name: outlook-owa
description: "Use for ANY operation on the SUEZ mailbox (rio.zhao@suez.com) via dsh-plugin-outlook-owa: reading/searching/drafting/sending email, listing/creating/deleting calendar events. Tools are prefixed outlook_owa_ (e.g. outlook_owa_list_mail, outlook_owa_create_event). Hard rule: this mailbox must NOT be touched via Outlook COM (no pwsh New-Object -ComObject Outlook.Application, no COM bridge) — the COM plugin is retired."
---

# Outlook OWA（dsh-plugin-outlook-owa）

邮箱：rio.zhao@suez.com。所有操作只用 `outlook_owa_*` 工具（插件 `dsh-plugin-outlook-owa`，工具前缀 `outlook_owa_`）。

## 后端（理解排错用）
通过 CDP 附着本机默认 Chromium 浏览器（独立 profile，未运行时自动拉起），复用已登录 OWA 标签页的会话与 Bearer token，在页面上下文内调用 `/owa/service.svc`（EWS JSON：FindItem / GetItem / CreateItem / DeleteItem）。无 Microsoft Graph（租户禁用），无 COM。token 只存页面 sessionStorage（`dsh:tok`），不落盘。

## 硬规则（违反即事故）
1. **禁止用 Outlook COM 操作本邮箱**：不得写 pwsh `New-Object -ComObject Outlook.Application` 之类的脚本读写邮件/日历，不得用任何 COM 桥。COM 版插件 `@local/dsh-outlook`（24 个 `outlook_*` 工具）已下线；旧 COM 技能已移出技能目录（agent 不要加载或引用其工具名）。
2. `outlook_owa_*` 工具不可用或报错时：检查 OWA 浏览器窗口是否处于登录态，并把原始错误如实上报；**绝不**改走 COM、Graph 或 IMAP。
3. 本机可能开着经典/新版 Outlook 客户端——那是用户自己的客户端，插件不依赖它，也不要用它做旁路。

## 工具速查
| 工具 | 用途 |
|---|---|
| `outlook_owa_now` | 本机时间 + 常用区间绝对起止。用户说相对时间先调它 |
| `outlook_owa_list_mail` | 按时间范围列邮件（默认 inbox；folder：inbox/drafts/sentitems/deleteditems/junk/archive；时间过滤=分页拉取+本地筛选） |
| `outlook_owa_search_mail` | 关键词搜索（服务端检索在本租户不稳定，失败时自动退化为本地子串匹配，结果会注明） |
| `outlook_owa_read_mail` | 按 id 读单封全文（id 取自 list/search 结果） |
| `outlook_owa_draft_mail` | 存草稿（不发送） |
| `outlook_owa_send_mail` | 真正发送。仅当用户明确要求发出并确认收件人/内容后，且 `confirm=true` |
| `outlook_owa_delete` | 删邮件/日程。`confirm=true` 必须；`hard=true` 永久删除；日程 `notify` 控制是否发取消通知 |
| `outlook_owa_list_events` | 按时间范围列日程（EWS FindItem calendar + 本地时间过滤，左闭右开） |
| `outlook_owa_create_event` | 创建日程。默认个人日程（自己日历、不发邀请）；`invite=true` + attendees 才发邀请（不可撤销） |

## 时间
- 本机时区 Asia/Shanghai；格式 `YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm:ss`；区间左闭右开。
- 相对说法（今天/昨天/上周…含其他语言）：先 `outlook_owa_now` 拿基准，自己推算绝对区间传 `since/until`，不要猜。

## 安全
- 发送 / 删除（尤其 hard）/ 发会议邀请 = 不可撤销：先向用户展示完整预览（收件人、主题、正文摘要、时间/参会人），拿到当轮明确确认后才执行，`confirm` 必须为 true。
- 草稿、无邀请的日程创建/删除（个人日程）= 本地可逆：用户已明确指示即可直接做。

## 已知坑
- OWA 标签页必须登录且较活跃。报"拿不到 OWA 的访问令牌：页面可能已登出或处于空闲"时：请用户在浏览器窗口里打开一封邮件（或导航一下），然后重试；插件遇 401 会自动强刷 token 重试一次。
- 本租户 FindItem 的日期 Restriction 不稳定（500 / 限制类型报错），插件已用分页+客户端过滤绕过；扫描上限截断时结果会注明"可能不完整"。
- 插件改代码后必须重启 DSH 才生效。已安装副本：`<profile>/node_modules/dsh-plugin-outlook-owa/`；源码：仓库 dist 目录。改 bug 时源码与已安装副本要同步（`link:` 安装时只需源码）。
- OWA 与本机 Outlook 客户端指向同一邮箱，数据一致；但插件只认浏览器会话。
- **工具长时间无响应（分钟级）= 卡死**：多为 CDP 连接 / OWA 页面状态异常（如刚重启 DSH 后的浏览器状态）。插件已带超时（CDP 握手 10s、in-page fetch 30s、CDP 每请求 45s、死连接自动丢弃重连），最坏情况应在 1 分钟内报明确错误；若仍卡死（多为 DSH 未重启、旧代码在跑）：不要干等，请用户刷新/重新打开 OWA 标签页或重启 DSH 后重试。

## 历史
- 2026-11-05：agent 误载旧 COM 技能后自写 pwsh COM 脚本读日历，绕过 OWA 方案 → 旧技能移出于技能目录。
- 2026-11-05：修复 `api.js` `DISTINGUISHED` 缺 `calendar` 键导致 `outlook_owa_list_events` 一直查收件箱恒返回 0 日程的 bug（重启后已验证：当天 10 个日程全部正常列出）。
- 2026-11-05：`outlook_owa_list_events` 因临时 CDP/OWA 状态卡死约 6 分钟被回合超时强杀；根因是 `session.js` 缺请求超时。同日已修复：WebSocket 握手 10s 超时 + CDP 每请求 45s 超时 + in-page fetch AbortController（reqTimeoutMs=30s，超时报 status 0）+ evaluate 出错丢弃死连接自动重连。`node --check` 通过；需重启 DSH 生效。
- 2026-11-05：技能文档收编进插件包（0.5.2），随包分发并由插件自注册；`~/.dsh/skills/outlook-owa` 独立副本退役。
