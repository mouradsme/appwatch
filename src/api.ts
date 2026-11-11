import { clearSessionCookie, isAuthenticated, isConfigured, login } from './auth';
import { checkNow } from './engine';
import { sendMonitorTest, sendTest, type Channel } from './notify';
import { normalizePhone, WASEND_PHONE_RE } from './notify/wasend';
import { getVapidKeys } from './notify/webpush';
import { loadSettings, maskSettings, saveSettingStmt, validateGeneral, validateSmtp, validateWasend } from './settings';
import type { MonitorRow } from './types';
import { HttpError, json, parseHostPort, splitList, STATUS_SPEC_RE, truncate } from './util';

const DAY = 86_400_000;

type Ctx = { req: Request; env: Env; ctx: ExecutionContext; url: URL; params: string[]; body: Record<string, unknown> };
type Handler = (c: Ctx) => Promise<Response>;

const routes: { method: string; re: RegExp; handler: Handler; public?: boolean }[] = [];
const route = (method: string, path: string, handler: Handler, isPublic = false) =>
  routes.push({ method, re: new RegExp(`^${path.replace(/:\w+/g, '(\\d+)')}$`), handler, public: isPublic });

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  try {
    const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!match) {
      const exists = routes.some((r) => r.re.test(url.pathname));
      return json({ error: exists ? 'Method not allowed' : 'Not found' }, exists ? 405 : 404);
    }
    if (req.method !== 'GET') {
      // CSRF defence on top of SameSite=Strict cookies.
      const origin = req.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'Cross-origin request blocked' }, 403);
    }
    if (!match.public && !(await isAuthenticated(req, env))) return json({ error: 'Not signed in' }, 401);
    const params = url.pathname.match(match.re)!.slice(1);
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
    return await match.handler({ req, env, ctx, url, params, body });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    const msg = (e as Error)?.message ?? String(e);
    console.error('API error', url.pathname, msg);
    if (/no such table/i.test(msg)) return json({ error: 'The database is not initialised. Run deploy.bat to apply the migrations.' }, 500);
    return json({ error: `Internal error: ${msg}` }, 500);
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  if (text.length > 100_000) throw new HttpError(413, 'Request body too large');
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

const num = (v: string | null, def: number) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? n : def;
};

/* ------------------------------------------------------------------ auth */

route('GET', '/api/health', async () => json({ ok: true, time: Date.now() }), true);

route(
  'GET',
  '/api/auth/session',
  async ({ req, env }) => {
    const authenticated = await isAuthenticated(req, env);
    let appName = 'AppWatch';
    if (authenticated) appName = (await loadSettings(env.DB)).general.app_name;
    return json({ authenticated, configured: isConfigured(env), app_name: appName });
  },
  true,
);

route('POST', '/api/auth/login', async ({ req, env, body }) => login(req, env, body), true);

route('POST', '/api/auth/logout', async ({ url }) => json({ ok: true }, 200, { 'set-cookie': clearSessionCookie(url.protocol === 'https:') }), true);

/* ------------------------------------------------------------------ monitors */

const MONITOR_LIST_COLUMNS = `id, name, type, target, method, interval_s, down_interval_s, retries, timeout_ms, active, status, status_since,
  fail_streak, open_incident_id, created_at, notify_email, notify_push, notify_wasend, keyword`;

function publicMonitor(m: MonitorRow) {
  let headers: Record<string, string> = {};
  try {
    headers = m.headers ? JSON.parse(m.headers) : {};
  } catch {
    /* ignore */
  }
  return { ...m, headers };
}

async function getMonitor(env: Env, id: number): Promise<MonitorRow> {
  const m = await env.DB.prepare('SELECT * FROM monitors WHERE id = ? AND deleted_at IS NULL').bind(id).first<MonitorRow>();
  if (!m) throw new HttpError(404, 'Monitor not found');
  return m;
}

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

type MonitorInput = Pick<
  MonitorRow,
  | 'name'
  | 'type'
  | 'target'
  | 'method'
  | 'headers'
  | 'body'
  | 'expected_status'
  | 'keyword'
  | 'keyword_mode'
  | 'follow_redirects'
  | 'timeout_ms'
  | 'interval_s'
  | 'down_interval_s'
  | 'retries'
  | 'notify_email'
  | 'notify_push'
  | 'notify_wasend'
  | 'email_to'
  | 'wasend_to'
>;

