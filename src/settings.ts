import { normalizePhone, WASEND_PHONE_RE } from './notify/wasend';
import type { AllSettings, GeneralSettings, SmtpSettings, WasendSettings } from './types';
import { HttpError, splitList } from './util';

export const DEFAULT_GENERAL: GeneralSettings = {
  app_name: 'AppWatch',
  timezone: 'UTC',
  notify_recovery: true,
  reminder_minutes: 0,
  retention_days: 365,
  contact_email: '',
};

export const DEFAULT_SMTP: SmtpSettings = {
  enabled: false,
  host: '',
  port: 465,
  security: 'tls',
  username: '',
  password: '',
  from_email: '',
  from_name: 'AppWatch',
  to: '',
};

export const DEFAULT_WASEND: WasendSettings = {
  enabled: false,
  base_url: '',
  session: '',
  api_key: '',
  recipients: '',
};

const SECTIONS = ['general', 'smtp', 'wasend', 'app_url'] as const;

export async function loadSettings(db: D1Database): Promise<AllSettings> {
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${SECTIONS.map(() => '?').join(',')})`)
    .bind(...SECTIONS)
    .all<{ key: string; value: string }>();
  return settingsFromRows(results);
}

export function settingsFromRows(rows: { key: string; value: string }[]): AllSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const parse = <T>(key: string, def: T): T => {
    try {
      const raw = map.get(key);
      return raw ? { ...def, ...JSON.parse(raw) } : { ...def };
    } catch {
      return { ...def };
    }
  };
  return {
    general: parse('general', DEFAULT_GENERAL),
    smtp: parse('smtp', DEFAULT_SMTP),
    wasend: parse('wasend', DEFAULT_WASEND),
    app_url: map.get('app_url') ?? '',
  };
}

export function saveSettingStmt(db: D1Database, key: string, value: unknown): D1PreparedStatement {
  return db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, typeof value === 'string' ? value : JSON.stringify(value));
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/* ---------- validation (input comes from the dashboard) ---------- */

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
const int = (v: unknown, min: number, max: number, def: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function validateGeneral(input: Record<string, unknown>, current: GeneralSettings): GeneralSettings {
  const tz = str(input.timezone ?? current.timezone, 64) || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw new HttpError(400, `Unknown time zone "${tz}"`);
  }
  const contact = str(input.contact_email ?? current.contact_email, 200);
  if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw new HttpError(400, 'Contact email is not valid');
  return {
    app_name: str(input.app_name ?? current.app_name, 60) || 'AppWatch',
    timezone: tz,
    notify_recovery: bool(input.notify_recovery ?? current.notify_recovery),
    reminder_minutes: int(input.reminder_minutes ?? current.reminder_minutes, 0, 10080, 0),
    retention_days: int(input.retention_days ?? current.retention_days, 0, 3650, 365),
    contact_email: contact,
  };
}

export function validateSmtp(input: Record<string, unknown>, current: SmtpSettings): SmtpSettings {
  const security = ['tls', 'starttls', 'none'].includes(String(input.security)) ? (input.security as SmtpSettings['security']) : current.security;
  const next: SmtpSettings = {
    enabled: bool(input.enabled ?? current.enabled),
    host: str(input.host ?? current.host, 255),
    port: int(input.port ?? current.port, 1, 65535, 465),
    security,
    username: str(input.username ?? current.username, 255),
    // Empty password in the form means "keep the stored one".
    password: typeof input.password === 'string' && input.password !== '' ? input.password.slice(0, 500) : current.password,
    from_email: str(input.from_email ?? current.from_email, 255),
    from_name: str(input.from_name ?? current.from_name, 100),
    to: str(input.to ?? current.to, 2000),
  };
  if (next.port === 25) throw new HttpError(400, 'Cloudflare blocks outbound port 25. Use 465 (TLS) or 587 (STARTTLS).');
  if (next.enabled) {
    if (!next.host) throw new HttpError(400, 'SMTP host is required');
    if (!/^[^\s@]+@[^\s@]+$/.test(next.from_email)) throw new HttpError(400, 'A valid "From" address is required');
    const to = splitList(next.to);
    if (!to.length) throw new HttpError(400, 'At least one recipient is required');
    for (const r of to) if (!/^[^\s@]+@[^\s@]+$/.test(r)) throw new HttpError(400, `Invalid recipient: ${r}`);
  }
  return next;
}

export function validateWasend(input: Record<string, unknown>, current: WasendSettings): WasendSettings {
  const next: WasendSettings = {
    enabled: bool(input.enabled ?? current.enabled),
    base_url: str(input.base_url ?? current.base_url, 300).replace(/\/+$/, ''),
    session: str(input.session ?? current.session, 64),
    api_key: typeof input.api_key === 'string' && input.api_key !== '' ? input.api_key.trim().slice(0, 300) : current.api_key,
    recipients: str(input.recipients ?? current.recipients, 2000),
  };
  if (next.enabled) {
    if (!/^https?:\/\/[^\s]+$/i.test(next.base_url)) throw new HttpError(400, 'Wasend URL must start with https://');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(next.session)) throw new HttpError(400, 'Wasend session ID: 1-64 letters, digits, _ or -');
    if (!next.api_key) throw new HttpError(400, 'Wasend API key is required');
    const nums = splitList(next.recipients);
    if (!nums.length) throw new HttpError(400, 'At least one WhatsApp number is required');
    for (const n of nums) {
      if (!WASEND_PHONE_RE.test(normalizePhone(n))) {
        throw new HttpError(400, `Invalid WhatsApp number "${n}": use international format with the country code, e.g. +213555123456`);
      }
    }
  }
  return next;
}

/** Settings as sent to the browser: secrets are never returned. */
export function maskSettings(s: AllSettings) {
  return {
    general: s.general,
    smtp: { ...s.smtp, password: '', password_set: !!s.smtp.password },
    wasend: { ...s.wasend, api_key: '', api_key_set: !!s.wasend.api_key, api_key_hint: s.wasend.api_key ? s.wasend.api_key.slice(0, 6) + '…' : '' },
    app_url: s.app_url,
  };
}
