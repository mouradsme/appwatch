import { get } from '../api.js';
import { $, busy, fmtDateTime, html, icon } from '../ui.js';

const CHANNEL = { email: ['mail', 'Email'], push: ['phone', 'Push'], wasend: ['chat', 'WhatsApp'] };
const EVENT = {
  down: ['down', 'Down'],
  up: ['up', 'Recovered'],
  reminder: ['warn', 'Still down'],
  test: ['pending', 'Test'],
};

export async function mount(el) {
  let rows = [];
  let next = null;

  el.innerHTML = String(html`
    <div class="page-head">
      <div><h1>Alert log</h1><div class="sub">Every notification AppWatch tried to send, per channel, with the delivery result.</div></div>
      <div class="actions"><button class="btn icon-only" id="refresh" title="Refresh" aria-label="Refresh">${icon('refresh')}</button></div>
    </div>
    <div class="card"><div class="card-body tight" id="list"></div></div>`);

  async function load(append = false) {
    const qs = new URLSearchParams({ limit: '100' });
    if (append && next) qs.set('before', String(next));
    const res = await get(`/api/notifications?${qs}`);
    rows = append ? rows.concat(res.notifications) : res.notifications;
    next = res.next;
    render();
  }

  function render() {
    $('#list', el).innerHTML = rows.length
      ? String(html`<div class="table-wrap"><table class="table">
          <thead><tr><th>Time</th><th>Channel</th><th>Event</th><th>Monitor</th><th>Result</th><th>Details</th></tr></thead>
          <tbody>${rows.map((n) => {
            const [ic, label] = CHANNEL[n.channel] ?? ['bell', n.channel];
            const [cls, ev] = EVENT[n.event] ?? ['', n.event];
            return html`<tr>
              <td class="nowrap num">${fmtDateTime(n.at)}</td>
              <td class="nowrap"><span class="row">${icon(ic)}${label}</span></td>
              <td><span class="pill ${cls}">${ev}</span></td>
              <td class="nowrap">${n.monitor_id ? (n.monitor_name ? html`<a href="#/monitors/${n.monitor_id}">${n.monitor_name}</a>` : html`<span class="faint">deleted</span>`) : html`<span class="faint">—</span>`}</td>
              <td>${n.success ? html`<span class="pill up">${icon('check')}Sent</span>` : html`<span class="pill down">${icon('x')}Failed</span>`}</td>
              <td><div class="small ${n.success ? 'muted' : 'err'}" style="max-width:520px;word-break:break-word">${n.detail ?? ''}</div></td></tr>`;
          })}</tbody></table></div>
          ${next ? html`<div class="load-more"><button class="btn sm" id="more">Load older</button></div>` : ''}`)
      : String(html`<div class="empty">${icon('bell')}<div class="big">No alerts sent yet</div>
          <div>Configure email, push or WhatsApp in <a href="#/settings">Settings</a> and send a test message.</div></div>`);
  }

  el.addEventListener('click', (e) => {
    if (e.target.closest('#more')) busy(e.target.closest('#more'), () => load(true));
    if (e.target.closest('#refresh')) busy(e.target.closest('#refresh'), () => load());
  });

  await load();
}
