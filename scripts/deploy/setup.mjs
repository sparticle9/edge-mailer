import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { parseArgs, parseEnv } from 'node:util'
import { pathToFileURL } from 'node:url'
import { deploymentConfig, secretNames } from './config.mjs'

export function uploadConfig(config, repo, command = 'gh', run = spawnSync) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error('Use --repo OWNER/REPO')
  if (!['gh', 'ghx'].includes(command))
    throw new Error('--gh must be gh or ghx')
  const encoded = JSON.stringify(config)
  if (Buffer.byteLength(encoded) > 40_000)
    throw new Error('Deployment bundle exceeds 40 KB')
  const result = run(
    command,
    ['secret', 'set', secretNames[config.target], '--repo', repo],
    {
      input: encoded,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  )
  if (result.error || result.status !== 0)
    throw new Error(
      'GitHub secret upload failed. Check CLI login and access to the selected repository; no provider deployment was started.',
    )
}
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'env-file': { type: 'string' },
      repo: { type: 'string' },
      apply: { type: 'boolean', default: false },
      gh: { type: 'string', default: 'gh' },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help) {
    console.log(
      'pnpm deploy:setup <cloudflare|deno> --env-file .env.deploy.<target> --repo OWNER/REPO [--apply] [--gh ghx]',
    )
    return
  }
  if (
    positionals.length !== 1 ||
    !values['env-file'] ||
    !values.repo ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo)
  )
    throw new Error(
      'Specify one target, --env-file PATH and --repo OWNER/REPO. Use --help for usage.',
    )
  let text
  try {
    text = await readFile(values['env-file'], 'utf8')
  } catch {
    throw new Error('Cannot read the explicitly selected env file')
  }
  let env
  try {
    env = parseEnv(text)
  } catch {
    throw new Error('Invalid dotenv file; values were not uploaded')
  }
  const config = deploymentConfig(positionals[0], env)
  console.log(
    `Validated ${config.target} bundle for ${values.repo}; only allowlisted settings are included. Values are hidden.`,
  )
  if (values.apply) {
    uploadConfig(config, values.repo, values.gh)
    console.log(
      `Updated ${secretNames[config.target]}. Run the Deploy ${config.target} sample workflow when ready.`,
    )
  } else
    console.log(
      'Check only. Add --apply to upload the bundle; no secrets or deployment state changed.',
    )
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