/** Optional per-monitor recipient list: validated, de-duplicated, NULL when empty (= use defaults). */
function recipientList(raw: unknown, kind: 'email' | 'phone'): string | null {
  const items = splitList(typeof raw === 'string' ? raw : '');
  if (!items.length) return null;
  if (items.length > 20) throw new HttpError(400, `At most 20 ${kind === 'email' ? 'email addresses' : 'WhatsApp numbers'} per monitor`);
  const out = new Map<string, string>();
  for (const item of items) {
    if (kind === 'email') {
      if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(item)) throw new HttpError(400, `Invalid email recipient: ${item}`);
      if (!out.has(item.toLowerCase())) out.set(item.toLowerCase(), item);
    } else {
      const phone = normalizePhone(item);
      if (!WASEND_PHONE_RE.test(phone)) throw new HttpError(400, `Invalid WhatsApp number "${item}": use international format, e.g. +213555123456`);
      out.set(phone, phone);
    }
  }
  return [...out.values()].join(', ');
}

function validateMonitor(b: Record<string, unknown>): MonitorInput {
  const s = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const int = (v: unknown, min: number, max: number, def: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const flag = (v: unknown, def = 1) => (v === undefined ? def : v === true || v === 1 || v === '1' ? 1 : 0);

  const name = s(b.name, 100);
  if (!name) throw new HttpError(400, 'Name is required');
  const type = b.type === 'tcp' ? 'tcp' : 'http';
  const target = s(b.target, 2000);
  if (type === 'http') {
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      throw new HttpError(400, 'Enter a full URL, e.g. https://example.com/health');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'URL must start with http:// or https://');
  } else {
    parseHostPort(target);
  }
  const method = METHODS.includes(String(b.method).toUpperCase()) ? String(b.method).toUpperCase() : 'GET';

  let headers: string | null = null;
  if (b.headers && typeof b.headers === 'object' && !Array.isArray(b.headers)) {
    const entries = Object.entries(b.headers as Record<string, unknown>)
      .map(([k, v]) => [k.trim(), String(v ?? '').trim()] as const)
      .filter(([k]) => k);
    for (const [k] of entries) if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) throw new HttpError(400, `Invalid header name: ${k}`);
    if (entries.length) headers = JSON.stringify(Object.fromEntries(entries));
  }

  const expected = s(b.expected_status, 100) || '200-399';
  if (!STATUS_SPEC_RE.test(expected)) throw new HttpError(400, 'Expected status codes look like "200-299" or "200,301,404"');

  const interval_s = int(b.interval_s, 60, 30 * 86_400, 300);
  return {
    name,
    type,
    target,
    method,
    headers,
    body: s(b.body, 10_000) || null,
    expected_status: expected,
    keyword: s(b.keyword, 500) || null,
    keyword_mode: b.keyword_mode === 'not_contains' ? 'not_contains' : 'contains',
    follow_redirects: flag(b.follow_redirects),
    timeout_ms: int(b.timeout_ms, 1000, 30_000, 10_000),
    interval_s,
    down_interval_s: Math.min(interval_s, int(b.down_interval_s, 60, 30 * 86_400, 60)),
    retries: int(b.retries, 1, 10, 2),
    notify_email: flag(b.notify_email),
    notify_push: flag(b.notify_push),
    notify_wasend: flag(b.notify_wasend),
    email_to: recipientList(b.email_to, 'email'),
    wasend_to: recipientList(b.wasend_to, 'phone'),
  };
}

const FIELDS: (keyof MonitorInput)[] = [
  'name',
  'type',
  'target',
  'method',
  'headers',
  'body',
  'expected_status',
  'keyword',
  'keyword_mode',
  'follow_redirects',
  'timeout_ms',
  'interval_s',
  'down_interval_s',
  'retries',
  'notify_email',
  'notify_push',
  'notify_wasend',
  'email_to',
  'wasend_to',
];

const eventStmt = (env: Env, monitorId: number, type: string, detail: unknown, at = Date.now()) =>
  env.DB.prepare('INSERT INTO events (monitor_id, at, type, detail) VALUES (?, ?, ?, ?)').bind(monitorId, at, type, detail == null ? null : JSON.stringify(detail));

