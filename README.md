# Edge Mailer

Edge Mailer is a serverless SMTP submission toolkit for applications that need
to send through existing SMTP infrastructure from modern edge runtimes.

The current implementation keeps Cloudflare Workers as the production baseline
and adds an explicit Deno runtime entrypoint for local Deno CLI work. It is not
published to npm yet, and the public API should be treated as prerelease.

## Scope

Supported today:

- Cloudflare Workers outbound TCP sockets through `edge-mailer/cloudflare`.
- SMTP over implicit TLS on port `465`.
- SMTP with STARTTLS on port `587`.
- `PLAIN`, `LOGIN`, and legacy `CRAM-MD5` authentication.
- Plain text, HTML, custom headers, CC, BCC, reply-to, and base64 attachments.
- DSN options when the server advertises support.
- Batch sending over one SMTP session.
- Structured SMTP errors with stage, command, response code, and transient
  classification.

Experimental:

- Deno CLI direct SMTP through `edge-mailer/deno`.
- Deno Deploy v2 direct SMTP, pending a deployed smoke with real SMTP
  credentials.

Not supported yet:

- Direct SMTP from Vercel Edge or other runtimes without outbound TCP sockets.
- XOAUTH2.
- DKIM signing.
- Message streaming for large attachments.
- HTTP provider SDK wrappers.

See [DEVELOPMENT.md](DEVELOPMENT.md) for quickstart, local checks, smoke
testing, runtime samples, and reporting guidance.

## Runtime Entrypoints

Use the default import or Cloudflare subpath for Cloudflare Workers:

```ts
import { EdgeMailer } from 'edge-mailer/cloudflare'
```

Use the Deno subpath for Deno:

```ts
import { DenoMailer } from 'edge-mailer/deno'
```

Runnable samples live in [sample](sample):

- [sample/cloudflare-worker-smtp](sample/cloudflare-worker-smtp)
- [sample/deno-smtp](sample/deno-smtp)

## Roadmap

Cloudflare Workers remains the production baseline. Planned work includes
stronger MIME/DKIM/XOAUTH2 support, better observation events, Deno Deploy v2
smoke coverage, and a Worker relay path for runtimes that cannot open SMTP
sockets directly.
