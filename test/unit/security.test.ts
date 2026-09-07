import { describe, expect, it, vi } from 'vitest'
import { Email, type EmailOptions } from '../../src/email'
import { createIcsAttachment, createIcsString } from '../../src/icalendar'
import { LogLevel } from '../../src/logger'
import {
  SMTPError,
  SmtpMailer,
  type EdgeMailerOptions,
} from '../../src/smtp/mailer'
import worker from '../../sample/cloudflare-worker-smtp/src/index'
import { EdgeMailer } from '../../src/cloudflare'
import { SmtpConnectionPool } from '../../src/smtp/pool'

const message: EmailOptions = {
  from: 'sender@example.com',
  to: 'recipient@example.com',
  subject: 'Test',
  text: 'Hello',
}

function session(replies: string[]) {
  const writes: string[] = []
  const close = vi.fn()
  const socket = {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const reply of replies)
          controller.enqueue(new TextEncoder().encode(reply))
        controller.close()
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        writes.push(new TextDecoder().decode(chunk))
      },
    }),
    close,
  }
  class TestMailer extends SmtpMailer {
    constructor(options: Partial<EdgeMailerOptions> = {}) {
      super(
        {
          host: 'smtp.example.com',
          port: 587,
          logLevel: LogLevel.NONE,
          ...options,
        },
        { connect: () => socket },
      )
    }
    initialize() {
      return this.initializeSmtpSession()
    }
  }
  return { TestMailer, writes, close }
}

