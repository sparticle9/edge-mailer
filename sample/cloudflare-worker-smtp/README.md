# Cloudflare Worker SMTP Sample

This sample exercises `edge-mailer/cloudflare` through `cloudflare:sockets`.

Required env names:

- `SMTP_HOST`
- `SMTP_USERNAME` or `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_TO` or `TEST_RECIPIENT_EMAIL`

Optional env names:

- `SMTP_PORT`, defaults to `587`
- `SMTP_FROM`, defaults to `SMTP_USERNAME` or `SMTP_USER`
- `SMTP_REPLY_TO`
- `SMTP_AUTH_TYPE`, comma-separated, defaults to `plain,login,cram-md5`
- `SMTP_POOL_MAX_CONNECTIONS`, defaults to `1`
- `SMTP_POOL_MAX_MESSAGES_PER_CONNECTION`, defaults to `20`
- `SMTP_POOL_IDLE_TIMEOUT_MS`, defaults to `1000`
- `DKIM_DOMAIN`
- `DKIM_SELECTOR`
- `DKIM_PRIVATE_KEY`, PEM content; escaped `\n` sequences are accepted

Run locally from the repo root:

```sh
pnpm run test:smoke:cloudflare
```

The smoke runner starts Wrangler locally and passes the direnv-loaded SMTP env
values as Worker bindings without writing a `.dev.vars` file.

Run a long-lived local server manually:

```sh
direnv exec . pnpm exec wrangler dev --config sample/cloudflare-worker-smtp/wrangler.toml --local --var SMTP_HOST:"$SMTP_HOST" --var SMTP_USERNAME:"${SMTP_USERNAME:-$SMTP_USER}" --var SMTP_PASSWORD:"$SMTP_PASSWORD" --var TEST_RECIPIENT_EMAIL:"$TEST_RECIPIENT_EMAIL"
```

Probe the manual server:

```sh
curl http://127.0.0.1:8787
curl -X POST http://127.0.0.1:8787
```

The POST response includes the subject marker and SMTP receipt message id after
the server accepts the message. The sample sends through a bounded pool. That
confirms the SMTP transaction completed; final inbox delivery can still depend
on provider queueing, spam filtering, sender policy, or the recipient mailbox.

Cloudflare Workers cannot open outbound TCP sockets to port `25`; use an SMTP
submission port such as `587` with STARTTLS or `465` with implicit TLS.

For live deploys, keep Cloudflare tooling credentials in the local `.env` loaded
by direnv:

```sh
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

Deploy to the sample's `workers.dev` route:

```sh
direnv exec . pnpm exec wrangler deploy --config sample/cloudflare-worker-smtp/wrangler.toml
```

Minimum API token permissions for this sample are account-level Workers Scripts
edit access and Account Settings read access. Add user details and memberships
read access if Wrangler needs account discovery, Workers Tail read access if
you want `wrangler tail`, and zone-level Workers Routes edit plus Zone read only
when binding a custom domain or route.
