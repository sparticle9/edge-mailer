# Deno SMTP Sample

This sample exercises `edge-mailer/deno` with local Deno CLI and is the entrypoint for future Deno Deploy v2 smoke tests.

Required env names:

- `SMTP_HOST`
- `SMTP_USERNAME` or `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_FROM`
- `SMTP_TO`

Optional env names:

- `SMTP_PORT`, defaults to `587`
- `SMTP_REPLY_TO`
- `SMTP_AUTH_TYPE`, comma-separated, defaults to `plain,login,cram-md5`
- `SMTP_RESPONSE_TIMEOUT_MS`
- `SMTP_SOCKET_TIMEOUT_MS`

This sample owns its own `deno.json` because it is a runnable Deno app. The
package repo root intentionally does not have a root Deno config.

Run a direct local smoke from the repo root so direnv can load local `.env`:

```sh
direnv exec . sh -c 'cd sample/deno-smtp && deno task smoke'
```

Run the local HTTP sample:

```sh
direnv exec . sh -c 'cd sample/deno-smtp && deno task serve'
```

Deno Deploy v2 uses the standard Deno runtime with `--allow-all`; custom Deno runtime flags cannot be passed. Use the current `deno deploy` CLI, not `deployctl`.

Example deploy command:

```sh
direnv exec . deno deploy --config sample/deno-smtp/deno.json --token "$DENO_ACCESS_TOKEN" --org "$DENO_DEPLOY_ORG" --app "$DENO_DEPLOY_APP" sample/deno-smtp/main.ts
```

Deno Deploy remains experimental for this package until that deployed sample sends through real SMTP credentials.
