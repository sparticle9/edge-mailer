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

Common SMTP environment names live in the root `env.example`.
Copy the section you need into a local env file and fill in values.

The core SMTP smoke/sample section covers:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USERNAME=sender@example.com
SMTP_PASSWORD=secret
SMTP_FROM=Edge Mailer <sender@example.com>
SMTP_TO=recipient@example.net
TEST_RECIPIENT_EMAIL=recipient@example.net
SMTP_AUTH_TYPE=plain,login
```

For token-only XOAUTH2, use the XOAUTH2 section from `env.example` and set
`SMTP_AUTH_TYPE=xoauth2` with `SMTP_XOAUTH2_ACCESS_TOKEN` instead of
`SMTP_PASSWORD`.

Recommended hosted sample protection:

```env
SAMPLE_SEND_TOKEN=generate-a-long-random-token
```

Optional DKIM self-signing environment names:

```env
DKIM_DOMAIN=example.com
DKIM_SELECTOR=mail
DKIM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

Set these only when Edge Mailer should sign before SMTP delivery. If your SMTP
provider manages DKIM, it keeps the private key and gives you only the DNS TXT
public key (`p=...`); leave `DKIM_PRIVATE_KEY` unset.

## Runtime Guides

- [Cloudflare Worker sample](cloudflare-worker-smtp)
- [Deno sample](deno-smtp)

Both guides keep credentials in ignored local files and upload SMTP credentials
as runtime secrets. Do not put SMTP passwords, OAuth tokens, API tokens, or DKIM
private keys in source files or committed config.

## Optional DSN Smoke Capture

Live smokes can request SMTP Delivery Status Notifications when the configured
server advertises `DSN`:

```sh
SMTP_SMOKE_DSN=1 pnpm run test:smoke:smtp
SMTP_SMOKE_DSN=1 pnpm run test:smoke:cloudflare
SMTP_SMOKE_DSN=1 pnpm run test:smoke:deno
```

When enabled, the smoke adds a unique `ENVID`, requests `RET=HDRS` and
`NOTIFY=SUCCESS,FAILURE,DELAY`, and writes a JSON capture under
`smoke-artifacts/` by default. The capture records SMTP acceptance, generated
message IDs, requested DSN options, and whether observation saw the server
advertise `DSN`. It does not poll a mailbox, receive webhooks, or prove inbox
placement.

Set `SMTP_SMOKE_DSN_OUTPUT=/path/to/file.json` to choose a capture path. A later
GitHub Actions smoke workflow can upload this JSON as an artifact once live SMTP
secrets are configured for CI.

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
