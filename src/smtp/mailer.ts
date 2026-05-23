import { decode, encode } from '../utils.ts'
import { Email, type EmailOptions } from '../email.ts'
import Logger, { LogLevel } from '../logger.ts'
import type { EdgeSocket, EdgeSocketConnector } from '../runtime/socket.ts'

export type AuthType = 'plain' | 'login' | 'cram-md5'
const DEFAULT_AUTH_TYPES: AuthType[] = ['plain', 'login', 'cram-md5']

export type Credentials = {
  username: string
  password: string
}
export type BatchSendOptions = {
  continueOnError?: boolean
}
export type BatchSendResult = PromiseSettledResult<void>[]
export type PipeliningMode = 'auto' | false
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

export type SMTPErrorOptions = {
  stage: SMTPStage
  command?: string
  response?: string
  cause?: unknown
}

export class SMTPError extends Error {
  public readonly stage: SMTPStage
  public readonly command?: string
  public readonly response?: string
  public readonly responseCode?: number
  public readonly transient: boolean
  public override readonly cause?: unknown

  constructor(message: string, options: SMTPErrorOptions) {
    super(message)
    this.name = 'SMTPError'
    this.stage = options.stage
    this.command = options.command
    this.response = options.response
    this.cause = options.cause

    const match = options.response?.match(/^(\d{3})/)
    this.responseCode = match ? Number(match[1]) : undefined
    this.transient = this.responseCode
      ? this.responseCode >= 400 && this.responseCode < 500
      : false
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

export type EdgeMailerOptions = {
  host: string
  port: number
  secure?: boolean
  startTls?: boolean
  credentials?: Credentials
  authType?: AuthType | AuthType[]
  logLevel?: LogLevel
  pipelining?: PipeliningMode
  dsn?:
    | {
        RET?:
          | {
              HEADERS?: boolean
              FULL?: boolean
            }
          | undefined
        NOTIFY?:
          | {
              DELAY?: boolean
              FAILURE?: boolean
              SUCCESS?: boolean
            }
          | undefined
      }
    | undefined
  socketTimeoutMs?: number
  responseTimeoutMs?: number
}

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

  private readonly dsn:
    | {
        envelopeId?: string | undefined
        RET?:
          | {
              HEADERS?: boolean
              FULL?: boolean
            }
          | undefined
        NOTIFY?:
          | {
              DELAY?: boolean
              FAILURE?: boolean
              SUCCESS?: boolean
            }
          | undefined
      }
    | undefined

  private active = false
  private closeError?: Error
  private sendChain: Promise<void> = Promise.resolve()
  private emailSending: Email | null = null
  private queuedSendRejects = new Set<(reason?: unknown) => void>()

  /** SMTP server capabilities **/
  private supportsDSN = false
  private allowAuth = false
  private authTypeSupported: AuthType[] = []
  private supportsStartTls = false
  private supportsPipelining = false

  protected constructor(
    options: EdgeMailerOptions,
    private readonly connector: EdgeSocketConnector,
    runtimeName = 'SmtpMailer',
  ) {
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

    this.socketTimeoutMs = options.socketTimeoutMs || 60_000
    this.responseTimeoutMs = options.responseTimeoutMs || 30_000

    this.logger = new Logger(
      options.logLevel,
      `[${runtimeName}:${this.host}:${this.port}]`,
    )
  }

  public send(options: EmailOptions): Promise<void> {
    const email = new Email(options)
    email.sent.catch(() => undefined)
    let rejectQueued!: (reason?: unknown) => void
    let cancelled = false
    const task = new Promise<void>((resolve, reject) => {
      rejectQueued = reason => {
        cancelled = true
        reject(reason)
      }
      this.queuedSendRejects.add(rejectQueued)
      const run = this.sendChain.then(async () => {
        this.queuedSendRejects.delete(rejectQueued)
        if (cancelled) {
          return
        }
        if (!this.active) {
          throw this.closedSendError()
        }
        await this.sendEmail(email)
      })
      run.then(resolve, reject)
    })

    this.sendChain = task.catch(() => undefined)
    return task
  }

  public async sendMany(
    emails: EmailOptions[],
    options: BatchSendOptions = {},
  ): Promise<BatchSendResult> {
    const results: BatchSendResult = []
    for (const email of emails) {
      try {
        await this.send(email)
        results.push({ status: 'fulfilled', value: undefined })
      } catch (reason) {
        if (!options.continueOnError) {
          throw reason
        }
        results.push({ status: 'rejected', reason })
      }
    }
    return results
  }

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

  protected async initializeSmtpSession() {
    await this.openSocket()
    await this.waitForSocketConnected()
    await this.greet()
    await this.ehlo()

    if (this.startTls && !this.secure && this.supportsStartTls) {
      await this.tls()
      await this.ehlo()
    }

    await this.auth()
    this.active = true
  }

  private async sendEmail(email: Email) {
    this.emailSending = email
    try {
      if (this.canPipeline()) {
        await this.envelopePipelined(email)
      } else {
        await this.mail(email)
        await this.rcpt(email)
        await this.data()
      }
      await this.body(email)
      email.setSent()
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
      throw sendError
    } finally {
      this.emailSending = null
    }
  }

  private canPipeline(): boolean {
    return this.pipelining === 'auto' && this.supportsPipelining
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
      this.logger.debug('SMTP server response:\n' + data)
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

  private async writeLine(line: string) {
    await this.write(`${line}\r\n`)
  }

  private async write(data: string) {
    this.logger.debug('Write to socket:\n' + data)
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
    const response = await this.readTimeout('greet')
    if (!response.startsWith('220')) {
      throw new SMTPError('Failed to connect to SMTP server: ' + response, {
        stage: 'greet',
        response,
      })
    }
  }

  private async ehlo() {
    const command = 'EHLO 127.0.0.1'
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
      await this.helo()
      return
    }
    this.parseCapabilities(response)
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
    const command = 'STARTTLS'
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
  }

  private resetCapabilities() {
    this.supportsDSN = false
    this.allowAuth = false
    this.authTypeSupported = []
    this.supportsStartTls = false
    this.supportsPipelining = false
  }

  private parseCapabilities(response: string) {
    this.resetCapabilities()
    if (/[ -]AUTH\b/i.test(response)) {
      this.allowAuth = true
    }
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)PLAIN/i.test(response)) {
      this.authTypeSupported.push('plain')
    }
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)LOGIN/i.test(response)) {
      this.authTypeSupported.push('login')
    }
    if (/[ -]AUTH(?:(\s+|=)[^\n]*\s+|\s+|=)CRAM-MD5/i.test(response)) {
      this.authTypeSupported.push('cram-md5')
    }
    if (/[ -]STARTTLS\b/i.test(response)) {
      this.supportsStartTls = true
    }
    if (/[ -]DSN\b/i.test(response)) {
      this.supportsDSN = true
    }
    if (/[ -]PIPELINING\b/i.test(response)) {
      this.supportsPipelining = true
    }
  }

  private async auth() {
    if (!this.allowAuth) {
      return
    }
    if (!this.credentials) {
      throw new SMTPError(
        'smtp server requires authentication, but no credentials found',
        { stage: 'auth' },
      )
    }
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
      throw new SMTPError('No supported auth method found.', { stage: 'auth' })
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
    await this.writeLine(usernameBase64)
    const userResponse = await this.readTimeout('auth', 'AUTH LOGIN username')
    if (!userResponse.startsWith('3')) {
      throw new SMTPError('Failed to login authentication: ' + userResponse, {
        stage: 'auth',
        command: 'AUTH LOGIN username',
        response: userResponse,
      })
    }

    const passwordBase64 = btoa(this.credentials!.password)
    await this.writeLine(passwordBase64)
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

  private async mail(email: Email) {
    const message = this.mailCommand(email)
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

  private async rcpt(email: Email) {
    const allRecipients = this.recipients(email)
    for (let user of allRecipients) {
      const message = this.rcptCommand(user.email, email)
      await this.writeLine(message)
      const rcptResponse = await this.readTimeout('rcpt', message)
      if (!rcptResponse.startsWith('2')) {
        throw new SMTPError(`Invalid ${message} ${rcptResponse}`, {
          stage: 'rcpt',
          command: message,
          response: rcptResponse,
        })
      }
    }
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

  private async envelopePipelined(email: Email) {
    const mailCommand = this.mailCommand(email)
    const recipientCommands = this.recipients(email).map(user =>
      this.rcptCommand(user.email, email),
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

    for (const command of recipientCommands) {
      const response = await this.readTimeout('rcpt', command)
      if (!response.startsWith('2') && !firstError) {
        firstError = new SMTPError(`Invalid ${command} ${response}`, {
          stage: 'rcpt',
          command,
          response,
        })
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
  }

  private async body(email: Email) {
    await this.write(email.getEmailData())
    const response = await this.readTimeout('body', '<message body>')
    if (!response.startsWith('2')) {
      throw new SMTPError('Failed send email body: ' + response, {
        stage: 'body',
        command: '<message body>',
        response,
      })
    }
  }

  private async rset() {
    const command = 'RSET'
    await this.writeLine(command)
    const response = await this.readTimeout('rset', command)
    if (!response.startsWith('2')) {
      throw new SMTPError(`Failed to reset: ${response}`, {
        stage: 'rset',
        command,
        response,
      })
    }
  }

  private mailCommand(email: Email): string {
    let message = `MAIL FROM: <${email.from.email}>`
    if (this.supportsDSN) {
      message += ` ${this.retBuilder(email)}`
      if (email.dsnOverride?.envelopeId) {
        message += ` ENVID=${email.dsnOverride.envelopeId}`
      }
    }
    return message.trim()
  }

  private rcptCommand(emailAddress: string, email: Email): string {
    let message = `RCPT TO: <${emailAddress}>`
    if (this.supportsDSN) {
      message += this.notificationBuilder(email)
    }
    return message
  }

  private recipients(email: Email) {
    return [...email.to, ...(email.cc || []), ...(email.bcc || [])]
  }

  private notificationBuilder(email: Email) {
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
      ? ` NOTIFY=${notifications.join(',')}`
      : ' NOTIFY=NEVER'
  }

  private retBuilder(email: Email) {
    const ret: string[] = []
    if (
      (email.dsnOverride?.RET && email.dsnOverride.RET.HEADERS) ||
      (!email.dsnOverride?.RET && this.dsn?.RET?.HEADERS)
    ) {
      ret.push('HDRS')
    }
    if (
      (email.dsnOverride?.RET && email.dsnOverride.RET.FULL) ||
      (!email.dsnOverride?.RET && this.dsn?.RET?.FULL)
    ) {
      ret.push('FULL')
    }
    return ret.length > 0 ? `RET=${ret.join(',')}` : ''
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
