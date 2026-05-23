import {
  DenoMailer,
  LogLevel,
  type AuthType,
  type DkimConfig,
  type EdgeMailerOptions,
  type EmailOptions,
} from '../../src/deno.ts'

function env(name: string): string | undefined {
  return Deno.env.get(name)
}

function authTypes(value: string | undefined): EdgeMailerOptions['authType'] {
  if (!value) {
    return ['plain', 'login', 'cram-md5']
  }
  const values = value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean) as AuthType[]
  return values.length === 1 ? values[0] : values
}

function defaultRecipient(): string | undefined {
  return env('SMTP_TO') || env('TEST_RECIPIENT_EMAIL')
}

function dkimConfig(): DkimConfig | undefined {
  const domainName = env('DKIM_DOMAIN')
  const keySelector = env('DKIM_SELECTOR')
  const privateKey = env('DKIM_PRIVATE_KEY')?.replace(/\\n/g, '\n')
  if (!domainName && !keySelector && !privateKey) {
    return undefined
  }
  if (!domainName || !keySelector || !privateKey) {
    throw new Error('Missing DKIM_DOMAIN, DKIM_SELECTOR, or DKIM_PRIVATE_KEY')
  }
  return { domainName, keySelector, privateKey }
}

function smtpConfig(): EdgeMailerOptions {
  const username = env('SMTP_USERNAME') || env('SMTP_USER')
  const password = env('SMTP_PASSWORD')
  const host = env('SMTP_HOST')
  const port = Number(env('SMTP_PORT') || 587)
  if (!host || !username || !password) {
    throw new Error('Missing SMTP_HOST, SMTP_USERNAME, or SMTP_PASSWORD')
  }
  return {
    host,
    port,
    secure: port === 465,
    startTls: port !== 465,
    credentials: { username, password },
    authType: authTypes(env('SMTP_AUTH_TYPE')),
    dkim: dkimConfig(),
    pool: {
      maxConnections: Number(env('SMTP_POOL_MAX_CONNECTIONS') || 1),
      maxMessagesPerConnection: Number(
        env('SMTP_POOL_MAX_MESSAGES_PER_CONNECTION') || 20,
      ),
      idleTimeoutMs: Number(env('SMTP_POOL_IDLE_TIMEOUT_MS') || 1_000),
    },
    logLevel: LogLevel.NONE,
    responseTimeoutMs: Number(env('SMTP_RESPONSE_TIMEOUT_MS') || 30_000),
    socketTimeoutMs: Number(env('SMTP_SOCKET_TIMEOUT_MS') || 30_000),
  }
}

function sampleEmail(body: Partial<EmailOptions> = {}): EmailOptions {
  const username = env('SMTP_USERNAME') || env('SMTP_USER')
  const from = body.from || env('SMTP_FROM') || username
  const to = body.to || defaultRecipient()
  if (!from || !to) {
    throw new Error('Missing SMTP_FROM or SMTP_TO/TEST_RECIPIENT_EMAIL')
  }
  return {
    from,
    to,
    reply: body.reply || env('SMTP_REPLY_TO') || from,
    subject:
      body.subject || `[edge-mailer sample] Deno ${new Date().toISOString()}`,
    text: body.text || 'Hello from the edge-mailer Deno sample.',
    html: body.html || '<p>Hello from the edge-mailer Deno sample.</p>',
    headers: {
      'X-Edge-Mailer-Sample': 'deno',
      ...body.headers,
    },
    attachments: body.attachments || [
      {
        filename: 'edge-mailer-sample.txt',
        content: 'Deno sample attachment\n',
        mimeType: 'text/plain',
        encoding: '7bit',
      },
    ],
  }
}

Deno.serve(async request => {
  if (request.method === 'GET') {
    return Response.json({
      ok: true,
      runtime: 'deno',
      deploy: 'v2-experimental',
      configured: Boolean(
        env('SMTP_HOST') &&
        (env('SMTP_USERNAME') || env('SMTP_USER')) &&
        env('SMTP_PASSWORD'),
      ),
    })
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const body = (await request.json().catch(() => ({}))) as Partial<EmailOptions>
  const email = sampleEmail(body)
  const pool = DenoMailer.createPool(smtpConfig())
  try {
    const receipt = await pool.send(email)
    return Response.json({
      ok: true,
      accepted: true,
      subject: email.subject,
      messageId: receipt.messageId,
      recipients: receipt.accepted,
    })
  } finally {
    await pool.close()
  }
})
