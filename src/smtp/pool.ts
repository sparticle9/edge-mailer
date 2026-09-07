import type {
  BatchSendOptions,
  BatchSendResult,
  EdgeMailerOptions,
  SendOptions,
  SmtpPoolOptions,
  SmtpSendReceipt,
} from './mailer.ts'
import { SmtpMailer } from './mailer.ts'
import Logger from '../logger.ts'
import {
  createObservationId,
  durationSince,
  type MailObservationEvent,
  type MailObservationEventType,
} from '../observation.ts'

type PooledMailer<TMailer extends SmtpMailer> = {
  mailer: TMailer
  messages: number
  idleTimer?: ReturnType<typeof setTimeout>
  destroyPromise?: Promise<void>
}

type Waiter<TMailer extends SmtpMailer> = {
  resolve(client: PooledMailer<TMailer>): void
  reject(reason: unknown): void
  startedAt: number
}

/** Bounded SMTP connection pool for reusing runtime mailer sessions. */
export class SmtpConnectionPool<TMailer extends SmtpMailer> {
  private readonly maxConnections: number
  private readonly maxMessagesPerConnection: number
  private readonly idleTimeoutMs: number

  private ready: PooledMailer<TMailer>[] = []
  private busy = new Set<PooledMailer<TMailer>>()
  private waitQueue: Waiter<TMailer>[] = []
  private pendingCreates = new Set<Promise<void>>()
  private pendingDestroys = new Set<Promise<void>>()
  private totalConnections = 0
  private closed = false
  private poolId?: string
  private readonly logger: Logger

