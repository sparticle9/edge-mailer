import {
  DenoMailer,
  LogLevel,
  type AuthType,
  type EdgeMailerOptions,
  type EmailOptions,
} from 'edge-mailer/deno'

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
    logLevel: LogLevel.NONE,
    responseTimeoutMs: Number(env('SMTP_RESPONSE_TIMEOUT_MS') || 30_000),
    socketTimeoutMs: Number(env('SMTP_SOCKET_TIMEOUT_MS') || 30_000),
  }
}

function sampleEmail(body: Partial<EmailOptions> = {}): EmailOptions {
  const username = env('SMTP_USERNAME') || env('SMTP_USER')
  const from = body.from || env('SMTP_FROM') || username
  const to = body.to || env('SMTP_TO')
  if (!from || !to) {
    throw new Error('Missing SMTP_FROM or SMTP_TO')
  }
  return {
    from,
    to,
    reply: body.reply || env('SMTP_REPLY_TO') || from,
    subject:
      body.subject || `[edge-mailer sample] Deno ${new Date().toISOString()}`,
    text: body.text || 'Hello from the edge-mailer Deno sample.',
    html: body.html,
    headers: {
      'X-Edge-Mailer-Sample': 'deno',
      ...body.headers,
    },
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
  await DenoMailer.send(smtpConfig(), sampleEmail(body))
  return Response.json({ ok: true })
})
