# Build with the SMTP service you already use

Edge Mailer fits applications running on Cloudflare Workers or Deno that already
have an SMTP server, verified sender, and credentials. The library handles the
SMTP session, MIME, attachments, and structured results without adding runtime
dependencies. Your application owns who may send, when to retry, and how to
handle delivery outcomes.

## Pick your first workflow

| User story                                                                 | What you can use today                                                  | Application work still needed                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A small business receives contact-form submissions in its existing mailbox | Runnable form, fixed routing, Reply-To, Turnstile, D1 limits            | Deploy/configure the starter, choose traffic/privacy policy                |
| A SaaS sends receipts or account notifications from a queue                | Runnable D1 outbox, idempotency, attempt history, bounded retries       | Business transaction integration, quotas, operator reconciliation          |
| A booking app sends meeting invitations and cancellations                  | UTF-8 ICS, attendees, stable UID and sequence, REQUEST/CANCEL           | Persist event identity, timezone conversion, client rendering verification |
| A Deno cron job emails a small report or invoice                           | Raw-byte/Blob attachments, MIME, provider-managed or local DKIM         | Scheduler, attachment size policy, delivery follow-up                      |
| An administrator connects an existing SMTP provider                        | No-send capability probe, provider profiles, token callback for XOAUTH2 | OAuth consent/refresh, credentials storage, provider sending policy        |

Use the [Worker sample](https://github.com/sparticle9/edge-mailer/tree/main/sample/cloudflare-worker-smtp)
or [Deno sample](https://github.com/sparticle9/edge-mailer/tree/main/sample/deno-smtp)
for the first send. They expose server-to-server endpoints protected by a token;
they are SMTP connectivity samples. For a complete browser flow, use the
[contact form starter](https://github.com/sparticle9/edge-mailer/tree/main/sample/contact-form).
For durable background notifications, use the
[outbox starter](https://github.com/sparticle9/edge-mailer/tree/main/sample/durable-outbox),
including its retry and reconciliation runbook.

## Contact form: fixed sender and destination

Call this helper from your application's validated, rate-limited form handler.
Keep the SMTP configuration and destination in server-side settings. Set the
visitor as Reply-To so your SMTP sender identity stays under your control.

```ts
import { EdgeMailer, type EdgeMailerOptions } from 'edge-mailer/cloudflare'

export async function submitContact(
  config: EdgeMailerOptions,
  input: { email: string; message: string },
  signal?: AbortSignal,
) {
  return EdgeMailer.send(
    config,
    {
      from: 'website@example.com',
      to: 'team@example.com',
      reply: input.email,
      subject: 'Website enquiry',
      text: input.message,
    },
    { signal },
  )
}
```

The application must validate the visitor's address and authorize the request
before calling this helper. Prefer plain text for untrusted form content.
Successful submission returns an SMTP receipt; show users “submitted” rather
than promising inbox delivery.

## Queued notifications: make retries deliberate

Persist an outbox entry before enqueueing a notification. Give it an application
id and stable `messageId`, then record `attemptId`, response code, and acceptance
time. A Message-ID is a correlation identifier; SMTP servers do not promise
deduplication based on it.

| Outcome                                                        | Queue action                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| Send returns a receipt                                         | Record acceptance, then acknowledge the job                           |
| Explicit transient SMTP rejection before acceptance            | Retry with backoff and a bounded attempt count                        |
| Permanent rejection, invalid input, or auth/TLS policy failure | Stop automatic retries; route to operator or dead-letter handling     |
| `reason: 'delivery_unknown'` after DATA                        | Hold for reconciliation; an automatic retry can duplicate the message |
| Cancellation after sending began                               | Treat delivery as potentially ambiguous; reconcile the attempt        |

Use one session or pool per Worker invocation and close it in `finally`.
Cloudflare sockets cannot be shared across requests, and outbound connections
to port 25 and Cloudflare IP ranges are blocked. See the
[Cloudflare socket restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).
In a long-lived Deno process, a pool can be process-scoped and closed on shutdown.
Keep application concurrency bounded; the pool limits connections, not the
number of queued messages or memory used by callers.

Batch sending currently fails a message if any recipient is rejected; it does
not submit that message's body to the accepted subset. `continueOnError` applies
to the next message in the batch. Prefer one logical notification per recipient
when independent outcomes matter.

## Calendar invitations: preserve identity

```ts
const invitation = {
  from: 'bookings@example.com',
  to: 'guest@example.com',
  subject: 'Your appointment',
  text: 'Your appointment details are attached.',
  icalendar: {
    uid: 'booking-123@example.com',
    sequence: 0,
    method: 'REQUEST' as const,
    summary: 'Project consultation',
    start: '20261001T090000Z',
    end: '20261001T093000Z',
    organizer: { name: 'Bookings', email: 'bookings@example.com' },
    attendees: [{ email: 'guest@example.com', rsvp: true }],
  },
}
```

Send updates with the same UID and a higher sequence number. For cancellation,
use `method: 'CANCEL'` with the same UID. Times use UTC basic format
`YYYYMMDDTHHMMSSZ`; all-day events use `YYYYMMDD` with an exclusive end date.
Timezone conversion and recurring events are not provided. MIME/ICS tests do not
prove RSVP rendering in every mail client; test the clients your users rely on.

## Where this package does not fit

Choose a broader email service when you need campaign management, suppression
lists, delivery webhooks, open/click analytics, inbound mail, or an operator UI.
These features are outside the SMTP library's scope. The default entrypoint is
Cloudflare-specific; plain Node.js and runtimes without outbound TCP are not
supported runtime targets.

## Help shape the next release

The contact-form and durable outbox starters are available with automated failure
recovery scenarios. The most valuable follow-ups are dated provider acceptance results
for both runtimes, independent DKIM verification, real mail-client invite
screenshots, and attachment memory measurements. Report the workflow you need
and a concrete success criterion in a
[feature proposal](https://github.com/sparticle9/edge-mailer/issues/new/choose).
