# Contact form starter

A same-origin browser form that sends to **one configured team mailbox**. The
visitor becomes `Reply-To`, never the sender or recipient. Uses text-only mail,
server-side validation, a honeypot, Turnstile (including hostname/action checks),
and atomic D1 limits: five attempts per IP per UTC hour, 100 globally per hour.
Rejected challenges consume the budget. Hourly IP keys use a secret HMAC; raw
IPs and form contents are not stored in D1. Counters expire and cron removes them.

## Run from a clean clone

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run test:starters
cd sample/contact-form
cp secrets.example .dev.vars
pnpm exec wrangler d1 migrations apply DB --local
pnpm exec wrangler dev --local --port 8787
```

Edit `wrangler.jsonc`: SMTP host/port (587 or 2525 with required STARTTLS, or
465 with required TLS), `MAIL_FROM`, fixed `MAIL_TO`, `PUBLIC_ORIGIN` (exact
origin, no trailing slash), and your Turnstile public site key. Fill `.dev.vars`
with the SMTP username/password, Turnstile secret key, and a random secret of at
least 32 characters for IP hashing. Generate the latter with `openssl rand -hex
32`. Never use SMTP passwords as the hashing secret.

Open `http://localhost:8787`. Configure your Turnstile widget to allow the chosen
hostname. To exercise the challenge locally without a real widget, use
[Cloudflare's documented test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
in your local configuration only. A successful challenge still sends real mail
when real SMTP credentials are supplied. The automated suite uses synthetic
values and injected SMTP/challenge outcomes; it sends no external email.

## Deploy your own instance

```sh
pnpm exec wrangler d1 create edge-mailer-contact-form
# Copy the returned database_id into wrangler.jsonc, replacing the all-zero ID.
# Set PUBLIC_ORIGIN to the final HTTPS origin and configure the Turnstile hostname.
pnpm exec wrangler d1 migrations apply DB --remote
pnpm exec wrangler secret put SMTP_USERNAME
pnpm exec wrangler secret put SMTP_PASSWORD
pnpm exec wrangler secret put TURNSTILE_SECRET_KEY
pnpm exec wrangler secret put RATE_LIMIT_SECRET
pnpm exec wrangler deploy
```

Local values stay in ignored `.dev.vars`. Production values are Worker secrets,
managed by the deployer's credential system; CI needs no SMTP or Turnstile
credentials to test this starter. Restore secrets from that system when
recreating the Worker. The library does not issue, store, or rotate credentials.

## Outcomes and operation

- `200 accepted`: the SMTP server accepted the message. This does not prove
  inbox delivery; SPF/DKIM/DMARC and downstream delivery remain provider concerns.
- `202 unknown`: the result is ambiguous. The form displays a reference and
  disables resubmission. Inspect provider logs before sending again. This direct
  starter has no durable message history; use the outbox starter when you need it.
- `400/403/413/415`: invalid submission, origin/challenge rejection, or body limit.
- `429`: budget exhausted, with `Retry-After`. Fixed-hour windows can allow a
  burst around the hour boundary; shared-IP visitors share one limit.
- `502/503`: definite SMTP rejection or unavailable configuration/dependency.
  SMTP response strings and credentials are never returned to the visitor.

`GET /`, `/form.js`, `/form.css` serve the UI. `POST /contact` accepts JSON
`name`, `email`, `subject`, `message`, empty `website`, and `turnstileToken`.
Other supplied mail-routing fields are ignored. The browser receives only the
public site key. Origin checking is an additional browser safeguard, not bot
authentication. Cloudflare provides `CF-Connecting-IP`; do not expose this
handler behind a proxy that trusts arbitrary client-supplied values for it.

The challenge token is verified through the official
[Siteverify endpoint](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
For production traffic, add WAF/request-rate rules to control requests that never
reach the application limits, choose suitable privacy/retention notices, and
monitor SMTP errors and the shared global cap. This is a bounded starting point,
not a complete abuse-prevention service.

Copy this folder together with `sample/starters/`, or change the shared imports
to your application layout and replace repository source imports with
`edge-mailer/cloudflare`. See [scenario verdicts](../VERDICTS-0.8.5.md).
