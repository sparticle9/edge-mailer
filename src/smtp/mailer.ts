import { decode, encode } from '../utils.ts'
import { Email, type DsnOptions, type EmailOptions } from '../email.ts'
import {
  signDkimMessage,
  validateDkimConfig,
  type DkimConfig,
} from '../dkim.ts'
import Logger, { LogLevel } from '../logger.ts'
import {
  classifyMailFailure,
  createObservationId,
  durationSince,
  redactSmtpCommand,
  redactSmtpResponse,
  type MailFailureReason,
  type MailNextAction,
  type MailObservationEvent,
  type MailObservationEventType,
  type MailObservationOptions,
  type MailObservationStatus,
  type MailRetryHint,
} from '../observation.ts'
import type { EdgeSocket, EdgeSocketConnector } from '../runtime/socket.ts'

/** SMTP authentication mechanisms supported by the shared SMTP client. */
export type AuthType = 'plain' | 'login' | 'cram-md5'
const DEFAULT_AUTH_TYPES: AuthType[] = ['plain', 'login', 'cram-md5']

/** Username and password used for SMTP AUTH. */
export type Credentials = {
  username: string
  password: string
}
/** Controls ordered batch behavior when one message fails. */
export type BatchSendOptions = {
  continueOnError?: boolean
}
/** Recipient rejected by the SMTP server during the envelope phase. */
export type SmtpRejectedRecipient = {
  recipient: string
  response: string
  responseCode?: number
  enhancedStatusCode?: string
  transient: boolean
}
/** Structured receipt returned after an SMTP DATA transaction completes. */
export type SmtpSendReceipt = {
  attemptId: string
  messageId: string
  envelope: {
    from: string
    to: string[]
  }
  accepted: string[]
  rejected: SmtpRejectedRecipient[]
  response: string
  responseCode?: number
  enhancedStatusCode?: string
  size: number
  durationMs: number
  toJSON(): SmtpSendReceiptJson
}
/** JSON form returned by {@link SmtpSendReceipt.toJSON}. */
export type SmtpSendReceiptJson = Omit<SmtpSendReceipt, 'toJSON'>
/** Ordered result list returned by `sendBatch()` and `sendMany()`. */
export type BatchSendResult = PromiseSettledResult<SmtpSendReceipt>[]
/** SMTP PIPELINING behavior. */
export type PipeliningMode = 'auto' | false
/** SMTP message body encoding advertised in MAIL FROM. */
export type SmtpBodyType = '7BIT' | '8BITMIME'
/** Protocol stage attached to structured SMTP errors. */
export type SMTPStage =
  | 'connect'
  | 'greet'
  | 'ehlo'
  | 'helo'
  | 'starttls'
  | 'auth'
  | 'mail'
  | 'rcpt'
  | 'data'
  | 'body'
  | 'rset'
  | 'quit'
  | 'send'
  | 'read'

/** Constructor details for {@link SMTPError}. */
export type SMTPErrorOptions = {
  stage: SMTPStage
  command?: string
  response?: string
  cause?: unknown
  reason?: MailFailureReason
  retryHint?: MailRetryHint
  nextAction?: MailNextAction
}

/** JSON form returned by {@link SMTPError.toJSON}. */
export type SMTPErrorJson = {
  name: string
  message: string
  stage: SMTPStage
  command?: string
  response?: string
  responseCode?: number
  enhancedStatusCode?: string
  transient: boolean
  reason: MailFailureReason
  retryHint: MailRetryHint
  nextAction: MailNextAction
  cause?: {
    name?: string
    message: string
  }
}

/** Error thrown when an SMTP command or socket stage fails. */
export class SMTPError extends Error {
  /** SMTP stage where the failure happened. */
  public readonly stage: SMTPStage
  /** SMTP command active when the failure happened, when available. */
  public readonly command?: string
  /** Raw SMTP response line associated with the failure. */
  public readonly response?: string
  /** Three-digit SMTP response code parsed from {@link response}. */
  public readonly responseCode?: number
  /** Enhanced status code parsed from {@link response}. */
  public readonly enhancedStatusCode?: string
  /** Whether the response code is a transient 4xx failure. */
  public readonly transient: boolean
  /** Compact reason suitable for retry policy and agent routing. */
  public readonly reason: MailFailureReason
  /** Retry guidance derived from stage and response metadata. */
  public readonly retryHint: MailRetryHint
  /** Suggested next action for callers and automation. */
  public readonly nextAction: MailNextAction
  public override readonly cause?: unknown

  /** Creates a structured SMTP error. */
  constructor(message: string, options: SMTPErrorOptions) {
    super(message)
    this.name = 'SMTPError'
    this.stage = options.stage
    this.command = options.command
    this.response = options.response
    this.cause = options.cause

    const match = options.response?.match(/^(\d{3})/)
    this.responseCode = match ? Number(match[1]) : undefined
    this.enhancedStatusCode = options.response
      ?.match(/^\d{3}[ -]([245]\.\d{1,3}\.\d{1,3})\b/)
      ?.at(1)
    this.transient = this.responseCode
      ? this.responseCode >= 400 && this.responseCode < 500
      : false
    const classification = classifyMailFailure({
      stage: options.stage,
      message,
      responseCode: this.responseCode,
    })
    this.reason = options.reason || classification.reason
    this.retryHint = options.retryHint || classification.retryHint
    this.nextAction = options.nextAction || classification.nextAction
  }

  /** Returns a redacted, JSON-safe representation of the SMTP error. */
  toJSON(): SMTPErrorJson {
    return {
      name: this.name,
      message: redactSmtpResponse(this.message),
      stage: this.stage,
      command: this.command ? redactSmtpCommand(this.command) : undefined,
      response: this.response ? redactSmtpResponse(this.response) : undefined,
      responseCode: this.responseCode,
      enhancedStatusCode: this.enhancedStatusCode,
      transient: this.transient,
      reason: this.reason,
      retryHint: this.retryHint,
      nextAction: this.nextAction,
      cause: this.errorCauseJson(),
    }
  }

