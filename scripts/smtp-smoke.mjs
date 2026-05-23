#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const envPath = process.env.SMTP_SMOKE_ENV || 'test/env.smtp-smoke'
const workerPort = Number(process.env.SMTP_SMOKE_WORKER_PORT || 8788)
const baseUrl = `http://127.0.0.1:${workerPort}`

function parseEnv(content) {
  const env = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) {
      continue
    }
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[match[1]] = value
  }
  return env
}

function required(env, keys) {
  const missing = keys.filter(key => !env[key])
  if (missing.length) {
    throw new Error(
      `Missing required SMTP smoke env keys in ${envPath}: ${missing.join(', ')}`,
    )
  }
}

function authTypes(value) {
  if (!value) {
    return ['plain', 'login', 'cram-md5']
  }
  const values = value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
  return values.length === 1 ? values[0] : values
}

async function waitForWorker(child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early with code ${child.exitCode}`)
    }
    try {
      const response = await fetch(baseUrl)
      if (response.status === 405) {
        return
      }
    } catch (ignore) {
      // keep polling
    }
    await delay(500)
  }
  throw new Error('Timed out waiting for wrangler dev')
}

async function postSmoke(body) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch (error) {
    payload = { raw: text }
  }
  if (!response.ok || payload?.ok !== true) {
    throw new Error(
      `Smoke request failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    )
  }
  return payload
}

function scenarioConfig(env, port) {
  const username = env.SMTP_USERNAME || env.SMTP_USER
  return {
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    startTls: port === 587,
    credentials: {
      username,
      password: env.SMTP_PASSWORD,
    },
    authType: authTypes(env.SMTP_AUTH_TYPE),
    responseTimeoutMs: Number(env.SMTP_RESPONSE_TIMEOUT_MS || 30_000),
    socketTimeoutMs: Number(env.SMTP_SOCKET_TIMEOUT_MS || 30_000),
  }
}

function emailBase(env, subject) {
  const username = env.SMTP_USERNAME || env.SMTP_USER
  return {
    from: env.SMTP_FROM || username,
    to: env.SMTP_TO,
    reply: env.SMTP_REPLY_TO || env.SMTP_FROM || username,
    subject: `[edge-mailer smoke] ${subject} ${new Date().toISOString()}`,
    headers: {
      'X-Edge-Mailer-Smoke': 'true',
    },
  }
}

async function main() {
  const env = { ...process.env, ...parseEnv(await readFile(envPath, 'utf8')) }
  const username = env.SMTP_USERNAME || env.SMTP_USER
  env.SMTP_USERNAME = username
  required(env, ['SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_TO'])

  const wrangler = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--config',
      'test/wrangler.toml',
      '--ip',
      '127.0.0.1',
      '--port',
      String(workerPort),
      '--local',
      '--log-level',
      'error',
      '--show-interactive-dev-session=false',
    ],
    {
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let wranglerOutput = ''
  const capture = chunk => {
    wranglerOutput = `${wranglerOutput}${chunk.toString()}`.slice(-6000)
  }
  wrangler.stdout.on('data', capture)
  wrangler.stderr.on('data', capture)

  try {
    await waitForWorker(wrangler)

    const scenarios = [
      {
        name: '587 STARTTLS batch',
        body: {
          mode: 'batch',
          config: scenarioConfig(env, 587),
          continueOnError: true,
          emails: [
            {
              ...emailBase(env, '587 text'),
              text: 'SMTP smoke over port 587 with STARTTLS.',
            },
            {
              ...emailBase(env, '587 html'),
              text: 'SMTP smoke over port 587 with STARTTLS and HTML.',
              html: '<p>SMTP smoke over <strong>port 587</strong> with STARTTLS and HTML.</p>',
            },
          ],
        },
      },
      {
        name: '465 TLS sendMany attachment',
        body: {
          mode: 'sendMany',
          config: scenarioConfig(env, 465),
          continueOnError: true,
          emails: [
            {
              ...emailBase(env, '465 attachment'),
              text: 'SMTP smoke over port 465 with implicit TLS and a small attachment.',
              attachments: [
                {
                  filename: 'edge-mailer-smoke.txt',
                  content: Buffer.from(
                    'edge-mailer SMTP smoke attachment\n',
                    'utf8',
                  ).toString('base64'),
                  mimeType: 'text/plain',
                },
              ],
            },
          ],
        },
      },
    ]

    for (const scenario of scenarios) {
      process.stdout.write(`Running ${scenario.name}... `)
      const result = await postSmoke(scenario.body)
      if (result.results) {
        const failed = result.results.filter(
          item => item.status !== 'fulfilled',
        )
        if (failed.length) {
          throw new Error(
            `${scenario.name} had rejected sends: ${JSON.stringify(failed)}`,
          )
        }
      }
      process.stdout.write('ok\n')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    if (wranglerOutput.trim()) {
      console.error('Recent wrangler output:')
      console.error(wranglerOutput)
    }
    process.exitCode = 1
  } finally {
    wrangler.kill('SIGTERM')
    await delay(500)
    if (wrangler.exitCode === null) {
      wrangler.kill('SIGKILL')
    }
  }
}

await main()
