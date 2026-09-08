export const secretNames = {
  cloudflare: 'EDGE_MAILER_CLOUDFLARE_DEPLOY',
  deno: 'EDGE_MAILER_DENO_DEPLOY',
}
export const runtimeKeys = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USERNAME',
  'SMTP_PASSWORD',
  'SMTP_XOAUTH2_ACCESS_TOKEN',
  'SMTP_FROM',
  'SMTP_TO',
  'SMTP_REPLY_TO',
  'SMTP_AUTH_TYPE',
  'SMTP_TLS_POLICY',
  'SAMPLE_SEND_TOKEN',
  'SMTP_POOL_MAX_CONNECTIONS',
  'SMTP_POOL_MAX_MESSAGES_PER_CONNECTION',
  'SMTP_POOL_IDLE_TIMEOUT_MS',
  'SMTP_RESPONSE_TIMEOUT_MS',
  'SMTP_SOCKET_TIMEOUT_MS',
  'DKIM_DOMAIN',
  'DKIM_SELECTOR',
  'DKIM_PRIVATE_KEY',
]
const deployKeys = {
  cloudflare: [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_WORKER_NAME',
  ],
  deno: ['DENO_DEPLOY_TOKEN', 'DENO_DEPLOY_ORG', 'DENO_DEPLOY_APP'],
}
function requireValue(env, key) {
  if (!env[key]?.trim()) throw new Error(`Missing ${key}`)
}
export function deploymentConfig(target, input) {
  if (!Object.hasOwn(secretNames, target))
    throw new Error('Target must be cloudflare or deno')
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Expected an env object')
  const allowed = [...runtimeKeys, ...deployKeys[target]]
  const source = {
    ...input,
    SMTP_USERNAME: input.SMTP_USERNAME || input.SMTP_USER,
    SMTP_TO: input.SMTP_TO || input.TEST_RECIPIENT_EMAIL,
    DENO_DEPLOY_TOKEN: input.DENO_DEPLOY_TOKEN || input.DENO_ACCESS_TOKEN,
  }
  const env = Object.fromEntries(
    allowed
      .filter(key => source[key] !== undefined && source[key] !== '')
      .map(key => [key, source[key]]),
  )
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value !== 'string' ||
      Buffer.byteLength(value) > 16_384 ||
      /\0/.test(value) ||
      (key !== 'DKIM_PRIVATE_KEY' && /[\r\n]/.test(value))
    )
      throw new Error(`Invalid ${key}`)
  }
  for (const key of [
    ...deployKeys[target],
    'SMTP_HOST',
    'SMTP_USERNAME',
    'SMTP_TO',
    'SAMPLE_SEND_TOKEN',
  ])
    requireValue(env, key)
  if (env.SAMPLE_SEND_TOKEN.length < 32)
    throw new Error('SAMPLE_SEND_TOKEN must contain at least 32 characters')
  for (const value of [
    env.SMTP_TO,
    env.SMTP_FROM || env.SMTP_USERNAME,
    env.SMTP_REPLY_TO,
  ].filter(Boolean)) {
    if (!/^[^\s<>@,;:]+@[^\s<>@,;:]+\.[^\s<>@,;:]+$/.test(value))
      throw new Error(
        'Use single bare addresses for SMTP_FROM, SMTP_TO and SMTP_REPLY_TO',
      )
  }
  env.SMTP_PORT ||= '587'
  if (!['465', '587', '2525'].includes(env.SMTP_PORT))
    throw new Error('SMTP_PORT must be 465, 587 or 2525')
  const auth = env.SMTP_AUTH_TYPE?.split(',').map(value =>
    value.trim().toLowerCase(),
  )
  if (
    auth?.some(
      value => !['plain', 'login', 'cram-md5', 'xoauth2'].includes(value),
    )
  )
    throw new Error('Invalid SMTP_AUTH_TYPE')
  const oauth = auth
    ? auth.includes('xoauth2')
    : !env.SMTP_PASSWORD && Boolean(env.SMTP_XOAUTH2_ACCESS_TOKEN)
  requireValue(env, oauth ? 'SMTP_XOAUTH2_ACCESS_TOKEN' : 'SMTP_PASSWORD')
  if (oauth && auth && auth.length !== 1)
    throw new Error('Use xoauth2 alone or password authentication types')
  env.SMTP_AUTH_TYPE = oauth ? 'xoauth2' : auth?.join(',') || 'plain,login'
  // Always make the active authentication mechanism explicit, including after rotations.
  delete env[oauth ? 'SMTP_PASSWORD' : 'SMTP_XOAUTH2_ACCESS_TOKEN']
  env.SMTP_TLS_POLICY =
    env.SMTP_PORT === '465' ? 'require-tls' : 'require-starttls'
  for (const key of [
    'SMTP_POOL_MAX_CONNECTIONS',
    'SMTP_POOL_MAX_MESSAGES_PER_CONNECTION',
    'SMTP_POOL_IDLE_TIMEOUT_MS',
    'SMTP_RESPONSE_TIMEOUT_MS',
    'SMTP_SOCKET_TIMEOUT_MS',
  ]) {
    if (
      env[key] !== undefined &&
      (!/^\d+$/.test(env[key]) ||
        !Number.isSafeInteger(Number(env[key])) ||
        Number(env[key]) < 1)
    )
      throw new Error(`Invalid ${key}`)
  }
  if (
    ['DKIM_DOMAIN', 'DKIM_SELECTOR', 'DKIM_PRIVATE_KEY'].some(key => env[key])
  ) {
    for (const key of ['DKIM_DOMAIN', 'DKIM_SELECTOR', 'DKIM_PRIVATE_KEY'])
      requireValue(env, key)
  }
  for (const key of target === 'cloudflare'
    ? ['CLOUDFLARE_WORKER_NAME']
    : ['DENO_DEPLOY_ORG', 'DENO_DEPLOY_APP']) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(env[key]))
      throw new Error(`Invalid ${key}; use a lowercase slug`)
  }
  if (
    target === 'cloudflare' &&
    !/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID)
  )
    throw new Error('Invalid CLOUDFLARE_ACCOUNT_ID')
  return { version: 1, target, env }
}
export function runtimeEnv(config) {
  return Object.fromEntries(
    runtimeKeys
      .filter(key => config.env[key] !== undefined)
      .map(key => [key, config.env[key]]),
  )
}
export function dotenv(env) {
  // Deno's dotenv parser interprets quoted escapes without expanding $variables.
  return (
    Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n') + '\n'
  )
}
