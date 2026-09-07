# edge-mailer

## 0.8.0

- Require TLS by default when authenticating; reject missing AUTH rather than
  silently continuing without authentication. Explicit plaintext policy remains
  available for controlled local SMTP servers.
- Reject SMTP/MIME metadata injection, escape quoted parameters, normalize DATA
  line endings, discard pre-TLS buffered replies, and bound server responses.
- Check advertised SIZE limits, measure SIZE before dot-stuffing, preserve empty
  reverse paths, and avoid entering DATA after a failed pipelined envelope.
- Classify missing final DATA replies as `delivery_unknown`; propagate one-shot
  send cancellation through connection setup.
- Support UTF-8 calendar attachments and octet-based folding; validate calendar
  metadata and mark all-day dates explicitly.
- Require HTTP sample tokens, bound request bodies, and reject malformed JSON.
- Add first-send and use-case guidance, contribution and security reporting docs,
  automated pull-request CI, package-content checks, and patched dev tooling.

Migration: use bare mailbox addresses or `{ name, email }` objects and single-line
header values. Set a sample token before using HTTP endpoints. Handle
`delivery_unknown` without blindly retrying. Review explicit plaintext TLS policy
settings before upgrading.

## Unreleased

- Add abortable connect/send/batch operations, explicit TLS policy controls,
  no-send capability probing, and receipt TLS mode metadata.
- Add provider profile helpers for Google Workspace, Microsoft 365, SES SMTP,
  Yandex SMTP, and custom SMTP.
- Upgrade the Cloudflare Worker sample with health, capability probe, dry-run,
  and send routes.
- Add `llms.txt` and a repo-local Edge Mailer agent skill artifact.

## 0.6.5

- Add lightweight SMTP observation events, redacted transcript summaries, stable
  attempt IDs, and JSON-safe receipt/error output.
- Add compact failure reasons, retry hints, and next-action metadata for SMTP
  errors.
- Add opt-in DSN capture for live smoke scripts. Smokes can request DSN,
  record SMTP acceptance and observed server capabilities, and write a local
  JSON artifact without adding mailbox polling or webhook receivers.
- Keep disabled observation lightweight with lazy session/pool IDs and no
  telemetry backend dependency.

## 0.6.1

- Add JSR module documentation for public entrypoints.
- Add JSDoc for exported symbols to improve generated API documentation.

## 0.6.0

- Start public prerelease versioning at `v0.6.0`.
- Publish the Cloudflare Workers SMTP toolkit as `edge-mailer` on npm.
- Publish the Deno-compatible source package as `@sparticle9/edge-mailer` on JSR.
- Include Cloudflare Workers as the production baseline and Deno CLI / Deno Deploy v2 as experimental runtime support.
