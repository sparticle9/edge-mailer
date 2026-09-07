# Edge Mailer

Edge Mailer is a serverless SMTP submission toolkit for applications that need
to send through existing SMTP infrastructure from modern edge runtimes.

The current implementation supports Cloudflare Workers and Deno as first-class
edge runtimes. The public API is versioned as a `0.x` prerelease surface.

Install from npm for Cloudflare Workers and Node-compatible build pipelines:

```sh
pnpm add edge-mailer
```

Use the JSR package for Deno:

```sh
deno add jsr:@sparticle9/edge-mailer
```

## Why use it?

Send transactional email from Cloudflare Workers or Deno using SMTP
infrastructure you already control. Keep the same message API across both
runtimes, with zero third-party runtime dependencies, typed receipts and errors,
TLS, attachments, and calendar invites.

Good first projects are contact-form notifications, queued account emails,
small scheduled reports, and booking invitations. See [USE-CASES.md](USE-CASES.md)
for recipes, retry decisions, and the application responsibilities for each.

Start with the runnable [contact form](https://github.com/sparticle9/edge-mailer/tree/main/sample/contact-form)
or [durable D1 outbox](https://github.com/sparticle9/edge-mailer/tree/main/sample/durable-outbox).
They include setup, abuse checks or retry/reconciliation policy, and
[0.8.5 scenario verdicts](https://github.com/sparticle9/edge-mailer/blob/main/sample/VERDICTS-0.8.5.md).
The starters live in the repository; npm and JSR contain the SMTP library and docs.

## First send

Call this from your server-side application after authorizing the action.
Supply SMTP settings through runtime secrets:

```ts
import { EdgeMailer } from 'edge-mailer/cloudflare'

const receipt = await EdgeMailer.send(
  {
    host: env.SMTP_HOST,
    port: 587,
    startTls: true,
    tlsPolicy: 'require-starttls',
    credentials: {
      username: env.SMTP_USERNAME,
      password: env.SMTP_PASSWORD,
    },
  },
  {
    from: 'sender@example.com',
    to: 'recipient@example.net',
    subject: 'Your report is ready',
    text: 'Your report is ready to view.',
  },
)

console.log({
  attemptId: receipt.attemptId,
  responseCode: receipt.responseCode,
})
```

For Deno, import `DenoMailer` from `jsr:@sparticle9/edge-mailer/deno` and use
`DenoMailer.send` with the same arguments. The default npm entrypoint imports
`cloudflare:sockets` and does not run in plain Node.js.

A receipt confirms SMTP server acceptance, not inbox delivery. Keep SMTP
credentials on the server, and never turn this snippet into an unauthenticated
public send endpoint. Runnable samples are linked below.

## Upgrading to 0.8

Authenticated connections now require TLS unless you explicitly opt into
`opportunistic` or `no-starttls` policy for a controlled plaintext server.
Servers that omit AUTH are rejected when credentials were supplied. Message
metadata rejects control characters and requires bare mailbox addresses; use
`{ name, email }` for display names. HTTP samples require `SAMPLE_SEND_TOKEN`.
The new `delivery_unknown` error reason must be reconciled before retrying.
See [SECURITY.md](SECURITY.md) for trust boundaries.

## Scope

Supported today:

- Cloudflare Workers outbound TCP sockets through `edge-mailer/cloudflare`.
- Deno CLI and Deno Deploy v2 direct SMTP through `edge-mailer/deno`.
- SMTP over implicit TLS on port `465`.
- SMTP with STARTTLS on port `587`.
- `PLAIN`, `LOGIN`, legacy `CRAM-MD5`, and token-only `XOAUTH2`
  authentication.
- SMTP extensions: `PIPELINING`, `SIZE`, `8BITMIME`, `SMTPUTF8`,
  `REQUIRETLS`, and `DSN` when advertised by the server.
- Abortable connect/send/batch operations through `AbortSignal`.
- Explicit TLS policy controls for required STARTTLS or implicit TLS.
- No-send SMTP capability probing for onboarding providers.
- Provider profile helpers for Google Workspace, Microsoft 365, SES SMTP,
  Yandex SMTP, and custom SMTP.
- Plain text, HTML, custom headers, CC, BCC, reply-to, inline/CID
  attachments, raw `Uint8Array`/`ArrayBuffer`/`Blob` attachment content, and
  attachment transfer encodings `base64`, `7bit`, and `quoted-printable`.
- Batch sending over one SMTP session and bounded connection pools.
- DKIM signing with RSA private keys.
- Typed outbound `Message-ID`, `In-Reply-To`, and `References` headers.
- Structured send receipts with attempt id, duration, message id, thread
  headers, envelope, accepted recipients, final SMTP response, response code,
  and message size.
- Structured SMTP errors with stage, command, response code, enhanced status
  code, transient classification, reason, retry hint, and next action.
- Optional observation events for SMTP lifecycle timing, redacted transcript
  summaries, and lightweight pool activity.
- Agent-facing `llms.txt` and a repo-local Edge Mailer skill artifact.

Not supported yet:

- Direct SMTP from Vercel Edge or other runtimes without outbound TCP sockets.
- True streaming SMTP `DATA` for large attachments.
- Open/click tracking, provider webhook receivers, bounce normalization, or
  inbox-placement analytics.
- HTTP provider SDK wrappers.

Calendar invites are supported via `icalendar` on `EmailOptions`, which
creates a UTF-8 `.ics` attachment. Verify RSVP rendering in your target mail clients.

See [CLIENT-INTEGRATION.md](CLIENT-INTEGRATION.md) for client-side runtime
imports, SMTP options, envelope/DSN usage, and real-server functional
verification. See [DEVELOPMENT.md](https://github.com/sparticle9/edge-mailer/blob/main/DEVELOPMENT.md) for local checks, smoke
testing, runtime samples, and reporting guidance. A sectioned `env.example` at
the repo root covers the common SMTP, XOAUTH2, DSN, sample, and Graph showcase
scenarios.

## Repository Shape

The npm and JSR packages ship the library build/source, core docs, `llms.txt`,
and the Edge Mailer agent skill. They intentionally do not ship runnable sample
apps or internal tests.

- `src/`: the package implementation and public runtime entrypoints.
- `sample/`: runnable OSS Worker/Deno apps with deploy and live-smoke
  instructions. Treat these as user-facing examples and integration starters.
- `test/`: internal verification suites for protocol, runtime boundaries, and
  regression coverage. Do not use this folder as user documentation.
- `scripts/`: release checks, local smoke helpers, and package maintenance.

## Capability Probe

Probe a provider before sending mail:

```ts
const capabilities = await EdgeMailer.probe({
  host: 'smtp.example.com',
  port: 587,
  startTls: true,
  tlsPolicy: 'require-starttls',
})
```

The probe connects, reads the greeting, sends `EHLO`, upgrades STARTTLS when
configured and advertised, reports capabilities, and closes without
authenticating or sending mail.

Provider profile helpers set conservative SMTP defaults without owning OAuth
consent, token refresh, or provider-native REST APIs:

```ts
import { googleWorkspaceProfile } from 'edge-mailer/cloudflare'

const config = googleWorkspaceProfile({
  username: 'sender@example.com',
  accessToken: env.SMTP_XOAUTH2_ACCESS_TOKEN,
})
```

## Smoke And DSN Evidence

Runtime smokes verify SMTP server acceptance, not inbox placement. Enable
best-effort DSN capture when you want a machine-readable artifact from live
smokes:

```sh
SMTP_SMOKE_DSN=1 pnpm run test:smoke:cloudflare
SMTP_SMOKE_DSN=1 pnpm run test:smoke:deno
```

The smoke requests `RET=HDRS` and `NOTIFY=SUCCESS,FAILURE,DELAY` with a unique
`ENVID`, then writes JSON under `smoke-artifacts/` by default. The artifact
includes the generated `ENVID`, accepted/rejected recipients, response code,
attempt duration, message id, observed EHLO capabilities, and whether the SMTP
server advertised `DSN`.

If the server does not advertise `DSN`, Edge Mailer still sends normally and
records `dsnAdvertised: false`; it does not force unsupported SMTP extension
parameters. DSN capture does not run a mailbox poller, webhook receiver, bounce
normalizer, or inbox-placement check.

## Runtime Entrypoints

Use the default import or Cloudflare subpath for Cloudflare Workers:

```ts
import { EdgeMailer } from 'edge-mailer/cloudflare'
```

The default npm entrypoint is Cloudflare-compatible and imports
`cloudflare:sockets`; it is not intended to load directly in plain Node.js.

Use the Deno subpath for Deno:

```ts
import { DenoMailer } from 'jsr:@sparticle9/edge-mailer/deno'
```

Runnable samples and deploy quickstarts live in [sample](https://github.com/sparticle9/edge-mailer/tree/main/sample):

- [sample/cloudflare-worker-smtp](https://github.com/sparticle9/edge-mailer/tree/main/sample/cloudflare-worker-smtp)
- [sample/deno-smtp](https://github.com/sparticle9/edge-mailer/tree/main/sample/deno-smtp)

## Runtime Matrix

| Capability              | Cloudflare Workers                                                                                                                | Deno CLI / Deno Deploy v2                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Import path             | `edge-mailer/cloudflare`                                                                                                          | `edge-mailer/deno`                                                              |
| Runtime class           | `EdgeMailer`                                                                                                                      | `DenoMailer`                                                                    |
| Socket backend          | `cloudflare:sockets`                                                                                                              | `Deno.connect`, `Deno.connectTls`, `Deno.startTls`                              |
| Direct SMTP             | Yes, outbound TCP sockets                                                                                                         | Yes, Deno TCP/TLS sockets                                                       |
| Port `587` STARTTLS     | Yes                                                                                                                               | Yes                                                                             |
| Port `465` implicit TLS | Yes                                                                                                                               | Yes                                                                             |
| Port `25`               | Not supported by Cloudflare Workers                                                                                               | Not recommended; provider/runtime policy may vary                               |
| Auth                    | `PLAIN`, `LOGIN`, `CRAM-MD5`, `XOAUTH2`                                                                                           | `PLAIN`, `LOGIN`, `CRAM-MD5`, `XOAUTH2`                                         |
| SMTP extensions         | `PIPELINING`, `SIZE`, `8BITMIME`, `SMTPUTF8`, `REQUIRETLS`, `DSN`                                                                 | Same shared SMTP core                                                           |
| Message features        | Text, HTML, custom headers, CC/BCC, reply-to, outbound threading headers, inline/CID attachments, raw byte/Blob attachment inputs | Same shared MIME/message builder                                                |
| Pooling and batch       | Bounded pool, `send`, `sendBatch`, `sendMany`                                                                                     | Same API and behavior                                                           |
| DKIM                    | RSA DKIM signing before `DATA`                                                                                                    | Same DKIM implementation                                                        |
| Smoke status            | Automated Worker tests; prior live acceptance, not rerun for every release                                                        | Automated Deno SMTP tests; prior Deploy acceptance, not rerun for every release |
| Status                  | First-class edge runtime support                                                                                                  | First-class edge runtime support                                                |

## Next priorities

The release is intended for small transactional workflows. The next adoption
work is fresh provider acceptance results for both runtimes, independent DKIM verification,
calendar client testing, and attachment memory measurements. These are tracked
with user stories and success criteria in [USE-CASES.md](USE-CASES.md).

Streaming DATA, provider HTTP SDKs, inbound mail, and campaign analytics remain
outside the current scope. Use links for large assets and keep application
concurrency bounded.

## Contributing and security

See [CONTRIBUTING.md](https://github.com/sparticle9/edge-mailer/blob/main/CONTRIBUTING.md)
for local checks and contribution guidance, and [SECURITY.md](SECURITY.md) for
private vulnerability reporting. Licensed under [MIT](LICENSE).
