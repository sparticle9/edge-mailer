import { describe, expect, it, vi } from 'vitest'
import type { EmailOptions } from '../../src/email'
import type {
  EdgeMailerOptions,
  SmtpMailer,
  SmtpSendReceipt,
} from '../../src/smtp/mailer'
import { SmtpConnectionPool } from '../../src/smtp/pool'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(next => {
    resolve = next
  })
  return { promise, resolve }
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

const email: EmailOptions = {
  from: 'sender@example.com',
  to: 'recipient@example.com',
  subject: 'Pool lifecycle',
  text: 'Pool lifecycle test.',
}

const receipt: SmtpSendReceipt = {
  messageId: '<pool-lifecycle@example.com>',
  envelope: {
    from: 'sender@example.com',
    to: ['recipient@example.com'],
  },
  accepted: ['recipient@example.com'],
  rejected: [],
  response: '250 Message accepted',
  responseCode: 250,
  size: 512,
}

const options: EdgeMailerOptions = {
  host: 'smtp.example.com',
  port: 587,
  pool: {
    maxConnections: 1,
    maxMessagesPerConnection: 1,
    idleTimeoutMs: 0,
  },
}

describe('SmtpConnectionPool lifecycle', () => {
  it('waits for a retired SMTP client to close before pool close resolves', async () => {
    const closeStarted = deferred()
    const closeGate = deferred()
    const mailer = {
      send: vi.fn(async () => receipt),
      close: vi.fn(async () => {
        closeStarted.resolve()
        await closeGate.promise
      }),
      isActive: vi.fn(() => true),
    }
    const pool = new SmtpConnectionPool<SmtpMailer>(
      options,
      async () => mailer as unknown as SmtpMailer,
    )

    const sendPromise = pool.send(email)
    await closeStarted.promise

    let closeSettled = false
    const closePromise = pool.close().then(() => {
      closeSettled = true
    })
    await flushMicrotasks()

    expect(closeSettled).toBe(false)
    closeGate.resolve()
    await closePromise
    await expect(sendPromise).resolves.toBe(receipt)
    expect(mailer.close).toHaveBeenCalledTimes(1)
  })

  it('closes a connection that resolves after the pool has closed', async () => {
    const connectGate = deferred<SmtpMailer>()
    const closeStarted = deferred()
    const closeGate = deferred()
    const mailer = {
      send: vi.fn(async () => receipt),
      close: vi.fn(async () => {
        closeStarted.resolve()
        await closeGate.promise
      }),
      isActive: vi.fn(() => true),
    }
    const pool = new SmtpConnectionPool<SmtpMailer>(
      options,
      () => connectGate.promise,
    )

    const sendResult = pool.send(email).then(
      value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason }),
    )
    await flushMicrotasks()

    let closeSettled = false
    const closePromise = pool.close().then(() => {
      closeSettled = true
    })
    await flushMicrotasks()
    expect(closeSettled).toBe(false)

    connectGate.resolve(mailer as unknown as SmtpMailer)
    await closeStarted.promise
    await flushMicrotasks()
    expect(closeSettled).toBe(false)

    closeGate.resolve()
    await closePromise
    const result = await sendResult
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect(result.reason).toBeInstanceOf(Error)
      expect(result.reason.message).toBe('SMTP connection pool is closed')
    }
    expect(mailer.send).not.toHaveBeenCalled()
    expect(mailer.close).toHaveBeenCalledTimes(1)
  })
})
