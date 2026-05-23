# Development

## Quickstart

Configure the Worker compatibility date:

```toml
compatibility_date = "2026-05-18"
```

Edge Mailer uses Workers-native APIs and does not require `nodejs_compat`.

Use `EdgeMailer` from a Cloudflare Worker:

```ts
import { EdgeMailer } from 'edge-mailer/cloudflare'

export default {
  async fetch() {
    await EdgeMailer.send(
      {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        startTls: true,
        credentials: {
          username: 'sender@example.com',
          password: 'smtp-password',
        },
        authType: ['plain', 'login'],
      },
      {
        from: { name: 'Edge Mailer', email: 'sender@example.com' },
        to: 'recipient@example.net',
        subject: 'SMTP from Cloudflare Workers',
        text: 'Hello from Edge Mailer.',
        html: '<p>Hello from <strong>Edge Mailer</strong>.</p>',
      },
    )

    return Response.json({ ok: true })
  },
}
```

Use `DenoMailer` from Deno:

```ts
import { DenoMailer } from 'edge-mailer/deno'

await DenoMailer.send(
  {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    startTls: true,
    credentials: {
      username: 'sender@example.com',
      password: 'smtp-password',
    },
    authType: ['plain', 'login'],
  },
  {
    from: 'sender@example.com',
    to: 'recipient@example.net',
    subject: 'SMTP from Deno',
    text: 'Hello from Edge Mailer.',
  },
)
```

For Queue consumers or scheduled jobs, reuse one SMTP session per invocation:

```ts
import { EdgeMailer, type EmailOptions } from 'edge-mailer/cloudflare'

type Env = {
  SMTP_HOST: string
  SMTP_PORT?: string
  SMTP_USERNAME: string
  SMTP_PASSWORD: string
  SMTP_FROM: string
}

export default {
  async queue(batch: MessageBatch<EmailOptions>, env: Env) {
    const port = Number(env.SMTP_PORT || 587)
    const results = await EdgeMailer.sendBatch(
      {
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        startTls: port !== 465,
        credentials: {
          username: env.SMTP_USERNAME,
          password: env.SMTP_PASSWORD,
        },
        authType: ['plain', 'login'],
      },
      batch.messages.map(message => ({
        from: env.SMTP_FROM,
        ...message.body,
      })),
      { continueOnError: true },
    )

    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        batch.messages[index].ack()
      } else {
        batch.messages[index].retry()
      }
    }
  },
} satisfies ExportedHandler<Env, EmailOptions>
```

SMTP failures throw `SMTPError` when the error came from the SMTP session.

```ts
import { EdgeMailer, SMTPError } from 'edge-mailer/cloudflare'

try {
  await EdgeMailer.send(config, email)
} catch (error) {
  if (error instanceof SMTPError) {
    console.log(error.stage)
    console.log(error.command)
    console.log(error.responseCode)
    console.log(error.transient)
  }
  throw error
}
```

Use `SMTPError.transient` at the Queue or job layer to decide whether a send
attempt should be retried.

## Local Checks

Install dependencies:

```sh
pnpm install
```

Run the unit tests:

```sh
pnpm test -- --run
```

Run Deno checks:

```sh
deno check
deno test
```

The same checks are available through `deno task check` and `deno task test`.

Build the package:

```sh
pnpm run build
```

Format the repo:

```sh
pnpm run format
```

## Runtime Samples

Samples live under `sample/`.

Run the Cloudflare Worker sample from the repo root:

```sh
direnv exec . pnpm exec wrangler dev --config sample/cloudflare-worker-smtp/wrangler.toml --local
```

Run the Deno direct SMTP smoke from the repo root:

```sh
direnv exec . deno task smoke:deno
```

Run the Deno HTTP sample locally:

```sh
direnv exec . deno task serve:deno
```

Deno Deploy v2 must use the current `deno deploy` CLI. Deploy v2 runs the
standard Deno runtime with `--allow-all`; custom Deno runtime flags cannot be
passed. Deno Deploy support remains experimental until the deployed sample sends
through real SMTP credentials.

## SMTP Smoke

Create `test/env.smtp-smoke` locally for the Cloudflare smoke harness. The file
is ignored by git. For Deno and deploy smokes, put credentials in local `.env`
and run commands through `direnv exec .`.

```env
SMTP_HOST=smtp.example.com
SMTP_USERNAME=sender@example.com
SMTP_PASSWORD=secret
SMTP_FROM=sender@example.com
SMTP_TO=recipient@example.net
SMTP_AUTH_TYPE=plain,login
```

Run the smoke harness:

```sh
pnpm run test:smoke:smtp
```

The smoke harness starts a local Wrangler Worker, sends through port `587`
with STARTTLS, then sends through port `465` with implicit TLS.

## Reports

When reporting a delivery or compatibility issue, include:

- Runtime: local Wrangler, deployed Cloudflare Worker, or another target.
- Edge Mailer commit SHA.
- SMTP provider and port, for example `smtp.example.com:587`.
- TLS mode: implicit TLS, STARTTLS, or plaintext test server.
- Auth method requested and auth method advertised by the server.
- Redacted config with passwords, tokens, and recipient PII removed.
- The structured `SMTPError` fields: `stage`, `command`, `response`,
  `responseCode`, and `transient`.
- Whether the failure is reproducible with `pnpm run test:smoke:smtp`.

Never share SMTP passwords, OAuth tokens, private keys, or full recipient lists
in reports.
