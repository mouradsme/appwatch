// The monitoring engine: picks the monitors that are due, checks them, records every result and
// turns state changes into incidents + alerts. Runs from the once-a-minute Cron Trigger.
import { runCheck } from './checker';
import { dispatchAlerts, emailRecipients, wasendRecipients } from './notify';
import { loadSettings, settingsFromRows } from './settings';
import type { AlertEvent, AllSettings, CheckResult, MonitorRow } from './types';
import { pool } from './util';

const DAY = 86_400_000;
/** Stop starting new checks after this long so two cron runs never overlap. */
const RUN_BUDGET_MS = 50_000;
/** Workers Free allows 50 external subrequests per invocation (checks + notifications). */
const SUBREQUEST_LIMIT = 50;
/** Workers allow 6 simultaneous outgoing connections; more would queue and skew timings. */
const CONCURRENCY = 6;
/** Cron fires roughly every 60 s; a monitor is due when it is within 30 s of its interval. */
const SLACK_MS = 30_000;

type MonitorWithLast = MonitorRow & { last_at: number | null };
type Checked = { m: MonitorRow; r: CheckResult };

/** Interval that applies right now: faster while failing so outages are confirmed and resolved quickly. */
export function effectiveIntervalMs(m: Pick<MonitorRow, 'open_incident_id' | 'fail_streak' | 'down_interval_s' | 'interval_s'>): number {
  const failing = m.open_incident_id != null || m.fail_streak > 0;
  return (failing ? Math.min(m.down_interval_s, m.interval_s) : m.interval_s) * 1000;
}

