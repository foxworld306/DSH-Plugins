/**
 * 本机时间上下文与自然语言时间范围的解析。
 *
 * 设计前提：模型不知道“昨天下午”“今年”具体指哪一段绝对时间，所以
 * 每个涉及时段的工具都先把相对说法解析成本机时区的绝对区间，并把
 * 解析结果回显到输出里，让模型和用户都能核对。
 */

const pad = (n) => String(n).padStart(2, '0');

/** 本地时间 → `YYYY-MM-DDTHH:mm:ss`（不带时区后缀，供 EWS 使用）。 */
export function fmtLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 本地时间 → 给人看的 `YYYY-MM-DD HH:mm`。 */
export function fmtHuman(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** 周一为一周起点。 */
function startOfWeek(d) {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7;
  return addDays(x, -dow);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfYear(d) {
  return new Date(d.getFullYear(), 0, 1);
}

function startOfQuarter(d) {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

const PARTS = {
  am: ['上午/早上', 6, 12],
  pm: ['下午', 12, 18],
  eve: ['晚上', 18, 24],
};

function withPart(base, part) {
  if (!part) return base;
  const [, from, to] = PARTS[part];
  const start = new Date(base.start);
  start.setHours(from, 0, 0, 0);
  const end = new Date(base.start);
  if (to === 24) {
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);
  } else {
    end.setHours(to, 0, 0, 0);
  }
  return { start, end, label: `${base.label}${PARTS[part][0]}` };
}

const DAY_ALIASES = new Map([
  ['today', 'today'], ['今天', 'today'],
  ['yesterday', 'yesterday'], ['昨天', 'yesterday'],
  ['tomorrow', 'tomorrow'], ['明天', 'tomorrow'],
  ['this_week', 'this_week'], ['thisweek', 'this_week'], ['本周', 'this_week'], ['这周', 'this_week'], ['这个星期', 'this_week'],
  ['last_week', 'last_week'], ['lastweek', 'last_week'], ['上周', 'last_week'], ['上星期', 'last_week'],
  ['this_month', 'this_month'], ['thismonth', 'this_month'], ['本月', 'this_month'], ['这个月', 'this_month'],
  ['last_month', 'last_month'], ['lastmonth', 'last_month'], ['上月', 'last_month'], ['上个月', 'last_month'],
  ['this_quarter', 'this_quarter'], ['quarter', 'this_quarter'], ['本季度', 'this_quarter'], ['这个季度', 'this_quarter'], ['本季', 'this_quarter'],
  ['last_quarter', 'last_quarter'], ['上季度', 'last_quarter'], ['上个季度', 'last_quarter'], ['上季', 'last_quarter'],
  ['this_year', 'this_year'], ['thisyear', 'this_year'], ['今年', 'this_year'],
  ['last_year', 'last_year'], ['lastyear', 'last_year'], ['去年', 'last_year'],
  ['last_7d', 'last_7d'], ['last7d', 'last_7d'], ['最近7天', 'last_7d'], ['近7天', 'last_7d'],
  ['last_30d', 'last_30d'], ['last30d', 'last_30d'], ['最近30天', 'last_30d'], ['近30天', 'last_30d'],
  ['last_24h', 'last_24h'], ['最近24小时', 'last_24h'],
]);

const PART_ALIASES = new Map([
  ['am', 'am'], ['morning', 'am'], ['上午', 'am'], ['早上', 'am'],
  ['pm', 'pm'], ['afternoon', 'pm'], ['下午', 'pm'],
  ['eve', 'eve'], ['evening', 'eve'], ['晚上', 'eve'],
]);

/** 某个基准日的区间表（供 outlook_owa_now 展示与 resolveRange 复用）。 */
export function presets(now = new Date()) {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const yesterday = addDays(today, -1);
  const week = startOfWeek(now);
  const month = startOfMonth(now);
  const quarter = startOfQuarter(now);
  const year = startOfYear(now);
  return {
    today: { start: today, end: tomorrow, label: '今天' },
    yesterday: { start: yesterday, end: today, label: '昨天' },
    tomorrow: { start: tomorrow, end: addDays(tomorrow, 1), label: '明天' },
    this_week: { start: week, end: addDays(week, 7), label: '本周' },
    last_week: { start: addDays(week, -7), end: week, label: '上周' },
    this_month: { start: month, end: addMonths(month, 1), label: '本月' },
    last_month: { start: addMonths(month, -1), end: month, label: '上月' },
    this_quarter: { start: quarter, end: addMonths(quarter, 3), label: '本季度' },
    last_quarter: { start: addMonths(quarter, -3), end: quarter, label: '上季度' },
    this_year: { start: year, end: new Date(now.getFullYear() + 1, 0, 1), label: '今年' },
    last_year: { start: new Date(now.getFullYear() - 1, 0, 1), end: year, label: '去年' },
    last_7d: { start: addDays(today, -7), end: tomorrow, label: '最近 7 天' },
    last_30d: { start: addDays(today, -30), end: tomorrow, label: '最近 30 天' },
    last_24h: { start: new Date(now.getTime() - 86400000), end: now, label: '最近 24 小时' },
  };
}

/**
 * 把外部时间字符串按“本机时区”解析。
 * 纯日期（YYYY-MM-DD）必须落在本地零点——不能用 new Date('2026-10-01')，
 * 那会被当作 UTC 零点，在东八区变成 08:00。
 */
export function parseLocal(value) {
  const s = String(value).trim();
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 0, 0, 0, 0);
  }
  const noZone = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (noZone) {
    return new Date(
      Number(noZone[1]), Number(noZone[2]) - 1, Number(noZone[3]),
      Number(noZone[4]), Number(noZone[5]), Number(noZone[6] || 0), 0
    );
  }
  return new Date(s); // 带 Z 或偏移量的写法交给标准解析
}

