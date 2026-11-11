// Small UI toolkit: safe HTML templating, icons, formatting, stats, toasts and dialogs.

/* ------------------------------------------------------------ templating */

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s));
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderValue(v) {
  if (v == null || v === false || v === true) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return esc(v);
}

/** Tagged template: interpolations are escaped unless wrapped in raw() or produced by html``. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------ icons */

const ICONS = {
  pulse: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
};

export const icon = (name, cls = '') => raw(`<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`);

/* ------------------------------------------------------------ formatting */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const TIME = { MIN, HOUR, DAY };

export function fmtDuration(ms, { short = false } = {}) {
  if (ms == null || !isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return short || s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

export function fmtInterval(seconds) {
  if (seconds % 86400 === 0) return seconds === 86400 ? '24h' : `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function fmtAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const d = now - ts;
  if (d < 10_000) return 'just now';
  if (d < MIN) return `${Math.round(d / 1000)}s ago`;
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  return `${Math.floor(d / DAY)}d ago`;
}

const dtf = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dtfShort = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dfDay = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const tfTime = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDateTime = (ts) => (ts ? dtf.format(ts) : '—');
export const fmtDateShort = (ts) => (ts ? dtfShort.format(ts) : '—');
export const fmtDay = (ts) => dfDay.format(ts);
export const fmtTime = (ts) => tfTime.format(ts);

export const fmtMs = (ms) => (ms == null ? '—' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)} ms`);

export function fmtPct(p) {
  if (p == null || !isFinite(p)) return '—';
  if (p >= 100) return '100%';
  // floor so that any downtime never displays as 100%
  const f = Math.floor(p * 100) / 100;
  return `${f.toFixed(2)}%`;
}

export function pctClass(p) {
  if (p == null) return 'faint';
  if (p >= 99.9) return 'c-up';
  if (p >= 99) return 'c-minor';
  if (p >= 95) return 'c-warn';
  return 'c-down';
}

export const fmtBytes = (b) => {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
};

export const fmtNum = (n) => (n == null ? '—' : Math.round(n).toLocaleString());

/* ------------------------------------------------------------ monitor status */

/** Visual state: up | down | retrying | pending | paused */
export function stateOf(m) {
  if (!m.active) return 'paused';
  if (m.status === 'down') return 'down';
  if (m.fail_streak > 0) return 'retrying';
  if (m.status === 'up') return 'up';
  return 'pending';
}

export function statusLabel(m, now = Date.now()) {
  const s = stateOf(m);
  const since = m.status_since ? fmtDuration(now - m.status_since, { short: true }) : '';
  switch (s) {
    case 'up':
      return since ? `Up ${since}` : 'Up';
    case 'down':
      return since ? `Down ${since}` : 'Down';
    case 'retrying':
      return `Failing ${m.fail_streak}/${m.retries}`;
    case 'paused':
      return 'Paused';
    default:
      return 'Pending';
  }
}

export const statusPill = (m, now) => html`<span class="pill ${stateOf(m)}"><span class="dot ${stateOf(m)}"></span>${statusLabel(m, now)}</span>`;

/* ------------------------------------------------------------ stats (computed in the browser) */

/** incidents: [{started_at, resolved_at}] */
export function downtimeBetween(incidents, from, to, now = Date.now()) {
  let total = 0;
  for (const i of incidents) {
    const s = Math.max(i.started_at, from);
    const e = Math.min(i.resolved_at ?? now, to);
    if (e > s) total += e - s;
  }
  return total;
}

export function uptimePct(incidents, from, to, createdAt, now = Date.now()) {
  const start = Math.max(from, createdAt);
  if (to - start <= 0) return null;
  return 100 * (1 - downtimeBetween(incidents, start, to, now) / (to - start));
}

/** Daily buckets (local time) for the uptime bars. */
export function dailyBars(incidents, createdAt, days, now = Date.now()) {
  const out = [];
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d0 = new Date(today);
    d0.setDate(today.getDate() - i);
    const d1 = new Date(d0);
    d1.setDate(d0.getDate() + 1);
    const from = d0.getTime();
    const to = Math.min(d1.getTime(), now);
    if (to <= createdAt) {
      out.push({ from, pct: null, down: 0, count: 0 });
      continue;
    }
    const start = Math.max(from, createdAt);
    const down = downtimeBetween(incidents, start, to, now);
    const count = incidents.filter((x) => x.started_at < to && (x.resolved_at ?? now) > start).length;
    out.push({ from, pct: 100 * (1 - down / Math.max(1, to - start)), down, count });
  }
  return out;
}

export function barClass(pct) {
  if (pct == null) return '';
  if (pct >= 99.99) return 'up';
  if (pct >= 99) return 'minor';
  if (pct >= 95) return 'warn';
  return 'down';
}

export function incidentStats(incidents, now = Date.now()) {
  const resolved = incidents.filter((i) => i.resolved_at);
  const durations = resolved.map((i) => i.resolved_at - i.started_at);
  const acked = incidents.filter((i) => i.acknowledged_at);
  const sum = (a) => a.reduce((n, x) => n + x, 0);
  return {
    count: incidents.length,
    open: incidents.length - resolved.length,
    mttr: durations.length ? sum(durations) / durations.length : null,
    longest: incidents.length ? Math.max(...incidents.map((i) => (i.resolved_at ?? now) - i.started_at)) : null,
    downtime: sum(incidents.map((i) => (i.resolved_at ?? now) - i.started_at)),
    mtta: acked.length ? sum(acked.map((i) => i.acknowledged_at - (i.detected_at ?? i.started_at))) / acked.length : null,
    mttd: incidents.length ? sum(incidents.map((i) => (i.detected_at ?? i.started_at) - i.started_at)) / incidents.length : null,
  };
}

/* ------------------------------------------------------------ toasts & dialogs */

export function toast(message, type = 'ok', ms = 4200) {
  let box = $('.toasts');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toasts';
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info')}<div>${esc(message)}</div>`;
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

export function modal({ title, body = '', confirmText = 'OK', cancelText = 'Cancel', danger = false, content = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = `
      <form method="dialog">
        <div class="body"><h2>${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ''}<div class="modal-content"></div></div>
        <div class="foot">
          ${cancelText ? `<button class="btn" value="cancel" type="submit">${esc(cancelText)}</button>` : ''}
          <button class="btn ${danger ? 'danger' : 'primary'}" value="ok" type="submit">${esc(confirmText)}</button>
        </div>
      </form>`;
    if (content) $('.modal-content', dlg).innerHTML = String(content);
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      const data = ok ? Object.fromEntries(new FormData($('form', dlg))) : null;
      dlg.remove();
      resolve(ok ? data : null);
    });
    dlg.showModal();
    $('textarea, input', dlg)?.focus();
  });
}

export const confirmDialog = (opts) => modal(opts).then((r) => r !== null);

/** Shows a floating tooltip near the pointer for elements carrying data-tip. */
export function enableTips(root) {
  let tip;
  const show = (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t || !root.contains(t)) return hide();
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'tip';
      document.body.append(tip);
    }
    tip.innerHTML = t.dataset.tip;
    const r = tip.getBoundingClientRect();
    const x = Math.min(window.innerWidth - r.width - 8, Math.max(8, e.clientX - r.width / 2));
    const y = e.clientY - r.height - 14 < 8 ? e.clientY + 18 : e.clientY - r.height - 14;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };
  const hide = () => {
    tip?.remove();
    tip = null;
  };
  root.addEventListener('pointermove', show);
  root.addEventListener('pointerleave', hide);
  return hide;
}

/** Marks a button busy while an async action runs. */
export async function busy(btn, fn) {
  if (!btn) return fn();
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

export function downloadCsv(filename, rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const isoLocal = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const loadingPage = () =>
  html`<div class="page loading-page"><div class="skeleton" style="height:34px;width:220px"></div><div class="skeleton" style="height:92px"></div><div class="skeleton" style="height:320px"></div></div>`;
