// Minimal SMTP client over Cloudflare TCP sockets (cloudflare:sockets).
// Supports implicit TLS (port 465), STARTTLS (port 587) and AUTH PLAIN / AUTH LOGIN.
// Note: Cloudflare blocks outbound port 25.
import { connect } from 'cloudflare:sockets';
import type { SmtpSettings } from '../types';
import { bytesToB64, enc, randomToken } from '../util';

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

class SmtpError extends Error {}

class SmtpConnection {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = '';
  private decoder = new TextDecoder();

  constructor(socket: Socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async readReply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) === -1) {
        const { done, value } = await this.reader.read();
        if (done) throw new SmtpError(`Server closed the connection${lines.length ? `: ${lines.join(' | ')}` : ''}`);
        this.buffer += this.decoder.decode(value, { stream: true });
      }
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      lines.push(line);
      if (/^\d{3}( |$)/.test(line)) return { code: parseInt(line.slice(0, 3), 10), text: lines.join('\n') };
      if (!/^\d{3}-/.test(line)) throw new SmtpError(`Unexpected reply: ${line}`);
    }
  }

  async write(data: string): Promise<void> {
    await this.writer.write(enc.encode(data));
  }

  /** Sends a command and checks the reply code. `label` replaces the command text in errors (hides credentials). */
  async command(cmd: string, expect: number[], label?: string): Promise<{ code: number; text: string }> {
    await this.write(cmd + '\r\n');
    const reply = await this.readReply();
    if (!expect.includes(reply.code)) throw new SmtpError(`${label ?? cmd} → ${reply.text}`);
    return reply;
  }

  release(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }
}

const b64 = (s: string) => bytesToB64(enc.encode(s));

function wrap76(b64text: string): string {
  return b64text.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

/** RFC 2047 encoded-words for header values that are not plain ASCII. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const chars = Array.from(value);
  const words: string[] = [];
  for (let i = 0; i < chars.length; i += 12) words.push(`=?UTF-8?B?${b64(chars.slice(i, i + 12).join(''))}?=`);
  return words.join('\r\n ');
}

function formatAddress(name: string, email: string): string {
  if (!name) return `<${email}>`;
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/["\\]/g, '')}" <${email}>`;
  return `${encodeHeader(name)} <${email}>`;
}

function buildMime(cfg: SmtpSettings, msg: MailMessage): string {
  const boundary = `aw_${randomToken(12)}`;
  const domain = cfg.from_email.split('@')[1] || 'appwatch.local';
  const headers = [
    `From: ${formatAddress(cfg.from_name, cfg.from_email)}`,
    `To: ${msg.to.join(', ')}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomToken(16)}@${domain}>`,
    'MIME-Version: 1.0',
    'X-Mailer: AppWatch',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, content: string) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(content))}\r\n`;
  return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', msg.text)}${part('text/html', msg.html)}--${boundary}--`;
}

/** Sends one message. Resolves with the server's final reply, rejects with a readable error. */
export async function sendMail(cfg: SmtpSettings, msg: MailMessage, timeoutMs = 25_000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let socket: Socket | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpError(`Timed out after ${timeoutMs / 1000}s talking to ${cfg.host}:${cfg.port}`)), timeoutMs);
  });

  const run = async (): Promise<string> => {
    const secureTransport = cfg.security === 'tls' ? 'on' : cfg.security === 'starttls' ? 'starttls' : 'off';
    socket = connect({ hostname: cfg.host, port: cfg.port }, { secureTransport, allowHalfOpen: false });
    let conn = new SmtpConnection(socket);
    const heloName = cfg.from_email.split('@')[1] || 'appwatch.local';

    const greeting = await conn.readReply();
    if (greeting.code !== 220) throw new SmtpError(`Greeting → ${greeting.text}`);
    let ehlo = await conn.command(`EHLO ${heloName}`, [250]);

    if (cfg.security === 'starttls') {
      await conn.command('STARTTLS', [220]);
      conn.release();
      socket = socket.startTls({ expectedServerHostname: cfg.host });
      conn = new SmtpConnection(socket);
      ehlo = await conn.command(`EHLO ${heloName}`, [250]);
    }

    if (cfg.username) {
      const authLine = ehlo.text.split('\n').find((l) => /^250[- ]AUTH[ =]/i.test(l))?.toUpperCase() ?? '';
      if (authLine.includes('LOGIN') && !authLine.includes('PLAIN')) {
        await conn.command('AUTH LOGIN', [334]);
        await conn.command(b64(cfg.username), [334], 'AUTH LOGIN (username)');
        await conn.command(b64(cfg.password), [235], 'AUTH LOGIN (password)');
      } else {
        await conn.command(`AUTH PLAIN ${b64(`\0${cfg.username}\0${cfg.password}`)}`, [235], 'AUTH PLAIN');
      }
    }

    await conn.command(`MAIL FROM:<${cfg.from_email}>`, [250]);
    for (const rcpt of msg.to) await conn.command(`RCPT TO:<${rcpt}>`, [250, 251]);
    await conn.command('DATA', [354]);
    // Body parts are base64, so no line can start with "." – dot-stuffing kept for safety.
    const data = buildMime(cfg, msg).replace(/\r\n\./g, '\r\n..');
    await conn.write(`${data}\r\n.\r\n`);
    const accepted = await conn.readReply();
    if (accepted.code !== 250) throw new SmtpError(`Message rejected → ${accepted.text}`);
    await conn.write('QUIT\r\n').catch(() => {});
    return accepted.text;
  };

  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // `socket` is reassigned by run(); TS cannot see that, so read it through a cast.
    (socket as Socket | undefined)?.close().catch(() => {});
  }
}
