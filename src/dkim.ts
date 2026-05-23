import { encode } from './utils.ts'

export type DkimConfig = {
  domainName: string
  keySelector: string
  privateKey: string
  headerFieldNames?: string[]
}

type ParsedHeader = {
  name: string
  value: string
}

const DEFAULT_DKIM_HEADERS = [
  'from',
  'to',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'content-type',
]

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

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array | ArrayBuffer) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (let index = 0; index < value.length; index += 0x8000) {
    binary += String.fromCharCode(...value.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

function cryptoBytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encode(value))
}

function derLength(length: number) {
  if (length < 0x80) {
    return new Uint8Array([length])
  }

  const bytes: number[] = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes])
}

function der(tag: number, value: Uint8Array) {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value)
}

function wrapPkcs1RsaPrivateKey(pkcs1Der: Uint8Array) {
  const version = new Uint8Array([0x02, 0x01, 0x00])
  const rsaEncryptionOid = new Uint8Array([
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  ])
  const nullParams = new Uint8Array([0x05, 0x00])
  const algorithm = der(0x30, concatBytes(rsaEncryptionOid, nullParams))
  const privateKey = der(0x04, pkcs1Der)
  return der(0x30, concatBytes(version, algorithm, privateKey))
}

function privateKeyDerFromPem(pem: string) {
  const match = pem.match(
    /-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY)-----([\s\S]+?)-----END \1-----/,
  )
  if (!match) {
    throw new Error('DKIM privateKey must be a PEM private key')
  }

  const label = match[1]
  const derBytes = base64ToBytes(match[2].replace(/\s+/g, ''))
  if (label === 'PRIVATE KEY') {
    return derBytes
  }
  if (label === 'RSA PRIVATE KEY') {
    return wrapPkcs1RsaPrivateKey(derBytes)
  }
  throw new Error(`Unsupported DKIM private key type: ${label}`)
}

function normalizeLineEndings(value: string) {
  return value.replace(/\r?\n/g, '\r\n')
}

function parseHeaders(headerSection: string): ParsedHeader[] {
  const headers: ParsedHeader[] = []
  for (const line of normalizeLineEndings(headerSection).split('\r\n')) {
    if (/^[ \t]/.test(line) && headers.length) {
      const last = headers[headers.length - 1]
      last.value += `\r\n${line}`
      continue
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex < 1) {
      continue
    }
    headers.push({
      name: line.slice(0, separatorIndex),
      value: line.slice(separatorIndex + 1),
    })
  }
  return headers
}

function relaxedHeader(header: ParsedHeader) {
  const name = header.name.trim().toLowerCase()
  const value = header.value
    .replace(/\r\n[ \t]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
  return `${name}:${value}`
}

function relaxedBody(body: string) {
  const lines = normalizeLineEndings(body)
    .split('\r\n')
    .map(line => line.replace(/[ \t]+$/g, '').replace(/[ \t]+/g, ' '))

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines.length ? `${lines.join('\r\n')}\r\n` : '\r\n'
}

function selectedHeaders(headers: ParsedHeader[], configured?: string[]) {
  const selectedNames =
    configured && configured.length
      ? configured.map(name => name.toLowerCase())
      : DEFAULT_DKIM_HEADERS
  const used = new Set<number>()
  const selected: ParsedHeader[] = []

  for (const name of selectedNames) {
    for (let index = headers.length - 1; index >= 0; index--) {
      if (used.has(index)) {
        continue
      }
      if (headers[index].name.trim().toLowerCase() === name) {
        used.add(index)
        selected.push(headers[index])
        break
      }
    }
  }

  return selected
}

export function validateDkimConfig(dkim: DkimConfig | undefined) {
  if (!dkim) {
    return
  }
  if (!dkim.domainName?.trim()) {
    throw new Error('DKIM domainName is required')
  }
  if (!dkim.keySelector?.trim()) {
    throw new Error('DKIM keySelector is required')
  }
  if (!dkim.privateKey?.trim()) {
    throw new Error('DKIM privateKey is required')
  }
  for (const value of [dkim.domainName, dkim.keySelector]) {
    if (/[\r\n;]/.test(value)) {
      throw new Error('DKIM domainName and keySelector must be header safe')
    }
  }
}

export async function signDkimMessage(
  message: string,
  dkim: DkimConfig,
): Promise<string> {
  validateDkimConfig(dkim)
  const splitIndex = message.indexOf('\r\n\r\n')
  if (splitIndex < 0) {
    throw new Error('Unable to DKIM sign message without headers and body')
  }

  const rawHeaderSection = message.slice(0, splitIndex)
  const rawBodySection = message.slice(splitIndex + 4)
  const headers = parseHeaders(rawHeaderSection)
  const signedHeaders = selectedHeaders(headers, dkim.headerFieldNames)
  if (!signedHeaders.some(header => header.name.toLowerCase() === 'from')) {
    throw new Error('DKIM signing requires a From header')
  }

  const canonicalizedBody = relaxedBody(rawBodySection)
  const bodyHash = await crypto.subtle.digest(
    'SHA-256',
    cryptoBytes(canonicalizedBody),
  )
  const signedHeaderNames = signedHeaders.map(header =>
    header.name.trim().toLowerCase(),
  )
  const dkimHeaderValue =
    `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${dkim.domainName}; ` +
    `s=${dkim.keySelector}; h=${signedHeaderNames.join(':')}; ` +
    `bh=${bytesToBase64(bodyHash)}; b=`
  const signingPayload = [
    ...signedHeaders.map(relaxedHeader),
    `dkim-signature:${dkimHeaderValue}`,
  ].join('\r\n')

  const key = await crypto.subtle.importKey(
    'pkcs8',
    privateKeyDerFromPem(dkim.privateKey),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    cryptoBytes(signingPayload),
  )

  return `DKIM-Signature: ${dkimHeaderValue}${bytesToBase64(signature)}\r\n${message}`
}
