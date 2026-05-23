# Client Integration

Edge Mailer exposes one SMTP client API with runtime-specific entrypoints.
Cloudflare Workers is the production baseline. Deno support is available for
local Deno CLI use and remains experimental on Deno Deploy v2 until a deployed
SMTP smoke passes.

## Runtime Imports

Cloudflare Workers:

```ts
import { EdgeMailer } from 'edge-mailer/cloudflare'
```

Deno:

```ts
import { DenoMailer } from 'edge-mailer/deno'
```

The default package entrypoint remains Cloudflare-compatible:

```ts
import { EdgeMailer } from 'edge-mailer'
```

## Minimal Send

```ts
await EdgeMailer.send(
  {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    startTls: true,
    credentials: {
      username: 'sender@example.com',
      password: env.SMTP_PASSWORD,
    },
    authType: ['plain', 'login'],
  },
  {
    from: 'sender@example.com',
    to: 'recipient@example.net',
    subject: 'Hello',
    text: 'Hello from Edge Mailer.',
  },
)
```

Use `secure: true` with port `465` for implicit TLS. Use `secure: false` and
`startTls: true` with port `587` for STARTTLS. If `credentials` are omitted,
the client does not attempt `AUTH`; servers that require auth will reject the
envelope command.

## Reusing A Session

Use `connect()` when one request, queue batch, or job sends more than one
message:

```ts
const mailer = await EdgeMailer.connect(config)
try {
  await mailer.send(firstEmail)
  await mailer.send(secondEmail)
} finally {
  await mailer.close()
}
```

For ordered batch results:

```ts
const results = await EdgeMailer.sendBatch(config, emails, {
  continueOnError: true,
})
```

When `continueOnError` is true, a failed message is followed by `RSET` before
the next message is attempted on the same SMTP session.

## SMTP Feature Mapping

The client uses server-advertised EHLO capabilities and only sends extension
parameters when the server advertises support or the feature is required by the
message.

Supported SMTP features:

- `AUTH PLAIN`, `AUTH LOGIN`, and `AUTH CRAM-MD5`
- `STARTTLS` and implicit TLS
- `PIPELINING`
- Enhanced status code parsing from server replies
- `SIZE`
- `8BITMIME` through `envelope.body`
- `SMTPUTF8` through `envelope.smtpUtf8` or non-ASCII envelope addresses
- `REQUIRETLS` through `envelope.requireTls`
- `DSN` through `dsn` defaults and per-message `dsnOverride`

## Envelope Options

The visible message headers and SMTP envelope can differ. Use `envelope` when a
bounce address, delivery recipient set, or SMTP extension parameter should not
be inferred from headers.

```ts
await EdgeMailer.send(config, {
  from: { name: 'Product', email: 'sender@example.com' },
  to: 'visible@example.net',
  bcc: 'audit@example.net',
  envelope: {
    from: 'bounce@example.com',
    to: ['visible@example.net', 'audit@example.net'],
    body: '8BITMIME',
    smtpUtf8: true,
    requireTls: true,
  },
  subject: 'Delivery',
  text: 'Message body.',
})
```

`envelope.size` can be supplied when an upstream system already knows the DATA
size. Otherwise the client computes `SIZE` from the encoded message it sends.

## DSN Options

Set session defaults with `config.dsn` and override per message with
`dsnOverride`.

```ts
const config = {
  host: 'smtp.example.com',
  port: 587,
  startTls: true,
  credentials,
  dsn: {
    RET: { HEADERS: true },
    NOTIFY: { FAILURE: true, DELAY: true },
  },
}

await EdgeMailer.send(config, {
  from: 'sender@example.com',
  to: 'recipient@example.net',
  dsnOverride: {
    envelopeId: 'order-123',
    RET: { FULL: true },
    NOTIFY: { SUCCESS: true, FAILURE: true },
    ORCPT: 'original@example.net',
  },
  subject: 'DSN request',
  text: 'Message body.',
})
```

`ORCPT` values without an address type are sent as `rfc822;<address>`.

## Error Handling

SMTP failures throw `SMTPError` when the failure is known to come from the SMTP
conversation.

```ts
try {
  await EdgeMailer.send(config, email)
} catch (error) {
  if (error instanceof SMTPError) {
    console.log(error.stage)
    console.log(error.command)
    console.log(error.responseCode)
    console.log(error.enhancedStatusCode)
    console.log(error.transient)
  }
  throw error
}
```

Use `responseCode` and `enhancedStatusCode` for provider-specific routing, and
use `transient` for coarse retry decisions.

## SMTP Core Verification

The SMTP core suite uses Nodemailer's `smtp-server` package as a real local
SMTP server. It validates the shared SMTP session logic against server-side
SMTP parsing for AUTH, TLS, STARTTLS, PIPELINING, SIZE, 8BITMIME, SMTPUTF8,
REQUIRETLS, DSN, and RSET recovery.

```sh
pnpm run test:smtp-core
```

Run the full local verification set:

```sh
pnpm test -- --run
pnpm run test:smtp-core
pnpm run build
pnpm run check:deno
pnpm run test:deno
```
