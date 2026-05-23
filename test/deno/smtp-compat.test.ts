// @deno-types="npm:@types/smtp-server@3.5.13"
import { SMTPServer, type SMTPServerOptions } from 'npm:smtp-server@3.18.4'
import {
  DenoMailer,
  LogLevel,
  SMTPError,
  type EdgeMailerOptions,
  type EmailOptions,
} from '../../src/deno.ts'

const USERNAME = 'sender@example.com'
const PASSWORD = 'smtp-password'

type ServerState = {
  auths: { method: string; username?: string }[]
  mailFrom: { address: string; args: Record<string, unknown> }[]
  rcptTo: { address: string; args: Record<string, unknown> }[]
  messages: { raw: string; transmissionType: string }[]
  connections: number
  resetCount: number
}

type TestServer = {
  port: number
  state: ServerState
  close(): Promise<void>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function assertEquals<T>(actual: T, expected: T, message?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

function pem(label: string, data: ArrayBuffer) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(data)))
  const lines = base64.match(/.{1,64}/g)?.join('\n') || base64
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`
}

async function generateDkimPrivateKey() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 1024,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  return pem(
    'PRIVATE KEY',
    await crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  )
}

async function startServer(
  options: SMTPServerOptions = {},
  behavior: {
    rejectRecipient?: string
  } = {},
): Promise<TestServer> {
  const state: ServerState = {
    auths: [],
    mailFrom: [],
    rcptTo: [],
    messages: [],
    connections: 0,
    resetCount: 0,
  }

  const server = new SMTPServer({
    name: 'smtp.test.local',
    banner: 'edge-mailer deno compatibility server',
    size: 1024 * 1024,
    hideDSN: false,
    hideENHANCEDSTATUSCODES: false,
    authMethods: ['PLAIN', 'LOGIN', 'CRAM-MD5'],
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    onConnect(_session, callback) {
      state.connections++
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
        error.responseCode = 550
        callback(error)
        return
      }
      callback()
    },
    onData(stream, session, callback) {
      const chunks: Uint8Array[] = []
      stream.on('data', chunk => chunks.push(new Uint8Array(chunk)))
      stream.on('error', error => callback(error))
      stream.on('end', () => {
        const length = chunks.reduce((total, chunk) => total + chunk.length, 0)
        const body = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          body.set(chunk, offset)
          offset += chunk.length
        }
        state.messages.push({
          raw: new TextDecoder().decode(body),
          transmissionType: session.transmissionType,
        })
        callback(null, 'queued')
      })
    },
    onClose(_session) {
      state.resetCount++
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

  const address = server.server.address()
  assert(
    typeof address === 'object' && address !== null,
    'SMTP server must listen on a TCP address',
  )
  return {
    port: address.port,
    state,
    close: () =>
      new Promise<void>(resolve => {
        server.close(resolve)
      }),
  }
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
    logLevel: LogLevel.NONE,
    socketTimeoutMs: 2_000,
    responseTimeoutMs: 2_000,
  }
}

function standardMessage(overrides: Partial<EmailOptions> = {}): EmailOptions {
  return {
    from: { name: 'Deno Sender', email: 'sender@example.com' },
    to: [
      { email: 'primary@example.com' },
      { name: 'Named Recipient', email: 'named@example.com' },
    ],
    cc: 'copy@example.com',
    bcc: 'hidden@example.com',
    reply: { name: 'Reply Desk', email: 'reply@example.com' },
    subject: 'Deno SMTP compatibility',
    text: 'Plain text body from the Deno runtime.',
    html: '<p>HTML body from the <strong>Deno</strong> runtime.</p>',
    headers: {
      'X-Edge-Mailer-Compat': 'deno',
    },
    attachments: [
      {
        filename: 'notes.txt',
        content: btoa('Deno attachment body'),
        mimeType: 'text/plain',
      },
    ],
    ...overrides,
  }
}

Deno.test(
  'DenoMailer sends standard text, html, headers, recipients, and attachments through a real SMTP server',
  async () => {
    const server = await startServer()
    try {
      const receipt = await DenoMailer.send(
        baseConfig(server.port),
        standardMessage(),
      )

      assertEquals(server.state.auths, [
        { method: 'PLAIN', username: USERNAME },
      ])
      assertEquals(receipt.accepted, [
        'primary@example.com',
        'named@example.com',
        'copy@example.com',
        'hidden@example.com',
      ])
      assertEquals(receipt.rejected, [])
      assertEquals(receipt.responseCode, 250)
      assert(
        receipt.messageId.startsWith('<') && receipt.messageId.endsWith('>'),
        'receipt includes message id',
      )
      assertEquals(
        server.state.rcptTo.map(recipient => recipient.address),
        [
          'primary@example.com',
          'named@example.com',
          'copy@example.com',
          'hidden@example.com',
        ],
      )

      const message = server.state.messages[0]?.raw
      assert(message, 'SMTP server should receive one message body')
      assert(message.includes('From: "Deno Sender"'), 'from header is present')
      assert(
        message.includes('To: primary@example.com'),
        'to header is present',
      )
      assert(message.includes('CC: copy@example.com'), 'cc header is present')
      assert(
        message.includes('Reply-To: "Reply Desk"'),
        'reply-to header is present',
      )
      assert(
        message.includes('X-Edge-Mailer-Compat: deno'),
        'custom header is present',
      )
      assert(!message.includes('hidden@example.com'), 'bcc header is hidden')
      assert(
        message.includes('Content-Type: text/plain; charset="UTF-8"'),
        'plain text MIME part is present',
      )
      assert(
        message.includes('Content-Type: text/html; charset="UTF-8"'),
        'HTML MIME part is present',
      )
      assert(
        message.includes(
          'Content-Disposition: attachment; filename="notes.txt"',
        ),
        'attachment MIME part is present',
      )
      assertEquals(server.state.mailFrom[0]?.address, 'sender@example.com')
      assert(
        server.state.mailFrom[0]?.args.SIZE !== undefined,
        'SIZE extension is applied when advertised',
      )
    } finally {
      await server.close()
    }
  },
)

Deno.test(
  'DenoMailer DKIM signs messages and returns structured receipts through a real SMTP server',
  async () => {
    const server = await startServer()
    try {
      const receipt = await DenoMailer.send(
        {
          ...baseConfig(server.port),
          dkim: {
            domainName: 'example.com',
            keySelector: 'test',
            privateKey: await generateDkimPrivateKey(),
          },
        },
        standardMessage({
          to: 'signed@example.com',
          cc: undefined,
          bcc: undefined,
          attachments: undefined,
          subject: 'Deno DKIM compatibility',
          text: 'DKIM signed message from Deno.',
          html: undefined,
        }),
      )

      const message = server.state.messages[0]?.raw
      assert(message, 'SMTP server should receive one signed message')
      assert(
        message.startsWith('DKIM-Signature: '),
        'DKIM signature header is prepended',
      )
      assert(message.includes('d=example.com'), 'DKIM domain is present')
      assert(message.includes('s=test'), 'DKIM selector is present')
      assert(message.includes('bh='), 'DKIM body hash is present')
      assert(message.includes('b='), 'DKIM signature is present')
      assertEquals(receipt.accepted, ['signed@example.com'])
      assertEquals(receipt.envelope, {
        from: 'sender@example.com',
        to: ['signed@example.com'],
      })
      assertEquals(receipt.responseCode, 250)
    } finally {
      await server.close()
    }
  },
)

Deno.test(
  'DenoMailer sends inline attachments and richer transfer encodings through a real SMTP server',
  async () => {
    const server = await startServer()
    try {
      await DenoMailer.send(
        baseConfig(server.port),
        standardMessage({
          to: 'mime@example.com',
          cc: undefined,
          bcc: undefined,
          subject: 'Deno rich MIME compatibility',
          text: 'Plain fallback with inline logo.',
          html: '<p>Inline <img src="cid:logo"></p>',
          attachments: [
            {
              filename: 'logo.txt',
              content: btoa('inline logo'),
              mimeType: 'text/plain',
              contentId: 'logo',
              disposition: 'inline',
            },
            {
              filename: 'plain.txt',
              content: 'plain ascii attachment',
              mimeType: 'text/plain',
              encoding: '7bit',
            },
            {
              filename: 'utf8.txt',
              content: 'ümlaut attachment',
              mimeType: 'text/plain',
              encoding: 'quoted-printable',
            },
          ],
        }),
      )

      const message = server.state.messages[0]?.raw
      assert(message, 'SMTP server should receive one rich MIME message')
      assert(
        message.includes('Content-Type: multipart/related;'),
        'related MIME wrapper is present',
      )
      assert(message.includes('Content-ID: <logo>'), 'Content-ID is present')
      assert(
        message.includes('Content-Disposition: inline; filename="logo.txt";'),
        'inline disposition is present',
      )
      assert(
        message.includes('Content-Transfer-Encoding: 7bit'),
        '7bit attachment is present',
      )
      assert(
        message.includes('plain ascii attachment'),
        '7bit attachment body is present',
      )
      assert(
        message.includes('Content-Transfer-Encoding: quoted-printable'),
        'quoted-printable attachment is present',
      )
      assert(
        message.includes('=C3=BCmlaut attachment'),
        'quoted-printable attachment body is encoded',
      )
    } finally {
      await server.close()
    }
  },
)

Deno.test(
  'DenoMailer connection pool rotates clients after maxMessagesPerConnection',
  async () => {
    const server = await startServer()
    const pool = DenoMailer.createPool({
      ...baseConfig(server.port),
      pool: {
        maxConnections: 1,
        maxMessagesPerConnection: 1,
        idleTimeoutMs: 0,
      },
    })
    try {
      await pool.send(
        standardMessage({
          to: 'pooled-one@example.com',
          cc: undefined,
          bcc: undefined,
          attachments: undefined,
          subject: 'Pooled one',
          text: 'First pooled message.',
          html: undefined,
        }),
      )
      await pool.send(
        standardMessage({
          to: 'pooled-two@example.com',
          cc: undefined,
          bcc: undefined,
          attachments: undefined,
          subject: 'Pooled two',
          text: 'Second pooled message.',
          html: undefined,
        }),
      )

      assertEquals(server.state.messages.length, 2)
      assertEquals(server.state.connections, 2)
    } finally {
      await pool.close()
      await server.close()
    }
  },
)

Deno.test(
  'DenoMailer can authenticate with LOGIN against a real SMTP server',
  async () => {
    const server = await startServer({
      authMethods: ['LOGIN'],
    })
    try {
      await DenoMailer.send(
        {
          ...baseConfig(server.port),
          authType: 'login',
        },
        standardMessage({
          to: 'login@example.com',
          cc: undefined,
          bcc: undefined,
          attachments: undefined,
          subject: 'Deno LOGIN compatibility',
          text: 'LOGIN authentication from Deno.',
          html: undefined,
        }),
      )

      assertEquals(server.state.auths, [
        { method: 'LOGIN', username: USERNAME },
      ])
      assertEquals(server.state.messages.length, 1)
    } finally {
      await server.close()
    }
  },
)

Deno.test(
  'DenoMailer sendBatch recovers after a rejected recipient with RSET',
  async () => {
    const server = await startServer({}, { rejectRecipient: 'bad@example.com' })
    try {
      const results = await DenoMailer.sendBatch(
        baseConfig(server.port),
        [
          standardMessage({
            to: 'bad@example.com',
            cc: undefined,
            bcc: undefined,
            attachments: undefined,
            subject: 'Deno rejected recipient',
            text: 'This recipient should be rejected.',
            html: undefined,
          }),
          standardMessage({
            to: 'good@example.com',
            cc: undefined,
            bcc: undefined,
            attachments: undefined,
            subject: 'Deno accepted recipient',
            text: 'This recipient should be accepted after RSET.',
            html: undefined,
          }),
        ],
        { continueOnError: true },
      )

      assertEquals(
        results.map(result => result.status),
        ['rejected', 'fulfilled'],
      )
      const rejected = results[0] as PromiseRejectedResult
      assert(
        rejected.reason instanceof SMTPError,
        'recipient rejection should surface as SMTPError',
      )
      assertEquals(rejected.reason.responseCode, 550)
      assertEquals(rejected.reason.enhancedStatusCode, '5.1.1')
      assertEquals(server.state.messages.length, 1)
      assertEquals(
        server.state.messages[0]?.raw.includes('good@example.com'),
        true,
      )
    } finally {
      await server.close()
    }
  },
)
