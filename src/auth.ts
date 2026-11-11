import { saveSettingStmt } from './settings';
import { b64uDecode, b64uEncode, dec, enc, json, sha256 } from './util';

const COOKIE = 'aw_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60_000;

export function isConfigured(env: Env): boolean {
  return !!env.ADMIN_PASSWORD && !!env.SESSION_SECRET;
}

/** The signing key includes a hash of the password, so changing the password logs every session out. */
async function signingKey(env: Env): Promise<CryptoKey> {
  const material = `${env.SESSION_SECRET}|${b64uEncode(await sha256(env.ADMIN_PASSWORD ?? ''))}`;
  return crypto.subtle.importKey('raw', enc.encode(material), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sessionCookie(env: Env, secure: boolean): Promise<string> {
  const now = Date.now();
  const payload = b64uEncode(JSON.stringify({ iat: now, exp: now + SESSION_DAYS * 86_400_000 }));
  const sig = b64uEncode(await crypto.subtle.sign('HMAC', await signingKey(env), enc.encode(payload)));
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export async function isAuthenticated(req: Request, env: Env): Promise<boolean> {
  if (!isConfigured(env)) return false;
  const m = (req.headers.get('cookie') ?? '').match(/(?:^|;\s*)aw_session=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    const valid = await crypto.subtle.verify('HMAC', await signingKey(env), b64uDecode(m[2]), enc.encode(m[1]));
    if (!valid) return false;
    const { exp } = JSON.parse(dec.decode(b64uDecode(m[1]))) as { exp?: number };
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

export async function login(req: Request, env: Env, body: Record<string, unknown>): Promise<Response> {
  if (!isConfigured(env)) {
    return json({ error: 'The admin password is not set yet. Run deploy.bat to finish the setup.' }, 503);
  }
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  const now = Date.now();
  const attempt = await env.DB.prepare('SELECT failures, window_start FROM login_attempts WHERE ip = ?').bind(ip).first<{ failures: number; window_start: number }>();
  const inWindow = !!attempt && now - attempt.window_start < WINDOW_MS;
  if (inWindow && attempt!.failures >= MAX_FAILURES) {
    const wait = Math.ceil((attempt!.window_start + WINDOW_MS - now) / 60_000);
    return json({ error: `Too many failed attempts. Try again in ${wait} minute(s).` }, 429, { 'retry-after': String(wait * 60) });
  }

  const password = typeof body.password === 'string' ? body.password : '';
  const ok = crypto.subtle.timingSafeEqual(await sha256(password), await sha256(env.ADMIN_PASSWORD!));
  if (!ok) {
    await env.DB.prepare(
      'INSERT INTO login_attempts (ip, failures, window_start) VALUES (?1, ?2, ?3) ON CONFLICT(ip) DO UPDATE SET failures = ?2, window_start = ?3',
    )
      .bind(ip, inWindow ? attempt!.failures + 1 : 1, inWindow ? attempt!.window_start : now)
      .run();
    return json({ error: 'Wrong password.' }, 401);
  }

  const url = new URL(req.url);
  // Remember the public URL so alerts can link back to the dashboard.
  const stmts = [saveSettingStmt(env.DB, 'app_url', url.origin)];
  if (attempt) stmts.push(env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip));
  await env.DB.batch(stmts);
  return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(env, url.protocol === 'https:') });
}
