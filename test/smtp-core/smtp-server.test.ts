import { once } from 'node:events'
import net, { type AddressInfo } from 'node:net'
import { Readable, Writable } from 'node:stream'
import tls from 'node:tls'
import { SMTPServer, type SMTPServerOptions } from 'smtp-server'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SMTPError,
  SmtpMailer,
  type EdgeMailerOptions,
} from '../../src/smtp/mailer.ts'
import type { EmailOptions } from '../../src/email'
import type { MailObservationEvent } from '../../src/observation'
import type { EdgeSocket, EdgeSocketConnector } from '../../src/runtime/socket'

const USERNAME = 'sender@example.com'
const PASSWORD = 'smtp-password'

type ServerState = {
  auths: { method: string; username?: string }[]
  mailFrom: { address: string; args: Record<string, unknown> }[]
  rcptTo: { address: string; args: Record<string, unknown> }[]
  messages: { raw: string; secure: boolean; transmissionType: string }[]
  secureCount: number
}

type TestServer = {
  port: number
  state: ServerState
  close(): Promise<void>
}

const activeServers: TestServer[] = []

function wrapNodeSocket(
  socket: net.Socket | tls.TLSSocket,
  hostname: string,
  opened: Promise<unknown>,
): EdgeSocket {
  return {
    readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(socket) as WritableStream<Uint8Array>,
    opened,
    closed: once(socket, 'close').then(() => undefined),
    close() {
      socket.destroy()
    },
    async startTls() {
      socket.pause()
      const tlsSocket = tls.connect({
        socket,
        servername: tlsServerName(hostname),
        rejectUnauthorized: false,
      })
      return wrapNodeSocket(
        tlsSocket,
        hostname,
        once(tlsSocket, 'secureConnect'),
      )
    },
  }
}

const nodeSocketConnector: EdgeSocketConnector = {
  connect(options) {
    if (options.tls === 'on') {
      const socket = tls.connect({
        host: options.hostname,
        port: options.port,
        servername: tlsServerName(options.hostname),
        rejectUnauthorized: false,
      })
      return wrapNodeSocket(
        socket,
        options.hostname,
        once(socket, 'secureConnect'),
      )
    }

    const socket = net.connect({
      host: options.hostname,
      port: options.port,
      signal: options.signal,
    })
    return wrapNodeSocket(socket, options.hostname, once(socket, 'connect'))
  },
}

function tlsServerName(hostname: string) {
  return net.isIP(hostname) ? 'localhost' : hostname
}

class FunctionalMailer extends SmtpMailer {
  private constructor(options: EdgeMailerOptions) {
    super(options, nodeSocketConnector, 'FunctionalMailer')
  }

  static async connect(options: EdgeMailerOptions): Promise<FunctionalMailer> {
    const mailer = new FunctionalMailer(options)
    try {
      await mailer.initializeSmtpSession()
      return mailer
    } catch (error) {
      await mailer.abortConnection(error)
      throw error
    }
  }

  static async send(
    options: EdgeMailerOptions,
    email: EmailOptions,
  ): Promise<void> {
    const mailer = await FunctionalMailer.connect(options)
    try {
      await mailer.send(email)
    } finally {
      await mailer.close()
    }
  }

  static async sendBatch(
    options: EdgeMailerOptions,
    emails: EmailOptions[],
    batchOptions: { continueOnError?: boolean } = {},
  ) {
    const mailer = await FunctionalMailer.connect(options)
    try {
      return await mailer.sendMany(emails, batchOptions)
    } finally {
      await mailer.close()
    }
  }
}

