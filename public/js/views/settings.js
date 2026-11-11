import { del, get, post, put } from '../api.js';
import { getSubscription, isIOS, isStandalone, pushSupported, subscribe, unsubscribe } from '../push.js';
import { $, $$, busy, confirmDialog, fmtAgo, fmtBytes, fmtDateShort, fmtNum, html, icon, toast } from '../ui.js';

const SECTIONS = [
  ['general', 'General', 'sliders'],
  ['email', 'Email (SMTP)', 'mail'],
  ['wasend', 'WhatsApp (Wasend)', 'chat'],
  ['push', 'Push notifications', 'phone'],
  ['usage', 'Free-tier usage', 'database'],
  ['security', 'Security', 'lock'],
];

const SMTP_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 465, security: 'tls', note: 'Use an App Password (Google Account → Security → App passwords).' },
  outlook: { host: 'smtp.office365.com', port: 587, security: 'starttls', note: 'SMTP AUTH must be enabled for the mailbox.' },
  zoho: { host: 'smtp.zoho.com', port: 465, security: 'tls', note: '' },
  brevo: { host: 'smtp-relay.brevo.com', port: 587, security: 'starttls', note: 'Use your SMTP key as the password.' },
  mailgun: { host: 'smtp.mailgun.org', port: 587, security: 'starttls', note: '' },
  sendgrid: { host: 'smtp.sendgrid.net', port: 465, security: 'tls', note: 'Username is literally "apikey"; the password is your API key.' },
};

const REMINDERS = [
  [0, 'Off – alert once per outage'],
  [15, 'Every 15 minutes'],
  [30, 'Every 30 minutes'],
  [60, 'Every hour'],
  [180, 'Every 3 hours'],
  [720, 'Every 12 hours'],
  [1440, 'Every day'],
];
const RETENTION = [
  [30, '30 days'],
  [90, '90 days'],
  [180, '6 months'],
  [365, '1 year'],
  [730, '2 years'],
  [0, 'Forever'],
];