describe('public input and protocol security', () => {
  it('rejects invalid security policy and numeric configuration', () => {
    const { TestMailer } = session([])
    expect(() => new TestMailer({ tlsPolicy: 'required' as never })).toThrow(
      'TLS policy',
    )
    expect(() => new TestMailer({ port: NaN })).toThrow('valid port')
    expect(() => new TestMailer({ socketTimeoutMs: Infinity })).toThrow(
      'finite',
    )
    expect(
      () =>
        new SmtpConnectionPool(
          {
            host: 'smtp.example.com',
            port: 587,
            pool: { maxConnections: NaN },
          },
          async () => new TestMailer(),
        ),
    ).toThrow('safe integers')
  })

  it('honors an already cancelled one-shot send before connection setup', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      EdgeMailer.send({ host: 'smtp.example.com', port: 587 }, message, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: 'aborted', stage: 'connect' })
  })

  it('does not mutate shared caller headers or reuse generated message IDs', () => {
    const headers = { 'X-App': 'fixture' }
    const first = new Email({ ...message, headers })
    const second = new Email({ ...message, headers })
    first.getMessageData()
    second.getMessageData()
    expect(headers).toEqual({ 'X-App': 'fixture' })
    expect(first.headers['Message-ID']).not.toBe(second.headers['Message-ID'])
  })
  it('marks lost final DATA replies as ambiguous rather than safe to retry', () => {
    const error = new SMTPError(
      'Timeout while waiting for smtp server response',
      { stage: 'body' },
    )
    expect(error).toMatchObject({
      reason: 'delivery_unknown',
      retryHint: 'unknown',
      nextAction: 'inspect_error',
    })
    expect(
      new SMTPError('Try later', {
        stage: 'body',
        response: '451 Temporary failure',
      }).retryHint,
    ).toBe('retry')
  })

  it('does not enter DATA when a pipelined recipient fails', async () => {
    const { TestMailer, writes } = session([
      '220 Ready\r\n',
      '250 PIPELINING\r\n',
      '250 Sender\r\n',
      '250 Recipient\r\n',
      '550 Rejected\r\n',
      '250 Reset\r\n',
    ])
    const mailer = new TestMailer()
    await mailer.initialize()
    await expect(
      mailer.send({ ...message, to: ['ok@example.com', 'bad@example.com'] }),
    ).rejects.toMatchObject({ stage: 'rcpt' })
    expect(writes).not.toContain('DATA\r\n')
    expect(writes).toContain('RSET\r\n')
    await mailer.close()
  })
  it.each([
    { subject: 'hello\r\nBcc: hidden@example.com' },
    { from: 'sender@example.com> SIZE=1' },
    { to: 'recipient@example.com\r\nDATA' },
    { bcc: 'recipient@example.com\nDATA' },
    { reply: { name: 'name\rInjected: yes', email: 'reply@example.com' } },
    { headers: { 'X-Test\r\nBcc': 'hidden@example.com' } },
    { headers: { 'X-Test': 'ok\r\nBcc: hidden@example.com' } },
    { messageId: '<id@example.com>\r\nX-Injected: yes' },
    { references: ['<id@example.com>\nX-Injected: yes'] },
    { envelope: { from: 'sender@example.com> BODY=8BITMIME' } },
    { envelope: { to: ['recipient@example.com\r\nDATA'] } },
    { envelope: { size: '1\r\nDATA' } },
    { envelope: { body: '7BIT\r\nDATA' } },
    { attachments: [{ filename: 'test\r\nX-Injected: yes', content: 'eA==' }] },
    {
      attachments: [
        { filename: 'test', content: 'eA==', mimeType: 'text/plain\nX: y' },
      ],
    },
    {
      attachments: [
        { filename: 'test', content: 'eA==', contentId: 'id\r\nX: y' },
      ],
    },
  ])('rejects injection through message metadata (%j)', override => {
    expect(() =>
      new Email({ ...message, ...override } as EmailOptions).getMessageData(),
    ).toThrow()
  })

  it('escapes quoted names and filenames without introducing MIME parameters', () => {
    const data = new Email({
      ...message,
      from: { name: 'A "quoted" name', email: message.from as string },
      attachments: [{ filename: 'file"; injected="yes', content: 'eA==' }],
    }).getMessageData()
    expect(data).toContain('From: "A \\"quoted\\" name" <sender@example.com>')
    expect(data).toContain('filename="file\\"; injected=\\"yes"')
  })

  it('normalizes all newline forms before dot-stuffing DATA', () => {
    expect(Email.toSmtpData('body\r.\rQUIT\n.\nend')).toBe(
      'body\r\n..\r\nQUIT\r\n..\r\nend\r\n.\r\n',
    )
  })

  it('does not send credentials when STARTTLS is stripped from the greeting', async () => {
    const { TestMailer, writes } = session([
      '220 Ready\r\n',
      '250 AUTH PLAIN\r\n',
    ])
    const mailer = new TestMailer({
      credentials: {
        username: 'sender@example.com',
        password: 'fixture-password',
      },
    })
    await expect(mailer.initialize()).rejects.toMatchObject({
      reason: 'tls_failed',
    })
    expect(writes.some(line => line.startsWith('AUTH'))).toBe(false)
    await mailer.close()
  })

  it('refuses silent unauthenticated fallback when credentials were supplied', async () => {
    const { TestMailer } = session(['220 Ready\r\n', '250 SIZE 100000\r\n'])
    const mailer = new TestMailer({
      secure: true,
      credentials: {
        username: 'sender@example.com',
        password: 'fixture-password',
      },
    })
    await expect(mailer.initialize()).rejects.toMatchObject({ stage: 'auth' })
    await mailer.close()
  })

  it('bounds untrusted server response buffering', async () => {
    const { TestMailer, close } = session(['x'.repeat(65_537)])
    await expect(new TestMailer().initialize()).rejects.toThrow('64 KiB')
    expect(close).toHaveBeenCalled()
  })

  it('rejects oversized messages before submitting the envelope', async () => {
    const { TestMailer, writes } = session([
      '220 Ready\r\n',
      '250 SIZE 1\r\n',
      '250 Reset\r\n',
    ])
    const mailer = new TestMailer()
    await mailer.initialize()
    await expect(mailer.send(message)).rejects.toMatchObject({
      nextAction: 'reduce_message_size',
    })
    expect(writes.some(line => line.startsWith('MAIL FROM'))).toBe(false)
    await mailer.close()
  })

  it('keeps null reverse paths and measures message SIZE before dot-stuffing', async () => {
    const { TestMailer, writes } = session([
      '220 Ready\r\n',
      '250 SIZE 100000\r\n',
      '250 Sender\r\n',
      '250 Recipient\r\n',
      '354 Data\r\n',
      '250 Queued\r\n',
    ])
    const mailer = new TestMailer()
    await mailer.initialize()
    const receipt = await mailer.send({
      ...message,
      text: '.line',
      envelope: { from: '' },
    })
    expect(writes.find(line => line.startsWith('MAIL'))).toContain(
      'MAIL FROM: <>',
    )
    const data = writes.find(line => line.endsWith('\r\n.\r\n'))!
    expect(receipt.size).toBe(
      new TextEncoder().encode(data.replace(/\r\n\.\./g, '\r\n.').slice(0, -3))
        .length,
    )
    await mailer.close()
  })
})

