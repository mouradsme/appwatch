import type { AlertEvent, AllSettings, MonitorRow } from '../types';
import { errorMessage, fmtDate, fmtDuration, sha256, splitList, truncate } from '../util';
import { sendMail } from './smtp';
import { getVapidKeys, sendPush, type PushPayload, type PushResult, type PushSubscriptionRow } from './webpush';
import { phoneList, sendWasend } from './wasend';

export type Channel = 'email' | 'push' | 'wasend';

/* ---------- recipients: per-monitor override, falling back to the defaults in Settings ---------- */

type RecipientSource = Pick<MonitorRow, 'email_to' | 'wasend_to'>;

function emailList(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  return splitList(raw).filter((a) => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
}

export function emailRecipients(m: RecipientSource, s: AllSettings): string[] {
  const own = emailList(m.email_to);
  return own.length ? own : emailList(s.smtp.to);
}

export function wasendRecipients(m: RecipientSource, s: AllSettings): string[] {
  const own = phoneList(m.wasend_to);
  return own.length ? own : phoneList(s.wasend.recipients);
}

/**
 * Inverts events → recipients, then lets recipients that get exactly the same events share one
 * message. Everybody receives one message per run containing only the monitors routed to them.
 */
export function routeByRecipient(events: AlertEvent[], recipientsOf: (m: AlertEvent['monitor']) => string[]) {
  const byRecipient = new Map<string, { recipient: string; idx: number[] }>();
  events.forEach((e, i) => {
    for (const r of recipientsOf(e.monitor)) {
      const key = r.toLowerCase();
      if (!byRecipient.has(key)) byRecipient.set(key, { recipient: r, idx: [] });
      byRecipient.get(key)!.idx.push(i);
    }
  });
  const groups = new Map<string, { recipients: string[]; events: AlertEvent[] }>();
  for (const { recipient, idx } of byRecipient.values()) {
    const key = idx.join(',');
    if (!groups.has(key)) groups.set(key, { recipients: [], events: idx.map((i) => events[i]) });
    groups.get(key)!.recipients.push(recipient);
  }
  return [...groups.values()];
}

interface LogRow {
  monitor_id: number | null;
  incident_id: number | null;
  channel: Channel;
  event: string;
  success: boolean;
  detail: string;
}

const ICON: Record<AlertEvent['kind'], string> = { down: '🔴', up: '🟢', reminder: '🟠' };
const COLOR: Record<AlertEvent['kind'], string> = { down: '#e5484d', up: '#30a46c', reminder: '#f5a524' };

function eventTitle(e: AlertEvent): string {
  if (e.kind === 'down') return `${e.monitor.name} is DOWN`;
  if (e.kind === 'up') return `${e.monitor.name} is back UP`;
  return `${e.monitor.name} is still DOWN`;
}

function eventDetails(e: AlertEvent, tz: string): [string, string][] {
  const rows: [string, string][] = [['Target', e.monitor.target]];
  if (e.kind === 'down') {
    rows.push(['Cause', e.cause ?? 'Unknown error'], ['Down since', fmtDate(e.startedAt, tz)]);
  } else if (e.kind === 'up') {
    rows.push(['Downtime', fmtDuration(e.durationMs)], ['Down since', fmtDate(e.startedAt, tz)], ['Recovered', fmtDate(e.at, tz)]);
  } else {
    rows.push(['Down for', fmtDuration(e.at - e.startedAt)], ['Last error', e.cause ?? 'Unknown error'], ['Down since', fmtDate(e.startedAt, tz)]);
  }
  return rows;
}

function linkFor(appUrl: string, events: AlertEvent[]): string {
  if (!appUrl) return '';
  return events.length === 1 ? `${appUrl}/#/monitors/${events[0].monitor.id}` : `${appUrl}/#/incidents`;
}

function digestSubject(events: AlertEvent[], appName: string): string {
  if (events.length === 1) return `${ICON[events[0].kind]} ${eventTitle(events[0])}`;
  const n = (k: AlertEvent['kind']) => events.filter((e) => e.kind === k).length;
  const parts = [n('down') && `${n('down')} down`, n('reminder') && `${n('reminder')} still down`, n('up') && `${n('up')} recovered`].filter(Boolean);
  const icon = n('down') || n('reminder') ? '🔴' : '🟢';
  return `${icon} ${appName}: ${parts.join(', ')}`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function composeEmail(events: AlertEvent[], s: AllSettings) {
  const tz = s.general.timezone;
  const link = linkFor(s.app_url, events);
  const subject = digestSubject(events, s.general.app_name);
  const text = [
    ...events.flatMap((e) => [`${ICON[e.kind]} ${eventTitle(e)}`, ...eventDetails(e, tz).map(([k, v]) => `  ${k}: ${v}`), '']),
    link ? `Open dashboard: ${link}` : '',
    '',
    `— ${s.general.app_name}`,
  ].join('\n');
  const cards = events
    .map(
      (e) => `
      <div style="border:1px solid #e4e7ec;border-left:4px solid ${COLOR[e.kind]};border-radius:8px;padding:14px 16px;margin:0 0 12px">
        <div style="font-size:16px;font-weight:600;color:#101828;margin-bottom:8px">${ICON[e.kind]} ${escapeHtml(eventTitle(e))}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;color:#344054;border-collapse:collapse">
          ${eventDetails(e, tz)
            .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#667085;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:2px 0;word-break:break-all">${escapeHtml(v)}</td></tr>`)
            .join('')}
        </table>
      </div>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#667085;margin-bottom:12px">${escapeHtml(s.general.app_name)}</div>
    <div style="background:#ffffff;border-radius:12px;padding:20px">
      ${cards}
      ${link ? `<a href="${escapeHtml(link)}" style="display:inline-block;margin-top:4px;background:#101828;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600">Open dashboard</a>` : ''}
    </div>
    <div style="font-size:12px;color:#98a2b3;margin-top:12px">Sent by ${escapeHtml(s.general.app_name)} uptime monitoring.</div>
  </div></body></html>`;
  return { subject, text, html };
}

export function composePush(events: AlertEvent[], s: AllSettings): PushPayload {
  const link = linkFor(s.app_url, events) || '/';
  if (events.length === 1) {
    const e = events[0];
    const body =
      e.kind === 'down'
        ? `${e.cause ?? 'Unknown error'}\n${e.monitor.target}`
        : e.kind === 'up'
          ? `Downtime ${fmtDuration(e.durationMs)} · ${e.monitor.target}`
          : `Down for ${fmtDuration(e.at - e.startedAt)} · ${e.cause ?? 'Unknown error'}`;
    return { title: `${ICON[e.kind]} ${eventTitle(e)}`, body: truncate(body, 240)!, url: link, tag: `monitor-${e.monitor.id}`, kind: e.kind };
  }
  const body = events.map((e) => `${ICON[e.kind]} ${eventTitle(e)}`).join('\n');
  const kind = events.some((e) => e.kind !== 'up') ? 'down' : 'up';
  return { title: digestSubject(events, s.general.app_name), body: truncate(body, 240)!, url: link, tag: 'appwatch-digest', kind };
}

export function composeWhatsApp(events: AlertEvent[], s: AllSettings): string {
  const tz = s.general.timezone;
  const link = linkFor(s.app_url, events);
  const blocks = events.map((e) => [`${ICON[e.kind]} *${eventTitle(e)}*`, ...eventDetails(e, tz).map(([k, v]) => `${k}: ${v}`)].join('\n'));
  return [`*${s.general.app_name}*`, ...blocks, link].filter(Boolean).join('\n\n');
}

/** Sends to every push device and cleans up expired subscriptions. */
export async function deliverPush(db: D1Database, subs: PushSubscriptionRow[], payload: PushPayload, s: AllSettings): Promise<PushResult[]> {
  if (!subs.length) return [];
  const keys = await getVapidKeys(db);
  const subject = s.general.contact_email ? `mailto:${s.general.contact_email}` : s.app_url || 'mailto:admin@example.com';
  const results = await sendPush(subs, payload, keys, subject);
  const now = Date.now();
  const stmts = results.map((r) =>
    r.gone
      ? db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(r.id)
      : r.ok
        ? db.prepare('UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL WHERE id = ?').bind(now, r.id)
        : db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').bind(truncate(r.detail, 300), r.id),
  );
  if (stmts.length) await db.batch(stmts);
  return results;
}

function summarizePush(results: PushResult[]): { ok: boolean; detail: string } {
  const delivered = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok).map((r) => `${r.label ?? `device #${r.id}`}: ${r.gone ? 'subscription expired (removed)' : r.detail}`);
  return { ok: delivered > 0, detail: truncate([`Delivered to ${delivered}/${results.length} device(s)`, ...failures].join('; '), 500)! };
}

async function idempotencyKey(events: AlertEvent[]): Promise<string> {
  const raw = events.map((e) => `${e.kind}:${e.monitor.id}:${e.incidentId ?? ''}:${e.at}`).join('|');
  const h = await sha256(raw);
  return 'appwatch-' + Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Sends one digest per channel for all events of a run (keeps the Worker under the free-tier
 * subrequest limit when many monitors change state at once) and records every attempt.
 */
export async function dispatchAlerts(db: D1Database, allEvents: AlertEvent[], s: AllSettings): Promise<void> {
  const events = s.general.notify_recovery ? allEvents : allEvents.filter((e) => e.kind !== 'up');
  if (!events.length) return;
  const logs: LogRow[] = [];
  const logFor = (list: AlertEvent[], channel: Channel, success: boolean, detail: string) => {
    for (const e of list) logs.push({ monitor_id: e.monitor.id, incident_id: e.incidentId, channel, event: e.kind, success, detail: truncate(detail, 500)! });
  };
  const tasks: Promise<void>[] = [];

  const emailEvents = events.filter((e) => e.monitor.notify_email);
  if (s.smtp.enabled && emailEvents.length) {
    for (const group of routeByRecipient(emailEvents, (m) => emailRecipients(m, s))) {
      tasks.push(
        (async () => {
          try {
            const reply = await sendMail(s.smtp, { to: group.recipients, ...composeEmail(group.events, s) });
            logFor(group.events, 'email', true, `Sent to ${group.recipients.join(', ')} – ${reply}`);
          } catch (e) {
            logFor(group.events, 'email', false, `To ${group.recipients.join(', ')}: ${errorMessage(e)}`);
          }
        })(),
      );
    }
  }

  const pushEvents = events.filter((e) => e.monitor.notify_push);
  if (pushEvents.length) {
    tasks.push(
      (async () => {
        try {
          const { results: subs } = await db.prepare('SELECT id, endpoint, p256dh, auth, label FROM push_subscriptions').all<PushSubscriptionRow>();
          if (!subs.length) return;
          const summary = summarizePush(await deliverPush(db, subs, composePush(pushEvents, s), s));
          logFor(pushEvents, 'push', summary.ok, summary.detail);
        } catch (e) {
          logFor(pushEvents, 'push', false, errorMessage(e));
        }
      })(),
    );
  }

  const waEvents = events.filter((e) => e.monitor.notify_wasend);
  if (s.wasend.enabled && waEvents.length) {
    for (const group of routeByRecipient(waEvents, (m) => wasendRecipients(m, s))) {
      tasks.push(
        (async () => {
          try {
            const results = await sendWasend(s.wasend, composeWhatsApp(group.events, s), await idempotencyKey(group.events), group.recipients);
            logFor(group.events, 'wasend', results.some((r) => r.ok), results.map((r) => `${r.to}: ${r.detail}`).join('; '));
          } catch (e) {
            logFor(group.events, 'wasend', false, `To ${group.recipients.join(', ')}: ${errorMessage(e)}`);
          }
        })(),
      );
    }
  }

  await Promise.allSettled(tasks);
  await logNotifications(db, logs);
}

export async function logNotifications(db: D1Database, logs: LogRow[]): Promise<void> {
  if (!logs.length) return;
  const now = Date.now();
  await db.batch(
    logs.map((l) =>
      db
        .prepare('INSERT INTO notifications (at, monitor_id, incident_id, channel, event, success, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(now, l.monitor_id, l.incident_id, l.channel, l.event, l.success ? 1 : 0, l.detail),
    ),
  );
}

/** Sends a test message on one channel and returns a human readable result. */
export async function sendTest(db: D1Database, channel: Channel, s: AllSettings, endpoint?: string): Promise<{ ok: boolean; detail: string }> {
  const title = `✅ ${s.general.app_name} test notification`;
  const line = `If you can read this, ${channel === 'email' ? 'email' : channel === 'push' ? 'push' : 'WhatsApp'} alerts are working.`;
  let result: { ok: boolean; detail: string };
  try {
    if (channel === 'email') {
      if (!s.smtp.host) return { ok: false, detail: 'SMTP is not configured yet. Save the settings first.' };
      const to = splitList(s.smtp.to);
      const reply = await sendMail(s.smtp, {
        to,
        subject: title,
        text: `${line}\n\nSent at ${fmtDate(Date.now(), s.general.timezone)}`,
        html: `<p style="font-family:sans-serif">${escapeHtml(line)}</p><p style="font-family:sans-serif;color:#667085">Sent at ${escapeHtml(fmtDate(Date.now(), s.general.timezone))}</p>`,
      });
      result = { ok: true, detail: `Sent to ${to.join(', ')} – server replied: ${reply}` };
    } else if (channel === 'push') {
      const q = endpoint
        ? db.prepare('SELECT id, endpoint, p256dh, auth, label FROM push_subscriptions WHERE endpoint = ?').bind(endpoint)
        : db.prepare('SELECT id, endpoint, p256dh, auth, label FROM push_subscriptions');
      const { results: subs } = await q.all<PushSubscriptionRow>();
      if (!subs.length) return { ok: false, detail: endpoint ? 'This device is not subscribed.' : 'No devices are subscribed to push notifications.' };
      result = summarizePush(await deliverPush(db, subs, { title, body: line, url: s.app_url ? `${s.app_url}/#/settings` : '/', tag: 'appwatch-test', kind: 'test' }, s));
    } else {
      if (!s.wasend.base_url || !s.wasend.api_key) return { ok: false, detail: 'Wasend is not configured yet. Save the settings first.' };
      const results = await sendWasend(s.wasend, `*${s.general.app_name}*\n\n${title}\n${line}`, `appwatch-test-${Date.now()}`);
      result = { ok: results.length > 0 && results.every((r) => r.ok), detail: results.map((r) => `${r.to}: ${r.detail}`).join('; ') || 'No recipients configured' };
    }
  } catch (e) {
    result = { ok: false, detail: errorMessage(e) };
  }
  await logNotifications(db, [{ monitor_id: null, incident_id: null, channel, event: 'test', success: result.ok, detail: truncate(result.detail, 500)! }]);
  return result;
}