  constructor(
    private readonly options: EdgeMailerOptions,
    private readonly connectMailer: (
      options: EdgeMailerOptions,
    ) => Promise<TMailer>,
    private readonly runtimeName = 'SmtpConnectionPool',
  ) {
    const poolOptions = normalizePoolOptions(options.pool)
    for (const limit of [
      poolOptions.maxConnections,
      poolOptions.maxMessagesPerConnection,
    ]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new Error('SMTP pool limits must be positive safe integers')
      }
    }
    if (
      poolOptions.idleTimeoutMs !== undefined &&
      (!Number.isFinite(poolOptions.idleTimeoutMs) ||
        poolOptions.idleTimeoutMs < 0)
    ) {
      throw new Error(
        'SMTP pool idle timeout must be a non-negative finite number',
      )
    }
    this.maxConnections = Math.max(1, poolOptions.maxConnections ?? 1)
    this.maxMessagesPerConnection = Math.max(
      1,
      poolOptions.maxMessagesPerConnection ?? Number.MAX_SAFE_INTEGER,
    )
    this.idleTimeoutMs = Math.max(0, poolOptions.idleTimeoutMs ?? 60_000)
    this.logger = new Logger(options.logLevel, `[${runtimeName}:pool]`)
  }

  /** Sends one message through an acquired SMTP session. */
  async send(
    email: Parameters<TMailer['send']>[0],
    options: SendOptions = {},
  ): Promise<SmtpSendReceipt> {
    const client = await this.acquire()
    try {
      const receipt = await client.mailer.send(email, options)
      client.messages++
      await this.release(client)
      return receipt
    } catch (error) {
      client.messages++
      await this.release(client)
      throw error
    }
  }

  /** Sends messages sequentially through the pool. */
  async sendMany(
    emails: Parameters<TMailer['send']>[0][],
    options: BatchSendOptions = {},
  ): Promise<BatchSendResult> {
    const results: BatchSendResult = []
    for (const email of emails) {
      try {
        results.push({
          status: 'fulfilled',
          value: await this.send(email, { signal: options.signal }),
        })
      } catch (reason) {
        if (!options.continueOnError) {
          throw reason
        }
        results.push({ status: 'rejected', reason })
      }
    }
    return results
  }

  /** Closes all pooled SMTP sessions and rejects queued sends. */
  async close() {
    this.closed = true
    for (const waiter of this.waitQueue) {
      waiter.reject(new Error('SMTP connection pool is closed'))
    }
    this.waitQueue = []

    const clients = [...this.ready, ...this.busy]
    this.ready = []
    this.busy.clear()
    for (const client of clients) {
      this.trackDestroy(client, false)
    }
    await this.waitForDrained()
  }

  private async acquire(): Promise<PooledMailer<TMailer>> {
    if (this.closed) {
      throw new Error('SMTP connection pool is closed')
    }

    const ready = this.ready.shift()
    if (ready) {
      this.clearIdleTimer(ready)
      this.busy.add(ready)
      if (this.hasObservation()) {
        this.emitPoolObservation('smtp.pool.connection.reused')
        this.emitPoolObservation('smtp.pool.acquire.completed', {
          durationMs: 0,
          pool: this.poolSnapshot({ waitMs: 0 }),
        })
      }
      return ready
    }

    if (this.totalConnections < this.maxConnections) {
      const startedAt = Date.now()
      const client = await this.createBusyClient()
      const waitMs = durationSince(startedAt)
      if (this.hasObservation()) {
        this.emitPoolObservation('smtp.pool.acquire.completed', {
          durationMs: waitMs,
          pool: this.poolSnapshot({ waitMs }),
        })
      }
      return client
    }

    const startedAt = Date.now()
    return await new Promise<PooledMailer<TMailer>>((resolve, reject) => {
      this.waitQueue.push({ resolve, reject, startedAt })
    }).then(client => {
      const waitMs = durationSince(startedAt)
      if (this.hasObservation()) {
        this.emitPoolObservation('smtp.pool.acquire.completed', {
          durationMs: waitMs,
          pool: this.poolSnapshot({ waitMs }),
        })
      }
      return client
    })
  }

  private async release(client: PooledMailer<TMailer>) {
    if (client.destroyPromise) {
      await this.trackDestroy(client)
      return
    }

    this.busy.delete(client)
    if (
      this.closed ||
      !client.mailer.isActive() ||
      client.messages >= this.maxMessagesPerConnection
    ) {
      await this.trackDestroy(client)
      return
    }

    const waiter = this.waitQueue.shift()
    if (waiter) {
      this.busy.add(client)
      if (this.hasObservation()) {
        this.emitPoolObservation('smtp.pool.connection.reused')
      }
      waiter.resolve(client)
      return
    }

    this.ready.push(client)
    if (this.idleTimeoutMs > 0) {
      client.idleTimer = setTimeout(() => {
        this.ready = this.ready.filter(ready => ready !== client)
        void this.trackDestroy(client)
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
      if (this.hasObservation()) {
        this.emitPoolObservation('smtp.pool.connection.reused')
      }
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

  private createBusyClient(): Promise<PooledMailer<TMailer>> {
    const create = this.createBusyClientInner()
    const trackedCreate = create.then(
      () => undefined,
      () => undefined,
    )
    this.pendingCreates.add(trackedCreate)
    void trackedCreate.finally(() => {
      this.pendingCreates.delete(trackedCreate)
    })
    return create
  }

  private async createBusyClientInner(): Promise<PooledMailer<TMailer>> {
    this.totalConnections++
    let destroyOwnsConnection = false
    try {
      const mailer = await this.connectMailer(this.options)
      const client = { mailer, messages: 0 }
      if (this.closed) {
        destroyOwnsConnection = true
        await this.trackDestroy(client, false)
        throw new Error('SMTP connection pool is closed')
      }
      this.busy.add(client)
      if (this.hasObservation()) {
        this.emitPoolObservation('smtp.pool.connection.created')
      }
      return client
    } catch (error) {
      if (!destroyOwnsConnection) {
        this.totalConnections--
        this.dispatchWaiters()
      }
      throw error
    }
  }

  private trackDestroy(
    client: PooledMailer<TMailer>,
    dispatchWaiters = true,
  ): Promise<void> {
    const destroyPromise = this.destroy(client)
    this.pendingDestroys.add(destroyPromise)
    void destroyPromise.finally(() => {
      this.pendingDestroys.delete(destroyPromise)
      if (dispatchWaiters) {
        this.dispatchWaiters()
      }
    })
    return destroyPromise
  }

  private destroy(client: PooledMailer<TMailer>): Promise<void> {
    if (client.destroyPromise) {
      return client.destroyPromise
    }

    client.destroyPromise = this.destroyOnce(client)
    return client.destroyPromise
  }

  private async destroyOnce(client: PooledMailer<TMailer>) {
    this.clearIdleTimer(client)
    this.ready = this.ready.filter(ready => ready !== client)
    this.busy.delete(client)
    try {
      await client.mailer.close()
    } catch {
      // Closing an already-failed SMTP connection should not mask send results.
    }
    this.totalConnections = Math.max(0, this.totalConnections - 1)
    if (this.hasObservation()) {
      this.emitPoolObservation('smtp.pool.connection.closed')
    }
  }

  private async waitForDrained() {
    while (this.pendingCreates.size || this.pendingDestroys.size) {
      await Promise.all([...this.pendingCreates, ...this.pendingDestroys])
    }
  }

  private clearIdleTimer(client: PooledMailer<TMailer>) {
    if (client.idleTimer) {
      clearTimeout(client.idleTimer)
      client.idleTimer = undefined
    }
  }

  private emitPoolObservation(
    type: MailObservationEventType,
    event: Partial<MailObservationEvent> = {},
  ) {
    const onEvent = this.options.observation?.onEvent
    if (!onEvent) {
      return
    }

    try {
      onEvent({
        version: 1,
        type,
        status: 'completed',
        runtime: this.runtimeName,
        sessionId: this.getPoolId(),
        timestamp: new Date().toISOString(),
        pool: this.poolSnapshot(),
        ...event,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('Observation handler failed: ' + message)
    }
  }

  private hasObservation() {
    return Boolean(this.options.observation?.onEvent)
  }

  private getPoolId() {
    this.poolId ||= createObservationId('smtp_pool')
    return this.poolId
  }

  private poolSnapshot(extra: MailObservationEvent['pool'] = {}) {
    return {
      ready: this.ready.length,
      busy: this.busy.size,
      totalConnections: this.totalConnections,
      ...extra,
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
