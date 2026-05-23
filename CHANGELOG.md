# edge-mailer

## 0.6.5

- Add lightweight SMTP observation events, redacted transcript summaries, stable
  attempt IDs, and JSON-safe receipt/error output.
- Add compact failure reasons, retry hints, and next-action metadata for SMTP
  errors.
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
