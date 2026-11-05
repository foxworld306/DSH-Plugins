/**
 * dsh-plugin-outlook-owa
 *
 * 通过 CDP 驱动本机 Edge 操作 Outlook Web（OWA），在禁止 Microsoft Graph 的
 * 租户里读写邮件与日历。涉及相对时间的工具会先解析本机时间，并把绝对区间
 * 回显给模型，避免「昨天下午」「今年」这类说法被猜错。
 *
 * 注意：本插件不 import 任何 @deepseek-ai/dsh-* 框架包（工具定义由 ./dsh.js
 * 生成，避免双实例注册表问题），仅依赖 @deepseek-ai/schemastery（纯 schema
 * 库，无宿主注册表共享）用于官方 Config 声明。
 * 工具 execute 遵循官方 (args, exec) 签名：exec.signal 经 session.beginSignal
 * 透传到 CDP 层实现宿主侧协作式取消。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

import { createEvent, createMessage, deleteItem, findMail, listEvents, readMail } from './api.js';
import { defineTool } from './dsh.js';
import { formatEvents, formatMailList, formatMessage } from './format.js';
import { OwaSession } from './session.js';
import { fmtHuman, nowContext, resolveRange } from './time.js';

export const name = 'outlook-owa';
export const inject = ['tools', 'skills'];

/**
 * 官方 Config 声明：profile 层 config 在插件激活时按此 schema 校验。
 * 键与 OwaSession 实际读取的键一一对应（README「配置」一节为完整说明）。
 * port/profileDir/edgePath 的默认值在 session.js 保留（支持环境变量
 * OWA_CDP_PORT / OWA_PROFILE_DIR / OWA_EDGE 的兜底）。
 */
/* ---- Bundled skill (SKILL.md at the package root) ---- */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_MD = path.join(PKG_ROOT, 'SKILL.md');
const BUNDLED_RANK = 600; // same rank the official bundled skill packages use

