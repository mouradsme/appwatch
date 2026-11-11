-- AppWatch initial schema.
-- Timestamps are Unix epoch milliseconds (UTC).
-- Written with the D1 free tier in mind (100k rows written/day): a healthy check costs one row write.

CREATE TABLE IF NOT EXISTS monitors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  type             TEXT    NOT NULL DEFAULT 'http',      -- http | tcp
  target           TEXT    NOT NULL,                     -- URL for http, host:port for tcp
  method           TEXT    NOT NULL DEFAULT 'GET',
  headers          TEXT,                                 -- JSON object of request headers
  body             TEXT,
  expected_status  TEXT    NOT NULL DEFAULT '200-399',   -- e.g. "200-299,301,404"
  keyword          TEXT,
  keyword_mode     TEXT    NOT NULL DEFAULT 'contains',  -- contains | not_contains
  follow_redirects INTEGER NOT NULL DEFAULT 1,
  timeout_ms       INTEGER NOT NULL DEFAULT 10000,
  interval_s       INTEGER NOT NULL DEFAULT 300,         -- polling interval while healthy
  down_interval_s  INTEGER NOT NULL DEFAULT 60,          -- polling interval while failing / down
  retries          INTEGER NOT NULL DEFAULT 2,           -- consecutive failures before DOWN is declared
  notify_email     INTEGER NOT NULL DEFAULT 1,
  notify_push      INTEGER NOT NULL DEFAULT 1,
  notify_wasend    INTEGER NOT NULL DEFAULT 1,
  active           INTEGER NOT NULL DEFAULT 1,
  deleted_at       INTEGER,                              -- soft delete; data is purged gradually
  -- runtime state (only written when it changes)
  status           TEXT    NOT NULL DEFAULT 'pending',   -- pending | up | down
  status_since     INTEGER,
  fail_streak      INTEGER NOT NULL DEFAULT 0,
  first_fail_at    INTEGER,
  open_incident_id INTEGER,
  last_alert_at    INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Every check ever run. Clustered on (monitor, time) so range scans read only what they need
-- and an insert costs a single row write (no secondary index).
CREATE TABLE IF NOT EXISTS checks (
  monitor_id  INTEGER NOT NULL,
  checked_at  INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  response_ms INTEGER,
  status_code INTEGER,
  error       TEXT,
  PRIMARY KEY (monitor_id, checked_at)
) WITHOUT ROWID;

-- One row per outage. started_at = first failed check, resolved_at = first successful check after it.
CREATE TABLE IF NOT EXISTS incidents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id      INTEGER NOT NULL,
  started_at      INTEGER NOT NULL,
  detected_at     INTEGER NOT NULL,   -- when DOWN was confirmed and alerts went out
  resolved_at     INTEGER,
  duration_ms     INTEGER,
  cause           TEXT,
  status_code     INTEGER,
  failed_checks   INTEGER NOT NULL DEFAULT 0,
  acknowledged_at INTEGER,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents (monitor_id, started_at);
CREATE INDEX IF NOT EXISTS idx_incidents_started ON incidents (started_at);

-- Audit trail: monitor created / edited / paused / resumed / deleted / manual checks.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER,
  at         INTEGER NOT NULL,
  type       TEXT    NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_monitor ON events (monitor_id, at);

-- Every notification attempt, per channel.
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  monitor_id  INTEGER,
  incident_id INTEGER,
  channel     TEXT    NOT NULL,   -- email | push | wasend
  event       TEXT    NOT NULL,   -- down | up | reminder | test
  success     INTEGER NOT NULL,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_at ON notifications (at);
CREATE INDEX IF NOT EXISTS idx_notifications_monitor ON notifications (monitor_id, at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint        TEXT    NOT NULL UNIQUE,
  p256dh          TEXT    NOT NULL,
  auth            TEXT    NOT NULL,
  label           TEXT,
  created_at      INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error      TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip           TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
