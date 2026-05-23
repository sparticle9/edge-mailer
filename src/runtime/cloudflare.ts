import { connect as connectSocket } from 'cloudflare:sockets'
import { SmtpMailer } from '../smtp/mailer.ts'
import type {
  BatchSendOptions,
  BatchSendResult,
  EdgeMailerOptions,
} from '../smtp/mailer.ts'
import type { EmailOptions } from '../email.ts'
import type { EdgeSocketConnector, SocketTlsMode } from './socket.ts'

function secureTransport(tls: SocketTlsMode) {
  if (tls === 'on') {
    return 'on'
  }
  if (tls === 'starttls') {
    return 'starttls'
  }
  return 'off'
}

export const cloudflareSocketConnector: EdgeSocketConnector = {
  connect(options) {
    return connectSocket(
      {
        hostname: options.hostname,
        port: options.port,
      },
      {
        secureTransport: secureTransport(options.tls),
        allowHalfOpen: false,
      },
    )
  },
}

export class EdgeMailer extends SmtpMailer {
  private constructor(options: EdgeMailerOptions) {
    super(options, cloudflareSocketConnector, 'EdgeMailer')
  }

  static async connect(options: EdgeMailerOptions): Promise<EdgeMailer> {
    const mailer = new EdgeMailer(options)
    try {
      await mailer.initializeSmtpSession()
      return mailer
    } catch (error) {
      await mailer.abortConnection(error)
      throw error
    }
  }

  static async send(
    options: EdgeMailerOptions,
    email: EmailOptions,
  ): Promise<void> {
    const mailer = await EdgeMailer.connect(options)
    try {
      await mailer.send(email)
    } finally {
      await mailer.close()
    }
  }

  static async sendBatch(
    options: EdgeMailerOptions,
    emails: EmailOptions[],
    batchOptions: BatchSendOptions = {},
  ): Promise<BatchSendResult> {
    const mailer = await EdgeMailer.connect(options)
    try {
      return await mailer.sendMany(emails, batchOptions)
    } finally {
      await mailer.close()
    }
  }
}
