#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  applySmokeDsnObservation,
  applySmokeDsnResult,
  createSmokeDsnCapture,
  createSmokeDsnRequest,
  mergeSmokeHeaders,
  writeSmokeDsnCapture,
} from '../../scripts/smoke-dsn.mjs'

const sampleDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(sampleDir, '../..')
const port = Number(process.env.CLOUDFLARE_SAMPLE_PORT || 8787)
const baseUrl = `http://127.0.0.1:${port}`

function env(name) {
  return process.env[name]
}

function required(name) {
  const value = env(name)
  if (!value) {
    throw new Error(`Missing ${name}`)
  }
  return value
}

function collectVars() {
  const username = env('SMTP_USERNAME') || env('SMTP_USER')
  if (!username) {
    throw new Error('Missing SMTP_USERNAME or SMTP_USER')
  }

  const values = {
    SMTP_HOST: required('SMTP_HOST'),
    SMTP_PORT: env('SMTP_PORT'),
    SMTP_USERNAME: username,
    SMTP_PASSWORD: required('SMTP_PASSWORD'),
    SMTP_FROM: env('SMTP_FROM'),
    SMTP_TO: env('SMTP_TO'),
    TEST_RECIPIENT_EMAIL: env('TEST_RECIPIENT_EMAIL'),
    SMTP_REPLY_TO: env('SMTP_REPLY_TO'),
    SMTP_AUTH_TYPE: env('SMTP_AUTH_TYPE'),
    DKIM_DOMAIN: env('DKIM_DOMAIN'),
    DKIM_SELECTOR: env('DKIM_SELECTOR'),
    DKIM_PRIVATE_KEY: env('DKIM_PRIVATE_KEY'),
    SMTP_POOL_MAX_CONNECTIONS: env('SMTP_POOL_MAX_CONNECTIONS'),
    SMTP_POOL_MAX_MESSAGES_PER_CONNECTION: env(
      'SMTP_POOL_MAX_MESSAGES_PER_CONNECTION',
    ),
    SMTP_POOL_IDLE_TIMEOUT_MS: env('SMTP_POOL_IDLE_TIMEOUT_MS'),
  }

  if (!values.SMTP_TO && !values.TEST_RECIPIENT_EMAIL) {
    throw new Error('Missing SMTP_TO or TEST_RECIPIENT_EMAIL')
  }

  return Object.entries(values).filter(([, value]) => value)
}

function redact(text, vars) {
  let redacted = text
  for (const [, value] of vars) {
    if (value && value.length > 2) {
      redacted = redacted.split(value).join('[redacted]')
    }
  }
  return redacted
}

async function waitForWorker(child) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early with code ${child.exitCode}`)
    }
    try {
      const response = await fetch(baseUrl)
      if (response.ok) {
        const payload = await response.json()
        if (payload.configured) {
          return
        }
        throw new Error('Worker env bindings are not configured')
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Worker env bindings are not configured'
      ) {
        throw error
      }
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
  } catch {
    payload = { raw: text }
  }
  if (!response.ok || payload?.ok !== true || payload?.accepted !== true) {
    throw new Error(
      `Smoke request failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    )
  }
  return payload
}

async function main() {
  const vars = collectVars()
  const dsnCapture = createSmokeDsnCapture('cloudflare-sample', process.env)
  const wranglerArgs = [
    'exec',
    'wrangler',
    'dev',
    '--config',
    'sample/cloudflare-worker-smtp/wrangler.toml',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--local',
    '--log-level',
    'error',
    '--show-interactive-dev-session=false',
  ]
  for (const [key, value] of vars) {
    wranglerArgs.push('--var', `${key}:${value}`)
  }

  const wrangler = spawn('pnpm', wranglerArgs, {
    cwd: repoRoot,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let wranglerOutput = ''
  const capture = chunk => {
    wranglerOutput = `${wranglerOutput}${chunk.toString()}`.slice(-6000)
  }
  wrangler.stdout.on('data', capture)
  wrangler.stderr.on('data', capture)

  try {
    await waitForWorker(wrangler)
    const dsnRequest = createSmokeDsnRequest(dsnCapture, 'cloudflare sample')
    const result = await postSmoke(
      mergeSmokeHeaders(
        {
          captureObservation: Boolean(dsnCapture),
        },
        dsnRequest,
      ),
    )
    if (dsnCapture) {
      applySmokeDsnResult(dsnCapture.requests[0], result)
      applySmokeDsnObservation(dsnCapture, result.observation)
      await writeSmokeDsnCapture(dsnCapture)
    }
    console.log(
      `Cloudflare Worker SMTP smoke accepted by SMTP server: ${result.subject} ${result.messageId}`,
    )
  } catch (error) {
    if (dsnCapture) {
      dsnCapture.error = error instanceof Error ? error.message : String(error)
      await writeSmokeDsnCapture(dsnCapture)
    }
    console.error(error instanceof Error ? error.message : String(error))
    if (wranglerOutput.trim()) {
      console.error('Recent wrangler output:')
      console.error(redact(wranglerOutput, vars))
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
