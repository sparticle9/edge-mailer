import {
  DenoMailer,
  LogLevel,
  type AuthType,
  type EdgeMailerOptions,
  type EmailOptions,
} from 'edge-mailer/deno'

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
  logLevel: LogLevel.NONE,
  responseTimeoutMs: Number(env('SMTP_RESPONSE_TIMEOUT_MS') || 30_000),
  socketTimeoutMs: Number(env('SMTP_SOCKET_TIMEOUT_MS') || 30_000),
}

const from = env('SMTP_FROM') || username
const email: EmailOptions = {
  from,
  to: required('SMTP_TO'),
  reply: env('SMTP_REPLY_TO') || from,
  subject: `[edge-mailer smoke] Deno ${new Date().toISOString()}`,
  text: 'SMTP smoke from edge-mailer through the Deno runtime.',
  headers: {
    'X-Edge-Mailer-Smoke': 'deno',
  },
}

await DenoMailer.send(config, email)
console.log('Deno SMTP smoke sent')
