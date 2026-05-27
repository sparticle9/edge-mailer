---
name: edge-mailer
description: Use when building or integrating Edge Mailer SMTP sends from Cloudflare Workers or Deno.
---

# Edge Mailer Skill

Use this skill for `edge-mailer`, a serverless SMTP submission toolkit for
Cloudflare Workers and Deno.

## Import Paths

- Cloudflare Workers: `import { EdgeMailer } from 'edge-mailer/cloudflare'`
- Deno: `import { DenoMailer } from 'edge-mailer/deno'`
- JSR Deno: `import { DenoMailer } from 'jsr:@sparticle9/edge-mailer/deno'`

## Safe Defaults

- Prefer port `587`, `startTls: true`, and `tlsPolicy: 'require-starttls'`.
- Use port `465`, `secure: true`, and `tlsPolicy: 'require-tls'` for implicit
  TLS providers.
- Pass an `AbortSignal` from request, queue, cron, or agent cancellation paths.
- Use `probe(config)` before onboarding a new SMTP provider.
- Use structured `SMTPError.reason`, `retryHint`, and `nextAction` instead of
  parsing error strings.

## Boundaries

- Do not implement OAuth consent, refresh-token storage, provider HTTP SDK
  wrappers, inbound parsing, webhooks, bounce normalization, open/click tracking,
  or inbox-placement analytics inside the OSS core.
- Keep runtime-specific code behind Cloudflare or Deno entrypoints.
- Keep runnable samples under `sample/`.
- Do not read or print `.env` secrets unless a live smoke explicitly requires
  them.

## Checks

Run targeted checks first, then release checks:

```sh
pnpm test -- --run
pnpm run test:smtp-core
pnpm run build
pnpm run check:deno
pnpm run test:deno
```