export async function mount(el, _params, app) {
  let s = await get('/api/settings');
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  if (!zones.includes('UTC')) zones.unshift('UTC');

  const result = (id) => html`<div class="callout result-line hidden" id="${id}"></div>`;
  const showResult = (id, ok, text) => {
    const box = $(`#${id}`, el);
    box.className = `callout result-line ${ok ? 'ok' : 'bad'}`;
    box.textContent = text;
  };

  el.innerHTML = String(html`
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Alert channels, data retention and free-tier usage.</div></div></div>
    <div class="settings-layout">
      <nav class="settings-nav">${SECTIONS.map(([id, label, ic]) => html`<a href="#/settings" data-jump="${id}">${icon(ic)}${label}</a>`)}</nav>
      <div class="stack">

        <form class="card section-anchor" id="general" data-section="general">
          <div class="card-head"><div><h2>General</h2><div class="sub">Applies to all monitors and alerts.</div></div></div>
          <div class="card-body form-grid">
            <div class="field"><label for="app_name">Dashboard name</label><input class="input" id="app_name" name="app_name" maxlength="60" value="${s.general.app_name}" /></div>
            <div class="field"><label for="timezone">Time zone for alert messages</label>
              ${zones.length
                ? html`<select class="select" id="timezone" name="timezone">${zones.map((z) => html`<option ${z === s.general.timezone ? 'selected' : ''}>${z}</option>`)}</select>`
                : html`<input class="input" id="timezone" name="timezone" value="${s.general.timezone}" />`}</div>
            <div class="field"><label for="reminder_minutes">Repeat alerts while a monitor stays down</label>
              <select class="select" id="reminder_minutes" name="reminder_minutes">${REMINDERS.map(([v, l]) => html`<option value="${v}" ${v === s.general.reminder_minutes ? 'selected' : ''}>${l}</option>`)}</select></div>
            <div class="field"><label for="retention_days">Keep individual check results for</label>
              <select class="select" id="retention_days" name="retention_days">${RETENTION.map(([v, l]) => html`<option value="${v}" ${v === s.general.retention_days ? 'selected' : ''}>${l}</option>`)}</select>
              <span class="hint">Incidents, alerts and the audit log are always kept. Purging old checks costs D1 writes, spread over time.</span></div>
            <div class="field"><label for="contact_email">Contact email (used for web push)</label>
              <input class="input" id="contact_email" name="contact_email" type="email" value="${s.general.contact_email}" placeholder="you@example.com" />
              <span class="hint">Push services may contact this address. Optional.</span></div>
            <div class="field"><span class="label">Recovery alerts</span>
              <label class="switch"><input type="checkbox" name="notify_recovery" ${s.general.notify_recovery ? 'checked' : ''} />Notify when a monitor is back up</label></div>
          </div>
          <div class="card-foot"><button class="btn primary" type="submit">Save</button></div>
        </form>

        <form class="card section-anchor" id="email" data-section="smtp">
          <div class="card-head"><div><h2>Email (SMTP)</h2><div class="sub">Sent directly from the Worker over a TLS socket. Port 25 is blocked by Cloudflare – use 465 or 587.</div></div>
            <label class="switch"><input type="checkbox" name="enabled" ${s.smtp.enabled ? 'checked' : ''} />Enabled</label></div>
          <div class="card-body form-grid">
            <div class="field span-2"><label for="smtp-preset">Provider preset</label>
              <select class="select" id="smtp-preset" style="max-width:280px"><option value="">Custom server</option>
                <option value="gmail">Gmail / Google Workspace</option><option value="outlook">Outlook / Microsoft 365</option><option value="zoho">Zoho Mail</option>
                <option value="brevo">Brevo</option><option value="mailgun">Mailgun</option><option value="sendgrid">SendGrid</option></select>
              <span class="hint" id="preset-note"></span></div>
            <div class="field"><label for="host">SMTP host</label><input class="input mono" id="host" name="host" value="${s.smtp.host}" placeholder="smtp.example.com" /></div>
            <div class="field"><label for="port">Port & security</label>
              <div class="input-group">
                <input class="input num" id="port" name="port" type="number" min="1" max="65535" value="${s.smtp.port}" style="max-width:110px" />
                <select class="select" name="security" id="smtp-security" aria-label="Security">
                  <option value="tls" ${s.smtp.security === 'tls' ? 'selected' : ''}>SSL/TLS (usually 465)</option>
                  <option value="starttls" ${s.smtp.security === 'starttls' ? 'selected' : ''}>STARTTLS (usually 587)</option>
                  <option value="none" ${s.smtp.security === 'none' ? 'selected' : ''}>None (not recommended)</option>
                </select></div></div>
            <div class="field"><label for="username">Username</label><input class="input" id="username" name="username" value="${s.smtp.username}" autocomplete="off" /></div>
            <div class="field"><label for="password">Password</label>
              <input class="input" id="password" name="password" type="password" autocomplete="new-password" placeholder="${s.smtp.password_set ? '•••••••• (saved – leave empty to keep)' : ''}" /></div>
            <div class="field"><label for="from_email">From address</label><input class="input" id="from_email" name="from_email" value="${s.smtp.from_email}" placeholder="alerts@example.com" /></div>
            <div class="field"><label for="from_name">From name</label><input class="input" id="from_name" name="from_name" value="${s.smtp.from_name}" /></div>
            <div class="field span-2"><label for="to">Default recipients</label><input class="input" id="to" name="to" value="${s.smtp.to}" placeholder="ops@example.com, me@example.com" />
              <span class="hint">Comma separated. Used by every monitor without its own recipients (set them in the monitor’s Alerts section). Each person gets one email per check run listing their monitors.</span></div>
            <div class="span-2">${result('email-result')}</div>
          </div>
          <div class="card-foot"><button class="btn" type="button" data-test="email">${icon('send')}Save & send test</button><button class="btn primary" type="submit">Save</button></div>
        </form>

        <form class="card section-anchor" id="wasend" data-section="wasend">
          <div class="card-head"><div><h2>WhatsApp (Wasend)</h2><div class="sub">Through your own <a href="https://github.com/mouradsme/wasend" target="_blank" rel="noopener">Wasend</a> gateway – also free on Cloudflare.</div></div>
            <label class="switch"><input type="checkbox" name="enabled" ${s.wasend.enabled ? 'checked' : ''} />Enabled</label></div>
          <div class="card-body form-grid">
            <div class="field"><label for="base_url">Wasend URL</label><input class="input mono" id="base_url" name="base_url" value="${s.wasend.base_url}" placeholder="https://wasend.your-account.workers.dev" /></div>
            <div class="field"><label for="session">Session ID</label><input class="input mono" id="session" name="session" value="${s.wasend.session}" placeholder="main" />
              <span class="hint">The paired WhatsApp session in your Wasend dashboard.</span></div>
            <div class="field"><label for="api_key">API key</label>
              <input class="input mono" id="api_key" name="api_key" type="password" autocomplete="off" placeholder="${s.wasend.api_key_set ? `${s.wasend.api_key_hint} (saved – leave empty to keep)` : 'wsk_…'}" /></div>
            <div class="field"><label for="recipients">Default WhatsApp numbers</label><input class="input mono" id="recipients" name="recipients" value="${s.wasend.recipients}" placeholder="+15551234567, +213555000000" />
              <span class="hint">International format, comma separated. Monitors can override them in their Alerts section.</span></div>
            <div class="span-2">${result('wasend-result')}</div>
          </div>
          <div class="card-foot"><button class="btn" type="button" data-test="wasend">${icon('send')}Save & send test</button><button class="btn primary" type="submit">Save</button></div>
        </form>

        <div class="card section-anchor" id="push">
          <div class="card-head"><div><h2>Push notifications</h2><div class="sub">Install AppWatch as an app (PWA) and get native notifications on desktop and mobile.</div></div></div>
          <div class="card-body stack" id="push-body"></div>
        </div>

        <div class="card section-anchor" id="usage">
          <div class="card-head"><div><h2>Free-tier usage</h2><div class="sub">Estimated from your monitors. Everything runs on Cloudflare's free plan.</div></div></div>
          <div class="card-body stack" id="usage-body"></div>
        </div>

        <div class="card section-anchor" id="security">
          <div class="card-head"><div><h2>Security</h2></div></div>
          <div class="card-body stack">
            <div class="callout">The admin password is stored as an encrypted Worker secret. To change it, run <code>deploy.bat --reset-password</code> on your computer. Changing it signs out every session.</div>
            <div class="callout">Want a second factor or SSO? Put the dashboard behind <b>Cloudflare Access</b> (Zero Trust, free for up to 50 users) – the cron checks are not affected.</div>
          </div>
        </div>
      </div>
    </div>`);

  /* ---------------- forms ---------------- */

  async function saveSection(form) {
    const section = form.dataset.section;
    const f = new FormData(form);
    const body = Object.fromEntries(f.entries());
    $$('input[type=checkbox][name]', form).forEach((c) => (body[c.name] = c.checked));
    if (section === 'general') {
      body.reminder_minutes = Number(body.reminder_minutes);
      body.retention_days = Number(body.retention_days);
    }
    if (section === 'smtp') body.port = Number(body.port);
    const res = await put(`/api/settings/${section}`, body);
    s = { ...s, ...res };
    if (section === 'general') app.setAppName(res.general.app_name);
    if (section === 'smtp') {
      form.password.value = '';
      form.password.placeholder = res.smtp.password_set ? '•••••••• (saved – leave empty to keep)' : '';
    }
    if (section === 'wasend') {
      form.api_key.value = '';
      form.api_key.placeholder = res.wasend.api_key_set ? `${res.wasend.api_key_hint} (saved – leave empty to keep)` : 'wsk_…';
    }
    renderUsage();
    return res;
  }

  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    await busy($('button[type=submit]', form), async () => {
      try {
        await saveSection(form);
        toast('Settings saved');
      } catch (ex) {
        toast(ex.message, 'err', 7000);
      }
    });
  });

  el.addEventListener('click', async (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) {
      e.preventDefault();
      $(`#${jump.dataset.jump}`, el).scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const test = e.target.closest('[data-test]');
    if (test) {
      const channel = test.dataset.test;
      const form = test.closest('form');
      await busy(test, async () => {
        try {
          await saveSection(form);
          const r = await post(`/api/settings/test/${channel}`);
          showResult(`${channel}-result`, r.ok, r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`);
        } catch (ex) {
          showResult(`${channel}-result`, false, `✗ ${ex.message}`);
        }
      });
    }
  });

  $('#smtp-preset', el).addEventListener('change', (e) => {
    const p = SMTP_PRESETS[e.target.value];
    $('#preset-note', el).textContent = p?.note ?? '';
    if (!p) return;
    const form = $('#email', el);
    form.host.value = p.host;
    form.port.value = p.port;
    form.security.value = p.security;
  });
  $('#smtp-security', el).addEventListener('change', (e) => {
    const port = $('#port', el);
    if (e.target.value === 'tls' && port.value === '587') port.value = '465';
    if (e.target.value === 'starttls' && port.value === '465') port.value = '587';
  });

  /* ---------------- push ---------------- */

  async function renderPush() {
    const body = $('#push-body', el);
    const supported = pushSupported();
    let sub = null;
    let state = 'unsupported';
    if (supported) {
      try {
        sub = await getSubscription();
      } catch {
        /* SW not ready */
      }
      state = Notification.permission === 'denied' ? 'blocked' : sub ? 'on' : 'off';
    }
    const devices = s.push.devices;
    const iosNeedsInstall = isIOS() && !isStandalone();
    const stateText = {
      on: html`<div class="callout ok">${icon('check')} <b>This device receives push alerts.</b></div>`,
      off: html`<div class="callout">This device is <b>not subscribed</b> yet.</div>`,
      blocked: html`<div class="callout bad">Notifications are <b>blocked</b> for this site. Allow them in your browser's site settings, then reload.</div>`,
      unsupported: iosNeedsInstall
        ? html`<div class="callout warn">On iPhone and iPad, push needs the installed app: tap <b>Share → Add to Home Screen</b>, open AppWatch from the Home Screen and enable notifications there (iOS 16.4+).</div>`
        : html`<div class="callout warn">This browser does not support web push.</div>`,
    }[state];

    body.innerHTML = String(html`
      ${stateText}
      ${iosNeedsInstall && supported ? html`<div class="callout warn">Tip: on iOS, install the app first (Share → Add to Home Screen) – push only works from the installed app.</div>` : ''}
      <div class="row wrap">
        ${state === 'off' ? html`<button class="btn primary" data-push="enable">${icon('bell')}Enable on this device</button>` : ''}
        ${state === 'on'
          ? html`<button class="btn" data-push="test-me">${icon('send')}Test this device</button><button class="btn" data-push="disable">Disable on this device</button>`
          : ''}
        ${devices.length ? html`<button class="btn" data-push="test-all">${icon('send')}Test all devices</button>` : ''}
      </div>
      ${result('push-result')}
      ${devices.length
        ? html`<div class="table-wrap" style="border:1px solid var(--border);border-radius:10px"><table class="table">
            <thead><tr><th>Device</th><th>Added</th><th>Last delivery</th><th></th></tr></thead>
            <tbody>${devices.map(
              (dv) => html`<tr>
                <td><div>${dv.label ?? 'Device'}${sub && sub.endpoint === dv.endpoint ? html` <span class="tag">this device</span>` : ''}</div><div class="small faint">${dv.service}</div>
                  ${dv.last_error ? html`<div class="small err">${dv.last_error}</div>` : ''}</td>
                <td class="nowrap">${fmtDateShort(dv.created_at)}</td>
                <td class="nowrap">${dv.last_success_at ? fmtAgo(dv.last_success_at) : html`<span class="faint">never</span>`}</td>
                <td class="r"><button class="btn sm ghost icon-only" data-remove="${dv.id}" title="Remove device" aria-label="Remove device">${icon('trash')}</button></td></tr>`,
            )}</tbody></table></div>`
        : html`<div class="hint">No devices subscribed yet. Enable push on each phone or computer that should get alerts.</div>`}`);
  }

  async function refreshSettings() {
    s = await get('/api/settings');
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-push], [data-remove]');
    if (!b) return;
    if (b.dataset.remove) {
      if (!(await confirmDialog({ title: 'Remove this device?', body: 'It will stop receiving push alerts.', confirmText: 'Remove', danger: true }))) return;
      await del(`/api/push/devices/${b.dataset.remove}`);
      await refreshSettings();
      return renderPush();
    }
    await busy(b, async () => {
      try {
        switch (b.dataset.push) {
          case 'enable':
            await subscribe();
            toast('Push notifications enabled on this device');
            break;
          case 'disable':
            await unsubscribe();
            toast('Push notifications disabled on this device');
            break;
          case 'test-me': {
            const sub = await getSubscription();
            const r = await post('/api/settings/test/push', { endpoint: sub?.endpoint });
            showResult('push-result', r.ok, r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`);
            break;
          }
          case 'test-all': {
            const r = await post('/api/settings/test/push');
            showResult('push-result', r.ok, r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`);
            break;
          }
        }
        if (b.dataset.push === 'enable' || b.dataset.push === 'disable') {
          await refreshSettings();
          await renderPush();
        }
      } catch (ex) {
        toast(ex.message, 'err', 8000);
      }
    });
  });

  /* ---------------- usage ---------------- */

  function meter(label, used, limit, fmt, note) {
    const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
    const cls = pct >= 90 ? 'danger' : pct >= 60 ? 'warn' : '';
    return html`<div class="meter ${cls}">
      <div class="top"><b>${label}</b><span class="num">${fmt(used)} <span class="faint">/ ${fmt(limit)}</span></span></div>
      <div class="bar"><span style="width:${Math.max(pct, used > 0 ? 1 : 0).toFixed(1)}%"></span></div>
      <div class="hint">${note}</div></div>`;
  }

  function renderUsage() {
    const u = s.usage;
    $('#usage-body', el).innerHTML = String(html`
      ${meter('D1 rows written per day (estimate)', u.est_writes_per_day, u.limits.writes_per_day, fmtNum,
        `${fmtNum(u.checks_per_day)} checks/day from ${u.active_monitors} active monitor${u.active_monitors === 1 ? '' : 's'}. A healthy check costs one row write${s.general.retention_days > 0 ? ', plus one when retention deletes it later' : ''}.`)}
      ${meter('D1 rows read per day by the scheduler (estimate)', u.est_cron_reads_per_day, u.limits.reads_per_day, fmtNum, 'Dashboard views add a few hundred reads each.')}
      ${u.db_size_bytes != null ? meter('Database size', u.db_size_bytes, u.limits.db_size_bytes, fmtBytes, 'Free D1 databases can grow to 500 MB. Lower the retention if this gets close.') : ''}
      <div class="callout">The Worker runs once a minute (1,440 cron runs/day) and checks up to ~40 monitors per run.
        Static dashboard files are free and unlimited. If D1's daily write quota is ever exceeded, results stop being recorded until 00:00 UTC – keep the estimate under 100,000.</div>`);
  }

  renderUsage();
  renderPush();
}
