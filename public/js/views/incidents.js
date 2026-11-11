import { get, patch } from '../api.js';
import {
  $,
  downloadCsv,
  fmtDateShort,
  fmtDateTime,
  fmtDuration,
  html,
  icon,
  incidentStats,
  isoLocal,
  modal,
  TIME,
  toast,
} from '../ui.js';

const RANGES = [
  ['1', '24 hours'],
  ['7', '7 days'],
  ['30', '30 days'],
  ['90', '90 days'],
  ['365', '1 year'],
  ['0', 'All time'],
];

export async function mount(el) {
  let days = '30';
  let monitorId = '';
  let status = '';
  let data = null;
  const { monitors } = await get('/api/monitors');

  el.innerHTML = String(html`
    <div class="page-head">
      <div><h1>Incidents</h1><div class="sub">Every outage with its cause and the time it took to fix.</div></div>
      <div class="actions"><button class="btn" id="export">${icon('download')}Export CSV</button></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="toolbar" style="border-bottom:0">
        <div class="segmented" id="ranges">${RANGES.map(([k, l]) => html`<button data-days="${k}" class="${k === days ? 'active' : ''}">${l}</button>`)}</div>
        <span class="spacer"></span>
        <select class="select" id="monitor" style="width:auto;min-width:180px" aria-label="Monitor">
          <option value="">All monitors</option>
          ${monitors.map((m) => html`<option value="${m.id}">${m.name}</option>`)}
        </select>
        <select class="select" id="status" style="width:auto" aria-label="Status">
          <option value="">Open and resolved</option><option value="open">Open only</option><option value="resolved">Resolved only</option>
        </select>
      </div>
    </div>
    <div class="kpis" id="kpis"></div>
    <div class="stack">
      <div class="card">
        <div class="card-head"><div><h2>By monitor</h2><div class="sub">Downtime and time to recover per server in the selected period</div></div></div>
        <div class="card-body tight" id="by-monitor"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Incident log</h2><div class="sub" id="log-sub"></div></div></div>
        <div class="card-body tight" id="list"></div>
      </div>
    </div>`);

  async function load() {
    const now = Date.now();
    const qs = new URLSearchParams({ limit: '1000' });
    qs.set('from', days === '0' ? '0' : String(now - Number(days) * TIME.DAY));
    if (monitorId) qs.set('monitor_id', monitorId);
    if (status) qs.set('status', status);
    data = await get(`/api/incidents?${qs}`);
    render();
  }

  function render() {
    const now = data.now;
    const inc = data.incidents;
    const st = incidentStats(inc, now);
    $('#kpis', el).innerHTML = String(html`
      <div class="kpi"><div class="label">${icon('alert')}Incidents</div><div class="value">${st.count}</div>
        <div class="foot">${st.open ? html`<span class="c-down">${st.open} open</span>` : 'none open'}</div></div>
      <div class="kpi"><div class="label">${icon('wrench')}Mean time to recover</div><div class="value">${fmtDuration(st.mttr)}</div><div class="foot">first failure → back up</div></div>
      <div class="kpi"><div class="label">${icon('zap')}Mean time to detect</div><div class="value">${fmtDuration(st.mttd)}</div><div class="foot">first failure → alert</div></div>
      <div class="kpi"><div class="label">${icon('check')}Mean time to acknowledge</div><div class="value">${fmtDuration(st.mtta)}</div><div class="foot">alert → acknowledged</div></div>
      <div class="kpi"><div class="label">${icon('clock')}Longest outage</div><div class="value">${fmtDuration(st.longest)}</div><div class="foot">&nbsp;</div></div>
      <div class="kpi"><div class="label">${icon('pulse')}Total downtime</div><div class="value">${fmtDuration(st.downtime)}</div><div class="foot">sum of all incidents</div></div>`);

    const groups = new Map();
    for (const i of inc) {
      if (!groups.has(i.monitor_id)) groups.set(i.monitor_id, { name: i.monitor_name, list: [] });
      groups.get(i.monitor_id).list.push(i);
    }
    const rows = [...groups.entries()].map(([mid, g]) => ({ id: mid, name: g.name, ...incidentStats(g.list, now), last: Math.max(...g.list.map((i) => i.started_at)) }));
    rows.sort((a, b) => b.downtime - a.downtime);
    $('#by-monitor', el).innerHTML = rows.length
      ? String(html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Monitor</th><th class="r">Incidents</th><th class="r">Total downtime</th><th class="r">Mean time to recover</th><th class="r">Longest</th><th class="r">Last incident</th></tr></thead>
          <tbody>${rows.map(
            (r) => html`<tr class="clickable" data-href="#/monitors/${r.id}">
              <td><a href="#/monitors/${r.id}">${r.name}</a>${r.open ? html` <span class="pill down" style="margin-left:6px">${r.open} open</span>` : ''}</td>
              <td class="r num">${r.count}</td><td class="r num">${fmtDuration(r.downtime)}</td><td class="r num">${fmtDuration(r.mttr)}</td>
              <td class="r num">${fmtDuration(r.longest)}</td><td class="r nowrap">${fmtDateShort(r.last)}</td></tr>`,
          )}</tbody></table></div>`)
      : String(html`<div class="empty">${icon('shield')}<div class="big">No incidents in this period</div><div>Everything stayed up.</div></div>`);

    $('#log-sub', el).textContent = `${inc.length} incident${inc.length === 1 ? '' : 's'}${data.next ? ' (showing the latest 1000)' : ''}`;
    $('#list', el).innerHTML = inc.length
      ? String(html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Status</th><th>Monitor</th><th>Started</th><th>Resolved</th><th class="r">Time to recover</th><th>Cause</th><th></th></tr></thead>
          <tbody>${inc.map(
            (i) => html`<tr>
              <td>${i.resolved_at ? html`<span class="pill up">Resolved</span>` : html`<span class="pill down"><span class="dot down"></span>Open</span>`}</td>
              <td class="nowrap"><a href="#/monitors/${i.monitor_id}">${i.monitor_name}</a></td>
              <td class="nowrap" title="Alert sent ${fmtDateTime(i.detected_at)}">${fmtDateTime(i.started_at)}</td>
              <td class="nowrap">${i.resolved_at ? fmtDateTime(i.resolved_at) : '—'}</td>
              <td class="r num nowrap">${i.resolved_at ? fmtDuration(i.resolved_at - i.started_at) : html`<span class="c-down">${fmtDuration(now - i.started_at)}…</span>`}</td>
              <td><div class="err">${i.cause ?? '—'}</div>${i.notes ? html`<div class="small muted" style="margin-top:4px;white-space:pre-wrap">${i.notes}</div>` : ''}</td>
              <td class="r nowrap">
                ${i.acknowledged_at
                  ? html`<span class="small faint" title="Acknowledged ${fmtDateTime(i.acknowledged_at)}">${icon('check')} Ack</span>`
                  : html`<button class="btn sm" data-ack="${i.id}">Acknowledge</button>`}
                <button class="btn sm ghost icon-only" data-note="${i.id}" title="Notes" aria-label="Edit notes">${icon('edit')}</button>
              </td></tr>`,
          )}</tbody></table></div>`)
      : String(html`<div class="empty">No incidents match the filters.</div>`);
  }

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-days], [data-ack], [data-note], [data-href]');
    if (!t) return;
    if (t.dataset.days) {
      days = t.dataset.days;
      el.querySelectorAll('[data-days]').forEach((b) => b.classList.toggle('active', b === t));
      return load();
    }
    if (t.dataset.ack) {
      await patch(`/api/incidents/${t.dataset.ack}`, { acknowledged: true });
      toast('Incident acknowledged');
      return load();
    }
    if (t.dataset.note) {
      const inc = data.incidents.find((i) => String(i.id) === t.dataset.note);
      const res = await modal({
        title: 'Incident notes',
        body: 'Root cause, fix applied, follow-ups…',
        confirmText: 'Save notes',
        content: html`<textarea class="textarea" name="notes" style="margin-top:12px;font-family:var(--font);font-size:13px" rows="5">${inc?.notes ?? ''}</textarea>`,
      });
      if (res) {
        await patch(`/api/incidents/${t.dataset.note}`, { notes: res.notes });
        toast('Notes saved');
        load();
      }
      return;
    }
    if (t.dataset.href && !e.target.closest('a')) location.hash = t.dataset.href;
  });
  $('#monitor', el).addEventListener('change', (e) => {
    monitorId = e.target.value;
    load();
  });
  $('#status', el).addEventListener('change', (e) => {
    status = e.target.value;
    load();
  });
  $('#export', el).addEventListener('click', () => {
    const now = data.now;
    const rows = [
      ['incident_id', 'monitor', 'target', 'started', 'detected', 'resolved', 'time_to_recover_seconds', 'time_to_recover', 'failed_checks', 'cause', 'http_status', 'acknowledged', 'notes'],
      ...data.incidents.map((i) => [
        i.id,
        i.monitor_name,
        i.monitor_target,
        isoLocal(i.started_at),
        isoLocal(i.detected_at),
        i.resolved_at ? isoLocal(i.resolved_at) : '',
        Math.round(((i.resolved_at ?? now) - i.started_at) / 1000),
        fmtDuration((i.resolved_at ?? now) - i.started_at),
        i.failed_checks,
        i.cause ?? '',
        i.status_code ?? '',
        i.acknowledged_at ? isoLocal(i.acknowledged_at) : '',
        i.notes ?? '',
      ]),
    ];
    downloadCsv(`incidents-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  });

  await load();
  const timer = setInterval(() => {
    if (!document.hidden) load().catch(() => {});
  }, 60_000);
  return () => clearInterval(timer);
}
