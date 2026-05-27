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
    const receipt = await EdgeMailer.send(
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

    return Response.json({ ok: true, messageId: receipt.messageId })
  },
}
```

Use `DenoMailer` from Deno:

```ts
import { DenoMailer } from 'edge-mailer/deno'

const receipt = await DenoMailer.send(
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

console.log(receipt.messageId)
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
    console.log(error.enhancedStatusCode)
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

Run the SMTP core tests against a real local SMTP server:

```sh
pnpm run test:smtp-core
```

Run Deno checks:

```sh
pnpm run check:deno
pnpm run test:deno
```

The Deno sample owns its own `sample/deno-smtp/deno.json`; the repo root does
not use a root Deno config.

Build the package:

```sh
pnpm run build
```

Format the repo:

```sh
pnpm run format
```

## Release Management

Public releases use SemVer with `vX.Y.Z` GitHub releases. The package version
must stay in sync across `package.json`, `jsr.json`, the Git tag, npm, and JSR.

Run the local release gate:

```sh
pnpm run release:dry-run
```

Future release notes and version bumps should start with Changesets:

```sh
pnpm changeset
pnpm run version
```

The first public release is bootstrapped directly as `0.6.0`. Publishing is
triggered by publishing a GitHub Release with the matching tag, for example
`v0.6.0`. The release workflow publishes `edge-mailer` to npm and
`@sparticle9/edge-mailer` to JSR without attaching GitHub release artifacts.

Before the first JSR publish, create the `@sparticle9/edge-mailer` package on
JSR and link it to `sparticle9/edge-mailer` for GitHub Actions OIDC. Before the
first npm publish, configure npm trusted publishing for `sparticle9/edge-mailer`
and `.github/workflows/publish.yml`; no npm token secret is used. If npm does
not allow trusted-publisher setup before the first package version exists,
publish `0.6.0` once with local interactive 2FA and without provenance, then
configure trusted publishing. The release workflow skips npm when the matching
version is already published.

## Test Layout

Tests are grouped by runtime purpose:

- `test/unit/`: Cloudflare-pool Vitest unit tests and runtime boundary checks.
- `test/smtp-core/`: Node Vitest tests for shared SMTP session behavior against
  a real local SMTP server.
- `test/deno/`: Deno-native connector tests.
- `test/cloudflare-worker/`: Wrangler Worker smoke harness used by the SMTP
  smoke script.

## Runtime Samples

Samples live under `sample/`.

Run the Cloudflare Worker sample from the repo root:

```sh
pnpm run test:smoke:cloudflare
```

Run the Deno direct SMTP smoke from the repo root:

```sh
pnpm run test:smoke:deno
```

Run the Deno HTTP sample locally:

```sh
direnv exec . sh -c 'cd sample/deno-smtp && deno task serve'
```

Runtime sample quickstarts and hosted deployment commands live in
[sample](sample), [sample/cloudflare-worker-smtp](sample/cloudflare-worker-smtp),
and [sample/deno-smtp](sample/deno-smtp).

Deno Deploy v2 must use the current `deno deploy` CLI. Deploy v2 runs the
standard Deno runtime with `--allow-all`; custom Deno runtime flags cannot be
passed. Deno Deploy support remains experimental until the live smoke matrix and
operational guidance are broader than the current single-app SMTP acceptance
proof.

## SMTP Core Server Suite

`pnpm run test:smtp-core` starts a local SMTP server with Nodemailer's
`smtp-server` package. This is a real SMTP parser/server for the shared SMTP
core and covers AUTH, including XOAUTH2, implicit TLS, STARTTLS, PIPELINING,
SIZE, 8BITMIME, SMTPUTF8, REQUIRETLS, DSN, and RSET recovery without using
external credentials.

## SMTP Smoke

Put real smoke credentials in local `.env`; `.envrc` loads them through direnv.
Do not commit real credentials.

```env
SMTP_HOST=smtp.example.com
SMTP_USERNAME=sender@example.com
SMTP_PASSWORD=secret
TEST_RECIPIENT_EMAIL=recipient@example.net
SMTP_AUTH_TYPE=plain,login
SMTP_POOL_MAX_CONNECTIONS=1
SMTP_POOL_MAX_MESSAGES_PER_CONNECTION=20
```

For XOAUTH2 smoke, use `SMTP_AUTH_TYPE=xoauth2` and
`SMTP_XOAUTH2_ACCESS_TOKEN` instead of `SMTP_PASSWORD`. Tokens must stay in
local env/secret storage and are never printed by the smoke scripts.

Run the smoke harness:

```sh
pnpm run test:smoke:smtp
```

The smoke harness starts a local Wrangler Worker, sends through port `587`
with STARTTLS, then sends through port `465` with implicit TLS.

Expected emails for `pnpm run test:smoke:smtp`:

| Count | Recipient                           | Subject                                              |
| ----- | ----------------------------------- | ---------------------------------------------------- |
| 1     | `SMTP_TO` or `TEST_RECIPIENT_EMAIL` | `[edge-mailer smoke] 587 text <ISO timestamp>`       |
| 1     | `SMTP_TO` or `TEST_RECIPIENT_EMAIL` | `[edge-mailer smoke] 587 html <ISO timestamp>`       |
| 1     | `SMTP_TO` or `TEST_RECIPIENT_EMAIL` | `[edge-mailer smoke] 465 attachment <ISO timestamp>` |

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
