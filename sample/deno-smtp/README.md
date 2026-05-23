# Deno SMTP Sample

This sample exercises `edge-mailer/deno` with local Deno CLI and is the entrypoint for future Deno Deploy v2 smoke tests.

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
- `SMTP_RESPONSE_TIMEOUT_MS`
- `SMTP_SOCKET_TIMEOUT_MS`

This sample owns its own `deno.json` because it is a runnable Deno app. The
package repo root intentionally does not have a root Deno config.

Run a direct local smoke from the repo root so direnv can load local `.env`:

```sh
direnv exec . sh -c 'cd sample/deno-smtp && deno task smoke'
```

The smoke output prints a marker in the subject/header after the SMTP server
accepts the message. That confirms the SMTP transaction completed; final inbox
delivery can still depend on provider queueing, spam filtering, sender policy,
or the recipient mailbox.

Run the local HTTP sample:

```sh
direnv exec . sh -c 'cd sample/deno-smtp && deno task serve'
```

Deno Deploy v2 uses the standard Deno runtime with `--allow-all`; custom Deno runtime flags cannot be passed. Use the current `deno deploy` CLI, not `deployctl`.

Create a Deno Deploy v2 app from the repo root so the upload includes both the
sample and the local package source:

```sh
direnv exec . deno deploy create --token "$DENO_ACCESS_TOKEN" --org "$DENO_DEPLOY_ORG" --app "$DENO_DEPLOY_APP" --source local --runtime-mode dynamic --entrypoint sample/deno-smtp/main.ts --region global --do-not-use-detected-build-config .
```

Deploy an existing app:

```sh
direnv exec . deno deploy --token "$DENO_ACCESS_TOKEN" --org "$DENO_DEPLOY_ORG" --app "$DENO_DEPLOY_APP" --prod .
```

When deploying from a local development checkout, add `--ignore` flags for any
local-only files that should not be uploaded.

Deno Deploy v2 noninteractive deploys require `DENO_DEPLOY_ORG` and
`DENO_DEPLOY_APP` to be set locally before running that command.

Deno Deploy remains experimental for this package until that deployed sample passes a real SMTP acceptance smoke and final mailbox delivery is manually verified.
