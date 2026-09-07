import { EdgeMailer, LogLevel } from '../../src/cloudflare'
import type { SendMail } from './shared'

export interface SmtpSettings {
  SMTP_HOST: string
  SMTP_PORT: string
  SMTP_USERNAME: string
  SMTP_PASSWORD: string
  MAIL_FROM: string
}
export function smtpSender(env: SmtpSettings): SendMail {
  return async mail => {
    const port = Number(env.SMTP_PORT)
    if (
      !env.SMTP_HOST ||
      !env.SMTP_USERNAME ||
      !env.SMTP_PASSWORD ||
      ![465, 587, 2525].includes(port)
    )
      throw new Error('Configure SMTP credentials and a TLS submission port')
    return EdgeMailer.send(
      {
        host: env.SMTP_HOST,
        port,
        secure: port === 465,
        startTls: port !== 465,
        tlsPolicy: port === 465 ? 'require-tls' : 'require-starttls',
        credentials: {
          username: env.SMTP_USERNAME,
          password: env.SMTP_PASSWORD,
        },
        signal: AbortSignal.timeout(60_000),
        socketTimeoutMs: 15_000,
        logLevel: LogLevel.NONE,
      },
      mail,
    )
  }
}
