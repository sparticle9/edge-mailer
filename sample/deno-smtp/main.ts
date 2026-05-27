import {
  DenoMailer,
  LogLevel,
  type AuthType,
  type DkimConfig,
  type EdgeMailerOptions,
  type EmailOptions,
  type MailObservationEvent,
} from '../../src/deno.ts'

function env(name: string): string | undefined {
  return Deno.env.get(name)
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
  const accessToken = env('SMTP_XOAUTH2_ACCESS_TOKEN')
  const host = env('SMTP_HOST')
  const port = Number(env('SMTP_PORT') || 587)
  if (!host || !username) {
    throw new Error('Missing SMTP_HOST or SMTP_USERNAME')
  }
  const requestedAuthTypes = authTypeValues(env('SMTP_AUTH_TYPE'))
  const useXOAuth2 =
    requestedAuthTypes.includes('xoauth2') ||
    (!password && Boolean(accessToken))
  if (useXOAuth2 && !accessToken) {
    throw new Error('Missing SMTP_XOAUTH2_ACCESS_TOKEN')
  }
  if (!useXOAuth2 && !password) {
    throw new Error('Missing SMTP_PASSWORD')
  }
  return {
    host,
    port,
    secure: port === 465,
    startTls: port !== 465,
    credentials: useXOAuth2
      ? { username, accessToken: accessToken! }
      : { username, password: password! },
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
    envelope: body.envelope,
    dsnOverride: body.dsnOverride,
    attachments: body.attachments || [
      {
        filename: 'edge-mailer-sample.txt',
        content: new Blob(['Deno sample attachment\n'], { type: 'text/plain' }),
      },
    ],
  }
}

function authorized(request: Request) {
  const token = env('SAMPLE_SEND_TOKEN')
  if (!token) {
    return true
  }
  const authorization = request.headers.get('authorization')
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  const headerToken = request.headers.get('x-sample-send-token')
  return bearer === token || headerToken === token
}

Deno.serve(async request => {
  if (request.method === 'GET') {
    return Response.json({
      ok: true,
      runtime: 'deno',
      deploy: 'v2',
      configured: Boolean(
        env('SMTP_HOST') &&
        (env('SMTP_USERNAME') || env('SMTP_USER')) &&
        (env('SMTP_PASSWORD') || env('SMTP_XOAUTH2_ACCESS_TOKEN')),
      ),
      protected: Boolean(env('SAMPLE_SEND_TOKEN')),
    })
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  if (!authorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request
    .json()
    .catch(() => ({}))) as Partial<EmailOptions> & {
    captureObservation?: boolean
  }
  const email = sampleEmail(body)
  const observationEvents: MailObservationEvent[] = []
  const config = smtpConfig()
  if (body.captureObservation) {
    config.observation = {
      mode: 'summary',
      onEvent(event) {
        observationEvents.push(event)
      },
    }
  }
  const pool = DenoMailer.createPool(config)
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
})