async function startServer(
  options: SMTPServerOptions = {},
  behavior: {
    rejectRecipient?: string
    rejectRecipientCode?: number
  } = {},
): Promise<TestServer> {
  const state: ServerState = {
    auths: [],
    mailFrom: [],
    rcptTo: [],
    messages: [],
    secureCount: 0,
  }

  const server = new SMTPServer({
    name: 'smtp.test.local',
    banner: 'edge-mailer functional test server',
    size: 1024 * 1024,
    hideDSN: false,
    hideENHANCEDSTATUSCODES: false,
    authMethods: ['PLAIN', 'LOGIN', 'CRAM-MD5'],
    onSecure(_socket, _session, callback) {
      state.secureCount++
      callback()
    },
    onAuth(auth, _session, callback) {
      state.auths.push({ method: auth.method, username: auth.username })
      const method = auth.method as string
      const valid =
        auth.username === USERNAME &&
        (method === 'CRAM-MD5'
          ? auth.validatePassword(PASSWORD)
          : auth.password === PASSWORD)

      if (valid) {
        callback(null, { user: auth.username })
        return
      }

      const error = new Error('Invalid credentials') as Error & {
        responseCode?: number
      }
      error.responseCode = 535
      callback(error)
    },
    onMailFrom(address, _session, callback) {
      state.mailFrom.push({
        address: address.address,
        args: address.args as Record<string, unknown>,
      })
      callback()
    },
    onRcptTo(address, _session, callback) {
      state.rcptTo.push({
        address: address.address,
        args: address.args as Record<string, unknown>,
      })
      if (address.address === behavior.rejectRecipient) {
        const error = new Error('Recipient rejected') as Error & {
          responseCode?: number
        }
        error.responseCode = behavior.rejectRecipientCode ?? 550
        callback(error)
        return
      }
      callback()
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', chunk => chunks.push(Buffer.from(chunk)))
      stream.on('error', error => callback(error))
      stream.on('end', () => {
        state.messages.push({
          raw: Buffer.concat(chunks).toString('utf8'),
          secure: session.secure,
          transmissionType: session.transmissionType,
        })
        callback(null, 'queued')
      })
    },
    ...options,
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.server.address() as AddressInfo
  const testServer = {
    port: address.port,
    state,
    close: () =>
      new Promise<void>(resolve => {
        server.close(resolve)
      }),
  }
  activeServers.push(testServer)
  return testServer
}

function baseConfig(port: number): EdgeMailerOptions {
  return {
    host: '127.0.0.1',
    port,
    secure: false,
    startTls: false,
    credentials: {
      username: USERNAME,
      password: PASSWORD,
    },
    authType: ['plain', 'login', 'cram-md5'],
    socketTimeoutMs: 2_000,
    responseTimeoutMs: 2_000,
  }
}

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(server => server.close()))
})

