import {
  EdgeMailer,
  LogLevel,
  type AuthType,
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
  SMTP_REPLY_TO?: string
  SMTP_AUTH_TYPE?: string
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
    logLevel: LogLevel.NONE,
  }
}

function sampleEmail(env: Env, body: Partial<EmailOptions> = {}): EmailOptions {
  const username = env.SMTP_USERNAME || env.SMTP_USER
  const from = body.from || env.SMTP_FROM || username
  const to = body.to || env.SMTP_TO
  if (!from || !to) {
    throw new Error('Missing SMTP_FROM or SMTP_TO')
  }
  return {
    from,
    to,
    reply: body.reply || env.SMTP_REPLY_TO || from,
    subject:
      body.subject ||
      `[edge-mailer sample] Cloudflare ${new Date().toISOString()}`,
    text: body.text || 'Hello from the edge-mailer Cloudflare Worker sample.',
    html: body.html,
    headers: {
      'X-Edge-Mailer-Sample': 'cloudflare-worker',
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
    await EdgeMailer.send(smtpConfig(env), sampleEmail(env, body))
    return Response.json({ ok: true })
  },
} satisfies ExportedHandler<Env>