route('GET', '/api/dashboard', async ({ env }) => {
  const now = Date.now();
  const since = now - 90 * DAY;
  const { results: monitors } = await env.DB.prepare(`SELECT ${MONITOR_LIST_COLUMNS} FROM monitors WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`).all<MonitorRow>();
  const [incRes, ...recentRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT i.id, i.monitor_id, i.started_at, i.resolved_at, i.detected_at, i.acknowledged_at
       FROM incidents i JOIN monitors m ON m.id = i.monitor_id AND m.deleted_at IS NULL
       WHERE i.started_at >= ?1 OR i.resolved_at IS NULL OR i.resolved_at >= ?1`,
    ).bind(since),
    ...monitors.map((m) =>
      env.DB.prepare('SELECT checked_at, ok, response_ms, status_code, error FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 30').bind(m.id),
    ),
  ]);
  type CheckRow = { checked_at: number; ok: number; response_ms: number | null; status_code: number | null; error: string | null };
  return json({
    now,
    monitors: monitors.map((m, i) => {
      const rows = recentRes[i].results as CheckRow[];
      const last = rows[0];
      return {
        ...m,
        last: last ? { t: last.checked_at, ok: !!last.ok, ms: last.response_ms, code: last.status_code, error: last.error } : null,
        recent: rows.reverse().map((r) => [r.checked_at, r.ok, r.response_ms]),
      };
    }),
    incidents: (incRes.results as Record<string, number | null>[]).map((r) => [r.id, r.monitor_id, r.started_at, r.resolved_at, r.detected_at, r.acknowledged_at]),
  });
});

route('GET', '/api/monitors', async ({ env }) => {
  const { results } = await env.DB.prepare(`SELECT ${MONITOR_LIST_COLUMNS} FROM monitors WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE`).all();
  return json({ monitors: results });
});

route('POST', '/api/monitors', async ({ env, body }) => {
  const input = validateMonitor(body);
  const now = Date.now();
  const cols = [...FIELDS, 'active', 'status', 'created_at', 'updated_at'];
  const values = [...FIELDS.map((f) => input[f]), body.active === false ? 0 : 1, 'pending', now, now];
  const m = await env.DB.prepare(`INSERT INTO monitors (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`)
    .bind(...values)
    .first<MonitorRow>();
  await eventStmt(env, m!.id, 'created', { name: m!.name, target: m!.target, interval_s: m!.interval_s }).run();
  return json({ monitor: publicMonitor(m!) }, 201);
});

route('GET', '/api/monitors/:id', async ({ env, params }) => {
  const id = Number(params[0]);
  const now = Date.now();
  const [monRes, incRes, statRes, allRes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM monitors WHERE id = ? AND deleted_at IS NULL').bind(id),
    env.DB.prepare('SELECT * FROM incidents WHERE monitor_id = ?1 AND (started_at >= ?2 OR resolved_at IS NULL OR resolved_at >= ?2) ORDER BY started_at DESC').bind(id, now - 90 * DAY),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS up, AVG(CASE WHEN ok = 1 THEN response_ms END) AS avg,
              MIN(CASE WHEN ok = 1 THEN response_ms END) AS min, MAX(CASE WHEN ok = 1 THEN response_ms END) AS max
       FROM checks WHERE monitor_id = ? AND checked_at >= ?`,
    ).bind(id, now - DAY),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, SUM(COALESCE(duration_ms, ?2 - started_at)) AS downtime, AVG(duration_ms) AS mttr, MAX(COALESCE(duration_ms, ?2 - started_at)) AS longest
       FROM incidents WHERE monitor_id = ?1`,
    ).bind(id, now),
  ]);
  const m = monRes.results[0] as MonitorRow | undefined;
  if (!m) throw new HttpError(404, 'Monitor not found');
  const stats = statRes.results[0] as { n: number; up: number; avg: number | null; min: number | null; max: number | null };
  const [lastRes, p95Res] = await env.DB.batch([
    env.DB.prepare('SELECT checked_at, ok, response_ms, status_code, error FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1').bind(id),
    env.DB.prepare('SELECT response_ms FROM checks WHERE monitor_id = ? AND checked_at >= ? AND ok = 1 AND response_ms IS NOT NULL ORDER BY response_ms LIMIT 1 OFFSET ?').bind(
      id,
      now - DAY,
      Math.max(0, Math.floor(0.95 * (stats.up - 1))),
    ),
  ]);
  const last = lastRes.results[0] as { checked_at: number; ok: number; response_ms: number | null; status_code: number | null; error: string | null } | undefined;
  return json({
    now,
    monitor: publicMonitor(m),
    last: last ? { t: last.checked_at, ok: !!last.ok, ms: last.response_ms, code: last.status_code, error: last.error } : null,
    incidents: incRes.results,
    stats24h: { ...stats, p95: (p95Res.results[0] as { response_ms: number } | undefined)?.response_ms ?? null },
    allTime: allRes.results[0],
  });
});

route('PUT', '/api/monitors/:id', async ({ env, params, body }) => {
  const id = Number(params[0]);
  const before = await getMonitor(env, id);
  const input = validateMonitor(body);
  const changes: Record<string, [unknown, unknown]> = {};
  for (const f of FIELDS) {
    if (before[f] !== input[f]) changes[f] = f === 'headers' || f === 'body' ? ['(changed)', '(changed)'] : [before[f], input[f]];
  }
  const now = Date.now();
  const [res] = await env.DB.batch([
    env.DB.prepare(`UPDATE monitors SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ? RETURNING *`).bind(...FIELDS.map((f) => input[f]), now, id),
    ...(Object.keys(changes).length ? [eventStmt(env, id, 'updated', changes, now)] : []),
  ]);
  return json({ monitor: publicMonitor(res.results[0] as MonitorRow) });
});

/** Closes the open incident (if any) and resets the runtime state. Used by pause and delete. */
function stopStmts(env: Env, id: number, now: number, reason: string, extraSet: string) {
  return [
    env.DB.prepare(
      `UPDATE incidents SET resolved_at = ?2, duration_ms = ?2 - started_at,
       notes = COALESCE(notes || char(10), '') || ?3 WHERE monitor_id = ?1 AND resolved_at IS NULL`,
    ).bind(id, now, `Closed automatically: monitor ${reason}.`),
    env.DB.prepare(
      `UPDATE monitors SET active = 0, status = 'pending', status_since = ?2, fail_streak = 0, first_fail_at = NULL,
       open_incident_id = NULL, last_alert_at = NULL, updated_at = ?2${extraSet} WHERE id = ?1`,
    ).bind(id, now),
  ];
}

route('POST', '/api/monitors/:id/pause', async ({ env, params }) => {
  const id = Number(params[0]);
  await getMonitor(env, id);
  const now = Date.now();
  await env.DB.batch([...stopStmts(env, id, now, 'paused', ''), eventStmt(env, id, 'paused', null, now)]);
  return json({ monitor: publicMonitor(await getMonitor(env, id)) });
});

route('POST', '/api/monitors/:id/resume', async ({ env, params }) => {
  const id = Number(params[0]);
  await getMonitor(env, id);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE monitors SET active = 1, status = 'pending', status_since = ?2, updated_at = ?2 WHERE id = ?1`).bind(id, now),
    eventStmt(env, id, 'resumed', null, now),
  ]);
  return json({ monitor: publicMonitor(await getMonitor(env, id)) });
});

