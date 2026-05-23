# Edge Mailer Samples

This folder contains runnable SMTP samples for the two supported runtime lanes.
Each runtime folder has one README with local smoke, deploy, and live smoke
commands.

| Runtime            | Folder                                           | Live deploy target              | Direct SMTP support                                | Current proof                                                      |
| ------------------ | ------------------------------------------------ | ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| Cloudflare Workers | [cloudflare-worker-smtp](cloudflare-worker-smtp) | `workers.dev` or a Worker route | `cloudflare:sockets` outbound TCP                  | Local Wrangler smoke and live `workers.dev` SMTP acceptance passed |
| Deno               | [deno-smtp](deno-smtp)                           | Deno CLI or Deno Deploy v2      | `Deno.connect`, `Deno.connectTls`, `Deno.startTls` | Local Deno smoke and live Deno Deploy v2 SMTP acceptance passed    |

## Fast Path

Choose one runtime:

- Use Cloudflare Workers when your application already runs on Workers or you
  want a small hosted mail sender on `workers.dev`.
- Use Deno when you want a plain Deno server locally or a Deno Deploy v2 app.

Common SMTP environment names:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USERNAME=sender@example.com
SMTP_PASSWORD=secret
TEST_RECIPIENT_EMAIL=recipient@example.net
SMTP_AUTH_TYPE=plain,login
```

Recommended hosted sample protection:

```env
SAMPLE_SEND_TOKEN=generate-a-long-random-token
```

Optional DKIM environment names:

```env
DKIM_DOMAIN=example.com
DKIM_SELECTOR=mail
DKIM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

## Runtime Guides

- [Cloudflare Worker sample](cloudflare-worker-smtp)
- [Deno sample](deno-smtp)

Both guides keep credentials in ignored local files and upload SMTP credentials
as runtime secrets. Do not put SMTP passwords, API tokens, or DKIM private keys
in source files or committed config.

## Expected Smoke Emails

| Smoke command                                               | Expected emails                                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run test:smoke:cloudflare`                            | 1 email to `SMTP_TO` or `TEST_RECIPIENT_EMAIL`: subject `[edge-mailer sample] cloudflare-<ISO timestamp>`                                                                   |
| Cloudflare live smoke in `cloudflare-worker-smtp/README.md` | 2 emails to `SMTP_TO` or `TEST_RECIPIENT_EMAIL`: subjects `[edge-mailer sample] cloudflare-<ISO timestamp>` and `[edge-mailer sample] Cloudflare rich MIME <ISO timestamp>` |
| `pnpm run test:smoke:deno`                                  | 1 email to `SMTP_TO` or `TEST_RECIPIENT_EMAIL`: subject `[edge-mailer smoke] deno-<ISO timestamp>`                                                                          |
| Deno live smoke in `deno-smtp/README.md`                    | 2 emails to `SMTP_TO` or `TEST_RECIPIENT_EMAIL`: subjects `[edge-mailer sample] Deno <ISO timestamp>` and `[edge-mailer sample] Deno rich MIME <ISO timestamp>`             |

## AI Assistant Prompt

Use this prompt with a local AI coding assistant after filling local secret
values:

```text
Use the Edge Mailer sample in this folder. Do not print or commit secrets.
Follow the runtime-specific README exactly, use ignored local env files for
credentials, deploy the sample, then prove GET health, unauthenticated POST
rejection when SAMPLE_SEND_TOKEN is set, authorized POST SMTP acceptance, and
the expected email count/subjects.
```
