#!/usr/bin/env node
// AppWatch deploy / update script. Run through deploy.bat (Windows) or `npm run deploy`.
//
// Creates or updates every Cloudflare resource the app needs, all on the free plan:
//   1. signs you in to Cloudflare (wrangler login) if needed
//   2. creates the D1 database "appwatch-db" if it does not exist and links it in wrangler.jsonc
//   3. applies database migrations
//   4. deploys the Worker + dashboard (static assets) + the once-a-minute Cron Trigger
//   5. sets the admin password and session secret on first deploy
//
// Safe to run again at any time: every step is idempotent, so the same command updates the app.
//
// Flags:
//   --reset-password   only change the admin password (signs everybody out)
//   --yes              skip the "deploy to this account?" confirmation on the first deploy
//   --help             show this help

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const CONFIG = path.join(ROOT, 'wrangler.jsonc');
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';
const args = new Set(process.argv.slice(2));

const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const ok = (s) => console.log(`${color('32', '  ✔')} ${s}`);
const info = (s) => console.log(`${color('36', '  ›')} ${s}`);
const warn = (s) => console.log(`${color('33', '  !')} ${s}`);
const step = (n, s) => console.log(`\n${color('1', `[${n}/5] ${s}`)}`);

class DeployError extends Error {}
const fail = (msg) => {
  throw new DeployError(msg);
};

/* ------------------------------------------------------------------ helpers */

let accountEnv = {};