  private errorCauseJson() {
    if (!(this.cause instanceof Error)) {
      return undefined
    }
    return {
      name: this.cause.name,
      message: redactSmtpResponse(this.cause.message),
    }
  }
}

const MD5_SHIFT_AMOUNTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
]

const MD5_CONSTANTS = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0,
)

function leftRotate(value: number, shift: number) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

function concatBytes(...chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((length, chunk) => length + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function md5(input: Uint8Array) {
  const bitLength = BigInt(input.length) * 8n
  let paddedLength = input.length + 1
  while (paddedLength % 64 !== 56) {
    paddedLength++
  }

  const buffer = new Uint8Array(paddedLength + 8)
  buffer.set(input)
  buffer[input.length] = 0x80
  const view = new DataView(buffer.buffer)
  for (let index = 0; index < 8; index++) {
    view.setUint8(
      paddedLength + index,
      Number((bitLength >> BigInt(index * 8)) & 0xffn),
    )
  }

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const words = new Array<number>(16)

  for (let offset = 0; offset < buffer.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4, true)
    }

    let a = a0
    let b = b0
    let c = c0
    let d = d0

    for (let index = 0; index < 64; index++) {
      let f: number
      let g: number

      if (index < 16) {
        f = (b & c) | (~b & d)
        g = index
      } else if (index < 32) {
        f = (d & b) | (~d & c)
        g = (5 * index + 1) % 16
      } else if (index < 48) {
        f = b ^ c ^ d
        g = (3 * index + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * index) % 16
      }

      const next = d
      d = c
      c = b
      b =
        (b +
          leftRotate(
            (a + f + MD5_CONSTANTS[index] + words[g]) >>> 0,
            MD5_SHIFT_AMOUNTS[index],
          )) >>>
        0
      a = next
    }

    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  const digest = new Uint8Array(16)
  const digestView = new DataView(digest.buffer)
  digestView.setUint32(0, a0, true)
  digestView.setUint32(4, b0, true)
  digestView.setUint32(8, c0, true)
  digestView.setUint32(12, d0, true)
  return digest
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function hmacMd5Hex(key: Uint8Array, message: Uint8Array) {
  const blockSize = 64
  const normalizedKey = key.length > blockSize ? md5(key) : key
  const outerPad = new Uint8Array(blockSize).fill(0x5c)
  const innerPad = new Uint8Array(blockSize).fill(0x36)

  normalizedKey.forEach((byte, index) => {
    outerPad[index] ^= byte
    innerPad[index] ^= byte
  })

  return bytesToHex(
    md5(concatBytes(outerPad, md5(concatBytes(innerPad, message)))),
  )
}

function binaryStringToBytes(value: string) {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index++) {
    bytes[index] = value.charCodeAt(index) & 0xff
  }
  return bytes
}

function base64ToBytes(value: string) {
  return binaryStringToBytes(atob(value))
}

function xtext(value: string) {
  let result = ''
  for (const byte of encode(value)) {
    if (byte >= 33 && byte <= 126 && byte !== 43 && byte !== 61) {
      result += String.fromCharCode(byte)
    } else {
      result += `+${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return result
}

function normalizeOrcpt(value: string) {
  return value.includes(';') ? value : `rfc822;${value}`
}

/** SMTP client configuration shared by Cloudflare and Deno runtimes. */
export type EdgeMailerOptions = {
  host: string
  port: number
  secure?: boolean
  startTls?: boolean
  credentials?: Credentials
  authType?: AuthType | AuthType[]
  logLevel?: LogLevel
  pipelining?: PipeliningMode
  dsn?: DsnOptions | undefined
  dkim?: DkimConfig | undefined
  pool?: SmtpPoolOptions | boolean | undefined
  socketTimeoutMs?: number
  responseTimeoutMs?: number
  observation?: MailObservationOptions | undefined
}

/** Connection-pool limits for repeated SMTP sends. */
export type SmtpPoolOptions = {
  maxConnections?: number
  maxMessagesPerConnection?: number
  idleTimeoutMs?: number
}

type PreparedEmail = {
  email: Email
  data: string
  size: number
}

type SmtpTransaction = {
  accepted: string[]
  rejected: SmtpRejectedRecipient[]
}

/** Runtime-neutral SMTP session implementation used by runtime mailers. */
export class SmtpMailer {
  private readonly host: string
  private readonly port: number
  private readonly secure: boolean
  private readonly startTls: boolean
  private readonly authType: AuthType[]
  private readonly credentials?: Credentials
  private readonly pipelining: PipeliningMode

  private readonly socketTimeoutMs: number
  private readonly responseTimeoutMs: number

  private socket?: EdgeSocket
  private reader!: ReadableStreamDefaultReader<Uint8Array>
  private writer!: WritableStreamDefaultWriter<Uint8Array>
  private responseBuffer = ''

  private readonly logger: Logger
  private readonly runtimeName: string
  private readonly observation?: MailObservationOptions
  private readonly sessionId = createObservationId('smtp_session')

  private readonly dsn: DsnOptions | undefined
  private readonly dkim: DkimConfig | undefined

  private active = false
  private closeError?: Error
  private sendChain: Promise<unknown> = Promise.resolve()
  private emailSending: Email | null = null
  private queuedSendRejects = new Set<(reason?: unknown) => void>()

  /** SMTP server capabilities **/
  private supportsDSN = false
  private supportsSize = false
  private maxMessageSize?: number
  private supports8BitMime = false
  private supportsSmtpUtf8 = false
  private supportsRequireTls = false
  private allowAuth = false
  private authTypeSupported: AuthType[] = []
  private supportsStartTls = false
  private supportsPipelining = false

  protected constructor(
    options: EdgeMailerOptions,
    private readonly connector: EdgeSocketConnector,
    runtimeName = 'SmtpMailer',
  ) {
    this.runtimeName = runtimeName
    this.port = options.port
    this.host = options.host
    this.secure = !!options.secure
    if (Array.isArray(options.authType)) {
      this.authType = options.authType
    } else if (typeof options.authType === 'string') {
      this.authType = [options.authType]
    } else {
      this.authType = DEFAULT_AUTH_TYPES
    }
    this.startTls = options.startTls === undefined ? true : options.startTls
    this.credentials = options.credentials
    this.pipelining = options.pipelining === false ? false : 'auto'
    this.dsn = options.dsn || {}
    this.dkim = options.dkim
    validateDkimConfig(this.dkim)

    this.socketTimeoutMs = options.socketTimeoutMs || 60_000
    this.responseTimeoutMs = options.responseTimeoutMs || 30_000
    this.observation = options.observation

    this.logger = new Logger(
      options.logLevel,
      `[${runtimeName}:${this.host}:${this.port}]`,
    )
  }

  /** Sends one message over the active SMTP session. */
  public send(options: EmailOptions): Promise<SmtpSendReceipt> {
    const email = new Email(options)
    email.sent.catch(() => undefined)
    let rejectQueued!: (reason?: unknown) => void
    let cancelled = false
    const task = new Promise<SmtpSendReceipt>((resolve, reject) => {
      rejectQueued = reason => {
        cancelled = true
        reject(reason)
      }
      this.queuedSendRejects.add(rejectQueued)
      const run = this.sendChain.then(async () => {
        this.queuedSendRejects.delete(rejectQueued)
        if (cancelled) {
          throw this.closedSendError()
        }
        if (!this.active) {
          throw this.closedSendError()
        }
        return await this.sendEmail(email)
      })
      run.then(resolve, reject)
    })

    this.sendChain = task.catch(() => undefined)
    return task
  }

  /** Sends messages sequentially over the active SMTP session. */
  public async sendMany(
    emails: EmailOptions[],
    options: BatchSendOptions = {},
  ): Promise<BatchSendResult> {
    const results: BatchSendResult = []
    for (const email of emails) {
      try {
        const receipt = await this.send(email)
        results.push({ status: 'fulfilled', value: receipt })
      } catch (reason) {
        if (!options.continueOnError) {
          throw reason
        }
        results.push({ status: 'rejected', reason })
      }
    }
    return results
  }

  /** Closes the SMTP socket and rejects any queued sends. */
  public async close(error?: Error) {
    const closeError =
      error || new SMTPError('EdgeMailer is shutting down', { stage: 'quit' })
    this.active = false
    this.closeError = closeError
    this.logger.info('EdgeMailer is closed', error?.message || '')
    for (const reject of this.queuedSendRejects) {
      reject(this.closedSendError())
    }
    this.queuedSendRejects.clear()

    if (!error) {
      try {
        await this.writeLine('QUIT')
        await this.readTimeout('quit', 'QUIT')
      } catch (ignore) {
        // The server may have already closed the connection.
      }
    }

    await this.closeSocket()
  }

  /** Returns whether the SMTP session is open and usable. */
  public isActive(): boolean {
    return this.active
  }

  private emitObservation(
    type: MailObservationEventType,
    event: Partial<MailObservationEvent> &
      Pick<MailObservationEvent, 'status'> = { status: 'completed' },
  ) {
    const onEvent = this.observation?.onEvent
    if (!onEvent) {
      return
    }

    const includeTranscript = this.observation?.mode === 'transcript'
    const observed: MailObservationEvent = {
      version: 1,
      type,
      runtime: this.runtimeName,
      sessionId: this.sessionId,
      timestamp: event.timestamp || new Date().toISOString(),
      ...event,
      status: event.status,
      command:
        includeTranscript && event.command
          ? redactSmtpCommand(event.command)
          : undefined,
      response:
        includeTranscript && event.response
          ? redactSmtpResponse(event.response)
          : undefined,
    }

    try {
      onEvent(observed)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('Observation handler failed: ' + message)
    }
  }

  private emitStageObservation(
    type: MailObservationEventType,
    stage: SMTPStage,
    startedAt: number,
    status: MailObservationStatus = 'completed',
    event: Partial<MailObservationEvent> = {},
  ) {
    this.emitObservation(type, {
      stage,
      status,
      durationMs: durationSince(startedAt),
      ...event,
    })
  }

  private failureEvent(error: unknown): Pick<
    MailObservationEvent,
    'reason' | 'retryHint' | 'nextAction'
  > & {
    responseCode?: number
    enhancedStatusCode?: string
    command?: string
    response?: string
  } {
    if (error instanceof SMTPError) {
      return {
        reason: error.reason,
        retryHint: error.retryHint,
        nextAction: error.nextAction,
        responseCode: error.responseCode,
        enhancedStatusCode: error.enhancedStatusCode,
        command: error.command,
        response: error.response,
      }
    }

    const message = error instanceof Error ? error.message : String(error)
    return classifyMailFailure({ stage: 'send', message })
  }

  protected async initializeSmtpSession() {
    const connectStartedAt = Date.now()
    try {
      await this.openSocket()
      await this.waitForSocketConnected()
      this.emitStageObservation(
        'smtp.connect.completed',
        'connect',
        connectStartedAt,
      )
    } catch (error) {
      this.emitStageObservation(
        'smtp.connect.completed',
        'connect',
        connectStartedAt,
        'failed',
        this.failureEvent(error),
      )
      throw error
    }
    await this.greet()
    await this.ehlo()

    if (this.startTls && !this.secure && this.supportsStartTls) {
      await this.tls()
      await this.ehlo()
    }

    await this.auth()
    this.active = true
  }

  private async sendEmail(email: Email): Promise<SmtpSendReceipt> {
    this.emailSending = email
    const attemptId = createObservationId('mail_attempt')
    const sendStartedAt = Date.now()
    this.emitObservation('mail.send.started', {
      status: 'started',
      attemptId,
      stage: 'send',
    })

    let transaction: SmtpTransaction = { accepted: [], rejected: [] }
    try {
      const composeStartedAt = Date.now()
      const prepared = await this.prepareEmail(email)
      this.emitStageObservation(
        'mail.compose.completed',
        'send',
        composeStartedAt,
        'completed',
        {
          attemptId,
          messageSize: prepared.size,
        },
      )

      const envelopeStartedAt = Date.now()
      try {
        if (this.canPipeline()) {
          transaction = await this.envelopePipelined(prepared)
        } else {
          await this.mail(prepared)
          transaction = await this.rcpt(prepared)
        }
      } catch (error) {
        this.emitStageObservation(
          'smtp.envelope.completed',
          'rcpt',
          envelopeStartedAt,
          'failed',
          {
            attemptId,
            acceptedCount: transaction.accepted.length,
            rejectedCount: transaction.rejected.length,
            ...this.failureEvent(error),
          },
        )
        throw error
      }
      this.emitStageObservation(
        'smtp.envelope.completed',
        'rcpt',
        envelopeStartedAt,
        'completed',
        {
          attemptId,
          acceptedCount: transaction.accepted.length,
          rejectedCount: transaction.rejected.length,
        },
      )

      const dataStartedAt = Date.now()
      let response: string
      try {
        if (!this.canPipeline()) {
          await this.data()
        }
        response = await this.body(prepared)
      } catch (error) {
        this.emitStageObservation(
          'smtp.data.completed',
          'data',
          dataStartedAt,
          'failed',
          {
            attemptId,
            ...this.failureEvent(error),
          },
        )
        throw error
      }
      this.emitStageObservation(
        'smtp.data.completed',
        'data',
        dataStartedAt,
        'completed',
        {
          attemptId,
          command: 'DATA',
          response,
          responseCode: this.responseCode(response),
          enhancedStatusCode: this.enhancedStatusCode(response),
        },
      )
      email.setSent()
      const receipt = this.createReceipt(
        prepared,
        transaction,
        response,
        attemptId,
        durationSince(sendStartedAt),
      )
      this.emitStageObservation(
        'mail.send.completed',
        'send',
        sendStartedAt,
        'completed',
        {
          attemptId,
          messageSize: receipt.size,
          responseCode: receipt.responseCode,
          enhancedStatusCode: receipt.enhancedStatusCode,
          acceptedCount: receipt.accepted.length,
          rejectedCount: receipt.rejected.length,
        },
      )
      return receipt
    } catch (error) {
      const sendError =
        error instanceof Error
          ? error
          : new SMTPError('Failed to send email', {
              stage: 'send',
              cause: error,
            })
      this.logger.error('Failed to send email: ' + sendError.message)
      email.setSentError(sendError)
      if (this.active) {
        try {
          await this.rset()
        } catch (resetError) {
          await this.close(
            resetError instanceof Error
              ? resetError
              : new SMTPError('Failed to reset after send error', {
                  stage: 'rset',
                  cause: resetError,
                }),
          )
        }
      }
      this.emitStageObservation(
        'mail.send.failed',
        'send',
        sendStartedAt,
        'failed',
        {
          attemptId,
          ...this.failureEvent(sendError),
        },
      )
      throw sendError
    } finally {
      this.emailSending = null
    }
  }

  private canPipeline(): boolean {
    return this.pipelining === 'auto' && this.supportsPipelining
  }

  private async prepareEmail(email: Email): Promise<PreparedEmail> {
    const message = await email.getMessageDataAsync()
    const messageData = this.dkim
      ? await signDkimMessage(message, this.dkim)
      : message
    const data = Email.toSmtpData(messageData)
    return {
      email,
      data,
      size: Math.max(0, encode(data).length - encode('.\r\n').length),
    }
  }

  private async readTimeout(
    stage: SMTPStage,
    command?: string,
  ): Promise<string> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const error = new SMTPError(
      'Timeout while waiting for smtp server response',
      {
        stage,
        command,
      },
    )
    const readPromise = this.read(stage, command)
    readPromise.catch(() => undefined)

    try {
      return await Promise.race([
        readPromise,
        new Promise<string>((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true
            void this.abortConnection(error)
            reject(error)
          }, this.responseTimeoutMs)
        }),
      ])
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (timedOut) {
        this.closeError = error
      }
    }
  }

  private async read(stage: SMTPStage, command?: string): Promise<string> {
    const bufferedResponse = this.shiftResponse()
    if (bufferedResponse) {
      return bufferedResponse
    }

    while (true) {
      const { value, done } = await this.reader.read()
      if (done) {
        throw new SMTPError('SMTP server closed the connection', {
          stage,
          command,
          response: this.responseBuffer,
        })
      }
      if (!value?.length) {
        continue
      }
      const data = decode(value).toString()
      this.logger.debug('SMTP server response:\n' + redactSmtpResponse(data))
      this.responseBuffer = this.responseBuffer + data
      const response = this.shiftResponse()
      if (response) {
        return response
      }
    }
  }

  private shiftResponse(): string | undefined {
    let start = 0
    const lineBreakPattern = /\r?\n/g
    let match: RegExpExecArray | null

    while ((match = lineBreakPattern.exec(this.responseBuffer))) {
      const line = this.responseBuffer.slice(start, match.index)
      const end = match.index + match[0].length
      if (/^\d{3}(?:\s|$)/.test(line)) {
        const response = this.responseBuffer.slice(0, end)
        this.responseBuffer = this.responseBuffer.slice(end)
        return response
      }
      start = end
    }

    return undefined
  }

  private async writeLine(line: string, debugLine?: string) {
    await this.write(`${line}\r\n`, debugLine || line)
  }

  private async write(data: string, debugData = data) {
    this.logger.debug('Write to socket:\n' + redactSmtpCommand(debugData))
    await this.writer.write(encode(data))
  }

  private async openSocket() {
    this.logger.info(`Connecting to SMTP server`)
    const error = new SMTPError('Socket timeout!', { stage: 'connect' })
    const controller = new AbortController()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let timedOut = false

    try {
      const socket = await Promise.race([
        Promise.resolve(
          this.connector.connect({
            hostname: this.host,
            port: this.port,
            tls: this.secure ? 'on' : this.startTls ? 'starttls' : 'off',
            signal: controller.signal,
          }),
        ),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true
            controller.abort(error)
            reject(error)
          }, this.socketTimeoutMs)
        }),
      ])
      this.socket = socket
      this.reader = socket.readable.getReader()
      this.writer = socket.writable.getWriter()
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
      if (timedOut) {
        this.closeError = error
      }
    }
  }

  private async waitForSocketConnected() {
    const socket = this.getSocket()
    if (!socket.opened) {
      this.logger.info('SMTP server connected')
      return
    }
    const error = new SMTPError('Socket timeout!', { stage: 'connect' })
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        socket.opened,
        new Promise<void>((_, reject) => {
          timeoutId = setTimeout(() => {
            void this.abortConnection(error)
            reject(error)
          }, this.socketTimeoutMs)
        }),
      ])
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId)
      }
    }
    this.logger.info('SMTP server connected')
  }

  private async greet() {
    const startedAt = Date.now()
    try {
      const response = await this.readTimeout('greet')
      if (!response.startsWith('220')) {
        throw new SMTPError('Failed to connect to SMTP server: ' + response, {
          stage: 'greet',
          response,
        })
      }
      this.emitStageObservation(
        'smtp.greet.completed',
        'greet',
        startedAt,
        'completed',
        {
          response,
          responseCode: this.responseCode(response),
          enhancedStatusCode: this.enhancedStatusCode(response),
        },
      )
    } catch (error) {
      this.emitStageObservation(
        'smtp.greet.completed',
        'greet',
        startedAt,
        'failed',
        this.failureEvent(error),
      )
      throw error
    }
  }

  private async ehlo() {
    const startedAt = Date.now()
    const command = 'EHLO 127.0.0.1'
    try {
      await this.writeLine(command)
      const response = await this.readTimeout('ehlo', command)
      if (response.startsWith('421')) {
        throw new SMTPError(`Failed to EHLO. ${response}`, {
          stage: 'ehlo',
          command,
          response,
        })
      }
      if (!response.startsWith('2')) {
        this.emitStageObservation(
          'smtp.ehlo.completed',
          'ehlo',
          startedAt,
          'failed',
          {
            command,
            response,
            responseCode: this.responseCode(response),
            enhancedStatusCode: this.enhancedStatusCode(response),
          },
        )
        await this.helo()
        return
      }
      this.parseCapabilities(response)
      this.emitStageObservation(
        'smtp.ehlo.completed',
        'ehlo',
        startedAt,
        'completed',
        {
          command,
          response,
          responseCode: this.responseCode(response),
          enhancedStatusCode: this.enhancedStatusCode(response),
          capabilities: this.capabilityNames(),
        },
      )
    } catch (error) {
      this.emitStageObservation(
        'smtp.ehlo.completed',
        'ehlo',
        startedAt,
        'failed',
        this.failureEvent(error),
      )
      throw error
    }
  }

  private async helo() {
    const command = 'HELO 127.0.0.1'
    await this.writeLine(command)
    const response = await this.readTimeout('helo', command)
    if (response.startsWith('2')) {
      return
    }
    throw new SMTPError(`Failed to HELO. ${response}`, {
      stage: 'helo',
      command,
      response,
    })
  }

  private async tls() {
    const startedAt = Date.now()
    const command = 'STARTTLS'
    try {
      await this.writeLine(command)
      const response = await this.readTimeout('starttls', command)
      if (!response.startsWith('220')) {
        throw new SMTPError('Failed to start TLS: ' + response, {
          stage: 'starttls',
          command,
          response,
        })
      }

      this.reader.releaseLock()
      this.writer.releaseLock()
      const socket = this.getSocket()
      if (!socket.startTls) {
        throw new SMTPError('Runtime socket does not support STARTTLS', {
          stage: 'starttls',
          command,
          response,
        })
      }
      this.socket = await socket.startTls()
      this.reader = this.socket.readable.getReader()
      this.writer = this.socket.writable.getWriter()
      this.resetCapabilities()
      this.emitStageObservation(
        'smtp.starttls.completed',
        'starttls',
        startedAt,
        'completed',
        {
          command,
          response,
          responseCode: this.responseCode(response),
          enhancedStatusCode: this.enhancedStatusCode(response),
        },
      )
    } catch (error) {
      this.emitStageObservation(
        'smtp.starttls.completed',
        'starttls',
        startedAt,
        'failed',
        this.failureEvent(error),
      )
      throw error
    }
  }

  private resetCapabilities() {
    this.supportsDSN = false
    this.supportsSize = false
    this.maxMessageSize = undefined
    this.supports8BitMime = false
    this.supportsSmtpUtf8 = false
    this.supportsRequireTls = false
    this.allowAuth = false
    this.authTypeSupported = []
    this.supportsStartTls = false
    this.supportsPipelining = false
  }

  private parseCapabilities(response: string) {
    this.resetCapabilities()

    for (const line of response.split(/\r?\n/)) {
      const match = line.match(/^250[ -]([A-Z0-9][A-Z0-9-]*)(?:[ =](.*))?$/i)
      if (!match) {
        continue
      }

      const keyword = match[1].toUpperCase()
      const value = match[2]?.trim() || ''

      if (keyword === 'AUTH') {
        this.allowAuth = true
        for (const method of value.split(/\s+/)) {
          const normalized = method.toLowerCase()
          if (
            normalized === 'plain' ||
            normalized === 'login' ||
            normalized === 'cram-md5'
          ) {
            this.authTypeSupported.push(normalized)
          }
        }
      } else if (keyword === 'STARTTLS') {
        this.supportsStartTls = true
      } else if (keyword === 'DSN') {
        this.supportsDSN = true
      } else if (keyword === 'PIPELINING') {
        this.supportsPipelining = true
      } else if (keyword === 'SIZE') {
        this.supportsSize = true
        this.maxMessageSize = value ? Number(value) : undefined
      } else if (keyword === '8BITMIME') {
        this.supports8BitMime = true
      } else if (keyword === 'SMTPUTF8') {
        this.supportsSmtpUtf8 = true
      } else if (keyword === 'REQUIRETLS') {
        this.supportsRequireTls = true
      }
    }
  }

  private capabilityNames() {
    const capabilities: string[] = []
    if (this.allowAuth) {
      capabilities.push(
        this.authTypeSupported.length
          ? `AUTH ${this.authTypeSupported.join(' ').toUpperCase()}`
          : 'AUTH',
      )
    }
    if (this.supportsStartTls) {
      capabilities.push('STARTTLS')
    }
    if (this.supportsDSN) {
      capabilities.push('DSN')
    }
    if (this.supportsPipelining) {
      capabilities.push('PIPELINING')
    }
    if (this.supportsSize) {
      capabilities.push(
        this.maxMessageSize ? `SIZE ${this.maxMessageSize}` : 'SIZE',
      )
    }
    if (this.supports8BitMime) {
      capabilities.push('8BITMIME')
    }
    if (this.supportsSmtpUtf8) {
      capabilities.push('SMTPUTF8')
    }
    if (this.supportsRequireTls) {
      capabilities.push('REQUIRETLS')
    }
    return capabilities
  }

  private async auth() {
    if (!this.allowAuth) {
      return
    }
    if (!this.credentials) {
      return
    }
    const startedAt = Date.now()
    try {
      if (
        this.authTypeSupported.includes('plain') &&
        this.authType.includes('plain')
      ) {
        await this.authWithPlain()
      } else if (
        this.authTypeSupported.includes('login') &&
        this.authType.includes('login')
      ) {
        await this.authWithLogin()
      } else if (
        this.authTypeSupported.includes('cram-md5') &&
        this.authType.includes('cram-md5')
      ) {
        await this.authWithCramMD5()
      } else {
        throw new SMTPError('No supported auth method found.', {
          stage: 'auth',
        })
      }
      this.emitStageObservation(
        'smtp.auth.completed',
        'auth',
        startedAt,
        'completed',
      )
    } catch (error) {
      this.emitStageObservation(
        'smtp.auth.completed',
        'auth',
        startedAt,
        'failed',
        this.failureEvent(error),
      )
      throw error
    }
  }

  private async authWithPlain() {
    const command = `AUTH PLAIN ${btoa(
      `\u0000${this.credentials!.username}\u0000${this.credentials!.password}`,
    )}`
    await this.writeLine(command)
    const authResult = await this.readTimeout('auth', 'AUTH PLAIN')
    if (!authResult.startsWith('2')) {
      throw new SMTPError(`Failed to plain authentication: ${authResult}`, {
        stage: 'auth',
        command: 'AUTH PLAIN',
        response: authResult,
      })
    }
  }

  private async authWithLogin() {
    await this.writeLine(`AUTH LOGIN`)
    const startLoginResponse = await this.readTimeout('auth', 'AUTH LOGIN')
    if (!startLoginResponse.startsWith('3')) {
      throw new SMTPError('Invalid login: ' + startLoginResponse, {
        stage: 'auth',
        command: 'AUTH LOGIN',
        response: startLoginResponse,
      })
    }

    const usernameBase64 = btoa(this.credentials!.username)
    await this.writeLine(usernameBase64, 'AUTH LOGIN username <redacted>')
    const userResponse = await this.readTimeout('auth', 'AUTH LOGIN username')
    if (!userResponse.startsWith('3')) {
      throw new SMTPError('Failed to login authentication: ' + userResponse, {
        stage: 'auth',
        command: 'AUTH LOGIN username',
        response: userResponse,
      })
    }

    const passwordBase64 = btoa(this.credentials!.password)
    await this.writeLine(passwordBase64, 'AUTH LOGIN password <redacted>')
    const authResult = await this.readTimeout('auth', 'AUTH LOGIN password')
    if (!authResult.startsWith('2')) {
      throw new SMTPError('Failed to login authentication: ' + authResult, {
        stage: 'auth',
        command: 'AUTH LOGIN password',
        response: authResult,
      })
    }
  }

  private async authWithCramMD5() {
    const command = 'AUTH CRAM-MD5'
    await this.writeLine(command)
    const challengeResponse = await this.readTimeout('auth', command)
    const challengeWithBase64Encoded = challengeResponse
      .match(/^334\s+([^\r\n]+)/)
      ?.pop()
    if (!challengeWithBase64Encoded) {
      throw new SMTPError('Invalid CRAM-MD5 challenge: ' + challengeResponse, {
        stage: 'auth',
        command,
        response: challengeResponse,
      })
    }

    let challenge: Uint8Array
    try {
      challenge = base64ToBytes(challengeWithBase64Encoded)
    } catch (cause) {
      throw new SMTPError('Invalid CRAM-MD5 challenge encoding', {
        stage: 'auth',
        command,
        response: challengeResponse,
        cause,
      })
    }

    const challengeSolved = hmacMd5Hex(
      encode(this.credentials!.password),
      challenge,
    )

    await this.writeLine(
      btoa(`${this.credentials!.username} ${challengeSolved}`),
      'AUTH CRAM-MD5 <redacted>',
    )
    const authResult = await this.readTimeout('auth', command)
    if (!authResult.startsWith('2')) {
      throw new SMTPError('Failed to cram-md5 authentication: ' + authResult, {
        stage: 'auth',
        command,
        response: authResult,
      })
    }
  }

  private async mail(prepared: PreparedEmail) {
    const message = this.mailCommand(prepared)
    await this.writeLine(message)
    const response = await this.readTimeout('mail', message)
    if (!response.startsWith('2')) {
      throw new SMTPError(`Invalid ${message} ${response}`, {
        stage: 'mail',
        command: message,
        response,
      })
    }
  }

  private async rcpt(prepared: PreparedEmail): Promise<SmtpTransaction> {
    const transaction: SmtpTransaction = { accepted: [], rejected: [] }
    const allRecipients = this.recipients(prepared.email)
    for (let recipient of allRecipients) {
      const message = this.rcptCommand(recipient, prepared.email)
      await this.writeLine(message)
      const rcptResponse = await this.readTimeout('rcpt', message)
      if (!rcptResponse.startsWith('2')) {
        transaction.rejected.push(
          this.rejectedRecipient(recipient, rcptResponse),
        )
        throw new SMTPError(`Invalid ${message} ${rcptResponse}`, {
          stage: 'rcpt',
          command: message,
          response: rcptResponse,
        })
      }
      transaction.accepted.push(recipient)
    }
    return transaction
  }

  private async data() {
    const command = 'DATA'
    await this.writeLine(command)
    const response = await this.readTimeout('data', command)
    if (!response.startsWith('3')) {
      throw new SMTPError(`Failed to send DATA: ${response}`, {
        stage: 'data',
        command,
        response,
      })
    }
  }

  private async envelopePipelined(
    prepared: PreparedEmail,
  ): Promise<SmtpTransaction> {
    const transaction: SmtpTransaction = { accepted: [], rejected: [] }
    const mailCommand = this.mailCommand(prepared)
    const recipients = this.recipients(prepared.email)
    const recipientCommands = recipients.map(recipient =>
      this.rcptCommand(recipient, prepared.email),
    )
    const dataCommand = 'DATA'

    await this.writeLine(mailCommand)
    for (const command of recipientCommands) {
      await this.writeLine(command)
    }
    await this.writeLine(dataCommand)

    let firstError: SMTPError | undefined
    const mailResponse = await this.readTimeout('mail', mailCommand)
    if (!mailResponse.startsWith('2')) {
      firstError = new SMTPError(`Invalid ${mailCommand} ${mailResponse}`, {
        stage: 'mail',
        command: mailCommand,
        response: mailResponse,
      })
    }

    for (const [index, command] of recipientCommands.entries()) {
      const response = await this.readTimeout('rcpt', command)
      if (!response.startsWith('2')) {
        transaction.rejected.push(
          this.rejectedRecipient(recipients[index], response),
        )
        if (!firstError) {
          firstError = new SMTPError(`Invalid ${command} ${response}`, {
            stage: 'rcpt',
            command,
            response,
          })
        }
      } else if (response.startsWith('2')) {
        transaction.accepted.push(recipients[index])
      }
    }

    const dataResponse = await this.readTimeout('data', dataCommand)
    if (!dataResponse.startsWith('3') && !firstError) {
      firstError = new SMTPError(`Failed to send DATA: ${dataResponse}`, {
        stage: 'data',
        command: dataCommand,
        response: dataResponse,
      })
    }

    if (firstError) {
      throw firstError
    }

    return transaction
  }

  private async body(prepared: PreparedEmail) {
    await this.write(prepared.data, '<message body>')
    const response = await this.readTimeout('body', '<message body>')
    if (!response.startsWith('2')) {
      throw new SMTPError('Failed send email body: ' + response, {
        stage: 'body',
        command: '<message body>',
        response,
      })
    }
    return response
  }

  private createReceipt(
    prepared: PreparedEmail,
    transaction: SmtpTransaction,
    response: string,
    attemptId: string,
    durationMs: number,
  ): SmtpSendReceipt {
    const receipt: SmtpSendReceipt = {
      attemptId,
      messageId: prepared.email.headers['Message-ID'] || '',
      envelope: {
        from: this.mailFrom(prepared.email),
        to: this.recipients(prepared.email),
      },
      accepted: transaction.accepted,
      rejected: transaction.rejected,
      response,
      responseCode: this.responseCode(response),
      enhancedStatusCode: this.enhancedStatusCode(response),
      size: prepared.size,
      durationMs,
      toJSON() {
        return {
          attemptId: this.attemptId,
          messageId: this.messageId,
          envelope: this.envelope,
          accepted: this.accepted,
          rejected: this.rejected,
          response: this.response,
          responseCode: this.responseCode,
          enhancedStatusCode: this.enhancedStatusCode,
          size: this.size,
          durationMs: this.durationMs,
        }
      },
    }
    return receipt
  }

  private rejectedRecipient(
    recipient: string,
    response: string,
  ): SmtpRejectedRecipient {
    const responseCode = this.responseCode(response)
    return {
      recipient,
      response,
      responseCode,
      enhancedStatusCode: this.enhancedStatusCode(response),
      transient: responseCode
        ? responseCode >= 400 && responseCode < 500
        : false,
    }
  }

  private responseCode(response: string) {
    const match = response.match(/^(\d{3})/)
    return match ? Number(match[1]) : undefined
  }

  private enhancedStatusCode(response: string) {
    return response.match(/^\d{3}[ -]([245]\.\d{1,3}\.\d{1,3})\b/)?.at(1)
  }

  private async rset() {
    const startedAt = Date.now()
    const command = 'RSET'
    try {
      await this.writeLine(command)
      const response = await this.readTimeout('rset', command)
      if (!response.startsWith('2')) {
        throw new SMTPError(`Failed to reset: ${response}`, {
          stage: 'rset',
          command,
          response,
        })
      }
      this.emitStageObservation(
        'smtp.rset.completed',
        'rset',
        startedAt,
        'completed',
        {
          command,
          response,
          responseCode: this.responseCode(response),
          enhancedStatusCode: this.enhancedStatusCode(response),
        },
      )
    } catch (error) {
      this.emitStageObservation(
        'smtp.rset.completed',
        'rset',
        startedAt,
        'failed',
        this.failureEvent(error),
      )
      throw error
    }
  }

  private mailCommand(prepared: PreparedEmail): string {
    const email = prepared.email
    const message = [`MAIL FROM: <${this.mailFrom(email)}>`]
    const parameters = this.mailParameters(prepared)
    if (parameters.length) {
      message.push(parameters.join(' '))
    }
    return message.join(' ')
  }

  private rcptCommand(emailAddress: string, email: Email): string {
    let message = `RCPT TO: <${emailAddress}>`
    const parameters = this.rcptParameters(email)
    if (parameters.length) {
      message += ` ${parameters.join(' ')}`
    }
    return message
  }

  private recipients(email: Email) {
    return (
      email.envelope?.to || [
        ...email.to.map(user => user.email),
        ...(email.cc || []).map(user => user.email),
        ...(email.bcc || []).map(user => user.email),
      ]
    )
  }

  private mailFrom(email: Email) {
    return email.envelope?.from || email.from.email
  }

  private mailParameters(prepared: PreparedEmail) {
    const email = prepared.email
    const parameters: string[] = []
    const envelope = email.envelope

    if (this.supportsSize) {
      parameters.push(`SIZE=${envelope?.size ?? prepared.size}`)
    }

    const body = envelope?.body?.toUpperCase() as SmtpBodyType | undefined
    if (body) {
      if (!this.supports8BitMime) {
        throw new SMTPError(`${body} requires 8BITMIME support`, {
          stage: 'mail',
          command: 'MAIL FROM',
        })
      }
      parameters.push(`BODY=${body}`)
    }

    if (this.needsSmtpUtf8(email)) {
      if (!this.supportsSmtpUtf8) {
        throw new SMTPError('SMTPUTF8 is not supported by the SMTP server', {
          stage: 'mail',
          command: 'MAIL FROM',
        })
      }
      parameters.push('SMTPUTF8')
    }

    if (envelope?.requireTls) {
      if (!this.supportsRequireTls) {
        throw new SMTPError('REQUIRETLS is not supported by the SMTP server', {
          stage: 'mail',
          command: 'MAIL FROM',
        })
      }
      parameters.push('REQUIRETLS')
    }

    if (this.supportsDSN && this.hasDsnRequest(email)) {
      const ret = this.retParameter(email)
      if (ret) {
        parameters.push(ret)
      }
      const envelopeId = email.dsnOverride?.envelopeId || this.dsn?.envelopeId
      if (envelopeId) {
        parameters.push(`ENVID=${xtext(envelopeId)}`)
      }
    }

    return parameters
  }

  private rcptParameters(email: Email) {
    if (!this.supportsDSN || !this.hasDsnRequest(email)) {
      return []
    }

    const parameters = [this.notificationParameter(email)]
    const orcpt = email.dsnOverride?.ORCPT || this.dsn?.ORCPT
    if (orcpt) {
      parameters.push(`ORCPT=${xtext(normalizeOrcpt(orcpt))}`)
    }
    return parameters
  }

  private notificationParameter(email: Email) {
    if (email.dsnOverride?.NOTIFY?.NEVER || this.dsn?.NOTIFY?.NEVER) {
      return 'NOTIFY=NEVER'
    }

    const notifications: string[] = []
    if (
      (email.dsnOverride?.NOTIFY && email.dsnOverride.NOTIFY.SUCCESS) ||
      (!email.dsnOverride?.NOTIFY && this.dsn?.NOTIFY?.SUCCESS)
    ) {
      notifications.push('SUCCESS')
    }
    if (
      (email.dsnOverride?.NOTIFY && email.dsnOverride.NOTIFY.FAILURE) ||
      (!email.dsnOverride?.NOTIFY && this.dsn?.NOTIFY?.FAILURE)
    ) {
      notifications.push('FAILURE')
    }
    if (
      (email.dsnOverride?.NOTIFY && email.dsnOverride.NOTIFY.DELAY) ||
      (!email.dsnOverride?.NOTIFY && this.dsn?.NOTIFY?.DELAY)
    ) {
      notifications.push('DELAY')
    }
    return notifications.length > 0
      ? `NOTIFY=${notifications.join(',')}`
      : 'NOTIFY=NEVER'
  }

  private retParameter(email: Email) {
    if (
      (email.dsnOverride?.RET && email.dsnOverride.RET.FULL) ||
      (!email.dsnOverride?.RET && this.dsn?.RET?.FULL)
    ) {
      return 'RET=FULL'
    }
    if (
      (email.dsnOverride?.RET && email.dsnOverride.RET.HEADERS) ||
      (!email.dsnOverride?.RET && this.dsn?.RET?.HEADERS)
    ) {
      return 'RET=HDRS'
    }
    return undefined
  }

  private hasDsnRequest(email: Email) {
    return Boolean(
      email.dsnOverride?.envelopeId ||
      email.dsnOverride?.RET ||
      email.dsnOverride?.NOTIFY ||
      email.dsnOverride?.ORCPT ||
      this.dsn?.envelopeId ||
      this.dsn?.RET ||
      this.dsn?.NOTIFY ||
      this.dsn?.ORCPT,
    )
  }

  private needsSmtpUtf8(email: Email) {
    return (
      !!email.envelope?.smtpUtf8 ||
      [this.mailFrom(email), ...this.recipients(email)].some(value =>
        /[^\x00-\x7F]/.test(value),
      )
    )
  }

  protected async abortConnection(error: unknown) {
    this.active = false
    this.closeError =
      error instanceof Error
        ? error
        : new SMTPError('SMTP connection aborted', {
            stage: 'send',
            cause: error,
          })
    for (const reject of this.queuedSendRejects) {
      reject(this.closedSendError())
    }
    this.queuedSendRejects.clear()
    await this.closeSocket()
  }

  private closedSendError() {
    return new SMTPError(this.closeError?.message || 'EdgeMailer is closed', {
      stage: 'send',
      cause: this.closeError,
    })
  }

  private async closeSocket() {
    const socket = this.socket
    if (!socket) {
      return
    }
    try {
      await socket.close()
    } catch (ignore) {
      this.logger.error('Failed to close socket')
    }
  }

  private getSocket() {
    if (!this.socket) {
      throw new SMTPError('SMTP socket is not open', { stage: 'connect' })
    }
    return this.socket
  }
}
