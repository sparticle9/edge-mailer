import { env } from 'cloudflare:workers'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import contactWorker, {
  handleContact,
  verifyChallenge,
  type Env as ContactEnv,
} from '../../sample/contact-form/src/index'
import {
  handleOutbox,
  type Env as OutboxEnv,
} from '../../sample/durable-outbox/src/index'
import {
  claim,
  drain,
  enqueue,
  LEASE_MS,
} from '../../sample/durable-outbox/src/outbox'
import { body, type SendMail } from '../../sample/starters/shared'
import {
  EdgeMailer,
  LogLevel,
  SMTPError,
  SmtpMailer,
} from '../../src/cloudflare'
import type { EmailOptions } from '../../src/email'
import rateSchema from '../../sample/contact-form/migrations/0001_rate_limits.sql?raw'
import outboxSchema from '../../sample/durable-outbox/migrations/0001_outbox.sql?raw'

const db = (env as { STARTER_DB: D1Database }).STARTER_DB
const config = {
  DB: db,
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USERNAME: 'test',
  SMTP_PASSWORD: 'test',
  MAIL_FROM: 'sender@example.com',
  MAIL_TO: 'team@example.com',
  PUBLIC_ORIGIN: 'https://contact.example.com',
  TURNSTILE_SITE_KEY: 'test-site-key',
  TURNSTILE_SECRET_KEY: 'test-secret',
  RATE_LIMIT_SECRET: 'rate-limit-fixture-only-000000000000',
  OUTBOX_TOKEN: 'outbox-fixture-only-0000000000000000',
} satisfies ContactEnv & OutboxEnv
const receipt = {
  attemptId: 'smtp-attempt',
  responseCode: 250,
  tlsMode: 'starttls' as const,
}
const payload = {
  name: 'Visitor',
  email: 'visitor@example.com',
  subject: 'Hello',
  message: '<script>test</script>\nPlain text',
  website: '',
  turnstileToken: 'test-token',
}
const mail: EmailOptions = {
  from: 'sender@example.com',
  to: 'recipient@example.com',
  subject: 'Notification',
  text: 'Hello',
  messageId: '<stable@example.com>',
}
function contact(
  data: unknown = payload,
  headers: Record<string, string> = {},
) {
  return new Request('https://contact.example.com/contact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: config.PUBLIC_ORIGIN,
      'CF-Connecting-IP': '192.0.2.1',
      ...headers,
    },
    body: JSON.stringify(data),
  })
}
function notification(
  id: string,
  data: unknown = { to: mail.to, subject: mail.subject, text: mail.text },
  token = config.OUTBOX_TOKEN,
) {
  return new Request('https://outbox.example.com/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': id,
    },
    body: JSON.stringify(data),
  })
}
async function row(id: string) {
  return db
    .prepare('SELECT * FROM outbox WHERE id=?')
    .bind(id)
    .first<Record<string, unknown>>()
}
beforeEach(async () => {
  await db.exec(
    'DROP TABLE IF EXISTS outbox_attempts; DROP TABLE IF EXISTS outbox; DROP TABLE IF EXISTS rate_limits;',
  )
  for (const sql of (rateSchema + outboxSchema)
    .split(';')
    .map(s => s.trim())
    .filter(Boolean))
    await db.prepare(sql).run()
})
afterEach(() => vi.restoreAllMocks())

