import type { EmailOptions } from '../../../src/email'
import {
  digest,
  failure,
  HttpError,
  type Delivery,
  type SendMail,
} from '../../starters/shared'

export const MAX_ATTEMPTS = 3
export const LEASE_MS = 300_000
export interface Row {
  id: string
  mail_json: string
  message_id: string
  status: string
  attempts: number
  claim_id: string
  lease_until: number
  reason: string | null
  next_attempt_at: number
}
export async function enqueue(
  db: D1Database,
  id: string,
  mail: EmailOptions,
  now = Date.now(),
): Promise<{ id: string; status: string; duplicate: boolean }> {
  const serialized = JSON.stringify(mail),
    hash = await digest(serialized)
  const result = await db
    .prepare(
      `INSERT INTO outbox(id,payload_hash,mail_json,message_id,status,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?,?) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, hash, serialized, mail.messageId!, now, now, now)
    .run()
  const row = await db
    .prepare('SELECT payload_hash,status FROM outbox WHERE id=?')
    .bind(id)
    .first<{ payload_hash: string; status: string }>()
  if (!row) throw new Error('Outbox insert unavailable')
  if (row.payload_hash !== hash)
    throw new HttpError(
      409,
      'Idempotency key already used for a different message',
    )
  return { id, status: row.status, duplicate: result.meta.changes === 0 }
}
export async function recoverExpired(
  db: D1Database,
  now: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE outbox_attempts SET status='unknown',reason='lease_expired',finished_at=? WHERE id IN (SELECT claim_id FROM outbox WHERE status='sending' AND lease_until<=?)`,
      )
      .bind(now, now),
    db
      .prepare(
        `UPDATE outbox SET status='unknown',reason='lease_expired',updated_at=? WHERE status='sending' AND lease_until<=?`,
      )
      .bind(now, now),
  ])
}
export async function claim(db: D1Database, now: number): Promise<Row | null> {
  const claimId = crypto.randomUUID()
  // One atomic SQL claim: concurrent consumers cannot both own a row.
  const results = await db.batch<Row>([
    db
      .prepare(
        `UPDATE outbox SET status='sending',attempts=attempts+1,claim_id=?,lease_until=?,updated_at=? WHERE id=(SELECT id FROM outbox WHERE status IN ('pending','retry') AND next_attempt_at<=? AND attempts<? ORDER BY next_attempt_at,created_at,id LIMIT 1) RETURNING *`,
      )
      .bind(claimId, now + LEASE_MS, now, now, MAX_ATTEMPTS),
    db
      .prepare(
        `INSERT INTO outbox_attempts(id,outbox_id,number,status,started_at) SELECT claim_id,id,attempts,'sending',? FROM outbox WHERE claim_id=?`,
      )
      .bind(now, claimId),
  ])
  return results[0].results[0] ?? null
}
async function finish(
  db: D1Database,
  row: Row,
  status: string,
  reason: string | null,
  now: number,
  receipt?: Delivery,
): Promise<void> {
  const due = status === 'retry' ? now + 60_000 * 2 ** (row.attempts - 1) : now
  const results = await db.batch([
    db
      .prepare(
        `UPDATE outbox_attempts SET status=?,reason=?,finished_at=?,smtp_attempt_id=?,response_code=?,tls_mode=? WHERE id=? AND EXISTS(SELECT 1 FROM outbox WHERE id=? AND claim_id=? AND status='sending')`,
      )
      .bind(
        status,
        reason,
        now,
        receipt?.attemptId ?? null,
        receipt?.responseCode ?? null,
        receipt?.tlsMode ?? null,
        row.claim_id,
        row.id,
        row.claim_id,
      ),
    db
      .prepare(
        `UPDATE outbox SET status=?,reason=?,next_attempt_at=?,updated_at=?,lease_until=NULL WHERE id=? AND claim_id=? AND status='sending'`,
      )
      .bind(status, reason, due, now, row.id, row.claim_id),
  ])
  if (results[1].meta.changes !== 1)
    throw new Error('Claim expired; reconcile the SMTP outcome')
}
export async function drain(
  db: D1Database,
  send: SendMail,
  clock: () => number = Date.now,
): Promise<number> {
  await recoverExpired(db, clock())
  let processed = 0
  // Small serial batches keep the sample below a cron invocation's wall-time budget.
  for (; processed < 5; processed++) {
    const row = await claim(db, clock())
    if (!row) break
    let receipt: Delivery | undefined,
      status = 'accepted',
      reason: string | null = null
    try {
      receipt = await send(JSON.parse(row.mail_json) as EmailOptions)
    } catch (error) {
      const outcome = failure(error)
      status =
        outcome.status === 'retry' && row.attempts >= MAX_ATTEMPTS
          ? 'dead_letter'
          : outcome.status
      reason =
        outcome.status === 'retry' && row.attempts >= MAX_ATTEMPTS
          ? 'retry_exhausted'
          : outcome.reason
    }
    // Deliberately outside the SMTP catch: a database failure after acceptance must
    // leave the claim for reconciliation, never turn it into another send.
    await finish(db, row, status, reason, clock(), receipt)
  }
  return processed
}
