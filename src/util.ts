export const enc = new TextEncoder();
export const dec = new TextDecoder();

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/* ---------- bytes / base64url ---------- */

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function b64uEncode(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === 'string' ? enc.encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function randomToken(bytes = 32): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
}

/* ---------- formatting ---------- */

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function fmtDate(ts: number, timeZone = 'UTC'): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}

export function truncate(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* ---------- HTTP status expectations ---------- */

export const STATUS_SPEC_RE = /^\s*\d{3}(\s*-\s*\d{3})?(\s*,\s*\d{3}(\s*-\s*\d{3})?)*\s*$/;

export function statusMatches(code: number, spec: string): boolean {
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map((x) => parseInt(x.trim(), 10));
    if (Number.isNaN(a)) continue;
    if (b === undefined || Number.isNaN(b) ? code === a : code >= a && code <= b) return true;
  }
  return false;
}

/** Splits a comma / semicolon / newline separated list and trims it. */
export function splitList(s: string | null | undefined): string[] {
  return (s ?? '')
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseHostPort(target: string): { hostname: string; port: number } {
  const t = target.trim().replace(/^tcp:\/\//i, '');
  const m = t.match(/^\[([^\]]+)\]:(\d{1,5})$/) ?? t.match(/^([^:\s/]+):(\d{1,5})$/);
  if (!m) throw new HttpError(400, 'TCP target must look like host:port');
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw new HttpError(400, 'TCP port must be between 1 and 65535');
  return { hostname: m[1], port };
}

/** Runs `fn` over `items` with at most `limit` in flight. Preserves order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
