import {
  DenoMailer,
  LogLevel,
  type AuthType,
  type DkimConfig,
  type EdgeMailerOptions,
  type EmailOptions,
  type MailObservationEvent,
} from '../../src/deno.ts'

function env(name: string): string | undefined {
  return Deno.env.get(name)
}

function required(name: string): string {
  const value = env(name)
  if (!value) {
    throw new Error(`Missing ${name}`)
  }
  return value
}

function recipient(): string {
  return env('SMTP_TO') || required('TEST_RECIPIENT_EMAIL')
}

function authTypes(value: string | undefined): EdgeMailerOptions['authType'] {
  if (!value) {
    return ['plain', 'login', 'cram-md5']
  }
  const values = value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean) as AuthType[]
  return values.length === 1 ? values[0] : values
}

function smokeDsnEnabled(): boolean {
  return /^(1|true|yes|capture|request)$/i.test(env('SMTP_SMOKE_DSN') || '')
}

type DsnCapture = {
  version: 1
  runtime: string
  generatedAt: string
  outputPath: string
  requests: Array<{
    label: string
    envelopeId: string
    requested: {
      RET: 'HDRS'
      NOTIFY: string[]
    }
    subject?: string
    messageId?: string
    accepted?: string[]
    rejected?: unknown[]
    responseCode?: number
    attemptId?: string
    durationMs?: number
  }>
  observation?: {
    eventCount: number
    dsnAdvertised: boolean
    capabilities: string[]
  }
  error?: string
}

function createSmokeDsnCapture(): DsnCapture | undefined {
  if (!smokeDsnEnabled()) {
    return undefined
  }
  const generatedAt = new Date().toISOString()
  const safeTimestamp = generatedAt.replace(/[:.]/g, '-')
  return {
    version: 1,
    runtime: 'deno-local',
    generatedAt,
    outputPath:
      env('SMTP_SMOKE_DSN_OUTPUT') ||
      `../../smoke-artifacts/dsn-deno-local-${safeTimestamp}.json`,
    requests: [],
  }
}

function addDsnRequest(
  capture: DsnCapture | undefined,
  email: EmailOptions,
): EmailOptions {
  if (!capture) {
    return email
  }

  const envelopeId = [
    'edge-mailer',
    capture.runtime,
    capture.generatedAt.replace(/[^0-9A-Za-z]+/g, ''),
    'deno-smoke',
    '1',
  ].join('-')

  capture.requests.push({
    label: 'deno smoke',
    envelopeId,
    requested: {
      RET: 'HDRS',
      NOTIFY: ['SUCCESS', 'FAILURE', 'DELAY'],
    },
  })

  return {
    ...email,
    dsnOverride: {
      envelopeId,
      RET: { HEADERS: true },
      NOTIFY: { SUCCESS: true, FAILURE: true, DELAY: true },
    },
    headers: {
      ...email.headers,
      'X-Edge-Mailer-DSN-ENVID': envelopeId,
    },
  }
}

async function writeDsnCapture(capture: DsnCapture | undefined) {
  if (!capture) {
    return
  }
  const directory = capture.outputPath.replace(/[/\\][^/\\]+$/, '')
  if (directory && directory !== capture.outputPath) {
    await Deno.mkdir(directory, { recursive: true })
  }
  await Deno.writeTextFile(
    capture.outputPath,
    `${JSON.stringify(capture, null, 2)}\n`,
  )
  console.log(`DSN smoke capture written to ${capture.outputPath}`)
}

function dkimConfig(): DkimConfig | undefined {
  const domainName = env('DKIM_DOMAIN')
  const keySelector = env('DKIM_SELECTOR')
  const privateKey = env('DKIM_PRIVATE_KEY')?.replace(/\\n/g, '\n')
  if (!domainName && !keySelector && !privateKey) {
    return undefined
  }
  if (!domainName || !keySelector || !privateKey) {
    throw new Error('Missing DKIM_DOMAIN, DKIM_SELECTOR, or DKIM_PRIVATE_KEY')
  }
  return { domainName, keySelector, privateKey }
}