describe('contact form acceptance scenarios', () => {
  it('serves an accessible form and routes fetch through the default SMTP adapter', async () => {
    const response = await contactWorker.fetch(
      new Request(config.PUBLIC_ORIGIN),
      config,
    )
    expect(await response.text()).toContain('aria-live="polite"')
    expect(response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    )
    const verifyFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({
          success: true,
          action: 'contact',
          hostname: 'contact.example.com',
        }),
      )
    const send = vi
      .spyOn(EdgeMailer, 'send')
      .mockResolvedValue({ ...receipt } as Awaited<
        ReturnType<typeof EdgeMailer.send>
      >)
    expect((await contactWorker.fetch(contact(), config)).status).toBe(200)
    expect(send.mock.calls[0][0]).toMatchObject({
      tlsPolicy: 'require-starttls',
      logLevel: LogLevel.NONE,
    })
    expect(verifyFetch.mock.calls[0][0]).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    )
  })
  it('fixes sender and recipient and uses a validated visitor Reply-To, with text-only content', async () => {
    const send = vi.fn<SendMail>().mockResolvedValue(receipt)
    const response = await handleContact(
      contact({
        ...payload,
        to: 'attacker@example.com',
        from: 'attacker@example.com',
      }),
      config,
      send,
      async () => true,
    )
    expect(await response.json()).toMatchObject({ status: 'accepted' })
    expect(send.mock.calls[0][0]).toMatchObject({
      from: config.MAIL_FROM,
      to: config.MAIL_TO,
      reply: payload.email,
      text: `From: Visitor\n\n${payload.message}`,
    })
    expect(send.mock.calls[0][0].html).toBeUndefined()
  })
  it.each([
    [
      'header injection',
      { ...payload, email: 'visitor@example.com\r\nBcc: victim@example.com' },
      {},
      400,
    ],
    ['honeypot', { ...payload, website: 'https://spam.example.com' }, {}, 400],
    ['empty message', { ...payload, message: ' ' }, {}, 400],
    ['oversized payload', { ...payload, message: 'x'.repeat(17000) }, {}, 413],
    ['cross-origin', payload, { Origin: 'https://evil.example.com' }, 403],
    ['missing origin', payload, { Origin: '' }, 403],
  ])('rejects %s before SMTP', async (_name, data, headers, status) => {
    const send = vi.fn<SendMail>()
    expect(
      (
        await handleContact(
          contact(data, headers as Record<string, string>),
          config,
          send,
          async () => true,
        )
      ).status,
    ).toBe(status)
    expect(send).not.toHaveBeenCalled()
  })
  it('fails closed on missing settings and challenge rejection/unavailability', async () => {
    const send = vi.fn<SendMail>()
    expect(
      (
        await handleContact(
          contact(),
          { ...config, RATE_LIMIT_SECRET: '' },
          send,
        )
      ).status,
    ).toBe(503)
    expect(
      (await handleContact(contact(), config, send, async () => false)).status,
    ).toBe(403)
    expect(
      (
        await handleContact(contact(), config, send, async () => {
          throw new Error('unavailable')
        })
      ).status,
    ).toBe(503)
    expect(send).not.toHaveBeenCalled()
  })
  it.each([
    { success: false },
    { success: true, hostname: 'evil.example.com', action: 'contact' },
    { success: true, hostname: 'contact.example.com', action: 'other' },
  ])('validates Turnstile hostname and action: %j', async result => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(result))
    expect(await verifyChallenge('token', '192.0.2.1', config)).toBe(false)
  })
  it('atomically enforces five submissions per IP across concurrent requests without storing raw IPs', async () => {
    const send = vi.fn<SendMail>().mockResolvedValue(receipt)
    const replies = await Promise.all(
      Array.from({ length: 9 }, () =>
        handleContact(contact(), config, send, async () => true),
      ),
    )
    expect(replies.filter(r => r.status === 200)).toHaveLength(5)
    expect(replies.filter(r => r.status === 429)).toHaveLength(4)
    expect(send).toHaveBeenCalledTimes(5)
    const stored = await db.prepare('SELECT * FROM rate_limits').all()
    expect(JSON.stringify(stored.results)).not.toContain('192.0.2.1')
  })
  it('enforces the global hourly cap and cleans expired counters', async () => {
    const hour = Math.floor(Date.now() / 3600000)
    await db
      .prepare('INSERT INTO rate_limits VALUES(?,100,?)')
      .bind(`global:${hour}`, (hour + 1) * 3600000)
      .run()
    expect(
      (
        await handleContact(
          contact(),
          config,
          async () => receipt,
          async () => true,
        )
      ).status,
    ).toBe(429)
    await db
      .prepare('INSERT INTO rate_limits VALUES(?,1,0)')
      .bind('expired')
      .run()
    await contactWorker.scheduled({} as ScheduledController, config)
    expect(
      await db.prepare("SELECT * FROM rate_limits WHERE key='expired'").first(),
    ).toBeNull()
  })
  it('reports ambiguous sends without encouraging a blind resend and hides SMTP details', async () => {
    const send: SendMail = async () => {
      throw new SMTPError('Private provider details', {
        stage: 'body',
        reason: 'delivery_unknown',
        retryHint: 'unknown',
      })
    }
    const response = await handleContact(
      contact(),
      config,
      send,
      async () => true,
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ status: 'unknown' })
    const failure = await handleContact(
      contact(),
      config,
      async () => {
        throw new SMTPError('private', { stage: 'rcpt', response: '550 No' })
      },
      async () => true,
    )
    expect(failure.status).toBe(502)
    expect(await failure.text()).not.toContain('private')
  })
})

