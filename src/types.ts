declare global {
  // Secrets are set by deploy.bat (wrangler secret bulk). They are optional so the Worker can
  // explain what is missing instead of crashing.
  interface Env {
    ADMIN_PASSWORD?: string;
    SESSION_SECRET?: string;
  }
}

export type MonitorType = 'http' | 'tcp';
export type MonitorStatus = 'pending' | 'up' | 'down';

export interface MonitorRow {
  id: number;
  name: string;
  type: MonitorType;
  target: string;
  method: string;
  headers: string | null;
  body: string | null;
  expected_status: string;
  keyword: string | null;
  keyword_mode: 'contains' | 'not_contains';
  follow_redirects: number;
  timeout_ms: number;
  interval_s: number;
  down_interval_s: number;
  retries: number;
  notify_email: number;
  notify_push: number;
  notify_wasend: number;
  email_to: string | null; // per-monitor email recipients, NULL = defaults from Settings
  wasend_to: string | null; // per-monitor WhatsApp numbers, NULL = defaults from Settings
  active: number;
  deleted_at: number | null;
  status: MonitorStatus;
  status_since: number | null;
  fail_streak: number;
  first_fail_at: number | null;
  open_incident_id: number | null;
  last_alert_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CheckResult {
  t: number; // when the check started (epoch ms)
  ok: boolean;
  ms: number | null; // response time
  code: number | null; // HTTP status code
  error: string | null;
}

export interface IncidentRow {
  id: number;
  monitor_id: number;
  started_at: number;
  detected_at: number;
  resolved_at: number | null;
  duration_ms: number | null;
  cause: string | null;
  status_code: number | null;
  failed_checks: number;
  acknowledged_at: number | null;
  notes: string | null;
}

export type AlertKind = 'down' | 'up' | 'reminder';

export interface AlertEvent {
  kind: AlertKind;
  monitor: Pick<MonitorRow, 'id' | 'name' | 'target' | 'type' | 'notify_email' | 'notify_push' | 'notify_wasend' | 'email_to' | 'wasend_to'>;
  incidentId: number | null;
  at: number; // when the event happened
  startedAt: number; // when the outage started
  durationMs: number | null; // outage length (up / reminder)
  cause: string | null;
  statusCode: number | null;
}

export interface GeneralSettings {
  app_name: string;
  timezone: string;
  notify_recovery: boolean;
  reminder_minutes: number; // 0 = no repeated alerts while down
  retention_days: number; // 0 = keep checks forever
  contact_email: string; // used as the VAPID subject for web push
}

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  password: string;
  from_email: string;
  from_name: string;
  to: string; // comma separated
}

export interface WasendSettings {
  enabled: boolean;
  base_url: string;
  session: string;
  api_key: string;
  recipients: string; // comma separated E.164 numbers
}

export interface AllSettings {
  general: GeneralSettings;
  smtp: SmtpSettings;
  wasend: WasendSettings;
  app_url: string;
}
