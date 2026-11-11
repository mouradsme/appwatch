import { del, get, patch, post } from '../api.js';
import { responseChart, uptimeBars } from '../charts.js';
import {
  $,
  busy,
  confirmDialog,
  dailyBars,
  downloadCsv,
  downtimeBetween,
  enableTips,
  esc,
  fmtAgo,
  fmtDateShort,
  fmtDateTime,
  fmtDuration,
  fmtInterval,
  fmtMs,
  fmtPct,
  html,
  icon,
  incidentStats,
  isoLocal,
  modal,
  pctClass,
  stateOf,
  statusPill,
  TIME,
  toast,
  uptimePct,
} from '../ui.js';

const RANGES = [
  ['24h', '24 hours', TIME.DAY],
  ['7d', '7 days', 7 * TIME.DAY],
  ['30d', '30 days', 30 * TIME.DAY],
  ['90d', '90 days', 90 * TIME.DAY],
];

const EVENT_TEXT = {
  created: 'Monitor created',
  updated: 'Configuration changed',
  paused: 'Monitoring paused',
  resumed: 'Monitoring resumed',
  deleted: 'Monitor deleted',
};

const FIELD_LABEL = {
  interval_s: 'interval',
  down_interval_s: 'interval while failing',
  timeout_ms: 'timeout',
  retries: 'retries',
  expected_status: 'expected status',
  follow_redirects: 'follow redirects',
  notify_email: 'email alerts',
  notify_push: 'push alerts',
  notify_wasend: 'WhatsApp alerts',
  keyword_mode: 'keyword mode',
  email_to: 'email recipients',
  wasend_to: 'WhatsApp numbers',
};

const CHANNEL_NAME = { email: 'Email', wasend: 'WhatsApp', push: 'Push' };

function fmtField(k, v) {
  if (v == null || v === '') return '—';
  if (k === 'interval_s' || k === 'down_interval_s') return fmtInterval(v);
  if (k === 'timeout_ms') return `${v / 1000}s`;
  if (k.startsWith('notify_') || k === 'follow_redirects') return v ? 'on' : 'off';
  if (k === 'email_to' || k === 'wasend_to') return v || 'defaults';
  return String(v);
}

