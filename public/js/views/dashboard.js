import { get } from '../api.js';
import { sparkline, uptimeBars } from '../charts.js';
import {
  $,
  dailyBars,
  downtimeBetween,
  enableTips,
  fmtAgo,
  fmtDuration,
  fmtInterval,
  fmtMs,
  fmtNum,
  fmtPct,
  fmtTime,
  html,
  icon,
  incidentStats,
  pctClass,
  stateOf,
  statusPill,
  TIME,
  uptimePct,
} from '../ui.js';

const FILTERS = [
  ['all', 'All'],
  ['down', 'Down'],
  ['up', 'Up'],
  ['paused', 'Paused'],
];

export async function mount(el, _params, app) {
  let data = null;
  let filter = 'all';
  let query = '';

  el.innerHTML = String(html`
    <div class="page-head">
      <div>
        <h1>Monitors</h1>
        <div class="sub" id="updated">Loading…</div>
      </div>
      <div class="actions">
        <button class="btn icon-only" id="refresh" title="Refresh" aria-label="Refresh">${icon('refresh')}</button>
        <a class="btn primary" href="#/monitors/new">${icon('plus')}Add monitor</a>
      </div>
    </div>
    <div id="summary"></div>
    <div class="card">
      <div class="toolbar">
        <div class="chips" id="chips"></div>
        <span class="spacer"></span>
        <label class="search"><span class="sr-only">Search monitors</span>${icon('search')}<input class="input" id="q" type="search" placeholder="Search name or URL" /></label>
      </div>
      <div class="mon-list" id="list"></div>
    </div>`);

  const hideTip = enableTips(el);

  function enrich() {
    const now = data.now;
    const byMonitor = new Map();
    for (const [id, monitor_id, started_at, resolved_at, detected_at, acknowledged_at] of data.incidents) {
      if (!byMonitor.has(monitor_id)) byMonitor.set(monitor_id, []);
      byMonitor.get(monitor_id).push({ id, monitor_id, started_at, resolved_at, detected_at, acknowledged_at });
    }
    return data.monitors.map((m) => {
      const inc = byMonitor.get(m.id) ?? [];
      const okMs = m.recent.filter((r) => r[1] && r[2] != null).map((r) => r[2]);
      return {
        ...m,
        inc,
        state: stateOf(m),
        u24: uptimePct(inc, now - TIME.DAY, now, m.created_at, now),
        u7: uptimePct(inc, now - 7 * TIME.DAY, now, m.created_at, now),
        u30: uptimePct(inc, now - 30 * TIME.DAY, now, m.created_at, now),
        days: dailyBars(inc, m.created_at, 30, now),
        avgMs: okMs.length ? okMs.reduce((a, b) => a + b, 0) / okMs.length : null,
      };
    });
  }

  let monitors = [];

  function render() {
    const now = data.now;
    monitors = enrich();
    const count = (s) => monitors.filter((m) => m.state === s).length;
    const counts = { all: monitors.length, down: count('down'), up: count('up'), paused: count('paused'), retrying: count('retrying'), pending: count('pending') };
    app.setDownCount(counts.down);
    $('#updated', el).textContent = `Updated ${fmtTime(now)} · refreshes every minute`;

    const active = monitors.filter((m) => m.active);
    const since = now - 30 * TIME.DAY;
    const all = monitors.flatMap((m) => m.inc);
    const started30 = all.filter((i) => i.started_at >= since);
    const st = incidentStats(started30, now);
    const downtime30 = monitors.reduce((n, m) => n + downtimeBetween(m.inc, since, now, now), 0);
    const ups = active.map((m) => m.u30).filter((v) => v != null);
    const uptime30 = ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : null;
    const checksPerDay = active.reduce((n, m) => n + 86400 / m.interval_s, 0);
    const downNames = monitors.filter((m) => m.state === 'down').map((m) => m.name);

    let banner = '';
    if (!monitors.length) banner = '';
    else if (counts.down)
      banner = html`<div class="banner down"><span class="dot down"></span><div>${counts.down} monitor${counts.down > 1 ? 's are' : ' is'} down
        <span class="muted">— ${downNames.slice(0, 4).join(', ')}${downNames.length > 4 ? ` +${downNames.length - 4} more` : ''}</span></div></div>`;
    else if (counts.retrying)
      banner = html`<div class="banner warn"><span class="dot retrying"></span><div>${counts.retrying} monitor${counts.retrying > 1 ? 's are' : ' is'} failing checks
        <span class="muted">— waiting for confirmation before alerting</span></div></div>`;
    else if (active.length)
      banner = html`<div class="banner up"><span class="dot up"></span><div>All systems operational
        <span class="muted">— ${active.length} active monitor${active.length > 1 ? 's' : ''}${counts.paused ? `, ${counts.paused} paused` : ''}</span></div></div>`;

    $('#summary', el).innerHTML = String(html`
      ${banner}
      ${checksPerDay > 40_000
        ? html`<div class="banner warn">${icon('database')}<div>Your polling schedule needs about ${fmtNum(checksPerDay)} checks/day.
            <span class="muted">D1's free tier allows 100,000 row writes/day — see <a href="#/settings">Settings → Free-tier usage</a>.</span></div></div>`
        : ''}
      <div class="kpis">
        <div class="kpi"><div class="label">${icon('monitor')}Monitors</div><div class="value">${active.length}<small>active</small></div>
          <div class="foot"><span class="c-up">${counts.up} up</span> · <span class="${counts.down ? 'c-down' : ''}">${counts.down} down</span> · ${counts.paused} paused</div></div>
        <div class="kpi"><div class="label">${icon('pulse')}Uptime · 30 days</div><div class="value ${pctClass(uptime30)}">${fmtPct(uptime30)}</div>
          <div class="foot">average of active monitors</div></div>
        <div class="kpi"><div class="label">${icon('alert')}Incidents · 30 days</div><div class="value">${st.count}</div>
          <div class="foot">${st.open ? html`<span class="c-down">${st.open} still open</span>` : 'none open'}</div></div>
        <div class="kpi"><div class="label">${icon('wrench')}Mean time to recover</div><div class="value">${fmtDuration(st.mttr)}</div>
          <div class="foot">time to fix, 30 days</div></div>
        <div class="kpi"><div class="label">${icon('clock')}Longest outage</div><div class="value">${fmtDuration(st.longest)}</div>
          <div class="foot">30 days</div></div>
        <div class="kpi"><div class="label">${icon('zap')}Total downtime</div><div class="value">${fmtDuration(downtime30)}</div>
          <div class="foot">all monitors, 30 days</div></div>
      </div>`);

    $('#chips', el).innerHTML = String(
      html`${FILTERS.map(
        ([k, label]) => html`<button class="chip ${filter === k ? 'active' : ''}" data-filter="${k}">${label} <span class="n">${counts[k]}</span></button>`,
      )}`,
    );
    renderList();
  }

  function renderList() {
    const now = data.now;
    const q = query.trim().toLowerCase();
    const shown = monitors.filter(
      (m) =>
        (filter === 'all' || m.state === filter) &&
        (!q || m.name.toLowerCase().includes(q) || m.target.toLowerCase().includes(q)),
    );
    const list = $('#list', el);
    if (!monitors.length) {
      list.innerHTML = String(html`<div class="empty">${icon('pulse')}<div class="big">No monitors yet</div>
        <div>Add the URL of an app or a server's host:port and AppWatch will start checking it every minute or on your own schedule.</div>
        <div style="margin-top:16px"><a class="btn primary" href="#/monitors/new">${icon('plus')}Add your first monitor</a></div></div>`);
      return;
    }
    if (!shown.length) {
      list.innerHTML = String(html`<div class="empty">No monitors match this filter.</div>`);
      return;
    }
    // Down monitors first, then failing, then the rest alphabetically.
    const rank = { down: 0, retrying: 1, pending: 2, up: 3, paused: 4 };
    shown.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
    list.innerHTML = String(
      html`${shown.map(
        (m) => html`
          <a class="mon-row" href="#/monitors/${m.id}">
            <div class="mon-name">
              <span class="dot ${m.state}"></span>
              <div style="min-width:0">
                <div class="title ellipsis">${m.name}</div>
                <div class="target ellipsis"><span class="tag">${m.type === 'tcp' ? 'TCP' : m.method}</span> ${m.target}</div>
              </div>
            </div>
            <div class="mon-bars-cell">${uptimeBars(m.days)}</div>
            <div class="mon-uptimes">
              <div><div class="v ${pctClass(m.u24)}">${fmtPct(m.u24)}</div><div class="k">24 h</div></div>
              <div><div class="v ${pctClass(m.u7)}">${fmtPct(m.u7)}</div><div class="k">7 days</div></div>
              <div><div class="v ${pctClass(m.u30)}">${fmtPct(m.u30)}</div><div class="k">30 days</div></div>
            </div>
            <div class="mon-resp">${sparkline(m.recent)}<span class="v">${fmtMs(m.avgMs)}</span></div>
            <div class="mon-meta">
              ${statusPill(m, now)}
              <span title="${m.last?.error ?? ''}">every ${fmtInterval(m.interval_s)} · ${m.last ? fmtAgo(m.last.t, now) : 'not checked yet'}</span>
            </div>
          </a>`,
      )}`,
    );
  }

  const load = async () => {
    data = await get('/api/dashboard');
    render();
  };

  el.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (chip) {
      filter = chip.dataset.filter;
      el.querySelectorAll('[data-filter]').forEach((c) => c.classList.toggle('active', c === chip));
      renderList();
    }
  });
  $('#q', el).addEventListener('input', (e) => {
    query = e.target.value;
    if (data) renderList();
  });
  $('#refresh', el).addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.classList.add('busy');
    await load().finally(() => b.classList.remove('busy'));
  });

  await load();

  let last = Date.now();
  const tick = () => {
    if (document.hidden) return;
    last = Date.now();
    load().catch(() => {});
  };
  const timer = setInterval(tick, 60_000);
  const onVis = () => {
    if (!document.hidden && Date.now() - last > 60_000) tick();
  };
  document.addEventListener('visibilitychange', onVis);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVis);
    hideTip();
  };
}
