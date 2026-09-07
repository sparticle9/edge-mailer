/** Missing sample tokens never authorize a request. */
export function isSampleAuthorized(
  request: Request,
  token: string | undefined,
): boolean {
  if (!token) return false
  const bearer = request.headers
    .get('authorization')
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
  return (
    bearer === token || request.headers.get('x-sample-send-token') === token
  )
}

/** Samples accept small transactional messages, with a bounded JSON body. */
export async function readSampleBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader()
  if (!reader) return {}
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1_048_576) {
        await reader.cancel()
        throw new Error('Request body exceeds 1 MiB')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  const body = text ? JSON.parse(text) : {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Expected a JSON object')
  }
  return body
}
