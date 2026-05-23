import { connect as connectSocket } from 'cloudflare:sockets'
import { SmtpMailer } from '../smtp/mailer.ts'
import { SmtpConnectionPool } from '../smtp/pool.ts'
import type {
  BatchSendOptions,
  BatchSendResult,
  EdgeMailerOptions,
  SmtpSendReceipt,
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

/** Cloudflare Workers socket connector backed by `cloudflare:sockets`. */
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

/** Cloudflare Workers mailer using outbound TCP sockets. */
export class EdgeMailer extends SmtpMailer {
  private constructor(options: EdgeMailerOptions) {
    super(options, cloudflareSocketConnector, 'EdgeMailer')
  }

  /** Opens and initializes an SMTP session in a Cloudflare Worker. */
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

  /** Sends one message and closes the SMTP session afterward. */
  static async send(
    options: EdgeMailerOptions,
    email: EmailOptions,
  ): Promise<SmtpSendReceipt> {
    const mailer = await EdgeMailer.connect(options)
    try {
      return await mailer.send(email)
    } finally {
      await mailer.close()
    }
  }

  /** Sends messages sequentially over one SMTP session. */
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

  /** Creates a bounded pool of Cloudflare SMTP sessions. */
  static createPool(
    options: EdgeMailerOptions,
  ): SmtpConnectionPool<EdgeMailer> {
    return new SmtpConnectionPool(options, EdgeMailer.connect)
  }
}