export async function runScheduled(env: Env, scheduledTime: number): Promise<void> {
  const started = Date.now();
  const [monRes, setRes, pushRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT m.*, (SELECT MAX(checked_at) FROM checks c WHERE c.monitor_id = m.id) AS last_at
       FROM monitors m WHERE m.active = 1 AND m.deleted_at IS NULL`,
    ),
    env.DB.prepare(`SELECT key, value FROM settings WHERE key IN ('general', 'smtp', 'wasend', 'app_url')`),
    env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions'),
  ]);
  const monitors = monRes.results as MonitorWithLast[];
  const settings = settingsFromRows(setRes.results as { key: string; value: string }[]);
  const pushDevices = (pushRes.results[0] as { n: number }).n;

  // Keep enough subrequests for the alerts this run might send: at most one email per distinct
  // address, one WhatsApp message per distinct number, one push per device.
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const m of monitors) {
    if (settings.smtp.enabled && m.notify_email) emailRecipients(m, settings).forEach((a) => emails.add(a.toLowerCase()));
    if (settings.wasend.enabled && m.notify_wasend) wasendRecipients(m, settings).forEach((n) => phones.add(n));
  }
  const notifyTargets = emails.size + phones.size + pushDevices;
  const cap = Math.max(5, SUBREQUEST_LIMIT - 2 - notifyTargets);

  const now = Date.now();
  const due = monitors
    .map((m) => ({ m, overdue: m.last_at == null ? Number.MAX_SAFE_INTEGER : now - m.last_at - (effectiveIntervalMs(m) - SLACK_MS) }))
    .filter((x) => x.overdue >= 0)
    .sort((a, b) => b.overdue - a.overdue)
    .slice(0, cap)
    .map((x) => x.m);

  if (due.length) {
    const results = await pool(due, CONCURRENCY, async (m): Promise<Checked | null> => {
      const remaining = started + RUN_BUDGET_MS - Date.now();
      if (remaining < 4000) return null; // picked up by the next run
      return { m, r: await runCheck(m, remaining - 2000) };
    });
    const events = await persistResults(
      env.DB,
      results.filter((x): x is Checked => x !== null),
      settings,
    );
    await dispatchAlerts(env.DB, events, settings);
  }

  if (new Date(scheduledTime).getUTCMinutes() === 17) await housekeeping(env.DB, settings);
}

/** Runs one monitor immediately (dashboard "Check now"). */
export async function checkNow(env: Env, ctx: ExecutionContext, m: MonitorRow): Promise<CheckResult> {
  const r = await runCheck(m);
  const settings = await loadSettings(env.DB);
  const events = await persistResults(env.DB, [{ m, r }], settings);
  if (events.length) ctx.waitUntil(dispatchAlerts(env.DB, events, settings));
  return r;
}

/**
 * Records the results and applies the state machine:
 *   ok   → resolves an open incident (UP alert) or just clears the failure streak
 *   fail → counts consecutive failures; at `retries` failures an incident opens (DOWN alert)
 * The incident INSERT/UPDATE statements are conditional, so even overlapping runs can't open two
 * incidents for one outage or alert twice. A healthy monitor that stays healthy costs one row write.
 */
export async function persistResults(db: D1Database, items: Checked[], s: AllSettings): Promise<AlertEvent[]> {
  if (!items.length) return [];
  const now = Date.now();
  const reminderMs = s.general.reminder_minutes * 60_000;
  const stmts: D1PreparedStatement[] = [];
  const watch: { idx: number; kind: 'down' | 'up'; m: MonitorRow; r: CheckResult; firstFail: number }[] = [];
  const events: AlertEvent[] = [];

  for (const { m, r } of items) {
    stmts.push(
      db
        .prepare('INSERT OR REPLACE INTO checks (monitor_id, checked_at, ok, response_ms, status_code, error) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(m.id, r.t, r.ok ? 1 : 0, r.ms, r.code, r.error),
    );

    if (r.ok) {
      if (m.open_incident_id != null) {
        watch.push({ idx: stmts.length, kind: 'up', m, r, firstFail: m.first_fail_at ?? r.t });
        stmts.push(
          db
            .prepare(
              `UPDATE incidents SET resolved_at = ?2, duration_ms = ?2 - started_at, failed_checks = ?3
               WHERE monitor_id = ?1 AND resolved_at IS NULL RETURNING id, started_at, duration_ms`,
            )
            .bind(m.id, r.t, m.fail_streak),
        );
        stmts.push(
          db
            .prepare(
              `UPDATE monitors SET status = 'up', status_since = ?2, fail_streak = 0, first_fail_at = NULL,
               open_incident_id = NULL, last_alert_at = NULL WHERE id = ?1`,
            )
            .bind(m.id, r.t),
        );
      } else if (m.status !== 'up' || m.fail_streak > 0) {
        stmts.push(
          db
            .prepare(
              `UPDATE monitors SET status = 'up', status_since = CASE WHEN status = 'up' THEN status_since ELSE ?2 END,
               fail_streak = 0, first_fail_at = NULL WHERE id = ?1`,
            )
            .bind(m.id, r.t),
        );
      }
      continue;
    }

    const streak = m.fail_streak + 1;
    const firstFail = m.first_fail_at ?? r.t;
    if (m.open_incident_id != null) {
      const remind = reminderMs > 0 && now - (m.last_alert_at ?? 0) >= reminderMs;
      stmts.push(db.prepare('UPDATE monitors SET fail_streak = ?2, last_alert_at = ?3 WHERE id = ?1').bind(m.id, streak, remind ? now : m.last_alert_at));
      if (remind) {
        events.push({ kind: 'reminder', monitor: m, incidentId: m.open_incident_id, at: r.t, startedAt: firstFail, durationMs: r.t - firstFail, cause: r.error, statusCode: r.code });
      }
    } else if (streak >= Math.max(1, m.retries)) {
      watch.push({ idx: stmts.length, kind: 'down', m, r, firstFail });
      stmts.push(
        db
          .prepare(
            `INSERT INTO incidents (monitor_id, started_at, detected_at, cause, status_code, failed_checks)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6
             WHERE NOT EXISTS (SELECT 1 FROM incidents WHERE monitor_id = ?1 AND resolved_at IS NULL)
             RETURNING id`,
          )
          .bind(m.id, firstFail, r.t, r.error, r.code, streak),
      );
      stmts.push(
        db
          .prepare(
            `UPDATE monitors SET status = 'down', status_since = ?2, fail_streak = ?3, first_fail_at = ?2, last_alert_at = ?4,
             open_incident_id = (SELECT id FROM incidents WHERE monitor_id = ?1 AND resolved_at IS NULL ORDER BY id DESC LIMIT 1)
             WHERE id = ?1`,
          )
          .bind(m.id, firstFail, streak, now),
      );
    } else {
      stmts.push(db.prepare('UPDATE monitors SET fail_streak = ?2, first_fail_at = ?3 WHERE id = ?1').bind(m.id, streak, firstFail));
    }
  }

  const res = await db.batch(stmts);
  for (const w of watch) {
    const row = res[w.idx].results[0] as { id: number; started_at?: number; duration_ms?: number } | undefined;
    if (!row) continue; // a concurrent run already handled this transition
    if (w.kind === 'down') {
      events.push({ kind: 'down', monitor: w.m, incidentId: row.id, at: w.r.t, startedAt: w.firstFail, durationMs: null, cause: w.r.error, statusCode: w.r.code });
    } else {
      const startedAt = row.started_at ?? w.firstFail;
      events.push({ kind: 'up', monitor: w.m, incidentId: row.id, at: w.r.t, startedAt, durationMs: row.duration_ms ?? w.r.t - startedAt, cause: null, statusCode: w.r.code });
    }
  }
  return events;
}

/**
 * Hourly: applies check retention and removes data of deleted monitors. Deletes count as D1 row
 * writes, so they are spread out (at most a couple of days of data per monitor per hour).
 */
export async function housekeeping(db: D1Database, s: AllSettings): Promise<void> {
  const now = Date.now();
  const { results } = await db
    .prepare('SELECT m.id, m.deleted_at, (SELECT MIN(checked_at) FROM checks c WHERE c.monitor_id = m.id) AS oldest FROM monitors m')
    .all<{ id: number; deleted_at: number | null; oldest: number | null }>();
  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM login_attempts WHERE window_start < ?').bind(now - DAY)];
  const retention = s.general.retention_days;

  for (const r of results) {
    if (r.deleted_at != null) {
      if (r.oldest == null) {
        stmts.push(
          db.prepare('DELETE FROM incidents WHERE monitor_id = ?').bind(r.id),
          db.prepare('DELETE FROM events WHERE monitor_id = ?').bind(r.id),
          db.prepare('DELETE FROM notifications WHERE monitor_id = ?').bind(r.id),
          db.prepare('DELETE FROM monitors WHERE id = ?').bind(r.id),
        );
      } else {
        stmts.push(db.prepare('DELETE FROM checks WHERE monitor_id = ? AND checked_at < ?').bind(r.id, r.oldest + 7 * DAY));
      }
    } else if (retention > 0 && r.oldest != null) {
      const cutoff = now - retention * DAY;
      if (r.oldest < cutoff) {
        stmts.push(db.prepare('DELETE FROM checks WHERE monitor_id = ? AND checked_at < ?').bind(r.id, Math.min(cutoff, r.oldest + 2 * DAY)));
      }
    }
  }
  await db.batch(stmts);
}
