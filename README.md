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

## Scope

Supported today:

- Cloudflare Workers outbound TCP sockets through `edge-mailer/cloudflare`.
- Deno CLI and Deno Deploy v2 direct SMTP through `edge-mailer/deno`.
- SMTP over implicit TLS on port `465`.
- SMTP with STARTTLS on port `587`.
- `PLAIN`, `LOGIN`, and legacy `CRAM-MD5` authentication.
- SMTP extensions: `PIPELINING`, `SIZE`, `8BITMIME`, `SMTPUTF8`,
  `REQUIRETLS`, and `DSN` when advertised by the server.
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

Not supported yet:

- Direct SMTP from Vercel Edge or other runtimes without outbound TCP sockets.
- XOAUTH2.
- True streaming SMTP `DATA` for large attachments.
- ICS/calendar invite helpers.
- Open/click tracking, provider webhook receivers, bounce normalization, or
  inbox-placement analytics.
- HTTP provider SDK wrappers.

See [CLIENT-INTEGRATION.md](CLIENT-INTEGRATION.md) for client-side runtime
imports, SMTP options, envelope/DSN usage, and real-server functional
verification. See [DEVELOPMENT.md](DEVELOPMENT.md) for local checks, smoke
testing, runtime samples, and reporting guidance.

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

Runnable samples and deploy quickstarts live in [sample](sample):

- [sample/cloudflare-worker-smtp](sample/cloudflare-worker-smtp)
- [sample/deno-smtp](sample/deno-smtp)

## Runtime Matrix

| Capability              | Cloudflare Workers                                                                                    | Deno CLI / Deno Deploy v2                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Import path             | `edge-mailer/cloudflare`                                                                              | `edge-mailer/deno`                                                   |
| Runtime class           | `EdgeMailer`                                                                                          | `DenoMailer`                                                         |
| Socket backend          | `cloudflare:sockets`                                                                                  | `Deno.connect`, `Deno.connectTls`, `Deno.startTls`                   |
| Direct SMTP             | Yes, outbound TCP sockets                                                                             | Yes, Deno TCP/TLS sockets                                            |
| Port `587` STARTTLS     | Yes                                                                                                   | Yes                                                                  |
| Port `465` implicit TLS | Yes                                                                                                   | Yes                                                                  |
| Port `25`               | Not supported by Cloudflare Workers                                                                   | Not recommended; provider/runtime policy may vary                    |
| Auth                    | `PLAIN`, `LOGIN`, `CRAM-MD5`                                                                          | `PLAIN`, `LOGIN`, `CRAM-MD5`                                         |
| SMTP extensions         | `PIPELINING`, `SIZE`, `8BITMIME`, `SMTPUTF8`, `REQUIRETLS`, `DSN`                                     | Same shared SMTP core                                                |
| Message features        | Text, HTML, custom headers, CC/BCC, reply-to, outbound threading headers, inline/CID attachments, raw byte/Blob attachment inputs | Same shared MIME/message builder                                     |
| Pooling and batch       | Bounded pool, `send`, `sendBatch`, `sendMany`                                                         | Same API and behavior                                                |
| DKIM                    | RSA DKIM signing before `DATA`                                                                        | Same DKIM implementation                                             |
| Smoke status            | Local Wrangler smoke and live `workers.dev` SMTP acceptance passed                                    | Local Deno SMTP tests and live Deno Deploy v2 SMTP acceptance passed |
| Status                  | First-class edge runtime support                                                                      | First-class edge runtime support                                     |

## Roadmap

Cloudflare Workers and Deno are both first-class edge runtimes. Future work
should keep both runtimes aligned unless a runtime-specific platform limit is
documented. The next useful work is grouped by product risk:

- Stabilization: publish a v0 package surface, keep runtime subpaths stable,
  expand live smokes across at least two SMTP providers, and keep package
  contents free of local reference material and secrets.
- Runtime coverage: continue hardening Deno Deploy v2, add CI-friendly sample
  deployment checks, and document any runtime-specific socket limitations before
  adding another runtime.
- Observability: keep structured SMTP lifecycle events and redacted debug
  logging focused on SMTP server acceptance; add optional bridges only after
  the core contract stays small and runtime-neutral.
- Deliverability and operations: add clearer retry guidance from structured SMTP
  errors, DKIM verification examples, and mailbox delivery caveats.
- Message features: add XOAUTH2, calendar invite helpers, richer MIME fixtures,
  and safer large-attachment guidance around provider size limits.
- No-direct-SMTP runtimes: design a Worker relay path for environments that
  cannot open TCP sockets directly, such as Vercel Edge.

Attachment ergonomics now favor raw `Uint8Array`, `ArrayBuffer`, and `Blob`
inputs while reducing avoidable base64 wrapping copies. True one-pass streaming
SMTP `DATA` remains deferred: DKIM needs the canonicalized body hash before the
signed headers are sent, SMTP `SIZE` and retries need repeatable byte sources,
and both Cloudflare Workers and Deno Deploy are more likely to benefit first
from predictable memory use and linked large assets than from a complex
streaming/spooling path. Revisit true streaming only if real users need large
in-message attachments rather than signed download links or small transactional
attachments.