describe('durable outbox acceptance scenarios', () => {
  it('requires server-side authorization for enqueue and status', async () => {
    expect((await handleOutbox(notification('a', {}, ''), config)).status).toBe(
      401,
    )
    expect(
      (await handleOutbox(notification('a'), { ...config, OUTBOX_TOKEN: '' }))
        .status,
    ).toBe(401)
    expect(
      (
        await handleOutbox(
          new Request('https://outbox.example.com/outbox/a'),
          config,
        )
      ).status,
    ).toBe(401)
    expect(await row('a')).toBeNull()
  })
  it('durably enqueues once, deduplicates concurrent requests, and rejects key reuse with different content', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        handleOutbox(notification('invoice-1'), config),
      ),
    )
    expect(responses.filter(r => r.status === 202)).toHaveLength(1)
    expect(responses.filter(r => r.status === 200)).toHaveLength(7)
    expect(
      (
        await handleOutbox(
          notification('invoice-1', {
            to: 'other@example.com',
            subject: 'Changed',
            text: 'Changed',
          }),
          config,
        )
      ).status,
    ).toBe(409)
    expect(await row('invoice-1')).toMatchObject({
      status: 'pending',
      attempts: 0,
    })
  })
  it('validates request bodies, recipient addresses, and idempotency keys before enqueue', async () => {
    expect((await handleOutbox(notification('../bad'), config)).status).toBe(
      400,
    )
    expect(
      (
        await handleOutbox(
          notification('bad', { to: 'bad\r\n', subject: 'x', text: 'x' }),
          config,
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await handleOutbox(
          notification('huge', {
            to: 'r@example.com',
            subject: 'x',
            text: 'x'.repeat(18000),
          }),
          config,
        )
      ).status,
    ).toBe(413)
    expect(
      (await db.prepare('SELECT * FROM outbox').all()).results,
    ).toHaveLength(0)
  })
  it('allows only one consumer to claim a message and persists acceptance and receipt metadata', async () => {
    await enqueue(db, 'one', mail, 0)
    const send = vi.fn<SendMail>().mockResolvedValue(receipt)
    await Promise.all([drain(db, send, () => 10), drain(db, send, () => 10)])
    expect(send).toHaveBeenCalledTimes(1)
    expect(await row('one')).toMatchObject({ status: 'accepted', attempts: 1 })
    const status = await handleOutbox(
      new Request('https://outbox.example.com/outbox/one', {
        headers: { Authorization: `Bearer ${config.OUTBOX_TOKEN}` },
      }),
      config,
    )
    const output = await status.json<{ history: unknown[] }>()
    expect(output.history).toEqual([
      expect.objectContaining({
        status: 'accepted',
        smtp_attempt_id: 'smtp-attempt',
        response_code: 250,
      }),
    ])
    expect(JSON.stringify(output)).not.toContain('recipient@example.com')
    await drain(db, send, () => LEASE_MS * 2)
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('backs off explicit transient failure, retains Message-ID, and succeeds on a later invocation', async () => {
    await enqueue(db, 'retry', mail, 0)
    const send = vi
      .fn<SendMail>()
      .mockRejectedValueOnce(
        new SMTPError('Temporary', {
          stage: 'rcpt',
          response: '451 Try later',
        }),
      )
      .mockResolvedValue(receipt)
    await drain(db, send, () => 0)
    expect(await row('retry')).toMatchObject({
      status: 'retry',
      next_attempt_at: 60000,
      attempts: 1,
    })
    await drain(db, send, () => 59999)
    expect(send).toHaveBeenCalledTimes(1)
    await drain(db, send, () => 60000)
    expect(await row('retry')).toMatchObject({
      status: 'accepted',
      attempts: 2,
    })
    expect(send.mock.calls.map(c => c[0].messageId)).toEqual([
      mail.messageId,
      mail.messageId,
    ])
  })
  it('dead-letters permanent errors immediately and transient errors after three attempts', async () => {
    await enqueue(db, 'permanent', mail, 0)
    await drain(
      db,
      async () => {
        throw new SMTPError('No', { stage: 'rcpt', response: '550 Rejected' })
      },
      () => 0,
    )
    expect(await row('permanent')).toMatchObject({
      status: 'dead_letter',
      attempts: 1,
    })
    await enqueue(db, 'exhausted', mail, 0)
    const send = vi
      .fn<SendMail>()
      .mockRejectedValue(
        new SMTPError('Later', { stage: 'rcpt', response: '451 Later' }),
      )
    for (const time of [0, 60000, 180000, 999999])
      await drain(db, send, () => time)
    expect(send).toHaveBeenCalledTimes(3)
    expect(await row('exhausted')).toMatchObject({
      status: 'dead_letter',
      reason: 'retry_exhausted',
    })
  })
  it('quarantines expired claims after a process crash instead of automatically resending', async () => {
    await enqueue(db, 'crash', mail, 0)
    expect(await claim(db, 0)).toMatchObject({ id: 'crash', status: 'sending' })
    const send = vi.fn<SendMail>()
    await drain(db, send, () => LEASE_MS)
    expect(send).not.toHaveBeenCalled()
    expect(await row('crash')).toMatchObject({
      status: 'unknown',
      reason: 'lease_expired',
      attempts: 1,
    })
    expect(
      await db.prepare('SELECT status FROM outbox_attempts').first(),
    ).toEqual({ status: 'unknown' })
  })
  it('keeps an accepted-but-unrecorded attempt out of automatic retries when the DB write fails', async () => {
    await enqueue(db, 'db-failure', mail, 0)
    await db.exec(
      "CREATE TRIGGER fail_acceptance BEFORE UPDATE ON outbox WHEN NEW.status='accepted' BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END;",
    )
    const send = vi.fn<SendMail>().mockResolvedValue(receipt)
    await expect(drain(db, send, () => 0)).rejects.toThrow(
      'injected persistence failure',
    )
    expect(await row('db-failure')).toMatchObject({ status: 'sending' })
    await drain(db, send, () => LEASE_MS)
    expect(await row('db-failure')).toMatchObject({
      status: 'unknown',
      reason: 'lease_expired',
    })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('induces a lost final DATA reply through the SMTP engine and persists unknown without retry', async () => {
    const writes: string[] = []
    class LostReplyMailer extends SmtpMailer {
      constructor() {
        super(
          {
            host: 'smtp.example.com',
            port: 2525,
            tlsPolicy: 'opportunistic',
            startTls: false,
            logLevel: LogLevel.NONE,
          },
          {
            connect: () => ({
              readable: new ReadableStream({
                start(controller) {
                  for (const response of [
                    '220 ready\r\n',
                    '250 hello\r\n',
                    '250 sender\r\n',
                    '250 recipient\r\n',
                    '354 send data\r\n',
                  ])
                    controller.enqueue(new TextEncoder().encode(response))
                  controller.close()
                },
              }),
              writable: new WritableStream({
                write(chunk) {
                  writes.push(new TextDecoder().decode(chunk))
                },
              }),
              close() {},
            }),
          },
        )
      }
      async initialize() {
        await this.initializeSmtpSession()
      }
    }
    const send = vi.fn<SendMail>(async message => {
      const mailer = new LostReplyMailer()
      await mailer.initialize()
      try {
        return await mailer.send(message)
      } finally {
        await mailer.close()
      }
    })
    await enqueue(db, 'lost', mail, 0)
    await drain(db, send, () => 0)
    expect(writes.join('')).toContain('\r\n.\r\n')
    expect(await row('lost')).toMatchObject({
      status: 'unknown',
      reason: 'delivery_unknown',
    })
    await drain(db, send, () => 999999)
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('holds unclassified exceptions for reconciliation', async () => {
    await enqueue(db, 'unknown', mail, 0)
    await drain(
      db,
      async () => {
        throw new Error('unclassified')
      },
      () => 0,
    )
    expect(await row('unknown')).toMatchObject({
      status: 'unknown',
      reason: 'unclassified_failure',
    })
  })
})

it('rejects invalid JSON, arrays and unsupported content types with bounded streaming reads', async () => {
  for (const text of ['{', '[]', 'null'])
    await expect(
      body(
        new Request('https://example.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: text,
        }),
      ),
    ).rejects.toMatchObject({ status: 400 })
  await expect(
    body(new Request('https://example.com', { method: 'POST', body: '{}' })),
  ).rejects.toMatchObject({ status: 415 })
})