const username = env('SMTP_USERNAME') || env('SMTP_USER')
if (!username) {
  throw new Error('Missing SMTP_USERNAME')
}

const dsnCapture = createSmokeDsnCapture()
const observationEvents: MailObservationEvent[] = []
const port = Number(env('SMTP_PORT') || 587)
const config: EdgeMailerOptions = {
  host: required('SMTP_HOST'),
  port,
  secure: port === 465,
  startTls: port !== 465,
  credentials: {
    username,
    password: required('SMTP_PASSWORD'),
  },
  authType: authTypes(env('SMTP_AUTH_TYPE')),
  dkim: dkimConfig(),
  pool: {
    maxConnections: Number(env('SMTP_POOL_MAX_CONNECTIONS') || 1),
    maxMessagesPerConnection: Number(
      env('SMTP_POOL_MAX_MESSAGES_PER_CONNECTION') || 20,
    ),
    idleTimeoutMs: Number(env('SMTP_POOL_IDLE_TIMEOUT_MS') || 1_000),
  },
  logLevel: LogLevel.NONE,
  responseTimeoutMs: Number(env('SMTP_RESPONSE_TIMEOUT_MS') || 30_000),
  socketTimeoutMs: Number(env('SMTP_SOCKET_TIMEOUT_MS') || 30_000),
  observation: dsnCapture
    ? {
        mode: 'summary',
        onEvent(event) {
          observationEvents.push(event)
        },
      }
    : undefined,
}

const from = env('SMTP_FROM') || username
const marker = `deno-${new Date().toISOString()}`
const email: EmailOptions = addDsnRequest(dsnCapture, {
  from,
  to: recipient(),
  reply: env('SMTP_REPLY_TO') || from,
  subject: `[edge-mailer smoke] ${marker}`,
  text: `SMTP smoke from edge-mailer through the Deno runtime.\n\nMarker: ${marker}`,
  html: `<p>SMTP smoke from edge-mailer through the Deno runtime.</p><p>Marker: ${marker}</p>`,
  headers: {
    'X-Edge-Mailer-Smoke': marker,
  },
  attachments: [
    {
      filename: 'edge-mailer-smoke.txt',
      content: new TextEncoder().encode(
        `Deno smoke attachment\nMarker: ${marker}\n`,
      ),
      mimeType: 'text/plain',
    },
  ],
})

const pool = DenoMailer.createPool(config)
try {
  const receipt = await pool.send(email)
  if (dsnCapture) {
    dsnCapture.requests[0].subject = email.subject
    dsnCapture.requests[0].messageId = receipt.messageId
    dsnCapture.requests[0].accepted = receipt.accepted
    dsnCapture.requests[0].rejected = receipt.rejected
    dsnCapture.requests[0].responseCode = receipt.responseCode
    dsnCapture.requests[0].attemptId = receipt.attemptId
    dsnCapture.requests[0].durationMs = receipt.durationMs

    const capabilities = new Set<string>()
    for (const event of observationEvents) {
      if (event.type === 'smtp.ehlo.completed') {
        for (const capability of event.capabilities || []) {
          capabilities.add(capability)
        }
      }
    }
    dsnCapture.observation = {
      eventCount: observationEvents.length,
      dsnAdvertised: capabilities.has('DSN'),
      capabilities: [...capabilities].sort(),
    }
    await writeDsnCapture(dsnCapture)
  }
  console.log(
    `Deno SMTP smoke accepted by SMTP server: ${marker} ${receipt.messageId}`,
  )
} catch (error) {
  if (dsnCapture) {
    dsnCapture.error = error instanceof Error ? error.message : String(error)
    await writeDsnCapture(dsnCapture)
  }
  throw error
} finally {
  await pool.close()
}
