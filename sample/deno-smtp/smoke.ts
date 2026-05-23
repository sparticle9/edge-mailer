import {
  DenoMailer,
  LogLevel,
  type AuthType,
  type DkimConfig,
  type EdgeMailerOptions,
  type EmailOptions,
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
}

const from = env('SMTP_FROM') || username
const marker = `deno-${new Date().toISOString()}`
const email: EmailOptions = {
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
}

const pool = DenoMailer.createPool(config)
try {
  const receipt = await pool.send(email)
  console.log(
    `Deno SMTP smoke accepted by SMTP server: ${marker} ${receipt.messageId}`,
  )
} finally {
  await pool.close()
}
