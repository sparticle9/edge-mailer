import type {
  BatchSendOptions,
  BatchSendResult,
  EdgeMailerOptions,
  SmtpPoolOptions,
  SmtpSendReceipt,
} from './mailer.ts'
import { SmtpMailer } from './mailer.ts'

type PooledMailer<TMailer extends SmtpMailer> = {
  mailer: TMailer
  messages: number
  idleTimer?: ReturnType<typeof setTimeout>
}

type Waiter<TMailer extends SmtpMailer> = {
  resolve(client: PooledMailer<TMailer>): void
  reject(reason: unknown): void
}

export class SmtpConnectionPool<TMailer extends SmtpMailer> {
  private readonly maxConnections: number
  private readonly maxMessagesPerConnection: number
  private readonly idleTimeoutMs: number

  private ready: PooledMailer<TMailer>[] = []
  private busy = new Set<PooledMailer<TMailer>>()
  private waitQueue: Waiter<TMailer>[] = []
  private totalConnections = 0
  private closed = false

  constructor(
    private readonly options: EdgeMailerOptions,
    private readonly connectMailer: (
      options: EdgeMailerOptions,
    ) => Promise<TMailer>,
  ) {
    const poolOptions = normalizePoolOptions(options.pool)
    this.maxConnections = Math.max(1, poolOptions.maxConnections ?? 1)
    this.maxMessagesPerConnection = Math.max(
      1,
      poolOptions.maxMessagesPerConnection ?? Number.MAX_SAFE_INTEGER,
    )
    this.idleTimeoutMs = Math.max(0, poolOptions.idleTimeoutMs ?? 60_000)
  }

  async send(email: Parameters<TMailer['send']>[0]): Promise<SmtpSendReceipt> {
    const client = await this.acquire()
    try {
      const receipt = await client.mailer.send(email)
      client.messages++
      this.release(client)
      return receipt
    } catch (error) {
      client.messages++
      this.release(client)
      throw error
    }
  }

  async sendMany(
    emails: Parameters<TMailer['send']>[0][],
    options: BatchSendOptions = {},
  ): Promise<BatchSendResult> {
    const results: BatchSendResult = []
    for (const email of emails) {
      try {
        results.push({ status: 'fulfilled', value: await this.send(email) })
      } catch (reason) {
        if (!options.continueOnError) {
          throw reason
        }
        results.push({ status: 'rejected', reason })
      }
    }
    return results
  }

  async close() {
    this.closed = true
    for (const waiter of this.waitQueue) {
      waiter.reject(new Error('SMTP connection pool is closed'))
    }
    this.waitQueue = []

    const clients = [...this.ready, ...this.busy]
    this.ready = []
    this.busy.clear()
    await Promise.all(clients.map(client => this.destroy(client)))
  }

  private async acquire(): Promise<PooledMailer<TMailer>> {
    if (this.closed) {
      throw new Error('SMTP connection pool is closed')
    }

    const ready = this.ready.shift()
    if (ready) {
      this.clearIdleTimer(ready)
      this.busy.add(ready)
      return ready
    }

    if (this.totalConnections < this.maxConnections) {
      return await this.createBusyClient()
    }

    return await new Promise<PooledMailer<TMailer>>((resolve, reject) => {
      this.waitQueue.push({ resolve, reject })
    })
  }

  private release(client: PooledMailer<TMailer>) {
    this.busy.delete(client)
    if (
      this.closed ||
      !client.mailer.isActive() ||
      client.messages >= this.maxMessagesPerConnection
    ) {
      void this.destroy(client).finally(() => this.dispatchWaiters())
      return
    }

    const waiter = this.waitQueue.shift()
    if (waiter) {
      this.busy.add(client)
      waiter.resolve(client)
      return
    }

    this.ready.push(client)
    if (this.idleTimeoutMs > 0) {
      client.idleTimer = setTimeout(() => {
        this.ready = this.ready.filter(ready => ready !== client)
        void this.destroy(client).finally(() => this.dispatchWaiters())
      }, this.idleTimeoutMs)
    }
  }

  private dispatchWaiters() {
    if (this.closed) {
      return
    }

    while (this.waitQueue.length && this.ready.length) {
      const waiter = this.waitQueue.shift()!
      const client = this.ready.shift()!
      this.clearIdleTimer(client)
      this.busy.add(client)
      waiter.resolve(client)
    }

    while (
      this.waitQueue.length &&
      this.totalConnections < this.maxConnections
    ) {
      const waiter = this.waitQueue.shift()!
      this.createBusyClient().then(waiter.resolve, waiter.reject)
    }
  }

  private async createBusyClient(): Promise<PooledMailer<TMailer>> {
    this.totalConnections++
    try {
      const mailer = await this.connectMailer(this.options)
      const client = { mailer, messages: 0 }
      this.busy.add(client)
      return client
    } catch (error) {
      this.totalConnections--
      this.dispatchWaiters()
      throw error
    }
  }

  private async destroy(client: PooledMailer<TMailer>) {
    this.clearIdleTimer(client)
    this.ready = this.ready.filter(ready => ready !== client)
    this.busy.delete(client)
    this.totalConnections = Math.max(0, this.totalConnections - 1)
    try {
      await client.mailer.close()
    } catch {
      // Closing an already-failed SMTP connection should not mask send results.
    }
  }

  private clearIdleTimer(client: PooledMailer<TMailer>) {
    if (client.idleTimer) {
      clearTimeout(client.idleTimer)
      client.idleTimer = undefined
    }
  }
}

function normalizePoolOptions(
  pool: EdgeMailerOptions['pool'],
): SmtpPoolOptions {
  if (pool && typeof pool === 'object') {
    return pool
  }
  return {}
}