export interface ChannelTestResult {
  channel: Channel;
  ok: boolean;
  recipients: string[];
  detail: string;
}

/** Sends a test alert through every channel enabled for one monitor, to that monitor's recipients. */
export async function sendMonitorTest(db: D1Database, m: MonitorRow, s: AllSettings): Promise<ChannelTestResult[]> {
  const title = `✅ Test alert: ${m.name}`;
  const line = `Alerts for ${m.name} (${m.target}) will reach you like this.`;
  const sentAt = `Sent at ${fmtDate(Date.now(), s.general.timezone)}`;
  const link = s.app_url ? `${s.app_url}/#/monitors/${m.id}` : '';
  const out: ChannelTestResult[] = [];
  const tasks: Promise<void>[] = [];

  if (m.notify_email) {
    const to = emailRecipients(m, s);
    if (!s.smtp.enabled) out.push({ channel: 'email', ok: false, recipients: to, detail: 'Email (SMTP) is disabled in Settings.' });
    else if (!to.length) out.push({ channel: 'email', ok: false, recipients: to, detail: 'No email recipients.' });
    else
      tasks.push(
        sendMail(s.smtp, {
          to,
          subject: title,
          text: `${line}\n\n${sentAt}${link ? `\n${link}` : ''}`,
          html: `<div style="font-family:sans-serif"><p>${escapeHtml(line)}</p><p style="color:#667085">${escapeHtml(sentAt)}</p>${link ? `<p><a href="${escapeHtml(link)}">Open monitor</a></p>` : ''}</div>`,
        })
          .then((reply) => void out.push({ channel: 'email', ok: true, recipients: to, detail: `Sent – ${reply}` }))
          .catch((e) => void out.push({ channel: 'email', ok: false, recipients: to, detail: errorMessage(e) })),
      );
  }

  if (m.notify_wasend) {
    const to = wasendRecipients(m, s);
    if (!s.wasend.enabled) out.push({ channel: 'wasend', ok: false, recipients: to, detail: 'WhatsApp (Wasend) is disabled in Settings.' });
    else if (!to.length) out.push({ channel: 'wasend', ok: false, recipients: to, detail: 'No WhatsApp numbers.' });
    else
      tasks.push(
        sendWasend(s.wasend, [`*${s.general.app_name}*`, title, line, sentAt, link].filter(Boolean).join('\n\n'), `appwatch-test-${m.id}-${Date.now()}`, to)
          .then((r) => void out.push({ channel: 'wasend', ok: r.every((x) => x.ok), recipients: to, detail: r.map((x) => `${x.to}: ${x.detail}`).join('; ') }))
          .catch((e) => void out.push({ channel: 'wasend', ok: false, recipients: to, detail: errorMessage(e) })),
      );
  }

  if (m.notify_push) {
    tasks.push(
      (async () => {
        const { results: subs } = await db.prepare('SELECT id, endpoint, p256dh, auth, label FROM push_subscriptions').all<PushSubscriptionRow>();
        if (!subs.length) return void out.push({ channel: 'push', ok: false, recipients: [], detail: 'No device is subscribed to push notifications.' });
        const summary = summarizePush(await deliverPush(db, subs, { title, body: line, url: link || '/', tag: `monitor-${m.id}`, kind: 'test' }, s));
        out.push({ channel: 'push', ok: summary.ok, recipients: subs.map((d) => d.label ?? `device #${d.id}`), detail: summary.detail });
      })().catch((e) => void out.push({ channel: 'push', ok: false, recipients: [], detail: errorMessage(e) })),
    );
  }

  await Promise.allSettled(tasks);
  await logNotifications(
    db,
    out.map((r) => ({
      monitor_id: m.id,
      incident_id: null,
      channel: r.channel,
      event: 'test',
      success: r.ok,
      detail: truncate(r.channel === 'email' && r.recipients.length ? `To ${r.recipients.join(', ')}: ${r.detail}` : r.detail, 500)!,
    })),
  );
  const order: Channel[] = ['email', 'wasend', 'push'];
  return out.sort((a, b) => order.indexOf(a.channel) - order.indexOf(b.channel));
}
