import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export function smokeDsnEnabled(env = process.env) {
  return /^(1|true|yes|capture|request)$/i.test(env.SMTP_SMOKE_DSN || '')
}

export function createSmokeDsnCapture(runtime, env = process.env) {
  if (!smokeDsnEnabled(env)) {
    return undefined
  }

  const generatedAt = new Date().toISOString()
  const safeTimestamp = generatedAt.replace(/[:.]/g, '-')
  const outputPath = resolve(
    env.SMTP_SMOKE_DSN_OUTPUT ||
      `smoke-artifacts/dsn-${runtime}-${safeTimestamp}.json`,
  )

  return {
    version: 1,
    runtime,
    generatedAt,
    outputPath,
    requests: [],
  }
}

export function createSmokeDsnRequest(capture, label, index = 0) {
  if (!capture) {
    return {}
  }

  const normalizedLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const envelopeId = [
    'edge-mailer',
    capture.runtime,
    capture.generatedAt.replace(/[^0-9A-Za-z]+/g, ''),
    normalizedLabel,
    String(index + 1),
  ].join('-')

  capture.requests.push({
    label,
    envelopeId,
    requested: {
      RET: 'HDRS',
      NOTIFY: ['SUCCESS', 'FAILURE', 'DELAY'],
    },
  })

  return {
    dsnOverride: {
      envelopeId,
      RET: { HEADERS: true },
      NOTIFY: { SUCCESS: true, FAILURE: true, DELAY: true },
    },
    headers: {
      'X-Edge-Mailer-DSN-ENVID': envelopeId,
    },
  }
}

export function mergeSmokeHeaders(email, dsnRequest) {
  if (!dsnRequest.headers) {
    return email
  }
  return {
    ...email,
    dsnOverride: dsnRequest.dsnOverride,
    headers: {
      ...email.headers,
      ...dsnRequest.headers,
    },
  }
}

export function applySmokeDsnResult(request, result) {
  if (!request) {
    return
  }
  request.subject =
    result?.subject || result?.receipt?.subject || request.subject
  const receipt = result?.receipt || result
  request.messageId = receipt?.messageId
  request.accepted = Array.isArray(receipt?.accepted)
    ? receipt.accepted
    : Array.isArray(receipt?.recipients)
      ? receipt.recipients
      : receipt?.accepted === true
        ? ['<accepted>']
        : receipt?.accepted
  request.rejected = receipt?.rejected
  request.responseCode = receipt?.responseCode
  request.attemptId = receipt?.attemptId
  request.durationMs = receipt?.durationMs
}

export function applySmokeDsnObservation(capture, observation) {
  if (!capture || !observation) {
    return
  }

  const events = Array.isArray(observation.events) ? observation.events : []
  const ehloEvents = events.filter(
    event => event.type === 'smtp.ehlo.completed',
  )
  const capabilities = new Set()
  for (const event of ehloEvents) {
    for (const capability of event.capabilities || []) {
      capabilities.add(capability)
    }
  }

  const existingCapabilities = new Set(capture.observation?.capabilities || [])
  for (const capability of capabilities) {
    existingCapabilities.add(capability)
  }

  capture.observation = {
    eventCount: (capture.observation?.eventCount || 0) + events.length,
    dsnAdvertised:
      Boolean(capture.observation?.dsnAdvertised) || capabilities.has('DSN'),
    capabilities: [...existingCapabilities].sort(),
  }
}

export async function writeSmokeDsnCapture(capture) {
  if (!capture) {
    return
  }
  await mkdir(dirname(capture.outputPath), { recursive: true })
  await writeFile(capture.outputPath, `${JSON.stringify(capture, null, 2)}\n`)
  console.log(`DSN smoke capture written to ${capture.outputPath}`)
}
