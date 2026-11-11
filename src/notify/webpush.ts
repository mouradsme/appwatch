// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291),
// implemented with WebCrypto only – no dependencies.
import { b64uDecode, b64uEncode, concatBytes, enc, errorMessage } from '../util';
import { getSetting } from '../settings';

interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point (65 bytes)
  privateJwk: JsonWebKey;
}

export interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  kind: string;
}

/** Loads the VAPID key pair, generating and storing it on first use. */
export async function getVapidKeys(db: D1Database): Promise<VapidKeys> {
  const stored = await getSetting(db, 'vapid');
  if (stored) return JSON.parse(stored) as VapidKeys;

  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const publicRaw = concatBytes(new Uint8Array([4]), b64uDecode(privateJwk.x!), b64uDecode(privateJwk.y!));
  const keys: VapidKeys = { publicKey: b64uEncode(publicRaw), privateJwk };
  // INSERT OR IGNORE + re-read keeps two concurrent first calls from ending up with different keys.
  await db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind('vapid', JSON.stringify(keys)).run();
  return JSON.parse((await getSetting(db, 'vapid'))!) as VapidKeys;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** RFC 8291 message encryption, single record. */
export async function encryptPayload(payload: Uint8Array, p256dh: string, authSecret: string): Promise<Uint8Array> {
  const uaPublic = b64uDecode(p256dh);
  const auth = b64uDecode(authSecret);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256));

  const keyInfo = concatBytes(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concatBytes(payload, new Uint8Array([2])); // 0x02 = last record delimiter
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes(header, cipher);
}

export async function vapidJwt(audience: string, subject: string, keys: VapidKeys): Promise<string> {
  const header = b64uEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64uEncode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64uEncode(sig)}`;
}

export interface PushResult {
  id: number;
  label: string | null;
  ok: boolean;
  gone: boolean; // subscription expired / revoked – should be deleted
  detail: string;
}

export async function sendPush(subs: PushSubscriptionRow[], payload: PushPayload, keys: VapidKeys, subject: string): Promise<PushResult[]> {
  const body = enc.encode(JSON.stringify(payload));
  const jwtCache = new Map<string, Promise<string>>();
  return Promise.all(
    subs.map(async (sub): Promise<PushResult> => {
      try {
        const audience = new URL(sub.endpoint).origin;
        if (!jwtCache.has(audience)) jwtCache.set(audience, vapidJwt(audience, subject, keys));
        const jwt = await jwtCache.get(audience)!;
        const res = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            ttl: '86400',
            urgency: payload.kind === 'up' ? 'normal' : 'high',
            topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'appwatch',
          },
          body: await encryptPayload(body, sub.p256dh, sub.auth),
        });
        const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200);
        if (!res.ok) res.body?.cancel().catch(() => {});
        return {
          id: sub.id,
          label: sub.label,
          ok: res.ok,
          gone: res.status === 404 || res.status === 410,
          detail: res.ok ? `Delivered (${res.status})` : `HTTP ${res.status} ${text}`.trim(),
        };
      } catch (e) {
        return { id: sub.id, label: sub.label, ok: false, gone: false, detail: errorMessage(e) };
      }
    }),
  );
}
