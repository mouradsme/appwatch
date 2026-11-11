// WhatsApp notifications through a self-hosted Wasend gateway (https://github.com/mouradsme/wasend).
// API: POST {base}/v1/sessions/{session}/messages  (Bearer wsk_… API key)
//      body {"to":"+15551234567","text":"…","kind":"transactional"} → 202 Accepted
import type { WasendSettings } from '../types';
import { errorMessage, splitList } from '../util';

export interface WasendResult {
  to: string;
  ok: boolean;
  detail: string;
}

/** Same rule Wasend applies to `to`. */
export const WASEND_PHONE_RE = /^\+[1-9]\d{6,14}$/;

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : `+${digits.replace(/^00/, '')}`;
}

/**
 * Wasend only accepts idempotency keys matching /^[\w.:/-]{1,128}$/ and remembers each key for
 * 24 h per session, so the key must also be unique per recipient.
 */
export function wasendIdempotencyKey(base: string, to: string): string {
  return `${base}.${to.replace(/\D/g, '')}`.replace(/[^\w.:/-]/g, '_').slice(0, 128);
}

/** Normalizes and de-duplicates a comma separated list of WhatsApp numbers. */
export function phoneList(raw: string | null | undefined): string[] {
  return [...new Set(splitList(raw).map(normalizePhone))];
}

/** Sends `text` to each recipient (defaults to the numbers configured in Settings). */
export async function sendWasend(cfg: WasendSettings, text: string, idempotencyKey: string, to?: string[]): Promise<WasendResult[]> {
  const url = `${cfg.base_url.replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(cfg.session)}/messages`;
  const recipients = to ?? phoneList(cfg.recipients);
  return Promise.all(
    recipients.map(async (to): Promise<WasendResult> => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${cfg.api_key}`,
            'content-type': 'application/json',
            'idempotency-key': wasendIdempotencyKey(idempotencyKey, to),
          },
          body: JSON.stringify({ to, text, kind: 'transactional' }),
          signal: AbortSignal.timeout(15_000),
        });
        const bodyText = (await res.text().catch(() => '')).slice(0, 300);
        if (res.ok) {
          let id = '';
          try {
            id = (JSON.parse(bodyText) as { id?: string }).id ?? '';
          } catch {
            /* not JSON */
          }
          return { to, ok: true, detail: `Accepted (${res.status})${id ? ` ${id}` : ''}` };
        }
        let reason = bodyText;
        try {
          const j = JSON.parse(bodyText) as { error?: string | { code?: string; message?: string }; message?: string };
          reason = typeof j.error === 'string' ? j.error : j.error?.message ?? j.error?.code ?? j.message ?? bodyText;
        } catch {
          /* not JSON */
        }
        return { to, ok: false, detail: `HTTP ${res.status}: ${reason}` };
      } catch (e) {
        return { to, ok: false, detail: errorMessage(e) };
      }
    }),
  );
}