/** Runs the project's local wrangler. */
function wrangler(argv, { capture = false, input, interactive = false, env = {} } = {}) {
  const res = spawnSync(process.execPath, [WRANGLER, ...argv], {
    cwd: ROOT,
    stdio: [input !== undefined ? 'pipe' : interactive ? 'inherit' : 'ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    input,
    encoding: 'utf8',
    env: { ...process.env, ...accountEnv, WRANGLER_SEND_METRICS: 'false', ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) fail(`Could not run wrangler: ${res.error.message}`);
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function extractJson(text, open, close) {
  const a = text.indexOf(open);
  const b = text.lastIndexOf(close);
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

/** Reads a line without echoing it (shows * per character). */
function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return finish();
        if (c === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\b' || c === '\u007f') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (c >= ' ') {
          value += c;
          process.stdout.write('*');
        }
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function askNewPassword() {
  console.log('');
  info('Choose the password you will use to sign in to the dashboard (at least 10 characters).');
  for (;;) {
    const p1 = await askHidden('    Admin password: ');
    if (p1.length < 10) {
      warn('Too short – use at least 10 characters.');
      continue;
    }
    const p2 = await askHidden('    Repeat password: ');
    if (p1 !== p2) {
      warn('The passwords do not match, try again.');
      continue;
    }
    return p1;
  }
}

function readConfig() {
  return readFileSync(CONFIG, 'utf8');
}
function configValue(text, key) {
  return text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))?.[1] ?? null;
}

/* ------------------------------------------------------------------ steps */

async function ensureLogin() {
  let who = wrangler(['whoami', '--json'], { capture: true });
  if (who.code !== 0) {
    if (process.env.CLOUDFLARE_API_TOKEN) fail('CLOUDFLARE_API_TOKEN is set but is not valid. Fix or remove it and run again.');
    info('Not signed in to Cloudflare yet – a browser window will open. Approve access, then come back here.');
    const login = wrangler(['login'], { interactive: true });
    if (login.code !== 0) fail('Cloudflare sign-in did not complete.');
    who = wrangler(['whoami', '--json'], { capture: true });
    if (who.code !== 0) fail('Still not signed in to Cloudflare. Run "npx wrangler login" manually and retry.');
  }
  const user = extractJson(who.stdout, '{', '}') ?? {};
  ok(`Signed in${user.email ? ` as ${user.email}` : ''}${user.authType ? ` (${user.authType})` : ''}`);
  return user;
}

async function ensureAccount(user) {
  const text = readConfig();
  const configured = configValue(text, 'account_id');
  const accounts = Array.isArray(user.accounts) ? user.accounts : [];
  if (configured) {
    const acc = accounts.find((a) => a.id === configured);
    ok(`Account: ${acc ? `${acc.name} ` : ''}(${configured}, from wrangler.jsonc)`);
    accountEnv = { CLOUDFLARE_ACCOUNT_ID: configured };
    return;
  }
  if (process.env.CLOUDFLARE_ACCOUNT_ID) {
    ok(`Account: ${process.env.CLOUDFLARE_ACCOUNT_ID} (from CLOUDFLARE_ACCOUNT_ID)`);
    return;
  }
  if (accounts.length <= 1) {
    if (accounts[0]) ok(`Account: ${accounts[0].name} (${accounts[0].id})`);
    await confirmTarget(user);
    return;
  }
  console.log('\n  Your login has access to several Cloudflare accounts:');
  accounts.forEach((a, i) => console.log(`    ${i + 1}) ${a.name}  (${a.id})`));
  let choice;
  while (!choice) {
    const n = Number(await ask(`  Which one should host AppWatch? [1-${accounts.length}]: `));
    choice = accounts[n - 1];
  }
  writeFileSync(CONFIG, text.replace(/("name"\s*:\s*"[^"]*",)/, `$1\n  "account_id": "${choice.id}",`));
  accountEnv = { CLOUDFLARE_ACCOUNT_ID: choice.id };
  ok(`Account: ${choice.name} – saved to wrangler.jsonc`);
}

/** First deploy from this folder: make sure resources land in the intended account. */
async function confirmTarget(user) {
  if (args.has('--yes') || !process.stdin.isTTY || configValue(readConfig(), 'database_id') !== PLACEHOLDER_ID) return;
  const answer = (await ask(`\n  Deploy AppWatch to this Cloudflare account${user.email ? ` (${user.email})` : ''}? [Y/n]: `)).toLowerCase();
  if (answer && !answer.startsWith('y')) {
    fail('Cancelled. To use another account run "npx wrangler logout", then run deploy.bat again and sign in with the right account.');
  }
}

function ensureDatabase() {
  const text = readConfig();
  const name = configValue(text, 'database_name') ?? 'appwatch-db';
  const list = () => {
    const r = wrangler(['d1', 'list', '--json'], { capture: true });
    if (r.code !== 0) fail(`Could not list D1 databases:\n${r.stderr || r.stdout}`);
    return extractJson(r.stdout, '[', ']') ?? [];
  };
  let db = list().find((d) => d.name === name);
  if (db) {
    ok(`D1 database "${name}" exists (${db.uuid})`);
  } else {
    info(`Creating D1 database "${name}" (free tier: 5 GB total, 500 MB per database)…`);
    const r = wrangler(['d1', 'create', name], { capture: true });
    if (r.code !== 0) fail(`Could not create the D1 database:\n${r.stderr || r.stdout}`);
    db = list().find((d) => d.name === name);
    if (!db) fail('The database was created but could not be found afterwards. Run deploy.bat again.');
    ok(`Created D1 database "${name}" (${db.uuid})`);
  }
  const current = configValue(text, 'database_id');
  if (current !== db.uuid) {
    writeFileSync(CONFIG, text.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${db.uuid}$2`));
    ok(`Linked the database in wrangler.jsonc${current && current !== PLACEHOLDER_ID ? ` (was ${current})` : ''}`);
  }
}

function applyMigrations() {
  // stdin is not a terminal here, so wrangler skips its confirmation prompt.
  const r = wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
  if (r.code !== 0) fail('Applying the database migrations failed (see the output above).');
  ok('Database schema is up to date');
}

function deployWorker() {
  const outFile = path.join(tmpdir(), `appwatch-deploy-${process.pid}-${Date.now()}.ndjson`);
  try {
    // Interactive so wrangler can offer to register a free workers.dev subdomain on a new account.
    const r = wrangler(['deploy'], { interactive: true, env: { WRANGLER_OUTPUT_FILE_PATH: outFile } });
    if (r.code !== 0) {
      fail(
        [
          'wrangler deploy failed (see the output above). Common causes:',
          '  • No workers.dev subdomain yet: open https://dash.cloudflare.com → Workers & Pages once, then run again.',
          '  • Cron Trigger limit: the free plan allows 5 per account; AppWatch needs 1.',
          '  • Worker name already used by another app: change "name" in wrangler.jsonc.',
        ].join('\n'),
      );
    }
    let urls = [];
    if (existsSync(outFile)) {
      for (const line of readFileSync(outFile, 'utf8').split('\n')) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'deploy' && Array.isArray(entry.targets)) urls = entry.targets;
        } catch {
          /* not a JSON line */
        }
      }
    }
    return urls.map((u) => (u.startsWith('http') ? u : `https://${u}`)).filter((u) => !u.includes('*'));
  } finally {
    rmSync(outFile, { force: true });
  }
}

function existingSecrets() {
  const r = wrangler(['secret', 'list', '--format', 'json'], { capture: true });
  if (r.code !== 0) return null;
  const list = extractJson(r.stdout, '[', ']');
  return Array.isArray(list) ? list.map((s) => s.name) : null;
}

function putSecrets(values) {
  // Sent through stdin so the values never touch the disk or the process list.
  const r = wrangler(['secret', 'bulk'], { input: JSON.stringify(values), capture: true });
  if (r.code !== 0) fail(`Could not save the secrets:\n${r.stderr || r.stdout}`);
}

/* ------------------------------------------------------------------ main */

async function main() {
  console.log(color('1', '\n  AppWatch → Cloudflare (Workers + D1 + Cron, free tier)\n'));
  if (!existsSync(WRANGLER)) fail('Wrangler is not installed. Run "npm install" first (deploy.bat does this automatically).');

  if (args.has('--help') || args.has('-h')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map((l) => l.replace(/^\/\/ ?/, '  ')).join('\n'));
    return;
  }

  if (args.has('--reset-password')) {
    step(1, 'Cloudflare sign-in');
    await ensureAccount(await ensureLogin());
    step(2, 'New admin password');
    const password = await askNewPassword();
    putSecrets({ ADMIN_PASSWORD: password });
    ok('Password changed. Every existing session is signed out.');
    return;
  }

  step(1, 'Cloudflare sign-in');
  const user = await ensureLogin();
  await ensureAccount(user);

  step(2, 'D1 database');
  ensureDatabase();

  step(3, 'Database migrations');
  applyMigrations();

  step(4, 'Deploying the Worker, dashboard and Cron Trigger');
  const urls = deployWorker();
  ok('Deployed');

  step(5, 'Secrets');
  const secrets = existingSecrets() ?? [];
  const missing = {};
  if (!secrets.includes('SESSION_SECRET')) missing.SESSION_SECRET = randomBytes(48).toString('base64url');
  if (!secrets.includes('ADMIN_PASSWORD')) missing.ADMIN_PASSWORD = await askNewPassword();
  if (Object.keys(missing).length) {
    putSecrets(missing);
    ok(`Saved ${Object.keys(missing).join(' and ')} as encrypted Worker secrets`);
  } else {
    ok('Admin password and session secret already set (use --reset-password to change the password)');
  }

  const url = urls[0];
  console.log(`\n${color('32;1', '  AppWatch is live!')}`);
  if (url) console.log(`\n    Dashboard:  ${color('1', url)}`);
  else console.log('\n    Dashboard:  see the URL printed by wrangler above (Workers & Pages in the Cloudflare dashboard).');
  console.log(`
    • Sign in with your admin password, then add monitors.
    • Settings → Email / WhatsApp / Push to configure alerts (use “Save & send test”).
    • Install it as an app (browser menu → Install) for push notifications on phone and desktop.
    • A brand-new workers.dev URL can take a minute or two before it resolves.
    • Run deploy.bat again any time to update. Change the password with: deploy.bat --reset-password
`);
}

main().catch((e) => {
  if (e instanceof DeployError) console.error(`\n${color('31', '  ✖')} ${e.message}\n`);
  else console.error(e);
  process.exit(1);
});
