# AppWatch

Uptime monitoring for your online apps and servers, running entirely on Cloudflare's **free plan**.

- **Admin dashboard (installable PWA):** live status, 24 h / 7 d / 30 d / 90 d uptime, response-time charts, 90-day uptime bars.
- **Downtime metrics:** every outage becomes an incident with its cause, *time to recover* (first failure → back up), time to detect, time to acknowledge, longest outage and total downtime, per server and overall. You can add notes and acknowledge incidents.
- **Per-monitor polling schedule:** 1 min, 5 min, 1 h, 24 h, or any custom value in minutes, hours or days. A separate, faster interval applies while a monitor is failing, so outages are confirmed quickly and recovery time is measured precisely.
- **Everything is recorded:** every check result, every incident, every alert sent (with its delivery result), and every configuration change. Checks and incidents export to CSV.
- **Alerts:** Email over SMTP, Web Push to installed PWAs (desktop, Android, iOS 16.4+) and WhatsApp through [Wasend](https://github.com/mouradsme/wasend). You get DOWN and RECOVERED alerts, plus optional reminders while a monitor stays down.
- **Check types:** HTTP(S) (method, headers, body, accepted status codes, redirects, keyword must or must not appear) and TCP port (databases, SSH, mail servers…).

## Deploy / update

Requirements: **Node.js 22.12+** and a free Cloudflare account.

```bat
deploy.bat
```

The script:

1. installs dependencies (Wrangler is pinned in `package.json`)
2. signs you in to Cloudflare in the browser, if you aren't signed in yet, and asks you to confirm the target account
3. creates the **D1 database** `appwatch-db` and writes its ID into `wrangler.jsonc`
4. applies the database **migrations**
5. deploys the **Worker**, the dashboard (static assets) and a **Cron Trigger** that fires once a minute
6. on the first deploy, asks for the admin password and generates a session secret. Both are stored as encrypted Worker secrets.

It then prints the dashboard URL (`https://appwatch.<your-subdomain>.workers.dev`).

**Updating:** run `deploy.bat` again. Every step is idempotent: existing resources are reused, only new migrations run, and your secrets and data are kept.

| Command | Purpose |
| --- | --- |
| `deploy.bat` | First deploy or update |
| `deploy.bat --reset-password` | Change the admin password. This signs out every session. |
| `deploy.bat --yes` | Skip the "deploy to this account?" confirmation |
| `deploy.bat --no-pause` | Don't wait for a key press at the end (for scripts) |

To deploy to a different Cloudflare account, run `npx wrangler logout` and then run `deploy.bat` again. To deploy from CI, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Setting up alerts

Open **Settings** in the dashboard. Each channel has a **Save & send test** button.

- **Email (SMTP):** choose a provider preset (Gmail, Outlook/365, Zoho, Brevo, Mailgun, SendGrid) or enter your own server. Use port **465 (SSL/TLS)** or **587 (STARTTLS)**, because Cloudflare blocks outbound port 25. Gmail needs an *App Password*.
- **WhatsApp (Wasend):** deploy your own Wasend gateway (it is also a free Cloudflare Worker), pair a WhatsApp session, create an API key (`wsk_…`), then enter the gateway URL, the session ID, the key and the recipient numbers in international format.
- **Push:** open the dashboard on each phone or computer and click **Enable on this device**. On iPhone and iPad, first add the dashboard to the Home Screen (*Share → Add to Home Screen*), then enable push from the installed app.

**Per-monitor recipients:** in a monitor's **Alerts** section you can enter its own email addresses and WhatsApp numbers. If you leave them empty, the defaults from Settings are used. Each monitor can also switch every channel on or off. Push goes to every subscribed device.

Alerts produced by the same check run are combined: each person gets **one** email or WhatsApp message per run, listing only the monitors routed to them.

Use **Test alert** on a monitor's page to send a test through its channels to its actual recipients.

## Free-tier budget

| Resource (free plan) | Limit | AppWatch usage |
| --- | --- | --- |
| Worker requests | 100,000/day | 1,440 cron runs/day + dashboard API calls. Static files are free and unlimited. |
| Cron Triggers | 5 per account | 1 |
| Subrequests per invocation | 50 | Up to about 40 checks per minute (the rest wait for the next minute), with the remainder kept for alerts |
| D1 rows written | 100,000/day | **1 row per healthy check** (+1 later if retention purges it) |
| D1 rows read | 5,000,000/day | About 2 × monitors per minute for scheduling, plus dashboard views |
| D1 database size | 500 MB | About 50 bytes per check. Retention is configurable (default 1 year). |

Example: 30 monitors every 5 minutes is about 8,600 checks/day, which uses around 9–17% of the write quota. **Settings → Free-tier usage** shows the estimate for your own monitors. The dashboard warns you when the schedule gets close to the limit.

## How it works

```
Cron (every minute) ─► Worker scheduled() ─► picks monitors that are due (per-monitor interval)
                                         ├─► runs HTTP / TCP checks (6 in parallel, 50 s budget)
                                         ├─► D1: one batch → checks, incident open/close, state
                                         └─► alerts: SMTP socket · Web Push (VAPID) · Wasend API
Browser (PWA) ─► static assets ─► /api/* on the same Worker (cookie session) ─► D1
```

- `src/engine.ts`: scheduling, the up/down state machine, incidents, housekeeping
- `src/checker.ts`: HTTP and TCP checks
- `src/notify/`: SMTP client (`cloudflare:sockets`), Web Push (RFC 8291 encryption + VAPID, WebCrypto only) and Wasend
- `src/api.ts`: dashboard REST API · `src/auth.ts`: password login and signed session cookie
- `migrations/`: D1 schema · `public/`: dashboard (vanilla JS, no build step) and service worker

**How an incident is measured:** a check fails → the monitor switches to the "while failing" interval → after *N* consecutive failures (the "Alert after" setting) an incident opens. Its start time is the *first* failed check, and the DOWN alert goes out at that point. The first successful check closes the incident and sends the RECOVERED alert. The time to recover is the difference between the two.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars          # set a local ADMIN_PASSWORD
npm run db:migrate:local
npm run dev                             # http://localhost:8787
npm run typecheck
```

To trigger the scheduler locally, use the explorer URL that `wrangler dev` prints (`POST /cdn-cgi/local/explorer/api/local/scheduled?worker=appwatch`).

## Notes and limits

- Checks run from Cloudflare's network. Workers cannot open TCP connections to port 25 or to Cloudflare's own IP ranges.
- The shortest interval is 1 minute, because that is the Cron Trigger's granularity.
- SMTP passwords and the Wasend API key are stored in D1 (encrypted at rest by Cloudflare) and are never sent back to the browser.
- For SSO or a second factor, put the dashboard behind **Cloudflare Access** (Zero Trust, free for up to 50 users). Scheduled checks are not affected.