describe('calendar safety and internationalization', () => {
  const event = {
    summary: '项目会议 📬'.repeat(30),
    start: '20260908T090000Z',
    end: '20260908T100000Z',
  }
  it('encodes UTF-8 invites and folds on octet boundaries', () => {
    const attachment = createIcsAttachment(event)
    const data = new TextDecoder().decode(
      Uint8Array.from(atob(attachment.content), c => c.charCodeAt(0)),
    )
    expect(data.replace(/\r\n /g, '')).toContain(event.summary)
    for (const line of data.split('\r\n'))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    expect(data).not.toContain('\uFFFD')
  })
  it('prevents injected calendar properties', () => {
    expect(() =>
      createIcsString({
        ...event,
        uid: 'id\r\nATTENDEE:mailto:hidden@example.com',
      }),
    ).toThrow()
    expect(() =>
      createIcsString({
        ...event,
        attendees: [{ email: 'x@example.com\r\nEND:VEVENT' }],
      }),
    ).toThrow()
    const data = createIcsString({
      ...event,
      summary: 'Title\r\nATTENDEE:mailto:hidden@example.com',
    })
    expect(data).not.toContain('\r\nATTENDEE:')
  })
  it('marks all-day events with DATE value types', () => {
    const data = createIcsString({
      ...event,
      start: '20260908',
      end: '20260909',
    })
    expect(data).toContain('DTSTART;VALUE=DATE:20260908')
    expect(data).toContain('DTEND;VALUE=DATE:20260909')
  })
})

describe('Worker sample authorization', () => {
  it.each(['{', 'null', '[]', ' '.repeat(1_048_577)])(
    'rejects invalid or oversized JSON without sending',
    async body => {
      const response = await worker.fetch(
        new Request('https://example.com/send', {
          method: 'POST',
          headers: { authorization: 'Bearer fixture-token' },
          body,
        }),
        { SAMPLE_SEND_TOKEN: 'fixture-token' },
      )
      expect(response.status).toBe(400)
    },
  )
  it.each(['/send', '/dry-run', '/capabilities'])(
    'denies %s when no token is configured',
    async route => {
      const response = await worker.fetch(
        new Request(`https://example.com${route}`, {
          method: route === '/capabilities' ? 'GET' : 'POST',
        }),
        {},
      )
      expect(response.status).toBe(401)
    },
  )
  it('requires a matching token for MIME preview', async () => {
    const env = {
      SAMPLE_SEND_TOKEN: 'fixture-token',
      SMTP_FROM: 'sender@example.com',
      SMTP_TO: 'recipient@example.com',
    }
    const denied = await worker.fetch(
      new Request('https://example.com/dry-run', { method: 'POST' }),
      env,
    )
    expect(denied.status).toBe(401)
    const allowed = await worker.fetch(
      new Request('https://example.com/dry-run', {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-token' },
        body: '{}',
      }),
      env,
    )
    expect(allowed.status).toBe(200)
  })
})
