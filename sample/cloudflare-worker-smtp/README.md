# Cloudflare Worker SMTP Sample

This sample exercises `edge-mailer/cloudflare` through `cloudflare:sockets`.

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

Run locally from the repo root:

```sh
direnv exec . pnpm exec wrangler dev --config sample/cloudflare-worker-smtp/wrangler.toml --local
```

Probe the sample:

```sh
curl http://127.0.0.1:8787
curl -X POST http://127.0.0.1:8787
```
