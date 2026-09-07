import { Email, type EmailOptions } from '../../src/email'
import { SMTPError, type SmtpSendReceipt } from '../../src/smtp/mailer'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  )
    throw new HttpError(415, 'Use application/json')
  const reader = request.body?.getReader()
  if (!reader) throw new HttpError(400, 'Missing body')
  let size = 0,
    text = ''
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16_384) {
        await reader.cancel()
        throw new HttpError(413, 'Body exceeds 16 KiB')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error()
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'Invalid JSON')
  } finally {
    reader.releaseLock()
  }
}
export function field(
  value: unknown,
  name: string,
  max: number,
  multiline = false,
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    (multiline
      ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
      : /[\u0000-\u001f\u007f]/
    ).test(value)
  )
    throw new HttpError(400, `Invalid ${name}`)
  return value.trim()
}
export function mailbox(value: unknown): string {
  const address = field(value, 'email', 254)
  if (!/^[^\s<>@,;:]+@[^\s<>@,;:]+\.[^\s<>@,;:]+$/.test(address))
    throw new HttpError(400, 'Invalid email')
  return address
}
export type Delivery = Pick<
  SmtpSendReceipt,
  'attemptId' | 'responseCode' | 'tlsMode'
>
export type SendMail = (mail: EmailOptions) => Promise<Delivery>
export function failure(error: unknown): {
  status: 'retry' | 'dead_letter' | 'unknown'
  reason: string
} {
  if (!(error instanceof SMTPError))
    return { status: 'unknown', reason: 'unclassified_failure' }
  if (error.reason === 'delivery_unknown' || error.reason === 'aborted')
    return { status: 'unknown', reason: error.reason }
  return {
    status:
      error.retryHint === 'retry'
        ? 'retry'
        : error.retryHint === 'do_not_retry'
          ? 'dead_letter'
          : 'unknown',
    reason: error.reason,
  }
}
export async function digest(text: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('')
}
export async function authorized(
  request: Request,
  token: string | undefined,
): Promise<boolean> {
  if (!token || token.length < 32) return false
  const provided = request.headers
    .get('authorization')
    ?.match(/^Bearer (.+)$/)?.[1]
  if (!provided) return false
  const [a, b] = await Promise.all([digest(provided), digest(token)])
  // Fixed-length comparison using the Workers Web Crypto extension.
  return crypto.subtle.timingSafeEqual(
    new TextEncoder().encode(a),
    new TextEncoder().encode(b),
  )
}
export function validMessage(mail: EmailOptions): void {
  new Email(mail)
}
