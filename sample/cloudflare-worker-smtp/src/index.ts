import {
  EdgeMailer,
  LogLevel,
  type AuthType,
  type DkimConfig,
  type EdgeMailerOptions,
  type EmailOptions,
  type MailObservationEvent,
} from '../../../src/cloudflare'

type Env = {
  SMTP_HOST?: string
  SMTP_PORT?: string
  SMTP_USERNAME?: string
  SMTP_USER?: string
  SMTP_PASSWORD?: string
  SMTP_XOAUTH2_ACCESS_TOKEN?: string
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
  SAMPLE_SEND_TOKEN?: string
}

function authTypes(value: string | undefined): EdgeMailerOptions['authType'] {
  if (!value) {
    return undefined
  }
  const values = value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean) as AuthType[]
  return values.length === 1 ? values[0] : values
}

function authTypeValues(value: string | undefined): AuthType[] {
  const values = authTypes(value)
  if (!values) {
    return []
  }
  return Array.isArray(values) ? values : [values]
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
  if (!env.SMTP_HOST || !username) {
    throw new Error('Missing SMTP_HOST or SMTP_USERNAME')
  }
  const requestedAuthTypes = authTypeValues(env.SMTP_AUTH_TYPE)
  const useXOAuth2 =
    requestedAuthTypes.includes('xoauth2') ||
    (!env.SMTP_PASSWORD && Boolean(env.SMTP_XOAUTH2_ACCESS_TOKEN))
  if (useXOAuth2 && !env.SMTP_XOAUTH2_ACCESS_TOKEN) {
    throw new Error('Missing SMTP_XOAUTH2_ACCESS_TOKEN')
  }
  if (!useXOAuth2 && !env.SMTP_PASSWORD) {
    throw new Error('Missing SMTP_PASSWORD')
  }
  return {
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    startTls: port !== 465,
    credentials: useXOAuth2
      ? {
          username,
          accessToken: env.SMTP_XOAUTH2_ACCESS_TOKEN!,
        }
      : {
          username,
          password: env.SMTP_PASSWORD!,
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
    html:
      body.html ||
      `<p>Hello from the edge-mailer Cloudflare Worker sample.</p><p>Marker: ${marker}</p>`,
    headers: {
      'X-Edge-Mailer-Sample': marker,
      ...body.headers,
    },
    envelope: body.envelope,
    dsnOverride: body.dsnOverride,
    attachments: body.attachments || [
      {
        filename: 'edge-mailer-sample.txt',
        content: new TextEncoder().encode(
          `Cloudflare sample attachment\nMarker: ${marker}\n`,
        ),
        mimeType: 'text/plain',
      },
    ],
  }
}

function authorized(request: Request, env: Env) {
  if (!env.SAMPLE_SEND_TOKEN) {
    return true
  }
  const authorization = request.headers.get('authorization')
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  const headerToken = request.headers.get('x-sample-send-token')
  return (
    bearer === env.SAMPLE_SEND_TOKEN || headerToken === env.SAMPLE_SEND_TOKEN
  )
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
          (env.SMTP_PASSWORD || env.SMTP_XOAUTH2_ACCESS_TOKEN),
        ),
        protected: Boolean(env.SAMPLE_SEND_TOKEN),
      })
    }

    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 })
    }

    if (!authorized(request, env)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request
      .json()
      .catch(() => ({}))) as Partial<EmailOptions> & {
      captureObservation?: boolean
    }
    const email = sampleEmail(env, body)
    const observationEvents: MailObservationEvent[] = []
    const config = smtpConfig(env)
    if (body.captureObservation) {
      config.observation = {
        mode: 'summary',
        onEvent(event) {
          observationEvents.push(event)
        },
      }
    }
    const pool = EdgeMailer.createPool(config)
    try {
      const receipt = await pool.send(email)
      return Response.json({
        ok: true,
        accepted: true,
        subject: email.subject,
        messageId: receipt.messageId,
        attemptId: receipt.attemptId,
        durationMs: receipt.durationMs,
        recipients: receipt.accepted,
        rejected: receipt.rejected,
        responseCode: receipt.responseCode,
        observation: body.captureObservation
          ? { events: observationEvents }
          : undefined,
      })
    } finally {
      await pool.close()
    }
  },
} satisfies ExportedHandler<Env>