/**
 * 解析时间范围。
 * 支持：token（今天/昨天/本周/今年…，可加 上午/下午/晚上 后缀）、
 * 显式 `{since, until}` ISO 字符串。
 * @returns {{start: Date, end: Date, label: string, source: string}}
 */
export function resolveRange(spec, now = new Date()) {
  if (!spec) {
    const p = presets(now).today;
    return { ...p, source: 'today(默认)' };
  }
  if (typeof spec === 'object' && (spec.since || spec.until)) {
    const start = spec.since ? parseLocal(spec.since) : startOfDay(now);
    const end = spec.until ? parseLocal(spec.until) : new Date(now.getTime() + 86400000);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error(
        `无法解析时间范围：${JSON.stringify(spec)}。请用 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm:ss（本机时区，左闭右开）。`
      );
    }
    if (end.getTime() <= start.getTime()) {
      throw new Error(`时间范围不合法：until(${fmtHuman(end)}) 必须晚于 since(${fmtHuman(start)})。`);
    }
    return { start, end, label: `${fmtHuman(start)} ~ ${fmtHuman(end)}`, source: 'explicit' };
  }
  const raw = String(spec).trim().toLowerCase();
  if (!raw) {
    const p = presets(now).today;
    return { ...p, source: 'today(默认)' };
  }
  // 也接受 “2026-10-01 ~ 2026-10-15” / “2026-10-01..2026-10-15” 这种紧凑写法
  const compact = raw.match(/^(\d{4}-\d{2}-\d{2}(?:t[\d:]{5,8})?)\s*(?:\.\.|~|至|到)\s*(\d{4}-\d{2}-\d{2}(?:t[\d:]{5,8})?)$/);
  if (compact) {
    return resolveRange({ since: compact[1], until: compact[2] }, now);
  }
  // 拆出“时段”后缀：昨天下午 / yesterday pm / yesterday_afternoon
  let part = null;
  let base = raw;
  for (const [alias, key] of PART_ALIASES) {
    if (raw.endsWith(alias)) {
      part = key;
      base = raw.slice(0, raw.length - alias.length).replace(/[_\s-]+$/, '');
      break;
    }
  }
  const key = DAY_ALIASES.get(base);
  if (!key) {
    throw new Error(
      `「${spec}」不在内置词表里（内置：今天/昨天/明天/本周/上周/本月/上月/本季度/上季度/今年/去年/last_7d/last_30d/last_24h，` +
      `可加 上午/下午/晚上 后缀）。\n` +
      `任意语言或自定义说法请这样处理：先调 outlook_owa_now 拿到今天的日期，自己算出绝对区间，再用 since/until 传入，` +
      `例如 since="2026-10-01T00:00:00" until="2026-11-01T00:00:00"。`
    );
  }
  const p = presets(now)[key];
  return { ...withPart(p, part), source: String(spec) };
}

/** 给模型的“现在”快照。 */
export function nowContext(now = new Date()) {
  const day = startOfDay(now);
  const p = presets(now);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  return {
    now,
    local: fmtLocal(now),
    human: fmtHuman(now),
    weekday,
    timeZone: tz,
    utcOffset: `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
    startOfToday: day,
    presets: p,
  };
}
