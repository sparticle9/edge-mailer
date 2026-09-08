import {
  mkdtemp,
  mkdir,
  copyFile,
  lstat,
  writeFile,
  rm,
} from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deploymentConfig, runtimeEnv, dotenv } from './config.mjs'

class DeploymentError extends Error {}

export const denoCLI = [
  'run',
  '--no-config',
  '--no-lock',
  '-A',
  'jsr:@deno/deploy@0.0.9904',
]
export async function verifyDeployment(
  url,
  token,
  sendTestEmail,
  request = fetch,
) {
  const origin = new URL(url)
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new DeploymentError('Deployment returned an invalid HTTPS origin')
  const health = await request(origin, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  let data
  try {
    data = await health.json()
  } catch {
    throw new DeploymentError('Deployment health returned invalid JSON')
  }
  if (!health.ok || !data.configured || !data.protected)
    throw new DeploymentError('Deployment health/configuration check failed')
  const denied = await request(origin, {
    method: 'POST',
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (denied.status !== 401)
    throw new DeploymentError('Unauthenticated POST was not rejected')
  if (sendTestEmail) {
    // One attempt only. Do not retry an ambiguous HTTP/SMTP result.
    const result = await request(origin, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(90_000),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subject: `[edge-mailer deploy test] ${crypto.randomUUID()}`,
        text: 'One explicitly requested deployment test email.',
      }),
    })
    let sent
    try {
      sent = await result.json()
    } catch {
      throw new DeploymentError(
        'Test send result unconfirmed; inspect provider logs before retrying',
      )
    }
    if (!result.ok || sent.accepted !== true)
      throw new DeploymentError(
        'Test send not confirmed; inspect provider logs before retrying',
      )
  }
}
export async function stageDenoSource(root, destination) {
  // Upload a positive allowlist, never the checkout containing local env files.
  await mkdir(join(destination, 'sample/deno-smtp'), { recursive: true })
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'src'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (listed.status !== 0)
    throw new DeploymentError('Could not enumerate tracked source files')
  for (const path of listed.stdout
    .split('\0')
    .filter(path => path.endsWith('.ts'))) {
    if (!(await lstat(join(root, path))).isFile())
      throw new DeploymentError('Source upload cannot contain symlinks')
    await mkdir(resolve(destination, path, '..'), { recursive: true })
    await copyFile(join(root, path), join(destination, path))
  }
  await copyFile(
    join(root, 'sample/http.ts'),
    join(destination, 'sample/http.ts'),
  )
  await copyFile(
    join(root, 'sample/deno-smtp/main.ts'),
    join(destination, 'sample/deno-smtp/main.ts'),
  )
  await writeFile(
    join(destination, 'deno.json'),
    JSON.stringify({
      compilerOptions: { lib: ['deno.ns', 'dom', 'dom.iterable', 'esnext'] },
    }),
  )
}
export async function deploy(
  config,
  {
    root = process.cwd(),
    run = spawnSync,
    verify = verifyDeployment,
    sendTestEmail = false,
  } = {},
) {
  const temporary = await mkdtemp(join(tmpdir(), 'edge-mailer-deploy-'))
  const env = { ...process.env }
  // The full GitHub bundle should not reach child tools or the deployed runtime.
  delete env.EDGE_MAILER_DEPLOY_CONFIG
  const execute = (label, command, args, options = {}) => {
    const result = run(command, args, {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
      maxBuffer: 4 * 1024 * 1024,
      ...options,
    })
    if (result.error || result.status !== 0)
      throw new DeploymentError(
        `${label} failed (exit ${result.status ?? 'unavailable'}). Check credentials, permissions and target configuration. Provider output is withheld to protect secrets.`,
      )
    console.log(`PASS ${label}`)
    return result.stdout
  }
  try {
    const runtime = runtimeEnv(config)
    let url
    if (config.target === 'cloudflare') {
      env.CLOUDFLARE_API_TOKEN = config.env.CLOUDFLARE_API_TOKEN
      env.CLOUDFLARE_ACCOUNT_ID = config.env.CLOUDFLARE_ACCOUNT_ID
      const file = join(temporary, 'runtime.json')
      await writeFile(file, JSON.stringify(runtime), { mode: 0o600 })
      const output = execute('Cloudflare deployment', 'pnpm', [
        'exec',
        'wrangler',
        'deploy',
        '--config',
        'sample/cloudflare-worker-smtp/wrangler.toml',
        '--name',
        config.env.CLOUDFLARE_WORKER_NAME,
        '--secrets-file',
        file,
      ])
      url = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0]
    } else {
      env.DENO_DEPLOY_TOKEN = config.env.DENO_DEPLOY_TOKEN
      const source = join(temporary, 'source')
      await stageDenoSource(root, source)
      const flags = [
        '--json',
        '--non-interactive',
        '--org',
        config.env.DENO_DEPLOY_ORG,
        '--app',
        config.env.DENO_DEPLOY_APP,
      ]
      const result = run('deno', [...denoCLI, 'apps', 'get', ...flags], {
        cwd: source,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      })
      if (result.error || ![0, 4].includes(result.status))
        throw new DeploymentError(
          'Deno app lookup failed; check token, organization and app settings',
        )
      if (result.status === 4)
        execute(
          'Deno app creation',
          'deno',
          [
            ...denoCLI,
            'create',
            ...flags,
            '--source',
            'local',
            '--runtime-mode',
            'dynamic',
            '--entrypoint',
            'sample/deno-smtp/main.ts',
            '--region',
            'global',
            '--do-not-use-detected-build-config',
            '.',
          ],
          { cwd: source },
        )
      const file = join(temporary, 'runtime.env')
      await writeFile(file, dotenv(runtime), { mode: 0o600 })
      execute(
        'Deno runtime settings',
        'deno',
        [...denoCLI, 'env', 'load', file, '--replace', ...flags],
        { cwd: source },
      )
      execute(
        'Deno deployment',
        'deno',
        [...denoCLI, ...flags, '--prod', '.'],
        { cwd: source },
      )
      const output = execute(
        'Deno app status',
        'deno',
        [...denoCLI, 'apps', 'get', ...flags],
        { cwd: source },
      )
      try {
        url = JSON.parse(output).productionUrl
      } catch {
        throw new DeploymentError('Deno returned invalid app status')
      }
    }
    if (!url)
      throw new DeploymentError(
        'Deployment completed but no public URL was returned; inspect the provider dashboard',
      )
    await verify(url, runtime.SAMPLE_SEND_TOKEN, sendTestEmail)
    console.log(`PASS deployed health and unauthenticated rejection: ${url}`)
    console.log(
      sendTestEmail
        ? 'PASS one SMTP test accepted; mailbox receipt not checked'
        : 'SMTP test not requested; no email sent',
    )
    return url
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
export async function main() {
  const target = process.argv[2]
  let input
  try {
    input = JSON.parse(process.env.EDGE_MAILER_DEPLOY_CONFIG || '')
  } catch {
    throw new DeploymentError(
      'Missing or invalid deployment bundle; run deploy:setup first',
    )
  }
  if (input.version !== 1 || input.target !== target)
    throw new DeploymentError('Deployment bundle target/version mismatch')
  const config = deploymentConfig(target, input.env)
  await deploy(config, {
    sendTestEmail: process.env.SEND_TEST_EMAIL === 'true',
  })
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(error => {
    console.error(
      error instanceof DeploymentError
        ? error.message
        : 'Deployment or verification could not complete; inspect the last completed step and provider dashboard.',
    )
    console.error(
      'No automatic send retry was performed. Raw provider errors are withheld to protect credentials.',
    )
    process.exitCode = 1
  })
}
