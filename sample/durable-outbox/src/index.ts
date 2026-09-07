import {
  authorized,
  body,
  digest,
  field,
  HttpError,
  json,
  mailbox,
  type SendMail,
  validMessage,
} from '../../starters/shared'
import { smtpSender } from '../../starters/smtp'
import { drain, enqueue } from './outbox'
export type Env = OutboxEnv
export async function handleOutbox(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!(await authorized(request, env.OUTBOX_TOKEN)))
    return json({ error: 'Unauthorized' }, 401)
  const url = new URL(request.url)
  try {
    if (request.method === 'POST' && url.pathname === '/notifications') {
      const id = request.headers.get('Idempotency-Key') ?? ''
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id))
        throw new HttpError(
          400,
          'Use a 1–64 character Idempotency-Key: letters, digits, underscore or hyphen',
        )
      const data = await body(request)
      const from = mailbox(env.MAIL_FROM)
      const mail = {
        from,
        to: mailbox(data.to),
        subject: field(data.subject, 'subject', 160),
        text: field(data.text, 'text', 8000, true),
        messageId: `<${await digest(id)}@${from.split('@')[1]}>`,
      }
      validMessage(mail)
      const result = await enqueue(env.DB, id, mail)
      return json(result, result.duplicate ? 200 : 202)
    }
    const match = url.pathname.match(/^\/outbox\/([a-zA-Z0-9_-]{1,64})$/)
    if (request.method === 'GET' && match) {
      const row = await env.DB.prepare(
        'SELECT id,message_id,status,attempts,next_attempt_at,reason,created_at,updated_at FROM outbox WHERE id=?',
      )
        .bind(match[1])
        .first()
      if (!row) throw new HttpError(404, 'Not found')
      const attempts = await env.DB.prepare(
        'SELECT number,status,started_at,finished_at,smtp_attempt_id,response_code,tls_mode,reason FROM outbox_attempts WHERE outbox_id=? ORDER BY number',
      )
        .bind(match[1])
        .all()
      return json({ ...row, history: attempts.results })
    }
    return json({ error: 'Not found' }, 404)
  } catch (error) {
    return json(
      {
        error:
          error instanceof HttpError ? error.message : 'Outbox unavailable',
      },
      error instanceof HttpError ? error.status : 503,
    )
  }
}
export async function processOutbox(
  env: Env,
  send: SendMail = smtpSender(env),
): Promise<number> {
  return drain(env.DB, send)
}
export default {
  fetch: handleOutbox,
  async scheduled(_controller: ScheduledController, env: Env) {
    await processOutbox(env)
  },
} satisfies ExportedHandler<Env>