route('DELETE', '/api/monitors/:id', async ({ env, params }) => {
  const id = Number(params[0]);
  await getMonitor(env, id);
  const now = Date.now();
  // Soft delete: the hourly housekeeping purges its data gradually to protect the daily write quota.
  await env.DB.batch([...stopStmts(env, id, now, 'deleted', ', deleted_at = ?2'), eventStmt(env, id, 'deleted', null, now)]);
  return json({ ok: true });
});

route('POST', '/api/monitors/:id/check', async ({ env, ctx, params }) => {
  const id = Number(params[0]);
  const m = await getMonitor(env, id);
  const result = await checkNow(env, ctx, m);
  return json({ result, monitor: publicMonitor(await getMonitor(env, id)) });
});

route('POST', '/api/monitors/:id/test-alert', async ({ env, params }) => {
  const m = await getMonitor(env, Number(params[0]));
  return json({ results: await sendMonitorTest(env.DB, m, await loadSettings(env.DB)) });
});

route('GET', '/api/monitors/:id/series', async ({ env, params, url }) => {
  const id = Number(params[0]);
  const now = Date.now();
  const to = Math.min(num(url.searchParams.get('to'), now), now);
  const from = Math.max(num(url.searchParams.get('from'), to - DAY), to - 400 * DAY);
  const buckets = Math.min(400, Math.max(10, num(url.searchParams.get('buckets'), 120)));
  const size = Math.max(60_000, Math.ceil((to - from) / buckets));
  const { results } = await env.DB.prepare(
    `SELECT CAST((checked_at - ?2) / ?3 AS INTEGER) AS b, COUNT(*) AS n, SUM(ok) AS up,
            AVG(CASE WHEN ok = 1 THEN response_ms END) AS avg,
            MIN(CASE WHEN ok = 1 THEN response_ms END) AS min,
            MAX(CASE WHEN ok = 1 THEN response_ms END) AS max
     FROM checks WHERE monitor_id = ?1 AND checked_at >= ?2 AND checked_at < ?4
     GROUP BY b ORDER BY b`,
  )
    .bind(id, from, size, to)
    .all<{ b: number; n: number; up: number; avg: number | null; min: number | null; max: number | null }>();
  return json({
    from,
    to,
    size,
    points: results.map((r) => ({ t: from + r.b * size, n: r.n, up: r.up, avg: r.avg == null ? null : Math.round(r.avg), min: r.min, max: r.max })),
  });
});

