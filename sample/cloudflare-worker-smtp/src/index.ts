import {
  EdgeMailer,
  LogLevel,
  type AuthType,
  type DkimConfig,
  type EdgeMailerOptions,
  type EmailOptions,
} from '../../../src/cloudflare'

type Env = {
  SMTP_HOST?: string
  SMTP_PORT?: string
  SMTP_USERNAME?: string
  SMTP_USER?: string
  SMTP_PASSWORD?: string
  SMTP_FROM?: string
  SMTP_TO?: string
  TEST_RECIPIENT_EMAIL?: string
  SMTP_REPLY_TO?: string
  SMTP_AUTH_TYPE?: string
  DKIM_DOMAIN?: string
  DKIM_SELECTOR?: string
  DKIM_PRIVATE_KEY?: string
  SMTP_POOL_MAX_CONNECTIONS?: string
  SMTP_POOL_MAX_MESSAGES_PER_CONNECTION?: string
  SMTP_POOL_IDLE_TIMEOUT_MS?: string
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

function defaultRecipient(env: Env): string | undefined {
  return env.SMTP_TO || env.TEST_RECIPIENT_EMAIL
}

function dkimConfig(env: Env): DkimConfig | undefined {
  const domainName = env.DKIM_DOMAIN
  const keySelector = env.DKIM_SELECTOR
  const privateKey = env.DKIM_PRIVATE_KEY?.replace(/\\n/g, '\n')
  if (!domainName && !keySelector && !privateKey) {
    return undefined
  }
  if (!domainName || !keySelector || !privateKey) {
    throw new Error('Missing DKIM_DOMAIN, DKIM_SELECTOR, or DKIM_PRIVATE_KEY')
  }
  return { domainName, keySelector, privateKey }
}

function smtpConfig(env: Env): EdgeMailerOptions {
  const username = env.SMTP_USERNAME || env.SMTP_USER
  const port = Number(env.SMTP_PORT || 587)
  if (!env.SMTP_HOST || !username || !env.SMTP_PASSWORD) {
    throw new Error('Missing SMTP_HOST, SMTP_USERNAME, or SMTP_PASSWORD')
  }
  return {
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    startTls: port !== 465,
    credentials: {
      username,
      password: env.SMTP_PASSWORD,
    },
    authType: authTypes(env.SMTP_AUTH_TYPE),
    dkim: dkimConfig(env),
    pool: {
      maxConnections: Number(env.SMTP_POOL_MAX_CONNECTIONS || 1),
      maxMessagesPerConnection: Number(
        env.SMTP_POOL_MAX_MESSAGES_PER_CONNECTION || 20,
      ),
      idleTimeoutMs: Number(env.SMTP_POOL_IDLE_TIMEOUT_MS || 1_000),
    },
    logLevel: LogLevel.NONE,
  }
}

function sampleEmail(env: Env, body: Partial<EmailOptions> = {}): EmailOptions {
  const username = env.SMTP_USERNAME || env.SMTP_USER
  const from = body.from || env.SMTP_FROM || username
  const to = body.to || defaultRecipient(env)
  if (!from || !to) {
    throw new Error('Missing SMTP_FROM or SMTP_TO/TEST_RECIPIENT_EMAIL')
  }
  const marker = `cloudflare-${new Date().toISOString()}`
  return {
    from,
    to,
    reply: body.reply || env.SMTP_REPLY_TO || from,
    subject: body.subject || `[edge-mailer sample] ${marker}`,
    text:
      body.text ||
      `Hello from the edge-mailer Cloudflare Worker sample.\n\nMarker: ${marker}`,
    html: body.html,
    headers: {
      'X-Edge-Mailer-Sample': marker,
      ...body.headers,
    },
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'GET') {
      return Response.json({
        ok: true,
        runtime: 'cloudflare-workers',
        directSmtp: true,
        pool: true,
        configured: Boolean(
          env.SMTP_HOST &&
          (env.SMTP_USERNAME || env.SMTP_USER) &&
          env.SMTP_PASSWORD,
        ),
      })
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 })
    }

    const body = (await request
      .json()
      .catch(() => ({}))) as Partial<EmailOptions>
    const email = sampleEmail(env, body)
    const pool = EdgeMailer.createPool(smtpConfig(env))
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
  },
} satisfies ExportedHandler<Env>
