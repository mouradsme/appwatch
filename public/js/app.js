import { get, post } from './api.js';
import { $, $$, esc, html, icon, loadingPage, toast } from './ui.js';

const VIEWS = [
  { re: /^\/$/, nav: 'dashboard', load: () => import('./views/dashboard.js') },
  { re: /^\/monitors\/new$/, nav: 'dashboard', load: () => import('./views/monitor-form.js') },
  { re: /^\/monitors\/(\d+)\/edit$/, nav: 'dashboard', load: () => import('./views/monitor-form.js') },
  { re: /^\/monitors\/(\d+)$/, nav: 'dashboard', load: () => import('./views/monitor.js') },
  { re: /^\/incidents$/, nav: 'incidents', load: () => import('./views/incidents.js') },
  { re: /^\/notifications$/, nav: 'notifications', load: () => import('./views/notifications.js') },
  { re: /^\/settings$/, nav: 'settings', load: () => import('./views/settings.js') },
];

const NAV = [
  { id: 'dashboard', href: '#/', label: 'Monitors', icon: 'grid' },
  { id: 'incidents', href: '#/incidents', label: 'Incidents', icon: 'alert' },
  { id: 'notifications', href: '#/notifications', label: 'Alert log', icon: 'bell' },
  { id: 'settings', href: '#/settings', label: 'Settings', icon: 'sliders' },
];

let session = null;
let cleanup = null;
let routeToken = 0;
let downCount = 0;

export const app = {
  get name() {
    return session?.app_name || 'AppWatch';
  },
  setAppName(name) {
    if (session) session.app_name = name;
    $$('.brand-name').forEach((el) => (el.textContent = name));
    updateTitle();
  },
  setDownCount(n) {
    downCount = n;
    $$('.nav-link[data-nav="dashboard"] .badge').forEach((b) => b.remove());
    if (n > 0) $$('.nav-link[data-nav="dashboard"]').forEach((a) => a.insertAdjacentHTML('beforeend', `<span class="badge">${n}</span>`));
    updateTitle();
  },
  go(path) {
    location.hash = `#${path}`;
  },
};

function updateTitle() {
  document.title = downCount > 0 ? `(${downCount} down) ${app.name}` : app.name;
}

/* ------------------------------------------------------------ theme */

function effectiveTheme() {
  return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('aw-theme', next);
  } catch {
    /* storage unavailable */
  }
  $$('.theme-toggle').forEach((b) => (b.innerHTML = String(icon(next === 'dark' ? 'sun' : 'moon'))));
}

/* ------------------------------------------------------------ shell */

function renderShell() {
  const themeIcon = icon(effectiveTheme() === 'dark' ? 'sun' : 'moon');
  document.body.innerHTML = String(html`
    <div class="app">
      <nav class="sidebar" aria-label="Main">
        <a class="brand" href="#/"><img src="/icons/icon.svg" alt="" /><span class="brand-name">${app.name}</span></a>
        ${NAV.map((n) => html`<a class="nav-link" data-nav="${n.id}" href="${n.href}">${icon(n.icon)}<span>${n.label}</span></a>`)}
        <div class="sidebar-foot">
          <button class="btn ghost icon-only theme-toggle" title="Toggle theme" aria-label="Toggle theme">${themeIcon}</button>
          <span class="spacer"></span>
          <button class="btn ghost sm logout" title="Sign out">${icon('logout')}<span>Sign out</span></button>
        </div>
      </nav>
      <div class="main-col">
        <header class="topbar">
          <a class="brand" href="#/"><img src="/icons/icon.svg" alt="" /><span class="brand-name">${app.name}</span></a>
          <div class="row">
            <button class="btn ghost icon-only theme-toggle" aria-label="Toggle theme">${themeIcon}</button>
            <button class="btn ghost icon-only logout" aria-label="Sign out">${icon('logout')}</button>
          </div>
        </header>
        <main class="main" id="view"></main>
      </div>
    </div>`);
  $$('.theme-toggle').forEach((b) => b.addEventListener('click', toggleTheme));
  $$('.logout').forEach((b) =>
    b.addEventListener('click', async () => {
      await post('/api/auth/logout').catch(() => {});
      session = { ...session, authenticated: false };
      renderLogin();
    }),
  );
  app.setDownCount(downCount);
}

/* ------------------------------------------------------------ login */

function renderLogin(message = '') {
  cleanup?.();
  cleanup = null;
  document.title = app.name;
  document.body.innerHTML = String(html`
    <div class="login">
      <form class="card" autocomplete="on">
        <img class="logo" src="/icons/icon.svg" alt="" />
        <h1>Sign in to ${app.name}</h1>
        <p>Uptime monitoring for your apps and servers.</p>
        ${session && !session.configured
          ? html`<div class="callout warn" style="margin-bottom:16px">The admin password is not set yet. Run <code>deploy.bat</code> to finish the setup.</div>`
          : ''}
        <div class="field">
          <label for="pw">Admin password</label>
          <input class="input" id="pw" name="password" type="password" autocomplete="current-password" required autofocus />
        </div>
        <div class="callout bad hidden" id="login-error" style="margin-top:12px"></div>
        <button class="btn primary" style="width:100%;margin-top:16px;height:38px" type="submit">Sign in</button>
      </form>
    </div>`);
  const form = $('form');
  const err = $('#login-error');
  if (message) {
    err.textContent = message;
    err.classList.remove('hidden');
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      await post('/api/auth/login', { password: form.password.value });
      session = await get('/api/auth/session');
      document.body.innerHTML = '';
      route();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
      form.password.select();
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  });
}

/* ------------------------------------------------------------ router */

async function route() {
  if (!session?.authenticated) return renderLogin();
  if (!$('#view')) renderShell();
  const path = location.hash.replace(/^#/, '') || '/';
  const view = VIEWS.find((v) => v.re.test(path));
  if (!view) return app.go('/');
  const params = path.match(view.re).slice(1);
  $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.nav === view.nav));

  cleanup?.();
  cleanup = null;
  const token = ++routeToken;
  const host = $('#view');
  const el = document.createElement('div');
  el.className = 'page';
  host.replaceChildren(el);
  el.innerHTML = String(loadingPage());
  window.scrollTo(0, 0);
  try {
    const mod = await view.load();
    if (token !== routeToken) return;
    const dispose = await mod.mount(el, params, app);
    if (token !== routeToken) dispose?.();
    else cleanup = dispose ?? null;
  } catch (e) {
    if (token !== routeToken) return;
    if (e?.status === 401) return;
    el.innerHTML = String(html`<div class="card"><div class="empty">${icon('alert')}<div class="big">Something went wrong</div><div>${e?.message ?? e}</div>
      <div style="margin-top:14px"><a class="btn" href="#/">Back to monitors</a></div></div></div>`);
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('aw:unauthorized', () => {
  if (session?.authenticated) {
    session = { ...session, authenticated: false };
    renderLogin('Your session has expired. Please sign in again.');
  }
});

async function boot() {
  try {
    session = await get('/api/auth/session');
  } catch (e) {
    document.body.innerHTML = `<div class="boot"><div>Cannot reach the server: ${esc(e.message)}</div></div>`;
    return;
  }
  route();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker registration failed', e));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.url) {
      const u = new URL(e.data.url, location.origin);
      if (u.hash) location.hash = u.hash;
    }
  });
}

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.status === 401) return;
  if (e.reason?.message) toast(e.reason.message, 'err');
});

boot();