route('GET', '/api/monitors/:id/checks', async ({ env, params, url }) => {
  const id = Number(params[0]);
  const before = num(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER);
  const after = num(url.searchParams.get('after'), 0);
  const limit = Math.min(1000, Math.max(1, num(url.searchParams.get('limit'), 50)));
  const failedOnly = url.searchParams.get('failed') === '1';
  const { results } = await env.DB.prepare(
    `SELECT checked_at, ok, response_ms, status_code, error FROM checks
     WHERE monitor_id = ? AND checked_at < ? AND checked_at >= ? ${failedOnly ? 'AND ok = 0' : ''}
     ORDER BY checked_at DESC LIMIT ?`,
  )
    .bind(id, before, after, limit)
    .all<{ checked_at: number; ok: number; response_ms: number | null; status_code: number | null; error: string | null }>();
  return json({
    checks: results.map((r) => ({ t: r.checked_at, ok: !!r.ok, ms: r.response_ms, code: r.status_code, error: r.error })),
    next: results.length === limit ? results[results.length - 1].checked_at : null,
  });
});

route('GET', '/api/monitors/:id/events', async ({ env, params, url }) => {
  const limit = Math.min(200, Math.max(1, num(url.searchParams.get('limit'), 50)));
  const { results } = await env.DB.prepare('SELECT id, at, type, detail FROM events WHERE monitor_id = ? ORDER BY at DESC LIMIT ?').bind(Number(params[0]), limit).all();
  return json({ events: results });
});

/* ------------------------------------------------------------------ incidents */

route('GET', '/api/incidents', async ({ env, url }) => {
  const now = Date.now();
  const from = num(url.searchParams.get('from'), now - 30 * DAY);
  const to = num(url.searchParams.get('to'), now + 1);
  const before = num(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER);
  const limit = Math.min(1000, Math.max(1, num(url.searchParams.get('limit'), 500)));
  const monitorId = url.searchParams.get('monitor_id');
  const status = url.searchParams.get('status');
  const where = ['(i.started_at >= ?1 OR i.resolved_at IS NULL OR i.resolved_at >= ?1)', 'i.started_at < ?2', 'i.id < ?3'];
  const binds: unknown[] = [from, to, before];
  if (monitorId) {
    where.push(`i.monitor_id = ?${binds.length + 1}`);
    binds.push(Number(monitorId));
  }
  if (status === 'open') where.push('i.resolved_at IS NULL');
  if (status === 'resolved') where.push('i.resolved_at IS NOT NULL');
  binds.push(limit);
  const { results } = await env.DB.prepare(
    `SELECT i.*, m.name AS monitor_name, m.target AS monitor_target FROM incidents i JOIN monitors m ON m.id = i.monitor_id
     WHERE m.deleted_at IS NULL AND ${where.join(' AND ')} ORDER BY i.id DESC LIMIT ?${binds.length}`,
  )
    .bind(...binds)
    .all<{ id: number }>();
  return json({ now, incidents: results, next: results.length === limit ? results[results.length - 1].id : null });
});

route('PATCH', '/api/incidents/:id', async ({ env, params, body }) => {
  const id = Number(params[0]);
  const inc = await env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(id).first<{ acknowledged_at: number | null; notes: string | null }>();
  if (!inc) throw new HttpError(404, 'Incident not found');
  const ack = body.acknowledged === undefined ? inc.acknowledged_at : body.acknowledged ? (inc.acknowledged_at ?? Date.now()) : null;
  const notes = typeof body.notes === 'string' ? truncate(body.notes.trim(), 4000) || null : inc.notes;
  const updated = await env.DB.prepare('UPDATE incidents SET acknowledged_at = ?, notes = ? WHERE id = ? RETURNING *').bind(ack, notes, id).first();
  return json({ incident: updated });
});

