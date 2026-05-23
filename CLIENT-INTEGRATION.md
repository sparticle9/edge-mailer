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
const receipt = await EdgeMailer.send(
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

`send()` resolves to a structured receipt:

```ts
console.log(receipt.messageId)
console.log(receipt.accepted)
console.log(receipt.responseCode)
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

Use a bounded pool when one invocation needs concurrent or repeated SMTP sends:

```ts
const pool = EdgeMailer.createPool({
  ...config,
  pool: {
    maxConnections: 2,
    maxMessagesPerConnection: 50,
    idleTimeoutMs: 30_000,
  },
})

try {
  const receipt = await pool.send(email)
  console.log(receipt.messageId)
} finally {
  await pool.close()
}
```

For Cloudflare Workers, create and close pools inside a request, queue, or
scheduled handler. Do not rely on a global SMTP socket surviving across Worker
invocations.

## DKIM

Set `config.dkim` only when Edge Mailer should sign outbound messages before
SMTP `DATA`:

```ts
await EdgeMailer.send(
  {
    ...config,
    dkim: {
      domainName: 'example.com',
      keySelector: 'mail',
      privateKey: env.DKIM_PRIVATE_KEY,
    },
  },
  email,
)
```

If your SMTP provider manages DKIM for a verified sending domain, leave
`config.dkim` unset. Provider-managed DKIM means the provider stores or
generates the private key and asks you to publish only the DNS TXT public key,
usually at `<selector>._domainkey.<domain>` with `p=<base64-public-key>`.

If Edge Mailer signs, `privateKey` accepts PEM PKCS#8 private keys and RSA
private keys. That private key must match the DNS TXT public key for
`dkim.keySelector` and `dkim.domainName`. The DKIM `d=` domain should align with
the visible `From:` domain when DKIM is used for DMARC. Multiple DKIM signatures
are valid, but avoid double-signing unless you intentionally need both Edge
Mailer and the provider to sign.

The default signed header list is `from`, `to`, `subject`, `date`,
`message-id`, `mime-version`, and `content-type`; override it with
`dkim.headerFieldNames`.

## MIME Attachments

Attachments from strings default to the previous base64-string behavior:

```ts
attachments: [
  {
    filename: 'report.txt',
    content: btoa('report body'),
    mimeType: 'text/plain',
  },
]
```

For new binary attachments, pass raw bytes directly. `Uint8Array`,
`ArrayBuffer`, typed-array views, and `Blob` content are encoded as MIME base64
by the library; `Blob.type` is used as the content type when no `mimeType` or
`contentType` is provided. Mailer sends handle `Blob` asynchronously. Direct
`Email` callers should use `getEmailDataAsync()` for `Blob` attachments.

```ts
attachments: [
  {
    filename: 'report.pdf',
    content: reportBytes, // Uint8Array or ArrayBuffer
    mimeType: 'application/pdf',
  },
  {
    filename: 'snapshot.json',
    content: new Blob([JSON.stringify(snapshot)], {
      type: 'application/json',
    }),
  },
]
```

Use `encoding` when the attachment content is raw text:

```ts
attachments: [
  {
    filename: 'plain.txt',
    content: 'plain ascii body',
    mimeType: 'text/plain',
    encoding: '7bit',
  },
  {
    filename: 'utf8.txt',
    content: 'ümlaut body',
    mimeType: 'text/plain',
    encoding: 'quoted-printable',
  },
]
```

Inline parts use `contentId` and are wrapped in `multipart/related`:

```ts
await EdgeMailer.send(config, {
  from: 'sender@example.com',
  to: 'recipient@example.net',
  subject: 'Inline image',
  html: '<img src="cid:logo">',
  attachments: [
    {
      filename: 'logo.png',
      content: logoBase64,
      mimeType: 'image/png',
      contentId: 'logo',
      disposition: 'inline',
    },
  ],
})
```

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
- DKIM signing before `DATA`
- Multipart alternative, related, and mixed MIME composition
- Attachments from base64 strings, raw bytes, or `Blob` content with `base64`,
  `7bit`, and `quoted-printable` transfer encodings

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