function skillCandidate() {
  const raw = fs.readFileSync(SKILL_MD, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
  const d = m && /(^|\n)description:\s*["']?([^\n"']+)/.exec(m[1]);
  if (!d) throw new Error('outlook-owa: SKILL.md has no description frontmatter');
  return {
    name: 'outlook-owa',
    description: d[2].trim(),
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'dsh-plugin-outlook-owa',
    source: 'bundled',
    rank: BUNDLED_RANK,
    resourceBase: { kind: 'directory', path: PKG_ROOT.split(path.sep).join('/') },
    locator: SKILL_MD,
  };
}

export const Config = z.object({
  /** CDP 调试端口（专用浏览器实例，非默认 profile）。 */
  port: z.number().step(1).min(1).max(65535).default(9333),
  /** 专用浏览器 profile 目录；"" = %LOCALAPPDATA%\dsh-outlook-owa\profile。 */
  profileDir: z.string().default(''),
  /** 浏览器 exe 绝对路径，或 'auto'（跟随 Windows 默认浏览器，限 Chromium 系）。 */
  edgePath: z.string().default(''),
  /** 邮件入口页（首次导航与令牌刷新用）。 */
  mailUrl: z.string().default('https://outlook.office.com/mail/'),
  /** 日历入口页。 */
  calendarUrl: z.string().default('https://outlook.office.com/calendar/'),
  /** EWS TimeZoneContext 用的 Windows 时区 id（本机时区）。 */
  timeZone: z.string().default('China Standard Time'),
  /** 页面内 fetch 调 /owa/service.svc 的超时（毫秒）。 */
  requestTimeoutMs: z.number().step(1).min(1000).default(30000),
});

const RENDER = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
const OUTPUT = { schema: { type: 'string' }, render: RENDER };

const RANGE_PARAM = {
  type: 'string',
  description:
    '【便捷写法】只覆盖常见说法：今天/昨天/明天/本周/上周/本月/上月/本季度/上季度/今年/去年/last_7d/last_30d/last_24h，' +
    '可加时段后缀 上午/下午/晚上（如“昨天下午”）。' +
    '【通用写法】任何其他说法（其他语言、“上个财年”、“国庆前那周”、“最近三个工作日”等）都不要硬套，' +
    '先调用 outlook_owa_now 拿到今天的日期，自己算出绝对区间，改用 since/until 传入。',
};
const SINCE_PARAM = { type: 'string', description: '绝对起始时间，YYYY-MM-DD 或 YYYY-MM-DDTHH:mm:ss（本机时区），左闭。与 until 配合可表达任意区间。' };
const UNTIL_PARAM = { type: 'string', description: '绝对结束时间，同上，右开区间。' };

function rangeLine(range) {
  const src = range.source && range.source !== 'explicit' ? `（由「${range.source}」解析）` : '';
  return `时间范围（本机时区）：${fmtHuman(range.start)} ~ ${fmtHuman(range.end)}${src}`;
}

function resolveFromArgs(args) {
  if (args.since || args.until) return resolveRange({ since: args.since, until: args.until });
  return resolveRange(args.range);
}

export function apply(ctx, config = {}) {
  const settings = config || {};
  const session = new OwaSession(settings);
  let chain = Promise.resolve();
  const serial = (fn) => (...a) => {
    const run = chain.then(() => fn(...a), () => fn(...a));
    chain = run.catch(() => {});
    return run;
  };

  const register = (tool) =>
    ctx.tools.register({
      ...tool,
      // 官方 execute(args, exec)：把宿主协作式取消信号接进 CDP 会话层。
      execute: async (args, exec) => {
        session.beginSignal(exec && exec.signal);
        try {
          return await tool.execute(args, exec);
        } finally {
          session.beginSignal(null);
        }
      },
    });

  register(defineTool({
    name: 'outlook_owa_now',
    description:
      '读取本机当前时间与时区，并给出常用时间区间的绝对起止（今天/昨天/本周/上周/本月/上月/本季度/上季度/今年/去年等）。' +
      '凡用户用相对说法（含其他语言、财年、季度、节假日等）提要求，先调用本工具拿基准，再自行推算绝对区间传给邮件/日历工具的 since/until。',
    parameters: {},
    output: OUTPUT,
    execute: serial(async () => {
      const c = nowContext();
      const rows = Object.entries(c.presets)
        .map(([k, v]) => `  ${k.padEnd(13)} ${fmtHuman(v.start)} ~ ${fmtHuman(v.end)}  (${v.label})`)
        .join('\n');
      return [
        `本机时间：${c.human} ${c.weekday}`,
        `时区：${c.timeZone}（${c.utcOffset}）`,
        `ISO：${c.local}`,
        '',
        '可用区间：',
        rows,
        '',
        '说明：区间都是左闭右开；昨天下午 = yesterday + 下午(12:00-18:00)。',
        '上面只是常用区间。遇到本表没有的说法（其他语言、财年、季度、节假日、“最近三个工作日”等），',
        '不要猜词表：用这里的日期自己推算绝对区间，然后用 since/until 传入（例如 since="2026-10-01T00:00:00" until="2026-11-01T00:00:00"）。',
      ].join('\n');
    }),
  }));

  register(defineTool({
    name: 'outlook_owa_list_mail',
    description: '按时间范围列出邮件（默认收件箱，按收件时间过滤）。用于“看看昨天的邮件”“这周收到什么”。',
    parameters: {
      range: RANGE_PARAM,
      since: SINCE_PARAM,
      until: UNTIL_PARAM,
      folder: { type: 'string', description: 'inbox（默认）/ drafts / sentitems / deleteditems / junk / archive' },
      limit: { type: 'number', description: '最多返回多少封，默认 20，上限 200' },
    },
    output: OUTPUT,
    execute: serial(async (args) => {
      const range = resolveFromArgs(args);
      const { items, scanned, clientFiltered, truncated } = await findMail(session, {
        folder: args.folder || 'inbox',
        range,
        limit: Number(args.limit || 20),
      });
      return [
        rangeLine(range),
        `文件夹：${args.folder || 'inbox'}，命中 ${items.length} 封（扫描 ${scanned} 封${clientFiltered ? '，按本机时间筛选' : ''}${truncated ? '，已到扫描上限，可能不完整' : ''}）`,
        '',
        formatMailList(items),
      ].join('\n');
    }),
  }));

  register(defineTool({
    name: 'outlook_owa_search_mail',
    description: '在邮箱里搜索邮件，可叠加时间范围。用于“找一下采购相关的邮件”“上个月关于 X 的往来”。',
    parameters: {
      query: { type: 'string', required: true, description: '搜索关键词，支持多个词' },
      range: RANGE_PARAM,
      since: SINCE_PARAM,
      until: UNTIL_PARAM,
      folder: { type: 'string', description: '默认 inbox；填 all 表示不限文件夹（当前实现仍从 inbox 起扫）' },
      limit: { type: 'number', description: '最多返回多少封，默认 15' },
    },
    output: OUTPUT,
    execute: serial(async (args) => {
      const range = resolveFromArgs(args);
      const useRange = !!(args.range || args.since || args.until);
      const folder = String(args.folder || 'inbox').toLowerCase();
      const { items, scanned, clientFiltered, truncated, clientQuery } = await findMail(session, {
        folder: folder === 'all' ? 'inbox' : folder,
        query: args.query,
        range: useRange ? range : undefined,
        limit: Number(args.limit || 15),
      });
      return [
        useRange ? rangeLine(range) : '时间范围：不限（最近若干页）',
        `搜索「${args.query}」命中 ${items.length} 封（扫描 ${scanned} 封${clientQuery ? '，服务端检索不可用已退化为本地匹配' : ''}${clientFiltered ? '，按本机时间筛选' : ''}${truncated ? '，已到扫描上限，可能不完整' : ''}）`,
        '',
        formatMailList(items),
      ].join('\n');
    }),
  }));

  register(defineTool({
    name: 'outlook_owa_read_mail',
    description: '读取单封邮件的完整内容（主题、发件人、收件人、时间、附件名、正文纯文本）。id 来自列表或搜索结果。',
    parameters: {
      id: { type: 'string', required: true, description: 'ItemId，从 outlook_owa_list_mail / outlook_owa_search_mail 结果里获取' },
    },
    output: OUTPUT,
    execute: serial(async (args) => formatMessage(await readMail(session, args.id))),
  }));

  register(defineTool({
    name: 'outlook_owa_draft_mail',
    description: '把一封邮件存为草稿（不会发送），放进“草稿”文件夹。需要用户确认内容后用。',
    parameters: {
      to: { type: 'string', required: true, description: '收件人，多个用分号或逗号分隔' },
      subject: { type: 'string', required: true, description: '主题' },
      body: { type: 'string', description: '正文纯文本' },
      cc: { type: 'string', description: '抄送，多个用分号分隔' },
      bcc: { type: 'string', description: '密送，多个用分号分隔' },
    },
    output: OUTPUT,
    execute: serial(async (args) => {
      const r = await createMessage(session, { ...args, send: false });
      return `已存为草稿：${args.subject}\n收件人：${args.to}\nid=${r.id || '(未返回)'}\n\n提示：草稿不会自动发送，需要发送请调用 outlook_owa_send_mail 或在 Outlook 里手动发。`;
    }),
  }));

  register(defineTool({
    name: 'outlook_owa_send_mail',
    description: '真正发送一封邮件。属于不可撤销操作：必须在用户明确要求“发出去”并确认收件人与内容后才能调用，且 confirm 必须为 true。',
    parameters: {
      to: { type: 'string', required: true, description: '收件人，多个用分号分隔' },
      subject: { type: 'string', required: true, description: '主题' },
      body: { type: 'string', description: '正文纯文本' },
      cc: { type: 'string', description: '抄送' },
      bcc: { type: 'string', description: '密送' },
      confirm: { type: 'boolean', required: true, description: '必须显式为 true；否则拒绝发送' },
    },
    output: OUTPUT,
    execute: serial(async (args) => {
      if (args.confirm !== true) throw new Error('拒绝发送：confirm 必须为 true，且需用户明确同意。可先用 outlook_owa_draft_mail 存草稿。');
      const r = await createMessage(session, { ...args, send: true });
      return `已发送给 ${args.to}：${args.subject}\nid=${r.id || '(已发出，无返回 id)'}`;
    }),
  }));

  register(defineTool({
    name: 'outlook_owa_delete',
    description: '删除邮件或日程。不可撤销（hard=true 直接永久删除）。需要用户确认后调用，confirm 必须为 true。',
    parameters: {
      id: { type: 'string', required: true, description: '要删除的对象 ItemId' },
      kind: { type: 'string', description: 'mail（默认）或 event/calendar' },
      hard: { type: 'boolean', description: 'true = 永久删除；默认移动到“已删除邮件”' },
      notify: { type: 'string', description: '删除日程时是否通知参会人：none（默认）或 all' },
      confirm: { type: 'boolean', required: true, description: '必须显式为 true' },
    },
    output: OUTPUT,
    execute: serial(async (args) => {
      if (args.confirm !== true) throw new Error('拒绝删除：confirm 必须为 true，且需用户明确同意。');
      await deleteItem(session, args);
      return `已删除（${args.kind || 'mail'}${args.hard ? '，永久' : '，移到已删除'}）：${args.id}`;
    }),
  }));

  register(defineTool({
    name: 'outlook_owa_list_events',
    description: '按时间范围列出日历日程（含起止时间、地点、组织者、暂定/取消标记）。用于“今天有什么会”“这周的安排”。',
    parameters: {
      range: RANGE_PARAM,
      since: SINCE_PARAM,
      until: UNTIL_PARAM,
      limit: { type: 'number', description: '最多返回多少条，默认 200' },
    },
    output: OUTPUT,
    execute: serial(async (args) => {
      const range = resolveFromArgs(args);
      const items = await listEvents(session, { range, limit: Number(args.limit || 200) });
      return [rangeLine(range), `共 ${items.length} 个日程`, '', formatEvents(items)].join('\n');
    }),
  }));

  register(defineTool({
    name: 'outlook_owa_create_event',
    description: '创建日历日程。默认只写进自己的日历；invite=true 且给了参会人时才会发出会议邀请（不可撤销）。',
    parameters: {
      subject: { type: 'string', required: true, description: '日程主题' },
      start: { type: 'string', required: true, description: '开始时间 YYYY-MM-DDTHH:mm:ss（本机时区）' },
      end: { type: 'string', required: true, description: '结束时间，格式同上' },
      location: { type: 'string', description: '地点' },
      attendees: { type: 'string', description: '参会人邮箱，多个用分号分隔' },
      invite: { type: 'boolean', description: '是否给参会人发邀请，默认 false' },
      body: { type: 'string', description: '日程说明' },
    },
    output: OUTPUT,
    execute: serial(async (args) => {
      const r = await createEvent(session, args);
      return `已创建日程：${args.subject}\n${args.start} ~ ${args.end}${args.location ? `\n地点：${args.location}` : ''}\n${r.invited ? '已向参会人发出邀请' : '未发送邀请'}\nid=${r.id || '(未返回)'}`;
    }),
  }));

  // Bundled skill, dual-channel (mirrors dsh-office-docs-win; measured 2026-11-05:
  // a provider alone never appeared in the host catalog, so a published plugin
  // must not rely on it; the inline register() is the documented runtime path).
  // Both registrations are owned by this plugin's fiber, so recomposing the
  // plugin replaces them instead of piling up.
  const installSkill = (scope) => {
    const skills = scope.skills;
    if (!skills) return;
    const effect = typeof scope.effect === 'function' ? (fn) => scope.effect(fn) : (fn) => fn();
    const candidate = skillCandidate();
    if (typeof skills.register === 'function') {
      effect(() =>
        skills.register({
          name: candidate.name,
          description: candidate.description,
          invocation: candidate.invocation,
          source: candidate.source,
          provider: candidate.provider,
          resourceBase: candidate.resourceBase,
          path: SKILL_MD,
          content: fs.readFileSync(SKILL_MD, 'utf8'),
        }));
    }
    if (typeof skills.registerProvider === 'function') {
      effect(() =>
        skills.registerProvider(() => ({
          name: 'dsh-plugin-outlook-owa',
          list: () => Promise.resolve([candidate]),
          get: async (chosen) => {
            const { rank: _rank, locator: _locator, ...summary } = chosen;
            return { ...summary, content: fs.readFileSync(SKILL_MD, 'utf8') };
          },
        })));
    }
  };
  if (ctx.skills) {
    installSkill(ctx);
  } else if (typeof ctx.inject === 'function') {
    // The skills service can come up after apply (the host does not necessarily
    // honour the module-level inject export).
    ctx.inject(['skills'], installSkill);
  }
}