/* ------------------------------------------------------------------ notifications log */

route('GET', '/api/notifications', async ({ env, url }) => {
  const before = num(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER);
  const limit = Math.min(500, Math.max(1, num(url.searchParams.get('limit'), 100)));
  const monitorId = url.searchParams.get('monitor_id');
  const { results } = await env.DB.prepare(
    `SELECT n.*, m.name AS monitor_name FROM notifications n LEFT JOIN monitors m ON m.id = n.monitor_id
     WHERE n.id < ? ${monitorId ? 'AND n.monitor_id = ?' : ''} ORDER BY n.id DESC LIMIT ?`,
  )
    .bind(...(monitorId ? [before, Number(monitorId), limit] : [before, limit]))
    .all<{ id: number }>();
  return json({ notifications: results, next: results.length === limit ? results[results.length - 1].id : null });
});

/* ------------------------------------------------------------------ settings */

route('GET', '/api/settings', async ({ env }) => {
  const settings = await loadSettings(env.DB);
  const [devRes, monRes] = await env.DB.batch([
    env.DB.prepare('SELECT id, label, created_at, last_success_at, last_error, endpoint FROM push_subscriptions ORDER BY created_at DESC'),
    env.DB.prepare('SELECT interval_s FROM monitors WHERE active = 1 AND deleted_at IS NULL'),
  ]);
  const intervals = (monRes.results as { interval_s: number }[]).map((r) => r.interval_s);
  const checksPerDay = Math.round(intervals.reduce((n, s) => n + 86_400 / s, 0));
  return json({
    ...maskSettings(settings),
    push: {
      devices: (devRes.results as { endpoint: string }[]).map((d) => ({ ...d, service: new URL(d.endpoint).hostname })),
    },
    usage: {
      active_monitors: intervals.length,
      checks_per_day: checksPerDay,
      // one row write per check, plus one more later if old checks are purged by retention
      est_writes_per_day: Math.round(checksPerDay * (settings.general.retention_days > 0 ? 2 : 1) + 200),
      est_cron_reads_per_day: 1440 * (2 * intervals.length + 6),
      db_size_bytes: (monRes.meta as { size_after?: number }).size_after ?? null,
      limits: { writes_per_day: 100_000, reads_per_day: 5_000_000, db_size_bytes: 500 * 1024 * 1024, worker_requests_per_day: 100_000 },
    },
  });
});

for (const section of ['general', 'smtp', 'wasend'] as const) {
  route('PUT', `/api/settings/${section}`, async ({ env, body }) => {
    const current = await loadSettings(env.DB);
    const next =
      section === 'general' ? validateGeneral(body, current.general) : section === 'smtp' ? validateSmtp(body, current.smtp) : validateWasend(body, current.wasend);
    await saveSettingStmt(env.DB, section, next).run();
    return json(maskSettings({ ...current, [section]: next }));
  });
}

for (const channel of ['email', 'push', 'wasend'] as const) {
  route('POST', `/api/settings/test/${channel}`, async ({ env, body }) => {
    const settings = await loadSettings(env.DB);
    const result = await sendTest(env.DB, channel as Channel, settings, typeof body.endpoint === 'string' ? body.endpoint : undefined);
    return json(result);
  });
}

/* ------------------------------------------------------------------ web push */

route('GET', '/api/push/key', async ({ env }) => json({ public_key: (await getVapidKeys(env.DB)).publicKey }));

route('POST', '/api/push/subscribe', async ({ env, body, url }) => {
  const sub = body.subscription as { endpoint?: string; keys?: { p256dh?: string; auth?: string } } | undefined;
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth || !/^https:\/\//.test(sub.endpoint)) throw new HttpError(400, 'Invalid push subscription');
  const label = typeof body.label === 'string' ? body.label.slice(0, 100) : null;
  const row = await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, label = ?4, last_error = NULL RETURNING id`,
  )
    .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, label, Date.now())
    .first<{ id: number }>();
  await saveSettingStmt(env.DB, 'app_url', url.origin).run();
  return json({ ok: true, id: row?.id });
});

route('POST', '/api/push/unsubscribe', async ({ env, body }) => {
  if (typeof body.endpoint !== 'string') throw new HttpError(400, 'endpoint is required');
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(body.endpoint).run();
  return json({ ok: true });
});

route('DELETE', '/api/push/devices/:id', async ({ env, params }) => {
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(Number(params[0])).run();
  return json({ ok: true });
});
