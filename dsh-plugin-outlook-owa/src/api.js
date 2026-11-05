/**
 * OWA 业务动作：邮件与日历。
 * 全部走 /owa/service.svc 的 EWS 动作（FindItem / GetItem / CreateItem / DeleteItem）。
 */

import { OwaSession } from './session.js';
import { fmtLocal } from './time.js';

const DISTINGUISHED = { inbox: 'inbox', drafts: 'drafts', sent: 'sentitems', sentitems: 'sentitems', deleted: 'deleteditems', deleteditems: 'deleteditems', junk: 'junkemail', archive: 'archive', calendar: 'calendar' };

function folderId(name = 'inbox') {
  return { __type: 'DistinguishedFolderId:#Exchange', Id: DISTINGUISHED[String(name).toLowerCase()] || 'inbox' };
}

/**
 * 列出/搜索邮件。
 *
 * 注意：本租户的 OWA 端点对 `item:DateTimeReceived` 的两操作数 Restriction 支持不稳定
 * （时而 500、时而 "The property can not be used with this type of restriction"），
 * QueryString 的 AQS 日期操作符又因残留的 "EWS Search" 文件夹失败。
 * 因此时间过滤改为「服务端按页拉取 + 客户端按范围筛选」，并在遇到早于起点的邮件时提前停止。
 */
