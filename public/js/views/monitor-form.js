import { get, post, put } from '../api.js';
import { $, $$, busy, fmtInterval, fmtNum, html, icon, toast } from '../ui.js';

const PRESETS = [60, 300, 900, 1800, 3600, 21600, 43200, 86400];
const DOWN_OPTIONS = [60, 120, 300, 600, 900, 1800];
const UNITS = [
  ['60', 'minutes'],
  ['3600', 'hours'],
  ['86400', 'days'],
];

const DEFAULTS = {
  name: '',
  type: 'http',
  target: '',
  method: 'GET',
  headers: {},
  body: '',
  expected_status: '200-399',
  keyword: '',
  keyword_mode: 'contains',
  follow_redirects: 1,
  timeout_ms: 10000,
  interval_s: 300,
  down_interval_s: 60,
  retries: 2,
  notify_email: 1,
  notify_push: 1,
  notify_wasend: 1,
};

export async function mount(el, [id], app) {
  const editing = !!id;
  const [monRes, settings] = await Promise.all([editing ? get(`/api/monitors/${id}`) : null, get('/api/settings').catch(() => null)]);
  const m = editing ? { ...DEFAULTS, ...monRes.monitor } : { ...DEFAULTS };
  let type = m.type;
  let interval = m.interval_s;
  let custom = !PRESETS.includes(interval);

  const unitFor = (s) => (s % 86400 === 0 ? 86400 : s % 3600 === 0 ? 3600 : 60);
  const headersText = Object.entries(m.headers ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const channelHint = (on, label) => (on ? html`<span class="c-up">${label}</span>` : html`<span class="faint">${label}</span>`);
  const pushDevices = settings?.push?.devices?.length ?? 0;

  el.innerHTML = String(html`
    <a class="back" href="${editing ? `#/monitors/${id}` : '#/'}">${icon('back')}${editing ? m.name : 'All monitors'}</a>
    <div class="page-head"><div><h1>${editing ? 'Edit monitor' : 'Add a monitor'}</h1>
      <div class="sub">${editing ? 'Changes apply from the next check and are recorded in the activity log.' : 'AppWatch checks it on your schedule and alerts you when it goes down and when it recovers.'}</div></div></div>
    <form class="form" id="form" novalidate>
      <div class="card">
        <div class="card-head"><h2>What to monitor</h2></div>
        <div class="card-body form-grid">
          <div class="field span-2">
            <span class="label">Check type</span>
            <div class="segmented" id="type">
              <button type="button" data-type="http" class="${type === 'http' ? 'active' : ''}">HTTP(S) / website / API</button>
              <button type="button" data-type="tcp" class="${type === 'tcp' ? 'active' : ''}">TCP port (server, database, SSH…)</button>
            </div>
          </div>
          <div class="field">
            <label for="name">Name</label>
            <input class="input" id="name" name="name" required maxlength="100" placeholder="Production API" value="${m.name}" />
          </div>
          <div class="field">
            <label for="target" id="target-label">URL</label>
            <input class="input mono" id="target" name="target" required placeholder="https://example.com/health" value="${m.target}" autocomplete="off" spellcheck="false" />
            <span class="hint" id="target-hint"></span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Polling schedule</h2><div class="sub">Every check is recorded. The minimum interval is 1 minute.</div></div></div>
        <div class="card-body form-grid">
          <div class="field span-2">
            <span class="label">Check every</span>
            <div class="chips" id="presets">
              ${PRESETS.map((s) => html`<button type="button" class="chip ${!custom && s === interval ? 'active' : ''}" data-preset="${s}">${fmtInterval(s)}</button>`)}
              <button type="button" class="chip ${custom ? 'active' : ''}" data-preset="custom">Custom…</button>
            </div>
            <div class="input-group ${custom ? '' : 'hidden'}" id="custom" style="max-width:320px;margin-top:6px">
              <input class="input num" type="number" min="1" step="1" id="custom-n" value="${interval / unitFor(interval)}" aria-label="Interval amount" />
              <select class="select" id="custom-unit" aria-label="Interval unit">
                ${UNITS.map(([v, l]) => html`<option value="${v}" ${Number(v) === unitFor(interval) ? 'selected' : ''}>${l}</option>`)}
              </select>
            </div>
            <span class="hint" id="load-hint"></span>
          </div>
          <div class="field">
            <label for="down_interval_s">While failing or down, check every</label>
            <select class="select" id="down_interval_s" name="down_interval_s">
              ${DOWN_OPTIONS.map((s) => html`<option value="${s}" ${s === m.down_interval_s ? 'selected' : ''}>${fmtInterval(s)}</option>`)}
              <option value="0" ${!DOWN_OPTIONS.includes(m.down_interval_s) ? 'selected' : ''}>Same as normal interval</option>
            </select>
            <span class="hint">Faster re-checks confirm outages sooner and measure the time to recover precisely.</span>
          </div>
          <div class="field">
            <label for="retries">Alert after</label>
            <select class="select" id="retries" name="retries">
              ${[1, 2, 3, 4, 5, 10].map((n) => html`<option value="${n}" ${n === m.retries ? 'selected' : ''}>${n} consecutive failed check${n > 1 ? 's' : ''}</option>`)}
            </select>
            <span class="hint">2 or more avoids alerts for a single network blip.</span>
          </div>
          <div class="field">
            <label for="timeout">Timeout</label>
            <select class="select" id="timeout" name="timeout_ms">
              ${[3000, 5000, 10000, 15000, 20000, 30000].map((t) => html`<option value="${t}" ${t === m.timeout_ms ? 'selected' : ''}>${t / 1000} seconds</option>`)}
            </select>
          </div>
        </div>
      </div>

      <div class="card" id="http-card">
        <div class="card-head"><div><h2>HTTP options</h2><div class="sub">Optional – the defaults work for most websites and APIs.</div></div></div>
        <div class="card-body form-grid">
          <div class="field">
            <label for="method">Method</label>
            <select class="select" id="method" name="method">
              ${['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((v) => html`<option ${v === m.method ? 'selected' : ''}>${v}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="expected_status">Accepted status codes</label>
            <input class="input mono" id="expected_status" name="expected_status" value="${m.expected_status}" placeholder="200-399" />
            <span class="hint">Ranges and lists, e.g. <code>200-299,301,401</code></span>
          </div>
          <div class="field">
            <label for="keyword">Keyword check</label>
            <div class="input-group">
              <select class="select" name="keyword_mode" style="max-width:170px" aria-label="Keyword mode">
                <option value="contains" ${m.keyword_mode === 'contains' ? 'selected' : ''}>Must contain</option>
                <option value="not_contains" ${m.keyword_mode === 'not_contains' ? 'selected' : ''}>Must not contain</option>
              </select>
              <input class="input" id="keyword" name="keyword" value="${m.keyword ?? ''}" placeholder='e.g. "ok":true' />
            </div>
            <span class="hint">Case-sensitive text searched in the response body (first 1 MB).</span>
          </div>
          <div class="field">
            <span class="label">Redirects</span>
            <label class="switch"><input type="checkbox" name="follow_redirects" ${m.follow_redirects ? 'checked' : ''} />Follow redirects</label>
            <span class="hint">When off, a 3xx response is checked against the accepted codes.</span>
          </div>
          <div class="field">
            <label for="headers">Request headers</label>
            <textarea class="textarea" id="headers" name="headers" rows="3" placeholder="Authorization: Bearer …&#10;X-Api-Key: …">${headersText}</textarea>
            <span class="hint">One <code>Name: value</code> per line.</span>
          </div>
          <div class="field">
            <label for="body">Request body</label>
            <textarea class="textarea" id="body" name="body" rows="3" placeholder='{"ping":true}'>${m.body ?? ''}</textarea>
            <span class="hint">Sent with POST / PUT / PATCH.</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h2>Alerts</h2><div class="sub">Channels are configured once in <a href="#/settings">Settings</a>. Recipients can be set per monitor – leave empty to use the defaults.</div></div></div>
        <div class="card-body stack" style="gap:16px">
          <div class="channel">
            <label class="check"><input type="checkbox" name="notify_email" data-recipients="email-to" ${m.notify_email ? 'checked' : ''} />
              <div><div class="t">Email (SMTP)</div><div class="hint">${settings ? channelHint(settings.smtp.enabled, settings.smtp.enabled ? 'Enabled in Settings' : 'SMTP is not enabled yet') : ''}</div></div></label>
            <div class="field recipients ${m.notify_email ? '' : 'hidden'}" id="email-to">
              <input class="input" name="email_to" value="${m.email_to ?? ''}" autocomplete="off" spellcheck="false"
                placeholder="${settings?.smtp.to ? `Default: ${settings.smtp.to}` : 'ops@example.com, oncall@example.com'}" aria-label="Email recipients for this monitor" />
              <span class="hint">Comma separated. Empty = default recipients from Settings${settings?.smtp.to ? html` (<b>${settings.smtp.to}</b>)` : ''}.</span>
            </div>
          </div>
          <div class="channel">
            <label class="check"><input type="checkbox" name="notify_wasend" data-recipients="wasend-to" ${m.notify_wasend ? 'checked' : ''} />
              <div><div class="t">WhatsApp (Wasend)</div><div class="hint">${settings ? channelHint(settings.wasend.enabled, settings.wasend.enabled ? 'Enabled in Settings' : 'Wasend is not enabled yet') : ''}</div></div></label>
            <div class="field recipients ${m.notify_wasend ? '' : 'hidden'}" id="wasend-to">
              <input class="input mono" name="wasend_to" value="${m.wasend_to ?? ''}" autocomplete="off" spellcheck="false"
                placeholder="${settings?.wasend.recipients ? `Default: ${settings.wasend.recipients}` : '+213555123456, +15551234567'}" aria-label="WhatsApp numbers for this monitor" />
              <span class="hint">International format, comma separated. Empty = default numbers from Settings${settings?.wasend.recipients ? html` (<b>${settings.wasend.recipients}</b>)` : ''}.</span>
            </div>
          </div>
          <div class="channel">
            <label class="check"><input type="checkbox" name="notify_push" ${m.notify_push ? 'checked' : ''} />
              <div><div class="t">Push notifications (PWA)</div><div class="hint">${channelHint(pushDevices > 0, pushDevices ? `Every subscribed device (${pushDevices})` : 'No device subscribed yet')}</div></div></label>
          </div>
        </div>
      </div>

      <div class="callout bad hidden" id="error"></div>
      <div class="row" style="justify-content:flex-end">
        <a class="btn" href="${editing ? `#/monitors/${id}` : '#/'}">Cancel</a>
        <button class="btn primary" type="submit" id="save">${editing ? 'Save changes' : html`${icon('plus')}Create monitor`}</button>
      </div>
    </form>`);

  const form = $('#form', el);

  function currentInterval() {
    if (!custom) return interval;
    const n = Math.max(1, Math.round(Number($('#custom-n', el).value) || 1));
    return Math.max(60, n * Number($('#custom-unit', el).value));
  }

  function syncType() {
    $$('[data-type]', el).forEach((b) => b.classList.toggle('active', b.dataset.type === type));
    $('#http-card', el).classList.toggle('hidden', type !== 'http');
    $('#target-label', el).textContent = type === 'http' ? 'URL' : 'Host and port';
    const target = $('#target', el);
    target.placeholder = type === 'http' ? 'https://example.com/health' : 'db.example.com:5432';
    $('#target-hint', el).innerHTML =
      type === 'http'
        ? 'Full URL including <code>https://</code>. Checked from Cloudflare’s network.'
        : 'Succeeds when a TCP connection opens. Port 25 and Cloudflare IP ranges are not reachable from Workers.';
  }

  function syncLoad() {
    const s = currentInterval();
    const perDay = 86400 / s;
    $('#load-hint', el).textContent = `≈ ${fmtNum(perDay)} checks/day for this monitor · uses about ${((perDay / 100_000) * 100).toFixed(perDay >= 1000 ? 1 : 2)}% of D1’s free daily write quota.`;
  }

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-type], [data-preset]');
    if (!t) return;
    if (t.dataset.type) {
      type = t.dataset.type;
      syncType();
    } else {
      custom = t.dataset.preset === 'custom';
      if (!custom) interval = Number(t.dataset.preset);
      $$('[data-preset]', el).forEach((b) => b.classList.toggle('active', b === t));
      $('#custom', el).classList.toggle('hidden', !custom);
      if (custom) $('#custom-n', el).focus();
      syncLoad();
    }
  });
  $('#custom-n', el).addEventListener('input', syncLoad);
  $('#custom-unit', el).addEventListener('change', syncLoad);
  // Show the recipient field only while its channel is ticked (the value is kept either way).
  $$('[data-recipients]', el).forEach((box) =>
    box.addEventListener('change', () => {
      const field = $(`#${box.dataset.recipients}`, el);
      field.classList.toggle('hidden', !box.checked);
      if (box.checked) $('input', field).focus();
    }),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#error', el);
    err.classList.add('hidden');
    const f = new FormData(form);
    const headers = {};
    for (const line of String(f.get('headers') ?? '').split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const intervalS = currentInterval();
    const down = Number(f.get('down_interval_s'));
    const payload = {
      name: f.get('name'),
      type,
      target: String(f.get('target') ?? '').trim(),
      method: f.get('method') ?? 'GET',
      headers,
      body: f.get('body') ?? '',
      expected_status: f.get('expected_status') || '200-399',
      keyword: f.get('keyword') ?? '',
      keyword_mode: f.get('keyword_mode') ?? 'contains',
      follow_redirects: f.get('follow_redirects') === 'on',
      timeout_ms: Number(f.get('timeout_ms')),
      interval_s: intervalS,
      down_interval_s: down > 0 ? Math.min(down, intervalS) : intervalS,
      retries: Number(f.get('retries')),
      notify_email: f.get('notify_email') === 'on',
      notify_push: f.get('notify_push') === 'on',
      notify_wasend: f.get('notify_wasend') === 'on',
      email_to: String(f.get('email_to') ?? '').trim(),
      wasend_to: String(f.get('wasend_to') ?? '').trim(),
    };
    if (type === 'http' && payload.target && !/^https?:\/\//i.test(payload.target)) payload.target = `https://${payload.target}`;
    await busy($('#save', el), async () => {
      try {
        const res = editing ? await put(`/api/monitors/${id}`, payload) : await post('/api/monitors', payload);
        toast(editing ? 'Monitor updated' : 'Monitor created – first check within a minute');
        app.go(`/monitors/${res.monitor.id}`);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        err.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });

  syncType();
  syncLoad();
  if (!editing) $('#name', el).focus();
}
