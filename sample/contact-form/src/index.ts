import {
  body,
  failure,
  field,
  HttpError,
  json,
  mailbox,
  type SendMail,
  validMessage,
} from '../../starters/shared'
import { smtpSender } from '../../starters/smtp'
import { css, form, script } from './form'

export type Env = ContactEnv
export type VerifyChallenge = (
  token: string,
  ip: string,
  env: Env,
) => Promise<boolean>
export const verifyChallenge: VerifyChallenge = async (token, ip, env) => {
  const response = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) return false
  const result = await response.json<{
    success?: boolean
    hostname?: string
    action?: string
  }>()
  return (
    result.success === true &&
    result.hostname === new URL(env.PUBLIC_ORIGIN).hostname &&
    result.action === 'contact'
  )
}
async function withinLimit(
  db: D1Database,
  key: string,
  expires: number,
  limit: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count`,
    )
    .bind(key, expires, limit)
    .first()
  return row !== null
}
async function rateLimit(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP')
  if (!ip) throw new HttpError(503, 'Client address unavailable')
  const hour = Math.floor(Date.now() / 3_600_000)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.RATE_LIMIT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${hour}:${ip}`),
  )
  const hash = Array.from(new Uint8Array(mac), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  if (!(await withinLimit(env.DB, hash, (hour + 1) * 3_600_000, 5)))
    return false
  return withinLimit(env.DB, `global:${hour}`, (hour + 1) * 3_600_000, 100)
}
export async function handleContact(
  request: Request,
  env: Env,
  send: SendMail = smtpSender(env),
  verify: VerifyChallenge = verifyChallenge,
): Promise<Response> {
  const path = new URL(request.url).pathname
  if (
    request.method === 'GET' &&
    ['/', '/form.js', '/form.css'].includes(path)
  ) {
    return new Response(
      path === '/'
        ? form(env.TURNSTILE_SITE_KEY)
        : path === '/form.js'
          ? script
          : css,
      {
        headers: {
          'Content-Type':
            path === '/'
              ? 'text/html; charset=utf-8'
              : path === '/form.js'
                ? 'text/javascript; charset=utf-8'
                : 'text/css; charset=utf-8',
          'Content-Security-Policy':
            "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Cache-Control': 'no-store',
        },
      },
    )
  }
  if (request.method !== 'POST' || path !== '/contact')
    return json({ error: 'Not found' }, 404)
  try {
    if (
      !env.PUBLIC_ORIGIN ||
      !env.TURNSTILE_SECRET_KEY ||
      env.RATE_LIMIT_SECRET?.length < 32 ||
      !env.RATE_LIMIT_SECRET ||
      !env.MAIL_FROM ||
      !env.MAIL_TO
    )
      throw new HttpError(503, 'Contact form is not configured')
    if (request.headers.get('origin') !== env.PUBLIC_ORIGIN)
      throw new HttpError(403, 'Origin not allowed')
    const data = await body(request)
    if (data.website) throw new HttpError(400, 'Invalid submission')
    const name = field(data.name, 'name', 100),
      reply = mailbox(data.email),
      subject = field(data.subject, 'subject', 160),
      message = field(data.message, 'message', 8000, true)
    const token = field(data.turnstileToken, 'challenge', 2048)
    if (!(await rateLimit(request, env)))
      return new Response(
        JSON.stringify({ error: 'Too many submissions. Try again later.' }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(
              3600 - (Math.floor(Date.now() / 1000) % 3600),
            ),
            'Cache-Control': 'no-store',
          },
        },
      )
    if (!(await verify(token, request.headers.get('CF-Connecting-IP')!, env)))
      throw new HttpError(403, 'Challenge rejected')
    const id = crypto.randomUUID()
    const mail = {
      from: mailbox(env.MAIL_FROM),
      to: mailbox(env.MAIL_TO),
      reply,
      subject: `[Contact] ${subject}`,
      text: `From: ${name}\n\n${message}`,
      messageId: `<${id}@${mailbox(env.MAIL_FROM).split('@')[1]}>`,
    }
    validMessage(mail)
    try {
      await send(mail)
      return json({ status: 'accepted', id })
    } catch (error) {
      const outcome = failure(error)
      return outcome.status === 'unknown'
        ? json({ status: 'unknown', id }, 202)
        : json({ error: 'Unable to send. Please try later.', id }, 502)
    }
  } catch (error) {
    return json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : 'Contact form unavailable',
      },
      error instanceof HttpError ? error.status : 503,
    )
  }
}
export default {
  fetch(request, env) {
    return handleContact(request, env)
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?')
      .bind(Date.now())
      .run()
  },
} satisfies ExportedHandler<Env>
