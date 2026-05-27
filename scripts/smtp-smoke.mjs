#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  applySmokeDsnObservation,
  applySmokeDsnResult,
  createSmokeDsnCapture,
  createSmokeDsnRequest,
  mergeSmokeHeaders,
  writeSmokeDsnCapture,
} from './smoke-dsn.mjs'

const workerPort = Number(process.env.SMTP_SMOKE_WORKER_PORT || 8788)
const baseUrl = `http://127.0.0.1:${workerPort}`

function required(env, keys) {
  const missing = keys.filter(key => !env[key])
  if (missing.length) {
    throw new Error(
      `Missing required SMTP smoke environment keys: ${missing.join(', ')}`,
    )
  }
}

function authTypes(value) {
  if (!value) {
    return undefined
  }
  const values = value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
  return values.length === 1 ? values[0] : values
}

function authTypeValues(value) {
  const types = authTypes(value)
  if (!types) {
    return []
  }
  return Array.isArray(types) ? types : [types]
}

function smtpCredentials(env) {
  const username = env.SMTP_USERNAME || env.SMTP_USER
  const requestedAuthTypes = authTypeValues(env.SMTP_AUTH_TYPE)
  const useXOAuth2 =
    requestedAuthTypes.includes('xoauth2') ||
    (!env.SMTP_PASSWORD && Boolean(env.SMTP_XOAUTH2_ACCESS_TOKEN))

  if (useXOAuth2) {
    if (!env.SMTP_XOAUTH2_ACCESS_TOKEN) {
      throw new Error(
        'Missing required SMTP smoke environment key: SMTP_XOAUTH2_ACCESS_TOKEN',
      )
    }
    return {
      username,
      accessToken: env.SMTP_XOAUTH2_ACCESS_TOKEN,
    }
  }

  if (!env.SMTP_PASSWORD) {
    throw new Error(
      'Missing required SMTP smoke environment key: SMTP_PASSWORD',
    )
  }
  return {
    username,
    password: env.SMTP_PASSWORD,
  }
}

async function waitForWorker(child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early with code ${child.exitCode}`)
    }
    try {
      const response = await fetch(baseUrl, {
        headers: { connection: 'close' },
      })
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
    headers: { connection: 'close', 'content-type': 'application/json' },
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
  return {
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    startTls: port === 587,
    credentials: smtpCredentials(env),
    authType: authTypes(env.SMTP_AUTH_TYPE),
    responseTimeoutMs: Number(env.SMTP_RESPONSE_TIMEOUT_MS || 30_000),
    socketTimeoutMs: Number(env.SMTP_SOCKET_TIMEOUT_MS || 30_000),
  }
}

function emailBase(env, subject) {
  const username = env.SMTP_USERNAME || env.SMTP_USER
  return {
    from: env.SMTP_FROM || username,
    to: env.SMTP_TO || env.TEST_RECIPIENT_EMAIL,
    reply: env.SMTP_REPLY_TO || env.SMTP_FROM || username,
    subject: `[edge-mailer smoke] ${subject} ${new Date().toISOString()}`,
    headers: {
      'X-Edge-Mailer-Smoke': 'true',
    },
  }
}

async function stopWorker(child) {
  const closePromise = new Promise(resolve => {
    child.once('close', resolve)
  })

  if (child.exitCode === null) {
    child.kill('SIGTERM')
    const stopped = await Promise.race([
      closePromise.then(() => true),
      delay(2_000).then(() => false),
    ])
    if (!stopped && child.exitCode === null) {
      child.kill('SIGKILL')
      await Promise.race([closePromise, delay(1_000)])
    }
  }

  child.stdout?.removeAllListeners('data')
  child.stderr?.removeAllListeners('data')
  child.stdout?.destroy()
  child.stderr?.destroy()
}

async function main() {
  const env = { ...process.env }
  const dsnCapture = createSmokeDsnCapture('cloudflare-local', env)
  const username = env.SMTP_USERNAME || env.SMTP_USER
  env.SMTP_USERNAME = username
  required(env, ['SMTP_HOST', 'SMTP_USERNAME'])
  smtpCredentials(env)
  if (!env.SMTP_TO && !env.TEST_RECIPIENT_EMAIL) {
    throw new Error(
      'Missing required SMTP smoke environment keys: SMTP_TO or TEST_RECIPIENT_EMAIL',
    )
  }

  const wrangler = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--config',
      'test/cloudflare-worker/wrangler.toml',
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

    const emailWithDsn = (label, index, email) => {
      const dsnRequest = createSmokeDsnRequest(dsnCapture, label, index)
      return mergeSmokeHeaders(email, dsnRequest)
    }

    const scenarios = [
      {
        name: '587 STARTTLS batch',
        body: {
          mode: 'batch',
          config: scenarioConfig(env, 587),
          continueOnError: true,
          captureObservation: Boolean(dsnCapture),
          emails: [
            emailWithDsn('587 text', 0, {
              ...emailBase(env, '587 text'),
              text: 'SMTP smoke over port 587 with STARTTLS.',
            }),
            emailWithDsn('587 html', 1, {
              ...emailBase(env, '587 html'),
              text: 'SMTP smoke over port 587 with STARTTLS and HTML.',
              html: '<p>SMTP smoke over <strong>port 587</strong> with STARTTLS and HTML.</p>',
            }),
          ],
        },
      },
      {
        name: '465 TLS sendMany attachment',
        body: {
          mode: 'sendMany',
          config: scenarioConfig(env, 465),
          continueOnError: true,
          captureObservation: Boolean(dsnCapture),
          emails: [
            emailWithDsn('465 attachment', 2, {
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
            }),
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
        if (dsnCapture) {
          result.results.forEach((item, index) => {
            if (item.status === 'fulfilled') {
              const captureIndex =
                scenario.name === '465 TLS sendMany attachment'
                  ? 2 + index
                  : index
              applySmokeDsnResult(dsnCapture.requests[captureIndex], item)
            }
          })
        }
      } else if (dsnCapture) {
        applySmokeDsnResult(dsnCapture.requests[0], result)
      }
      applySmokeDsnObservation(dsnCapture, result.observation)
      process.stdout.write('ok\n')
    }
    await writeSmokeDsnCapture(dsnCapture)
  } catch (error) {
    if (dsnCapture) {
      dsnCapture.error = error instanceof Error ? error.message : String(error)
      await writeSmokeDsnCapture(dsnCapture)
    }
    console.error(error instanceof Error ? error.message : String(error))
    if (wranglerOutput.trim()) {
      console.error('Recent wrangler output:')
      console.error(wranglerOutput)
    }
    process.exitCode = 1
  } finally {
    await stopWorker(wrangler)
  }
}

await main()