describe('SmtpMailer functional SMTP server integration', () => {
  it('sends through a real SMTP server with SIZE, 8BITMIME, SMTPUTF8, DSN, and PIPELINING', async () => {
    const server = await startServer({
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      hidePIPELINING: false,
      hide8BITMIME: false,
      hideSMTPUTF8: false,
    })

    await FunctionalMailer.send(baseConfig(server.port), {
      from: { name: 'Functional Sender', email: 'sender@example.com' },
      to: { name: 'Visible Recipient', email: 'visible@example.com' },
      cc: 'copy@example.com',
      bcc: 'hidden@example.com',
      envelope: {
        from: 'bounce@example.com',
        to: ['first@example.com', 'second@example.com'],
        body: '8BITMIME',
        smtpUtf8: true,
      },
      dsnOverride: {
        envelopeId: 'order 123+abc',
        RET: { HEADERS: true },
        NOTIFY: { SUCCESS: true, FAILURE: true },
        ORCPT: 'original@example.com',
      },
      subject: 'SMTP core send',
      text: 'Hello from a real SMTP parser.',
      html: '<p>Hello from a real SMTP parser.</p>',
    })

    expect(server.state.auths).toEqual([
      { method: 'PLAIN', username: USERNAME },
    ])
    expect(server.state.mailFrom).toHaveLength(1)
    expect(server.state.mailFrom[0].address).toBe('bounce@example.com')
    expect(server.state.mailFrom[0].args.BODY).toBe('8BITMIME')
    expect(server.state.mailFrom[0].args.SMTPUTF8).toBe(true)
    expect(server.state.mailFrom[0].args.RET).toBe('HDRS')
    expect(server.state.mailFrom[0].args.ENVID).toBe('order 123+abc')

    expect(server.state.rcptTo.map(recipient => recipient.address)).toEqual([
      'first@example.com',
      'second@example.com',
    ])
    expect(server.state.rcptTo[0].args.NOTIFY).toBe('SUCCESS,FAILURE')
    expect(server.state.rcptTo[0].args.ORCPT).toBe(
      'rfc822;original@example.com',
    )

    expect(server.state.messages).toHaveLength(1)
    expect(Number(server.state.mailFrom[0].args.SIZE)).toBe(
      Buffer.byteLength(server.state.messages[0].raw),
    )
    expect(server.state.messages[0].raw).toContain('To: "Visible Recipient"')
    expect(server.state.messages[0].raw).toContain('CC: copy@example.com')
    expect(server.state.messages[0].raw).not.toContain('hidden@example.com')
  })

  it('authenticates against a real CRAM-MD5 challenge', async () => {
    const server = await startServer({
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      authMethods: ['CRAM-MD5'],
    })

    await FunctionalMailer.send(
      {
        ...baseConfig(server.port),
        authType: 'cram-md5',
      },
      {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'CRAM-MD5',
        text: 'CRAM-MD5 functional test.',
      },
    )

    expect(server.state.auths).toEqual([
      { method: 'CRAM-MD5', username: USERNAME },
    ])
    expect(server.state.messages).toHaveLength(1)
  })

  it('upgrades with STARTTLS before AUTH when the server requires TLS', async () => {
    const server = await startServer({
      authMethods: ['LOGIN'],
      allowInsecureAuth: false,
    })

    await FunctionalMailer.send(
      {
        ...baseConfig(server.port),
        startTls: true,
        authType: 'login',
      },
      {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'STARTTLS',
        text: 'STARTTLS functional test.',
      },
    )

    expect(server.state.secureCount).toBe(1)
    expect(server.state.auths).toEqual([
      { method: 'LOGIN', username: USERNAME },
    ])
    expect(server.state.messages[0].secure).toBe(true)
  })

  it('sends REQUIRETLS over implicit TLS when advertised', async () => {
    const server = await startServer({
      secure: true,
      authMethods: ['PLAIN'],
      hideREQUIRETLS: false,
    } as SMTPServerOptions)

    await FunctionalMailer.send(
      {
        ...baseConfig(server.port),
        secure: true,
        startTls: false,
        authType: 'plain',
      },
      {
        from: 'sender@example.com',
        to: 'recipient@example.com',
        envelope: {
          requireTls: true,
        },
        subject: 'REQUIRETLS',
        text: 'REQUIRETLS functional test.',
      },
    )

    expect(server.state.messages[0].secure).toBe(true)
    expect(server.state.mailFrom[0].args.REQUIRETLS).toBe(true)
  })

  it('fails before MAIL FROM when SMTPUTF8 is required but not advertised', async () => {
    const server = await startServer({
      disabledCommands: ['STARTTLS', 'AUTH'],
      hideSMTPUTF8: true,
    })

    await expect(
      FunctionalMailer.send(
        {
          ...baseConfig(server.port),
          credentials: undefined,
        },
        {
          from: 'sender@example.com',
          to: 'recipient@example.com',
          envelope: {
            smtpUtf8: true,
          },
          subject: 'SMTPUTF8 missing',
          text: 'This send should fail before MAIL FROM.',
        },
      ),
    ).rejects.toMatchObject({
      name: 'SMTPError',
      stage: 'mail',
      command: 'MAIL FROM',
    } satisfies Partial<SMTPError>)

    expect(server.state.mailFrom).toHaveLength(0)
  })

  it('continues a batch after recipient rejection using RSET on a real server', async () => {
    const server = await startServer(
      {
        disabledCommands: ['STARTTLS'],
        allowInsecureAuth: true,
      },
      {
        rejectRecipient: 'bad@example.com',
      },
    )

    const results = await FunctionalMailer.sendBatch(
      baseConfig(server.port),
      [
        {
          from: 'sender@example.com',
          to: 'bad@example.com',
          subject: 'bad',
          text: 'This recipient is rejected.',
        },
        {
          from: 'sender@example.com',
          to: 'good@example.com',
          subject: 'good',
          text: 'This recipient is accepted.',
        },
      ],
      { continueOnError: true },
    )

    expect(results.map(result => result.status)).toEqual([
      'rejected',
      'fulfilled',
    ])
    const rejected = results[0] as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(SMTPError)
    expect(rejected.reason).toMatchObject({
      responseCode: 550,
      enhancedStatusCode: '5.1.1',
      transient: false,
    })
    expect(server.state.mailFrom).toHaveLength(2)
    expect(server.state.messages).toHaveLength(1)
    expect(server.state.rcptTo.map(recipient => recipient.address)).toEqual([
      'bad@example.com',
      'good@example.com',
    ])
  })

  it('emits observation events for a successful real SMTP transaction', async () => {
    const events: MailObservationEvent[] = []
    const server = await startServer({
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
    })

    const mailer = await FunctionalMailer.connect({
      ...baseConfig(server.port),
      observation: {
        mode: 'transcript',
        onEvent: event => events.push(event),
      },
    })
    try {
      const receipt = await mailer.send({
        from: 'sender@example.com',
        to: 'accepted@example.com',
        subject: 'Observed real SMTP',
        text: 'This send should be accepted by the local SMTP server.',
      })

      expect(receipt.attemptId).toMatch(/^mail_attempt_/)
      expect(receipt.durationMs).toBeGreaterThanOrEqual(0)
      expect(receipt.toJSON()).toMatchObject({
        attemptId: receipt.attemptId,
        responseCode: 250,
      })
    } finally {
      await mailer.close()
    }

    expect(events.map(event => event.type)).toEqual([
      'smtp.connect.completed',
      'smtp.greet.completed',
      'smtp.ehlo.completed',
      'smtp.auth.completed',
      'mail.send.started',
      'mail.compose.completed',
      'smtp.envelope.completed',
      'smtp.data.completed',
      'mail.send.completed',
    ])
    expect(
      events.find(event => event.type === 'smtp.data.completed'),
    ).toMatchObject({
      responseCode: 250,
      status: 'completed',
    })
  })

  it('classifies transient and permanent recipient failures from a real SMTP server', async () => {
    for (const [code, retryHint] of [
      [450, 'retry'],
      [550, 'do_not_retry'],
    ] as const) {
      const events: MailObservationEvent[] = []
      const server = await startServer(
        {
          disabledCommands: ['STARTTLS'],
          allowInsecureAuth: true,
        },
        {
          rejectRecipient: `bad-${code}@example.com`,
          rejectRecipientCode: code,
        },
      )

      const mailer = await FunctionalMailer.connect({
        ...baseConfig(server.port),
        observation: {
          mode: 'transcript',
          onEvent: event => events.push(event),
        },
      })
      try {
        await expect(
          mailer.send({
            from: 'sender@example.com',
            to: `bad-${code}@example.com`,
            subject: `Rejected ${code}`,
            text: 'This recipient should be rejected.',
          }),
        ).rejects.toMatchObject({
          responseCode: code,
          reason: 'recipient_rejected',
          retryHint,
        })
      } finally {
        await mailer.close()
      }

      expect(events.map(event => event.type)).toContain('smtp.rset.completed')
      expect(
        events.find(event => event.type === 'mail.send.failed'),
      ).toMatchObject({
        status: 'failed',
        reason: 'recipient_rejected',
        responseCode: code,
        retryHint,
      })
    }
  })
})
