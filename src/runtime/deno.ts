import { SmtpMailer } from '../smtp/mailer.ts'
import type {
  BatchSendOptions,
  BatchSendResult,
  EdgeMailerOptions,
} from '../smtp/mailer.ts'
import type { EmailOptions } from '../email.ts'
import type { EdgeSocket, EdgeSocketConnector } from './socket.ts'

type DenoConn = {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  closed?: Promise<void>
  close(): void
}

export type DenoSocketRuntime = {
  connect(options: {
    hostname: string
    port: number
    transport?: 'tcp'
    signal?: AbortSignal
  }): Promise<DenoConn>
  connectTls(options: { hostname: string; port: number }): Promise<DenoConn>
  startTls(
    conn: DenoConn,
    options?: {
      hostname?: string
    },
  ): Promise<DenoConn>
}

function currentDeno(): DenoSocketRuntime {
  const deno = (globalThis as { Deno?: DenoSocketRuntime }).Deno
  if (!deno) {
    throw new Error('Deno runtime APIs are not available')
  }
  return deno
}

function wrapDenoConn(
  conn: DenoConn,
  deno: DenoSocketRuntime,
  hostname: string,
  allowStartTls: boolean,
): EdgeSocket {
  return {
    readable: conn.readable,
    writable: conn.writable,
    closed: conn.closed,
    close() {
      conn.close()
    },
    startTls: allowStartTls
      ? async () =>
          wrapDenoConn(
            await deno.startTls(conn, { hostname }),
            deno,
            hostname,
            false,
          )
      : undefined,
  }
}

export function createDenoSocketConnector(
  deno: DenoSocketRuntime = currentDeno(),
): EdgeSocketConnector {
  return {
    async connect(options) {
      if (options.tls === 'on') {
        return wrapDenoConn(
          await deno.connectTls({
            hostname: options.hostname,
            port: options.port,
          }),
          deno,
          options.hostname,
          false,
        )
      }

      const conn = await deno.connect({
        hostname: options.hostname,
        port: options.port,
        transport: 'tcp',
        signal: options.signal,
      })

      return wrapDenoConn(
        conn,
        deno,
        options.hostname,
        options.tls === 'starttls',
      )
    },
  }
}

export class DenoMailer extends SmtpMailer {
  private constructor(options: EdgeMailerOptions) {
    super(options, createDenoSocketConnector(), 'DenoMailer')
  }

  static async connect(options: EdgeMailerOptions): Promise<DenoMailer> {
    const mailer = new DenoMailer(options)
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
    const mailer = await DenoMailer.connect(options)
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
    const mailer = await DenoMailer.connect(options)
    try {
      return await mailer.sendMany(emails, batchOptions)
    } finally {
      await mailer.close()
    }
  }
}
