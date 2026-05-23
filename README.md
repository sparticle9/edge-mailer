# Edge Mailer

Edge Mailer is a Cloudflare Workers SMTP submission toolkit for serverless
applications that need to send through existing SMTP infrastructure.

The current implementation targets Cloudflare Workers and
`cloudflare:sockets`. It is not published to npm yet, and the public API should
be treated as prerelease.

## Scope

Supported today:

- Cloudflare Workers outbound TCP sockets.
- SMTP over implicit TLS on port `465`.
- SMTP with STARTTLS on port `587`.
- `PLAIN`, `LOGIN`, and legacy `CRAM-MD5` authentication.
- Plain text, HTML, custom headers, CC, BCC, reply-to, and base64 attachments.
- DSN options when the server advertises support.
- Batch sending over one SMTP session.
- Structured SMTP errors with stage, command, response code, and transient
  classification.

Not supported yet:

- Direct SMTP from Vercel Edge or other runtimes without outbound TCP sockets.
- XOAUTH2.
- DKIM signing.
- Message streaming for large attachments.
- HTTP provider SDK wrappers.

See [DEVELOPMENT.md](DEVELOPMENT.md) for quickstart, local checks, smoke
testing, and reporting guidance.

## Roadmap

Cloudflare Workers remains the production baseline. Planned work includes
stronger MIME/DKIM/XOAUTH2 support, better observation events, and a Worker
relay path for runtimes that cannot open SMTP sockets directly.