export async function findMail(session, { folder = 'inbox', query, range, limit = 20 }) {
  const pageSize = 250;
  const maxPages = query ? 4 : range ? 6 : 1;
  const want = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const base = {
    __type: 'FindItemRequest:#Exchange',
    Traversal: 'Shallow',
    ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'Default' },
    ParentFolderIds: [folderId(folder)],
  };
  if (query) base.QueryString = { __type: 'QueryStringType:#Exchange', Value: query, ResetCache: true };

  const startStr = range ? fmtLocal(range.start) : null;
  const endStr = range ? fmtLocal(range.end) : null;
  const picked = [];
  let scanned = 0;
  let offset = 0;
  let truncated = false;
  let clientQuery = null;

  for (let page = 0; page < maxPages; page++) {
    const req = {
      ...base,
      ...(clientQuery ? {} : query ? { QueryString: base.QueryString } : {}),
      Paging: { __type: 'IndexedPageView:#Exchange', BasePoint: 'Beginning', Offset: offset, MaxEntriesReturned: pageSize },
    };
    if (clientQuery) delete req.QueryString;
    let r;
    try {
      r = await session.call('FindItem', req);
    } catch (e) {
      // 服务端检索文件夹（EWS Search）异常时，退化为本地子串匹配
      if (query && !clientQuery) { clientQuery = query; offset = 0; page--; continue; }
      throw e;
    }
    const msg = OwaSession.message(r);
    if (query && !clientQuery && (!msg || msg.ResponseClass === 'Error')) {
      clientQuery = query;
      offset = 0;
      page--;
      continue;
    }
    OwaSession.ensureOk(r, msg);
    const items = (msg.RootFolder && msg.RootFolder.Items) || [];
    if (items.length === 0) break;
    scanned += items.length;

    const needle = (clientQuery || '').toLowerCase();
    let reachedOlderThanStart = false;
    for (const it of items) {
      if (needle) {
        const hay = `${it.Subject || ''} ${it.BodyPreview || ''} ${(it.From && it.From.Mailbox && it.From.Mailbox.EmailAddress) || ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const t = it.DateTimeReceived || it.DateTimeSent || '';
      if (!range) { picked.push(it); continue; }
      if (t && t >= startStr && t < endStr) picked.push(it);
      if (t && t < startStr) reachedOlderThanStart = true;
    }
    if (!range) break;
    if (reachedOlderThanStart || picked.length >= want) break;
    offset += items.length;
    if (page === maxPages - 1) truncated = true;
  }

  return { items: picked.slice(0, want), scanned, clientFiltered: !!range || !!clientQuery, truncated, clientQuery: !!clientQuery };
}

export async function readMail(session, id) {
  const r = await session.call('GetItem', {
    __type: 'GetItemRequest:#Exchange',
    ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'AllProperties' },
    ItemIds: [{ __type: 'ItemId:#Exchange', Id: id }],
  });
  const msg = OwaSession.message(r);
  OwaSession.ensureOk(r, msg);
  const it = (msg.Items && msg.Items[0]) || null;
  if (!it) throw new Error('找不到这封邮件（可能已被移动或删除）');
  return it;
}

function recipients(value) {
  return String(value || '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((e) => ({ __type: 'EmailAddressType:#Exchange', EmailAddress: e, Name: e }));
}

export async function createMessage(session, { to, cc, bcc, subject, body, send }) {
  if (!to || !recipients(to).length) throw new Error('缺少收件人 to');
  const item = {
    __type: 'Message:#Exchange',
    Subject: subject || '(无主题)',
    Body: { __type: 'BodyContentType:#Exchange', BodyType: 'Text', Value: body || '' },
    ToRecipients: recipients(to),
  };
  const ccList = recipients(cc);
  if (ccList.length) item.CcRecipients = ccList;
  const bccList = recipients(bcc);
  if (bccList.length) item.BccRecipients = bccList;

  const req = {
    __type: 'CreateItemRequest:#Exchange',
    Items: [item],
    MessageDisposition: send ? 'SendAndSaveCopy' : 'SaveOnly',
  };
  if (!send) {
    req.SavedItemFolderId = {
      __type: 'TargetFolderId:#Exchange',
      BaseFolderId: { __type: 'DistinguishedFolderId:#Exchange', Id: 'drafts' },
    };
  }
  const r = await session.call('CreateItem', req);
  const msg = OwaSession.message(r);
  OwaSession.ensureOk(r, msg);
  const created = (msg.Items && msg.Items[0]) || {};
  return { id: created.ItemId && created.ItemId.Id, send };
}

export async function deleteItem(session, { id, kind = 'mail', hard = false, notify = 'none' }) {
  if (!id) throw new Error('缺少要删除的对象 id');
  const isCalendar = kind === 'event' || kind === 'calendar';
  const req = {
    __type: 'DeleteItemRequest:#Exchange',
    DeleteType: hard ? 'HardDelete' : 'MoveToDeletedItems',
    ItemIds: [{ __type: 'ItemId:#Exchange', Id: id }],
  };
  if (isCalendar) req.SendMeetingCancellations = notify === 'all' ? 'SendToAllAndSaveCopy' : 'SendToNone';
  const r = await session.call('DeleteItem', req, isCalendar ? 'Calendar' : 'Mail');
  OwaSession.ensureOk(r, OwaSession.message(r));
  return { id, deleted: true };
}

export async function listEvents(session, { range, limit = 200 }) {
  const r = await session.call('FindItem', {
    __type: 'FindItemRequest:#Exchange',
    Traversal: 'Shallow',
    ItemShape: { __type: 'ItemResponseShape:#Exchange', BaseShape: 'Default' },
    ParentFolderIds: [folderId('calendar')],
    Paging: { __type: 'IndexedPageView:#Exchange', BasePoint: 'Beginning', Offset: 0, MaxEntriesReturned: 500 },
  }, 'Calendar');
  const msg = OwaSession.message(r);
  OwaSession.ensureOk(r, msg);
  const items = ((msg.RootFolder && msg.RootFolder.Items) || [])
    .filter((it) => {
      const s = pickDate(it.Start);
      return s && s >= fmtLocal(range.start) && s < fmtLocal(range.end);
    })
    .sort((a, b) => pickDate(a.Start).localeCompare(pickDate(b.Start)))
    .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 500));
  return items;
}

export async function createEvent(session, { subject, start, end, location, attendees, invite = false, body }) {
  if (!subject) throw new Error('缺少日程主题 subject');
  if (!start || !end) throw new Error('缺少 start / end（格式 YYYY-MM-DDTHH:mm:ss）');
  const item = { __type: 'CalendarItem:#Exchange', Subject: subject, Start: start, End: end };
  if (location) item.Location = { __type: 'Location:#Exchange', DisplayName: location };
  if (body) item.Body = { __type: 'BodyContentType:#Exchange', BodyType: 'Text', Value: body };
  const list = recipients(attendees);
  if (list.length) {
    item.Attendees = list.map((a) => ({
      __type: 'Attendee:#Exchange',
      Mailbox: { __type: 'EmailAddress:#Exchange', EmailAddress: a.EmailAddress, Name: a.Name },
      AttendeeType: 'Required',
    }));
  }
  const r = await session.call('CreateItem', {
    __type: 'CreateItemRequest:#Exchange',
    Items: [item],
    SendMeetingInvitations: invite && list.length ? 'SendToAllAndSaveCopy' : 'SendToNone',
  }, 'Calendar');
  const msg = OwaSession.message(r);
  OwaSession.ensureOk(r, msg);
  const created = (msg.Items && msg.Items[0]) || {};
  return { id: created.ItemId && created.ItemId.Id, invited: invite && list.length > 0 };
}

export function pickDate(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 19);
  return (v.DateTime || '').slice(0, 19);
}
