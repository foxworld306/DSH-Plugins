/** 把 OWA 返回的结构转成模型好读的纯文本。 */

export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sender(it) {
  const mb = (it.From && it.From.Mailbox) || {};
  return mb.Name || mb.EmailAddress || '未知发件人';
}

function when(it) {
  const t = it.DateTimeReceived || it.DateTimeSent || '';
  return t ? t.slice(0, 16).replace('T', ' ') : '(无时间)';
}

function flags(it) {
  return [it.IsRead ? '已读' : '未读', it.HasAttachments ? '有附件' : null].filter(Boolean).join('/');
}

export function formatMailList(items) {
  if (!items.length) return '（该条件下没有邮件）';
  return items
    .map((it, i) => `${i + 1}. [${flags(it)}] ${when(it)} | ${sender(it)} | ${it.Subject || '(无主题)'}\n   id=${(it.ItemId && it.ItemId.Id) || ''}`)
    .join('\n');
}

export function formatMessage(it) {
  const to = (it.ToRecipients || []).map((r) => r.EmailAddress).filter(Boolean).join('; ');
  const cc = (it.CcRecipients || []).map((r) => r.EmailAddress).filter(Boolean).join('; ');
  const attachments = (it.Attachments || []).map((a) => a.Name).filter(Boolean);
  const body = htmlToText((it.Body && it.Body.Value) || '');
  const lines = [
    `主题: ${it.Subject || '(无主题)'}`,
    `发件人: ${sender(it)}`,
    `收件人: ${to || '-'}`,
  ];
  if (cc) lines.push(`抄送: ${cc}`);
  lines.push(`时间: ${when(it)}`);
  if (attachments.length) lines.push(`附件: ${attachments.join(', ')}`);
  lines.push('', body.slice(0, 12000));
  return lines.join('\n');
}

export function formatEvents(items) {
  if (!items.length) return '（该时段没有日程）';
  return items
    .map((it, i) => {
      const s = pick(it.Start);
      const e = pick(it.End);
      const loc = (it.Location && it.Location.DisplayName) || '';
      const org = (it.Organizer && it.Organizer.Mailbox && it.Organizer.Mailbox.Name) || '';
      const free = it.FreeBusyType === 'Free' ? '空闲' : it.FreeBusyType === 'Tentative' ? '暂定' : '';
      const cancelled = /^(Canceled|已取消)/i.test(it.Subject || '') ? '已取消' : '';
      const tags = [free, cancelled].filter(Boolean).join('/');
      return `${i + 1}. ${s} ~ ${e.slice(11, 16)} | ${it.Subject || '(无主题)'}${loc ? ' @ ' + loc : ''}${org ? ' | 组织者: ' + org : ''}${tags ? ` [${tags}]` : ''}\n   id=${(it.ItemId && it.ItemId.Id) || ''}`;
    })
    .join('\n');
}

function pick(v) {
  if (!v) return '';
  const s = typeof v === 'string' ? v : v.DateTime || '';
  return s.slice(0, 16).replace('T', ' ');
}
