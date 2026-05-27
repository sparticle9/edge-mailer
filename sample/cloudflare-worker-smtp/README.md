# Cloudflare Worker SMTP Sample

Cloudflare Workers sample for `edge-mailer/cloudflare` using
`cloudflare:sockets`. It sends through real SMTP on `587` STARTTLS or `465`
implicit TLS.

## Env

Start from the root `env.example` and copy the sections you need into a local
ignored env file.

Repo root `.env` for Wrangler auth:

```env
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

Ignored Worker runtime secret file:
`sample/cloudflare-worker-smtp/.env.production`

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USERNAME=sender@example.com
SMTP_PASSWORD=secret
TEST_RECIPIENT_EMAIL=recipient@example.net
SMTP_AUTH_TYPE=plain,login
SAMPLE_SEND_TOKEN=generate-a-long-random-token
```

For XOAUTH2, set `SMTP_AUTH_TYPE=xoauth2` and
`SMTP_XOAUTH2_ACCESS_TOKEN=<access-token>` instead of `SMTP_PASSWORD`.

Optional runtime env:

```env
SMTP_FROM=sender@example.com
SMTP_REPLY_TO=reply@example.com
SMTP_POOL_MAX_CONNECTIONS=1
SMTP_POOL_MAX_MESSAGES_PER_CONNECTION=20
SMTP_POOL_IDLE_TIMEOUT_MS=1000
DKIM_DOMAIN=example.com
DKIM_SELECTOR=mail
DKIM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Set `DKIM_*` only for Edge Mailer self-signing. If your SMTP provider manages
DKIM, it keeps the private key and gives you only the DNS TXT public key
(`p=...`); leave `DKIM_PRIVATE_KEY` unset. For self-signing, publish the public
key matching `DKIM_PRIVATE_KEY` at
`<DKIM_SELECTOR>._domainkey.<DKIM_DOMAIN>`.

Minimum Cloudflare token permissions:

- Account: `Workers Scripts Write`
- Account: `Account Settings Read`
- Account: `Workers Tail Read` only when using `wrangler tail`

No zone permissions are needed for `workers_dev = true`.

## Local Smoke

```sh
pnpm run test:smoke:cloudflare
```

Expected email:

| Count | Recipient                           | Subject                                           |
| ----- | ----------------------------------- | ------------------------------------------------- |
| 1     | `SMTP_TO` or `TEST_RECIPIENT_EMAIL` | `[edge-mailer sample] cloudflare-<ISO timestamp>` |

The local smoke sends text, HTML, custom headers, and
`edge-mailer-sample.txt` as a raw-byte attachment through a bounded pool.

To request and capture SMTP DSN evidence during the local smoke:

```sh
SMTP_SMOKE_DSN=1 pnpm run test:smoke:cloudflare
```

This writes a JSON capture under `smoke-artifacts/` by default. The capture
records the generated `ENVID`, requested `RET/NOTIFY` values, SMTP acceptance,
and whether observation saw the server advertise `DSN`.

## Deploy

```sh
direnv exec . pnpm exec wrangler whoami

direnv exec . pnpm exec wrangler deploy \
  --config sample/cloudflare-worker-smtp/wrangler.toml \
  --secrets-file sample/cloudflare-worker-smtp/.env.production
```

Set the deployed URL from Wrangler output:

```sh
export WORKER_URL="https://edge-mailer-sample-cloudflare.<your-subdomain>.workers.dev"
```

## Live Smoke

```sh
direnv exec . node - <<'NODE'
const url = process.env.WORKER_URL
if (!url) throw new Error('Set WORKER_URL first')

const fs = require('node:fs')
const envText = fs.readFileSync('sample/cloudflare-worker-smtp/.env.production', 'utf8')
const token = envText.match(/^SAMPLE_SEND_TOKEN=(.*)$/m)?.[1]
if (!token) throw new Error('Missing SAMPLE_SEND_TOKEN')

const json = async response => {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

const get = await fetch(url)
const health = await json(get)
console.log('GET', get.status, health)
if (!get.ok || !health.configured || !health.protected) throw new Error('not ready')

const denied = await fetch(url, { method: 'POST', body: '{}' })
console.log('POST without token', denied.status, await json(denied))
if (denied.status !== 401) throw new Error('expected 401')

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

const basic = await fetch(url, { method: 'POST', headers, body: '{}' })
const basicPayload = await json(basic)
console.log('POST basic', basic.status, basicPayload.subject, basicPayload.messageId)
if (!basic.ok || !basicPayload.accepted) throw new Error('basic send failed')

const rich = await fetch(url, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    subject: `[edge-mailer sample] Cloudflare rich MIME ${new Date().toISOString()}`,
    text: 'Cloudflare rich MIME smoke.',
    html: '<p>Cloudflare rich MIME smoke <img src="cid:logo"></p>',
    attachments: [
      { filename: 'inline-logo.txt', content: btoa('inline logo'), mimeType: 'text/plain', contentId: 'logo', disposition: 'inline' },
      { filename: 'plain.txt', content: 'plain ascii attachment', mimeType: 'text/plain', encoding: '7bit' },
      { filename: 'utf8.txt', content: 'ümlaut attachment', mimeType: 'text/plain', encoding: 'quoted-printable' },
      { filename: 'base64.txt', content: btoa('base64 attachment'), mimeType: 'text/plain' },
    ],
  }),
})
const richPayload = await json(rich)
console.log('POST rich', rich.status, richPayload.subject, richPayload.messageId)
if (!rich.ok || !richPayload.accepted) throw new Error('rich send failed')
NODE
```

Expected live smoke emails:

| Count | Recipient                           | Subject                                                     |
| ----- | ----------------------------------- | ----------------------------------------------------------- |
| 1     | `SMTP_TO` or `TEST_RECIPIENT_EMAIL` | `[edge-mailer sample] cloudflare-<ISO timestamp>`           |
| 1     | `SMTP_TO` or `TEST_RECIPIENT_EMAIL` | `[edge-mailer sample] Cloudflare rich MIME <ISO timestamp>` |

SMTP acceptance means the provider accepted the message. Inbox placement still
depends on provider queueing, sender policy, spam filtering, and mailbox rules.
DSN smoke capture is best-effort evidence only; it does not run a webhook or
mailbox receiver.

## Notes

- Keep `SAMPLE_SEND_TOKEN` set for hosted deployments; otherwise POST is public.
- Workers cannot open outbound TCP sockets to port `25`.
- For logs: `direnv exec . pnpm exec wrangler tail --config sample/cloudflare-worker-smtp/wrangler.toml`.
- Cloudflare docs: [Wrangler env vars](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/), [secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).
