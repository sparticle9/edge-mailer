# Durable outbox starter

An authenticated notification API writes mail to D1 before returning. A cron
consumer claims and sends up to five messages every five minutes, then persists
SMTP acceptance or a bounded retry/dead-letter/unknown outcome. No external queue
is required: the D1 outbox is the durable work queue.

## Run from a clean clone

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run test:starters
cd sample/durable-outbox
cp secrets.example .dev.vars
pnpm exec wrangler d1 migrations apply DB --local
pnpm exec wrangler dev --local --test-scheduled --port 8788
```

Set `SMTP_HOST`, `SMTP_PORT`, and `MAIL_FROM` in `wrangler.jsonc`. Fill the ignored
`.dev.vars` with SMTP credentials and a random `OUTBOX_TOKEN` of at least 32
characters (`openssl rand -hex 32`). Ports 587/2525 require STARTTLS; 465 requires
implicit TLS. The token belongs only on your trusted application server, never
in browser JavaScript. Anyone with it can queue mail to arbitrary recipients.

In a second terminal, provide the same token through your normal secret manager
or shell environment, then:

```sh
curl http://localhost:8788/notifications \
  -H "Authorization: Bearer $OUTBOX_TOKEN" \
  -H 'Idempotency-Key: invoice-1001' \
  -H 'Content-Type: application/json' \
  --data '{"to":"recipient@example.com","subject":"Your invoice","text":"Thank you for your order."}'
# Replace recipient@example.com with your own authorized test mailbox first.
# This local development endpoint executes the scheduled handler and sends mail:
curl http://localhost:8788/__scheduled
curl http://localhost:8788/outbox/invoice-1001 \
  -H "Authorization: Bearer $OUTBOX_TOKEN"
```

The first response is `202 pending`; repeating the same key and payload returns
`200` with the existing state, and changing the payload returns `409`. Keys allow
1–64 letters, digits, underscores or hyphens. Status responses show attempt
history and selected SMTP receipt metadata, without returning recipient/body or
raw SMTP responses. Status is also authenticated. There is no public drain,
retry, delete, or operator endpoint; `/__scheduled` is Wrangler's local test hook.

## State policy

| Outcome                                                        | Durable state and next action                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| New application key                                            | `pending`, no SMTP work inside the enqueue request                             |
| Atomic SQL claim                                               | `sending`, unique claim ID and an attempt row, five-minute lease               |
| SMTP acceptance                                                | `accepted`, SMTP attempt ID/code/TLS persisted; never sent again automatically |
| Explicit retryable failure                                     | `retry` after 60 seconds, then 120 seconds; cron timing may add delay          |
| Third retryable failure                                        | `dead_letter`, reason `retry_exhausted`                                        |
| Permanent failure                                              | `dead_letter` immediately                                                      |
| Lost final DATA reply, cancellation, or unclassified exception | `unknown`, no automatic retry                                                  |
| Process crash or failed DB write after sending                 | Expired `sending` becomes `unknown`, no automatic retry                        |

A database transaction claims the row and creates its attempt record together.
The completion transaction writes the attempt metadata and final row state
together, conditioned on the same claim still owning the row. SQL claims prevent
two workers sending the same row concurrently. Consumers never reclaim expired
leases for sending. A late result after lease recovery requires reconciliation.

SMTP and D1 cannot commit atomically. A stable Message-ID is for correlation,
**not an SMTP deduplication guarantee**. `accepted` means server acceptance, not
inbox delivery. This starter deliberately prefers operator attention over a
possible duplicate in an uncertain case.

## Reconcile unknown and dead-letter work

1. Inspect authenticated status/history. Find the stable `message_id`, timestamps,
   reason, and any SMTP attempt ID. Check provider logs for acceptance.
2. Pause the cron trigger and wait for all running invocations to finish before
   manually changing a row. A stopped HTTP client does not stop a cron consumer.
3. If acceptance is confirmed, mark the row `accepted`. If the result remains
   unknown, leave it `unknown`. If abandonment is appropriate, use `dead_letter`.
   Only when non-acceptance is established may you explicitly requeue it.
4. Record the evidence in your operational incident record. Retain attempt history.
   Apply a guarded update for the exact application key and current state; check
   the affected row count before resuming the cron trigger.

Example SQL for a confirmed non-acceptance with retry budget remaining:

```sql
UPDATE outbox
SET status = 'retry', next_attempt_at = unixepoch() * 1000,
    lease_until = NULL, reason = 'operator_confirmed_not_accepted',
    updated_at = unixepoch() * 1000
WHERE id = 'invoice-1001' AND status = 'unknown' AND attempts < 3;
```

Use `wrangler d1 execute DB --local --command '...'` for local data, or
`--remote` deliberately for your deployed database. For a confirmed acceptance,
set `status='accepted'` and `reason='operator_confirmed_accepted'` with the same
state guard. The attempt history remains a record of what the worker observed.
Exhausted/permanent errors require fixing the cause and an explicit new business
operation/key; the starter does not reset retry budgets silently.

## Deploy and integrate

```sh
pnpm exec wrangler d1 create edge-mailer-durable-outbox
# Replace the all-zero database_id in wrangler.jsonc with the returned ID.
pnpm exec wrangler d1 migrations apply DB --remote
pnpm exec wrangler secret put SMTP_USERNAME
pnpm exec wrangler secret put SMTP_PASSWORD
pnpm exec wrangler secret put OUTBOX_TOKEN
pnpm exec wrangler deploy
```

Keep credentials in your deployer's secret manager, ignored `.dev.vars` locally,
and Worker secrets in production. Restore them through that same delivery path.
Automated tests and release CI require no live SMTP secrets. This repository
publishes the starter; it does not provision a database or deploy a mail service
for you.

When a business mutation and notification must succeed together, put the outbox
insert and business update in the **same D1 `batch()` transaction**. Calling this
HTTP API after a separate business commit leaves a gap; use a durable event
handoff if the business database is elsewhere. See
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

This starter intentionally has one trusted caller/token, bounded message bodies
(16 KiB HTTP, 8,000 text characters), one recipient per message, and serial
processing. Add tenant authorization, enqueue quotas, alerts for backlog/unknown/
dead-letter counts, and a measured throughput policy for your application.
Message bodies and addresses remain in D1; choose a retention policy and protect
access/backups. Deleting a row also removes its idempotency protection, so retain
a tombstone/key for your application's replay window before pruning message data.

Copy this folder together with `sample/starters/`, or adapt the imports to use
`edge-mailer/cloudflare` in your application. See [scenario verdicts](../VERDICTS-0.8.5.md).