export async function mount(el, [id], app) {
  let d = null;
  let range = '24h';
  let failedOnly = false;
  let checks = [];
  let nextCursor = null;
  let disposeChart = null;

  el.innerHTML = String(html`
    <a class="back" href="#/">${icon('back')}All monitors</a>
    <div id="head"></div>
    <div id="hero"></div>
    <div class="kpis" id="kpis"></div>
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <div><h2>Response time</h2><div class="sub">Average with min–max band. Red marks are failed checks, shaded areas are outages.</div></div>
          <div class="segmented" id="ranges">${RANGES.map(([k, label]) => html`<button data-range="${k}" class="${k === range ? 'active' : ''}">${label}</button>`)}</div>
        </div>
        <div class="card-body"><div class="chart" id="chart"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Uptime · last 90 days</h2><div class="sub" id="bars-sub"></div></div></div>
        <div class="card-body" id="bars"></div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><div><h2>Incidents</h2><div class="sub">Last 90 days · time to recover per outage</div></div>
            <a class="btn sm" href="#/incidents">All incidents</a></div>
          <div class="card-body tight" id="incidents"></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Activity</h2><div class="sub">Configuration changes and alerts sent</div></div></div>
          <div class="card-body tight" id="activity"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head">
          <div><h2>Check log</h2><div class="sub">Every check is recorded</div></div>
          <div class="row wrap">
            <label class="switch small"><input type="checkbox" id="failed-only" />Failures only</label>
            <select class="select" id="export-range" style="width:auto;min-height:28px;height:28px;padding-top:2px;padding-bottom:2px">
              <option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="0">Everything</option>
            </select>
            <button class="btn sm" id="export">${icon('download')}Export CSV</button>
          </div>
        </div>
        <div class="card-body tight" id="checks"></div>
      </div>
    </div>`);

  const hideTip = enableTips(el);

  async function loadSummary() {
    d = await get(`/api/monitors/${id}`);
    renderSummary();
  }

  function renderSummary() {
    const m = d.monitor;
    const now = d.now;
    const state = stateOf(m);
    const inc = d.incidents;

    $('#head', el).innerHTML = String(html`
      <div class="detail-head">
        <div style="min-width:0">
          <div class="detail-title"><span class="dot ${state}"></span><h1>${m.name}</h1>${statusPill(m, now)}</div>
          <div class="detail-meta">
            <span class="tag">${m.type === 'tcp' ? 'TCP' : m.method}</span>
            ${m.type === 'http' ? html`<a href="${m.target}" target="_blank" rel="noopener noreferrer">${m.target}</a>` : html`<span class="mono">${m.target}</span>`}
            <span>${icon('clock')} every ${fmtInterval(m.interval_s)}${m.down_interval_s < m.interval_s ? ` · ${fmtInterval(m.down_interval_s)} while failing` : ''}</span>
            <span>timeout ${m.timeout_ms / 1000}s</span>
            <span>alert after ${m.retries} failed check${m.retries > 1 ? 's' : ''}</span>
            ${m.keyword ? html`<span>keyword ${m.keyword_mode === 'not_contains' ? 'must not contain' : 'must contain'} “${m.keyword}”</span>` : ''}
          </div>
          ${(m.notify_email && m.email_to) || (m.notify_wasend && m.wasend_to)
            ? html`<div class="detail-meta">
                ${m.notify_email && m.email_to ? html`<span title="Email recipients for this monitor">${icon('mail')} ${m.email_to}</span>` : ''}
                ${m.notify_wasend && m.wasend_to ? html`<span title="WhatsApp numbers for this monitor">${icon('chat')} ${m.wasend_to}</span>` : ''}
              </div>`
            : ''}
        </div>
        <div class="actions">
          <button class="btn" data-action="check" ${m.active ? '' : 'disabled'}>${icon('refresh')}Check now</button>
          ${m.active ? html`<button class="btn" data-action="pause">${icon('pause')}Pause</button>` : html`<button class="btn" data-action="resume">${icon('play')}Resume</button>`}
          <button class="btn" data-action="test-alert" title="Send a test alert to this monitor's recipients">${icon('bell')}Test alert</button>
          <a class="btn" href="#/monitors/${m.id}/edit">${icon('edit')}Edit</a>
          <button class="btn danger icon-only" data-action="delete" title="Delete monitor" aria-label="Delete monitor">${icon('trash')}</button>
        </div>
      </div>`);

    const last = d.last;
    const open = inc.find((i) => !i.resolved_at);
    let big;
    let sub;
    let ring;
    switch (state) {
      case 'up':
        big = `Up for ${fmtDuration(now - (m.status_since ?? now))}`;
        sub = last ? `Last checked ${fmtAgo(last.t, now)} · ${fmtMs(last.ms)}${last.code ? ` · HTTP ${last.code}` : ''}` : '';
        ring = 'check';
        break;
      case 'down':
        big = `Down for ${fmtDuration(now - (open?.started_at ?? m.status_since ?? now))}`;
        sub = `${last?.error ?? open?.cause ?? 'Unknown error'} · checking every ${fmtInterval(Math.min(m.down_interval_s, m.interval_s))} until it recovers`;
        ring = 'x';
        break;
      case 'retrying':
        big = `Failing — ${m.fail_streak} of ${m.retries} checks before alerting`;
        sub = last?.error ?? '';
        ring = 'alert';
        break;
      case 'paused':
        big = 'Monitoring paused';
        sub = 'No checks are running. Resume to start checking again.';
        ring = 'pause';
        break;
      default:
        big = 'Waiting for the first check';
        sub = 'Checks start within a minute. Use “Check now” to test immediately.';
        ring = 'clock';
    }
    $('#hero', el).innerHTML = String(html`
      <div class="card status-hero ${state}">
        <div class="ring">${icon(ring)}</div>
        <div style="min-width:0"><div class="big">${big}</div><div class="muted" style="word-break:break-word">${sub}</div></div>
      </div>`);

    const up = (ms) => uptimePct(inc, now - ms, now, m.created_at, now);
    const st30 = incidentStats(inc.filter((i) => i.started_at >= now - 30 * TIME.DAY), now);
    const st90 = incidentStats(inc, now);
    const s24 = d.stats24h;
    const all = d.allTime;
    $('#kpis', el).innerHTML = String(html`
      ${[
        ['24 hours', up(TIME.DAY)],
        ['7 days', up(7 * TIME.DAY)],
        ['30 days', up(30 * TIME.DAY)],
        ['90 days', up(90 * TIME.DAY)],
      ].map(([k, v]) => html`<div class="kpi"><div class="label">Uptime · ${k}</div><div class="value ${pctClass(v)}">${fmtPct(v)}</div></div>`)}
      <div class="kpi"><div class="label">Avg response · 24h</div><div class="value">${fmtMs(s24.avg)}</div>
        <div class="foot">p95 ${fmtMs(s24.p95)} · max ${fmtMs(s24.max)}</div></div>
      <div class="kpi"><div class="label">Checks · 24h</div><div class="value">${s24.n}</div>
        <div class="foot">${s24.n - s24.up ? html`<span class="c-down">${s24.n - s24.up} failed</span>` : 'none failed'}</div></div>
      <div class="kpi"><div class="label">Incidents · 30 days</div><div class="value">${st30.count}</div>
        <div class="foot">${all.n} all time</div></div>
      <div class="kpi"><div class="label">Mean time to recover</div><div class="value">${fmtDuration(st30.mttr ?? st90.mttr)}</div>
        <div class="foot">all time ${fmtDuration(all.mttr)}</div></div>
      <div class="kpi"><div class="label">Longest outage</div><div class="value">${fmtDuration(st90.longest)}</div>
        <div class="foot">all time ${fmtDuration(all.longest)}</div></div>
      <div class="kpi"><div class="label">Downtime · 30 days</div><div class="value">${fmtDuration(downtimeBetween(inc, now - 30 * TIME.DAY, now, now))}</div>
        <div class="foot">all time ${fmtDuration(all.downtime)}</div></div>`);

    const days = dailyBars(inc, m.created_at, 90, now);
    $('#bars-sub', el).textContent = `${fmtPct(up(90 * TIME.DAY))} uptime · ${st90.count} incident${st90.count === 1 ? '' : 's'} · ${fmtDuration(st90.downtime)} total downtime`;
    $('#bars', el).innerHTML = String(html`${uptimeBars(days, { large: true })}<div class="bars-legend"><span>90 days ago</span><span>Today</span></div>`);

    $('#incidents', el).innerHTML = inc.length
      ? String(html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Started</th><th>Time to recover</th><th>Cause</th><th></th></tr></thead>
          <tbody>${inc.slice(0, 15).map(
            (i) => html`<tr>
              <td class="nowrap">${fmtDateShort(i.started_at)}</td>
              <td class="nowrap num">${i.resolved_at ? fmtDuration(i.resolved_at - i.started_at) : html`<span class="pill down"><span class="dot down"></span>Ongoing · ${fmtDuration(now - i.started_at)}</span>`}</td>
              <td><div class="err">${i.cause ?? '—'}</div>${i.notes ? html`<div class="small muted" style="margin-top:4px;white-space:pre-wrap">${i.notes}</div>` : ''}</td>
              <td class="r nowrap">
                ${i.acknowledged_at ? html`<span class="small faint" title="Acknowledged ${fmtDateTime(i.acknowledged_at)}">${icon('check')}</span>` : html`<button class="btn sm" data-ack="${i.id}">Ack</button>`}
                <button class="btn sm ghost icon-only" data-note="${i.id}" title="Notes" aria-label="Edit notes">${icon('edit')}</button>
              </td></tr>`,
          )}</tbody></table></div>`)
      : String(html`<div class="empty">${icon('shield')}<div class="big">No incidents</div><div>No outages recorded in the last 90 days.</div></div>`);
  }

  async function loadChart() {
    const spec = RANGES.find((r) => r[0] === range);
    const now = Date.now();
    const from = Math.max(now - spec[2], (d?.monitor.created_at ?? 0) - 60_000);
    const data = await get(`/api/monitors/${id}/series?from=${Math.floor(from)}&to=${now}&buckets=${range === '24h' ? 144 : 180}`);
    data.intervalMs = (d?.monitor.interval_s ?? 60) * 1000;
    disposeChart?.();
    disposeChart = responseChart($('#chart', el), data);
  }

  async function loadChecks(append = false) {
    const qs = new URLSearchParams({ limit: '25' });
    if (append && nextCursor) qs.set('before', String(nextCursor));
    if (failedOnly) qs.set('failed', '1');
    const res = await get(`/api/monitors/${id}/checks?${qs}`);
    checks = append ? checks.concat(res.checks) : res.checks;
    nextCursor = res.next;
    $('#checks', el).innerHTML = checks.length
      ? String(html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Time</th><th>Result</th><th class="r">Response</th><th>Status</th><th>Details</th></tr></thead>
          <tbody>${checks.map(
            (c) => html`<tr>
              <td class="nowrap num">${fmtDateTime(c.t)}</td>
              <td>${c.ok ? html`<span class="pill up">${icon('check')}OK</span>` : html`<span class="pill down">${icon('x')}Failed</span>`}</td>
              <td class="r num nowrap">${fmtMs(c.ms)}</td>
              <td class="num">${c.code ?? '—'}</td>
              <td>${c.error ? html`<div class="err">${c.error}</div>` : html`<span class="faint">—</span>`}</td></tr>`,
          )}</tbody></table></div>
          ${nextCursor ? html`<div class="load-more"><button class="btn sm" data-action="more">Load older checks</button></div>` : ''}`)
      : String(html`<div class="empty">${failedOnly ? 'No failed checks recorded.' : 'No checks recorded yet.'}</div>`);
  }

  async function loadActivity() {
    const [ev, notif] = await Promise.all([get(`/api/monitors/${id}/events?limit=30`), get(`/api/notifications?monitor_id=${id}&limit=30`)]);
    const items = [
      ...ev.events.map((e) => ({ at: e.at, kind: 'event', e })),
      ...notif.notifications.map((n) => ({ at: n.at, kind: 'notif', n })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, 30);
    const CH = { email: ['mail', 'Email'], push: ['phone', 'Push'], wasend: ['chat', 'WhatsApp'] };
    $('#activity', el).innerHTML = items.length
      ? String(html`<ul class="timeline">${items.map((it) => {
          if (it.kind === 'event') {
            let detail = '';
            if (it.e.type === 'updated' && it.e.detail) {
              try {
                const ch = JSON.parse(it.e.detail);
                detail = Object.entries(ch)
                  .map(([k, [a, b]]) => (a === '(changed)' ? `${FIELD_LABEL[k] ?? k} changed` : `${FIELD_LABEL[k] ?? k}: ${fmtField(k, a)} → ${fmtField(k, b)}`))
                  .join(' · ');
              } catch {
                /* ignore */
              }
            }
            return html`<li>${icon(it.e.type === 'paused' ? 'pause' : it.e.type === 'resumed' ? 'play' : 'edit')}
              <div class="what">${EVENT_TEXT[it.e.type] ?? it.e.type}${detail ? html`<div class="small muted">${detail}</div>` : ''}</div>
              <div class="when">${fmtDateShort(it.at)}</div></li>`;
          }
          const [ic, label] = CH[it.n.channel] ?? ['bell', it.n.channel];
          return html`<li>${icon(ic)}
            <div class="what">${label} alert · <b>${it.n.event}</b> ${it.n.success ? html`<span class="c-up">sent</span>` : html`<span class="c-down">failed</span>`}
              ${it.n.success ? '' : html`<div class="small err">${it.n.detail}</div>`}</div>
            <div class="when">${fmtDateShort(it.at)}</div></li>`;
        })}</ul>`)
      : String(html`<div class="empty">No activity yet.</div>`);
  }

  async function exportCsv(btn) {
    const days = Number($('#export-range', el).value);
    const after = days ? Date.now() - days * TIME.DAY : 0;
    const rows = [['time', 'time_iso_utc', 'ok', 'response_ms', 'status_code', 'error']];
    let before = null;
    await busy(btn, async () => {
      for (let page = 0; page < 300; page++) {
        const qs = new URLSearchParams({ limit: '1000', after: String(after) });
        if (before) qs.set('before', String(before));
        if (failedOnly) qs.set('failed', '1');
        const res = await get(`/api/monitors/${id}/checks?${qs}`);
        for (const c of res.checks) rows.push([isoLocal(c.t), new Date(c.t).toISOString(), c.ok ? 1 : 0, c.ms ?? '', c.code ?? '', c.error ?? '']);
        if (!res.next) break;
        before = res.next;
      }
    });
    const slug = d.monitor.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `monitor-${id}`;
    downloadCsv(`${slug}-checks.csv`, rows);
    toast(`Exported ${rows.length - 1} checks`);
  }

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-range]');
    if (!t) return;
    if (t.dataset.range) {
      range = t.dataset.range;
      el.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('active', b === t));
      return loadChart();
    }
    if (t.dataset.ack) {
      await patch(`/api/incidents/${t.dataset.ack}`, { acknowledged: true });
      toast('Incident acknowledged');
      return loadSummary();
    }
    if (t.dataset.note) {
      const inc = d.incidents.find((i) => String(i.id) === t.dataset.note);
      const res = await modal({
        title: 'Incident notes',
        body: 'What happened and how it was fixed. Saved with the incident record.',
        confirmText: 'Save notes',
        content: html`<textarea class="textarea" name="notes" style="margin-top:12px;font-family:var(--font);font-size:13px" rows="5">${inc?.notes ?? ''}</textarea>`,
      });
      if (res) {
        await patch(`/api/incidents/${t.dataset.note}`, { notes: res.notes });
        toast('Notes saved');
        loadSummary();
      }
      return;
    }
    switch (t.dataset.action) {
      case 'check':
        return busy(t, async () => {
          const res = await post(`/api/monitors/${id}/check`);
          const r = res.result;
          toast(r.ok ? `Check passed · ${fmtMs(r.ms)}${r.code ? ` · HTTP ${r.code}` : ''}` : `Check failed: ${r.error}`, r.ok ? 'ok' : 'err', 6000);
          await Promise.all([loadSummary(), loadChecks(), loadChart(), loadActivity()]);
        });
      case 'test-alert':
        return busy(t, async () => {
          const { results } = await post(`/api/monitors/${id}/test-alert`);
          await modal({
            title: 'Test alert',
            cancelText: '',
            confirmText: 'Close',
            content: results.length
              ? html`<div class="test-results">${results.map(
                  (r) => html`<div class="callout ${r.ok ? 'ok' : 'bad'}">
                    <b>${r.ok ? '✓' : '✗'} ${CHANNEL_NAME[r.channel] ?? r.channel}${r.recipients.length ? html` → ${r.recipients.join(', ')}` : ''}</b>
                    <span class="small result-line">${r.detail}</span></div>`,
                )}</div>`
              : html`<p style="margin-top:12px">No alert channel is enabled for this monitor. Edit the monitor to turn on email, WhatsApp or push.</p>`,
          });
          loadActivity();
        });
      case 'pause':
        if (!(await confirmDialog({ title: 'Pause monitoring?', body: 'No checks will run and no alerts will be sent. An open incident is closed.', confirmText: 'Pause' }))) return;
        await post(`/api/monitors/${id}/pause`);
        toast('Monitoring paused');
        return Promise.all([loadSummary(), loadActivity()]);
      case 'resume':
        await post(`/api/monitors/${id}/resume`);
        toast('Monitoring resumed – first check within a minute');
        return Promise.all([loadSummary(), loadActivity()]);
      case 'delete':
        if (
          !(await confirmDialog({
            title: `Delete “${d.monitor.name}”?`,
            body: 'The monitor disappears immediately. Its check history, incidents and alerts are purged in the background over the next hours.',
            confirmText: 'Delete monitor',
            danger: true,
          }))
        )
          return;
        await del(`/api/monitors/${id}`);
        toast('Monitor deleted');
        return app.go('/');
      case 'more':
        return busy(t, () => loadChecks(true));
    }
  });
  $('#failed-only', el).addEventListener('change', (e) => {
    failedOnly = e.target.checked;
    loadChecks();
  });
  $('#export', el).addEventListener('click', (e) => exportCsv(e.currentTarget));

  await loadSummary();
  await Promise.all([loadChart(), loadChecks(), loadActivity()]);

  const timer = setInterval(() => {
    if (!document.hidden) loadSummary().catch(() => {});
  }, 60_000);
  return () => {
    clearInterval(timer);
    disposeChart?.();
    hideTip();
  };
}
