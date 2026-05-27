# Deno SMTP Sample

Deno sample for `edge-mailer/deno` using `Deno.connect`,
`Deno.connectTls`, and `Deno.startTls`. It runs locally with Deno CLI and can be
deployed to Deno Deploy v2.

## Env

Start from the root `env.example` and copy the sections you need into a local
ignored env file.

Repo root `.env` for Deploy auth:

```env
DENO_ACCESS_TOKEN=your-deno-token
DENO_DEPLOY_ORG=your-org
DENO_DEPLOY_APP=edge-mailer-deno-smtp-smoke
```

Ignored runtime env file: `sample/deno-smtp/.env.production`

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
SMTP_RESPONSE_TIMEOUT_MS=30000
SMTP_SOCKET_TIMEOUT_MS=30000
DKIM_DOMAIN=example.com
DKIM_SELECTOR=mail
DKIM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Set `DKIM_*` only for Edge Mailer self-signing. If your SMTP provider manages
DKIM, it keeps the private key and gives you only the DNS TXT public key
(`p=...`); leave `DKIM_PRIVATE_KEY` unset. For self-signing, publish the public
key matching `DKIM_PRIVATE_KEY` at
`<DKIM_SELECTOR>._domainkey.<DKIM_DOMAIN>`.

This sample owns `deno.json`; the package root intentionally does not.

## Local Smoke

```sh
direnv exec . sh -c 'cd sample/deno-smtp && deno task smoke'
```

Expected email:

| Count | Recipient                           | Subject                                    |
| ----- | ----------------------------------- | ------------------------------------------ |
| 1     | `SMTP_TO` or `TEST_RECIPIENT_EMAIL` | `[edge-mailer smoke] deno-<ISO timestamp>` |

The local smoke sends text, HTML, custom headers, and
`edge-mailer-smoke.txt` as a raw-byte attachment through a bounded pool.

To request and capture SMTP DSN evidence during the local smoke:

```sh
SMTP_SMOKE_DSN=1 direnv exec . sh -c 'cd sample/deno-smtp && deno task smoke'
```

This writes a JSON capture under `smoke-artifacts/` by default. The capture
records the generated `ENVID`, requested `RET/NOTIFY` values, SMTP acceptance,
and whether observation saw the server advertise `DSN`.

## Local HTTP Server

```sh
direnv exec . sh -c 'cd sample/deno-smtp && deno task serve'
```

## Deploy

Create the app once:

```sh
direnv exec . deno deploy create \
  --token "$DENO_ACCESS_TOKEN" \
  --org "$DENO_DEPLOY_ORG" \
  --app "$DENO_DEPLOY_APP" \
  --source local \
  --runtime-mode dynamic \
  --entrypoint sample/deno-smtp/main.ts \
  --region global \
  --do-not-use-detected-build-config \
  .
```

Upload runtime env:

```sh
direnv exec . deno deploy env load sample/deno-smtp/.env.production \
  --replace \
  --token "$DENO_ACCESS_TOKEN" \
  --org "$DENO_DEPLOY_ORG" \
  --app "$DENO_DEPLOY_APP"
```

Deploy:

```sh
direnv exec . deno deploy \
  --token "$DENO_ACCESS_TOKEN" \
  --org "$DENO_DEPLOY_ORG" \
  --app "$DENO_DEPLOY_APP" \
  --prod \
  --ignore=AGENTS.md \
  --ignore=.env \
  --ignore=node_modules \
  --ignore=dist \
  .
```

Set the deployed URL:

```sh
export DENO_SAMPLE_URL="https://<app>.<org>.deno.net"
```

## Live Smoke

```sh
direnv exec . node - <<'NODE'
const url = process.env.DENO_SAMPLE_URL
if (!url) throw new Error('Set DENO_SAMPLE_URL first')

const fs = require('node:fs')
const envText = fs.readFileSync('sample/deno-smtp/.env.production', 'utf8')
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
    subject: `[edge-mailer sample] Deno rich MIME ${new Date().toISOString()}`,
    text: 'Deno rich MIME smoke.',
    html: '<p>Deno rich MIME smoke <img src="cid:logo"></p>',
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

| Count | Recipient                           | Subject                                               |
| ----- | ----------------------------------- | ----------------------------------------------------- |
| 1     | `SMTP_TO` or `TEST_RECIPIENT_EMAIL` | `[edge-mailer sample] Deno <ISO timestamp>`           |
| 1     | `SMTP_TO` or `TEST_RECIPIENT_EMAIL` | `[edge-mailer sample] Deno rich MIME <ISO timestamp>` |

SMTP acceptance means the provider accepted the message. Inbox placement still
depends on provider queueing, sender policy, spam filtering, and mailbox rules.
DSN smoke capture is best-effort evidence only; it does not run a webhook or
mailbox receiver.

## Notes

- Keep `SAMPLE_SEND_TOKEN` set for hosted deployments; otherwise POST is public.
- Use `deno deploy`, not `deployctl`.
- Deno Deploy v2 runs with `--allow-all` and does not accept custom runtime flags.
- For logs: `direnv exec . deno deploy logs --token "$DENO_ACCESS_TOKEN" --org "$DENO_DEPLOY_ORG" --app "$DENO_DEPLOY_APP"`.
- Deno docs: [Deploy CLI](https://docs.deno.com/runtime/reference/cli/deploy/), [Deploy runtime](https://docs.deno.com/deploy/reference/runtime/), [Deno.connectTls](https://docs.deno.com/api/deno/~/Deno.connectTls), [Deno.startTls](https://docs.deno.com/api/deno/~/Deno.startTls).
