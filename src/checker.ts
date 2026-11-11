import { connect } from 'cloudflare:sockets';
import type { CheckResult, MonitorRow } from './types';
import { dec, errorMessage, parseHostPort, statusMatches, truncate } from './util';

const USER_AGENT = 'AppWatch-Uptime-Monitor/1.0 (+Cloudflare Workers)';
const MAX_BODY_BYTES = 1_000_000;

/** Cloudflare edge errors are much easier to act on with a short explanation. */
const CF_ERRORS: Record<number, string> = {
  520: 'Web server returned an unknown error',
  521: 'Web server is down (connection refused)',
  522: 'Connection timed out',
  523: 'Origin is unreachable',
  524: 'Origin timed out',
  525: 'SSL handshake failed',
  526: 'Invalid SSL certificate',
  530: 'Origin DNS error / host not resolvable',
};

export async function runCheck(m: MonitorRow, maxTimeoutMs?: number): Promise<CheckResult> {
  const timeout = Math.max(1000, Math.min(m.timeout_ms, maxTimeoutMs ?? m.timeout_ms));
  const t = Date.now();
  try {
    return m.type === 'tcp' ? await tcpCheck(m, t, timeout) : await httpCheck(m, t, timeout);
  } catch (e) {
    const name = (e as Error)?.name;
    const error = name === 'AbortError' || name === 'TimeoutError' ? `Timeout: no response within ${timeout} ms` : describeFetchError(errorMessage(e));
    return { t, ok: false, ms: null, code: null, error: truncate(error, 300) };
  }
}

/** The runtime reports DNS / connection failures as an opaque "internal error". */
function describeFetchError(msg: string): string {
  if (/internal error/i.test(msg)) return `Connection failed: host unreachable or DNS lookup failed (${msg})`;
  if (/network connection lost/i.test(msg)) return 'Connection lost before a response was received';
  if (/certificate|ssl|tls/i.test(msg)) return `TLS/SSL error: ${msg}`;
  return `Request failed: ${msg}`;
}

async function httpCheck(m: MonitorRow, t: number, timeout: number): Promise<CheckResult> {
  const headers = new Headers({ 'user-agent': USER_AGENT, accept: '*/*', 'cache-control': 'no-cache' });
  if (m.headers) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(m.headers) as Record<string, unknown>)) headers.set(k, String(v));
    } catch {
      /* ignore malformed headers; validated on save */
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const init: RequestInit = {
      method: m.method,
      headers,
      redirect: m.follow_redirects ? 'follow' : 'manual',
      signal: ctrl.signal,
      cache: 'no-store',
    };
    if (m.body && m.method !== 'GET' && m.method !== 'HEAD') init.body = m.body;

    const start = Date.now();
    const res = await fetch(m.target, init);
    let ms = Date.now() - start;
    const code = res.status;
    let ok = statusMatches(code, m.expected_status || '200-399');
    let error: string | null = null;
    if (!ok) {
      const hint = CF_ERRORS[code];
      error = `HTTP ${code}${hint ? ` – ${hint}` : res.statusText ? ` ${res.statusText}` : ''} (expected ${m.expected_status})`;
    }

    if (m.keyword && m.method !== 'HEAD') {
      const text = await readLimited(res, MAX_BODY_BYTES);
      ms = Date.now() - start; // include body download when we have to inspect it
      if (ok) {
        const found = text.includes(m.keyword);
        if (m.keyword_mode === 'not_contains' ? found : !found) {
          ok = false;
          error = m.keyword_mode === 'not_contains' ? `Forbidden keyword "${m.keyword}" found in response` : `Keyword "${m.keyword}" not found in response`;
        }
      }
    } else {
      res.body?.cancel().catch(() => {});
    }
    return { t, ok, ms, code, error: truncate(error, 300) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  let text = '';
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      text += dec.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

async function tcpCheck(m: MonitorRow, t: number, timeout: number): Promise<CheckResult> {
  const { hostname, port } = parseHostPort(m.target);
  const start = Date.now();
  const socket = connect({ hostname, port });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      socket.opened,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeout);
      }),
    ]);
    return { t, ok: true, ms: Date.now() - start, code: null, error: null };
  } catch (e) {
    const name = (e as Error)?.name;
    const error = name === 'TimeoutError' ? `Timeout: TCP connect to ${hostname}:${port} took more than ${timeout} ms` : `TCP connect to ${hostname}:${port} failed: ${errorMessage(e)}`;
    return { t, ok: false, ms: null, code: null, error: truncate(error, 300) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    socket.close().catch(() => {});
  }
}
