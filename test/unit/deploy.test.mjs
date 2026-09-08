import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  readdir,
  stat,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parseEnv } from 'node:util'
import {
  deploymentConfig,
  runtimeEnv,
  dotenv,
} from '../../scripts/deploy/config.mjs'
import { uploadConfig } from '../../scripts/deploy/setup.mjs'
import {
  deploy,
  verifyDeployment,
  stageDenoSource,
} from '../../scripts/deploy/run.mjs'

const root = process.cwd()
const common = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_USERNAME: 'sender@example.com',
  SMTP_PASSWORD: 'fixture-not-a-real-password',
  TEST_RECIPIENT_EMAIL: 'recipient@example.com',
  SAMPLE_SEND_TOKEN: 'fixture-send-token-00000000000000000',
}
const cf = () =>
  deploymentConfig('cloudflare', {
    ...common,
    CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'fixture-cloudflare-token',
    CLOUDFLARE_WORKER_NAME: 'edge-mailer-test',
  })
const deno = () =>
  deploymentConfig('deno', {
    ...common,
    DENO_ACCESS_TOKEN: 'fixture-deno-token',
    DENO_DEPLOY_ORG: 'example-org',
    DENO_DEPLOY_APP: 'edge-mailer-test',
  })
const success = stdout => ({ status: 0, stdout: stdout || '', stderr: '' })

test('normalizes existing aliases and excludes unrelated env values and provider credentials from runtime', () => {
  const config = deploymentConfig('deno', {
    ...common,
    DENO_ACCESS_TOKEN: 'fixture',
    DENO_DEPLOY_ORG: 'org',
    DENO_DEPLOY_APP: 'app',
    GH_TOKEN: 'must-not-upload',
    UNRELATED_PASSWORD: 'must-not-upload',
  })
  assert.equal(config.env.SMTP_TO, 'recipient@example.com')
  assert.equal(config.env.DENO_DEPLOY_TOKEN, 'fixture')
  assert.equal(config.env.GH_TOKEN, undefined)
  assert.equal(config.env.UNRELATED_PASSWORD, undefined)
  assert.equal(runtimeEnv(config).DENO_DEPLOY_TOKEN, undefined)
  assert.equal(config.env.SMTP_TLS_POLICY, 'require-starttls')
})

test('rejects missing values, short authorization tokens and unsafe settings without disclosing values', () => {
  for (const changes of [
    { SMTP_PASSWORD: '' },
    { SAMPLE_SEND_TOKEN: 'short' },
    { SMTP_PORT: '25' },
    { SMTP_HOST: 'bad\nsecret' },
    { SMTP_POOL_MAX_CONNECTIONS: 'NaN' },
    { DKIM_DOMAIN: 'example.com' },
  ]) {
    assert.throws(() =>
      deploymentConfig('cloudflare', { ...cf().env, ...changes }),
    )
  }
  assert.throws(() => deploymentConfig('unknown', {}), /Target/)
  assert.throws(() => deploymentConfig('deno', []), /env object/)
})

test('makes OAuth selection explicit and prevents stale-password fallback on the runtime', () => {
  const config = deploymentConfig('cloudflare', {
    ...cf().env,
    SMTP_AUTH_TYPE: 'xoauth2',
    SMTP_XOAUTH2_ACCESS_TOKEN: 'fixture-oauth',
  })
  assert.equal(config.env.SMTP_AUTH_TYPE, 'xoauth2')
  assert.equal(config.env.SMTP_PASSWORD, undefined)
  assert.throws(
    () =>
      deploymentConfig('cloudflare', {
        ...cf().env,
        SMTP_PASSWORD: '',
        SMTP_AUTH_TYPE: 'plain',
        SMTP_XOAUTH2_ACCESS_TOKEN: 'fixture-oauth',
      }),
    /SMTP_PASSWORD/,
  )
  assert.throws(
    () =>
      deploymentConfig('cloudflare', {
        ...config.env,
        SMTP_XOAUTH2_ACCESS_TOKEN: '',
      }),
    /SMTP_XOAUTH2_ACCESS_TOKEN/,
  )
})

test('GitHub upload uses an explicit repo and stdin, never credential-bearing arguments', () => {
  const config = cf()
  uploadConfig(config, 'example/repo', 'ghx', (command, args, options) => {
    assert.equal(command, 'ghx')
    assert.deepEqual(args, [
      'secret',
      'set',
      'EDGE_MAILER_CLOUDFLARE_DEPLOY',
      '--repo',
      'example/repo',
    ])
    assert.deepEqual(JSON.parse(options.input), config)
    assert(!args.join(' ').includes(common.SMTP_PASSWORD))
    return success()
  })
  assert.throws(() => uploadConfig(config, '-bad', 'gh'), /OWNER/)
  assert.throws(() => uploadConfig(config, 'example/repo', 'sh'), /--gh/)
})

test('GitHub upload failures suppress raw CLI output containing secrets', () => {
  assert.throws(
    () =>
      uploadConfig(cf(), 'example/repo', 'gh', () => ({
        status: 1,
        stderr: common.SMTP_PASSWORD,
      })),
    error =>
      !error.message.includes(common.SMTP_PASSWORD) &&
      /upload failed/.test(error.message),
  )
})

test('setup defaults to validation only, reads only the chosen file and does not evaluate shell expansions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'edge-mailer-setup-test-'))
  try {
    const file = join(dir, '.env.deploy.cloudflare')
    await writeFile(
      file,
      Object.entries(cf().env)
        .map(([k, v]) => `${k}='${v}'`)
        .join('\n') + '\nUNRELATED_SECRET=$(do-not-execute)\n',
    )
    const result = spawnSync(
      process.execPath,
      [
        'scripts/deploy/setup.mjs',
        'cloudflare',
        '--env-file',
        file,
        '--repo',
        'example/repo',
      ],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Check only/)
    assert(!result.stdout.includes(common.SMTP_PASSWORD))
    assert(!result.stdout.includes('do-not-execute'))
    assert.equal(
      parseEnv("PASSWORD='$(do-not-execute)'").PASSWORD,
      '$(do-not-execute)',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Cloudflare handoff creates a private runtime-only file and removes it after success', async () => {
  let runtimeFile
  const config = cf()
  const url = await deploy(config, {
    run(command, args, options) {
      assert.equal(command, 'pnpm')
      runtimeFile = args.at(-1)
      assert.equal(
        options.env.CLOUDFLARE_API_TOKEN,
        config.env.CLOUDFLARE_API_TOKEN,
      )
      assert.equal(options.env.EDGE_MAILER_DEPLOY_CONFIG, undefined)
      assert(!args.join(' ').includes(config.env.CLOUDFLARE_API_TOKEN))
      return success('Deployed https://edge-mailer-test.example.workers.dev')
    },
    async verify(url, token, send) {
      assert.equal(url, 'https://edge-mailer-test.example.workers.dev')
      assert.equal(token, common.SAMPLE_SEND_TOKEN)
      assert.equal(send, false)
      assert.deepEqual(
        JSON.parse(await readFile(runtimeFile, 'utf8')),
        runtimeEnv(config),
      )
      assert.equal((await stat(runtimeFile)).mode & 0o777, 0o600)
    },
  })
  assert.match(url, /workers.dev/)
  await assert.rejects(readFile(runtimeFile), { code: 'ENOENT' })
})

test('temporary secrets are also removed on provider failure and raw output is withheld', async () => {
  let file
  await assert.rejects(
    deploy(cf(), {
      run(_command, args) {
        file = args.at(-1)
        return { status: 1, stderr: common.SMTP_PASSWORD }
      },
    }),
    error =>
      /Cloudflare deployment failed/.test(error.message) &&
      !error.message.includes(common.SMTP_PASSWORD),
  )
  await assert.rejects(readFile(file), { code: 'ENOENT' })
})

test('Deno uploads only tracked library source and the runnable sample, without repo/env metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'edge-mailer-stage-test-'))
  try {
    await stageDenoSource(root, dir)
    assert.deepEqual((await readdir(dir)).sort(), [
      'deno.json',
      'sample',
      'src',
    ])
    assert.deepEqual((await readdir(join(dir, 'sample'))).sort(), [
      'deno-smtp',
      'http.ts',
    ])
    assert.deepEqual(await readdir(join(dir, 'sample/deno-smtp')), ['main.ts'])
    const files = await readdir(dir, { recursive: true })
    assert(!files.some(path => /(^|\/)\.env|\.git|node_modules/.test(path)))
    const check = spawnSync(
      'deno',
      [
        'check',
        '--no-lock',
        '--config',
        join(dir, 'deno.json'),
        join(dir, 'sample/deno-smtp/main.ts'),
      ],
      { encoding: 'utf8' },
    )
    assert.equal(check.status, 0, check.stderr)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Deno creates a missing app, loads env, deploys, and checks its returned URL', async () => {
  const calls = []
  await deploy(deno(), {
    run(command, args, options) {
      assert.equal(command, 'deno')
      assert(args.includes('jsr:@deno/deploy@0.0.9904'))
      assert.equal(options.env.DENO_DEPLOY_TOKEN, 'fixture-deno-token')
      assert(!args.includes('fixture-deno-token'))
      calls.push(args)
      if (calls.length === 1) return { status: 4, stderr: 'not found' }
      return success(
        JSON.stringify({
          productionUrl: 'https://edge-mailer-test.example-org.deno.net',
        }),
      )
    },
    verify: async () => {},
  })
  assert.equal(calls.length, 5)
  assert(calls[1].includes('create'))
  assert(calls[2].includes('load'))
  assert(calls[3].includes('--prod'))
})

test('Deno reuses an existing app and never treats auth/network errors as missing apps', async () => {
  const calls = []
  await deploy(deno(), {
    run(_command, args) {
      calls.push(args)
      return success(
        JSON.stringify({ productionUrl: 'https://app.example.deno.net' }),
      )
    },
    verify: async () => {},
  })
  assert(!calls.some(args => args.includes('create')))
  for (const status of [3, 6]) {
    let count = 0
    await assert.rejects(
      deploy(deno(), {
        run() {
          count++
          return { status, stderr: common.SMTP_PASSWORD }
        },
      }),
      /lookup failed/,
    )
    assert.equal(count, 1)
  }
})

test('dotenv serialization preserves quotes, dollar signs, backslashes and multiline key material', async () => {
  const values = {
    PASSWORD: 'quote " and \' $HOME \\ end',
    DKIM_PRIVATE_KEY: 'line 1\nline 2\n',
  }
  const result = spawnSync(
    'deno',
    [
      'eval',
      '--no-config',
      '--no-lock',
      'import { parse } from "jsr:@std/dotenv@0.225.7/parse"; const input = await new Response(Deno.stdin.readable).text(); console.log(JSON.stringify(parse(input)));',
    ],
    { input: dotenv(values), encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), values)
})

test('default verification performs no authorized send; explicit opt-in sends once', async () => {
  for (const send of [false, true]) {
    const requests = []
    await verifyDeployment(
      'https://app.example.com',
      common.SAMPLE_SEND_TOKEN,
      send,
      async (_url, options) => {
        requests.push(options)
        if (!options.method)
          return Response.json({ configured: true, protected: true })
        if (!options.headers) return new Response('', { status: 401 })
        return Response.json({ accepted: true })
      },
    )
    assert.equal(requests.length, send ? 3 : 2)
    if (send)
      assert.equal(
        requests[2].headers.Authorization,
        `Bearer ${common.SAMPLE_SEND_TOKEN}`,
      )
  }
})

test('verification rejects unprotected endpoints, redirects and ambiguous sends without retry', async () => {
  await assert.rejects(
    verifyDeployment('http://app.example.com', 'token', false),
    /HTTPS/,
  )
  let count = 0
  await assert.rejects(
    verifyDeployment(
      'https://app.example.com',
      'token',
      true,
      async (_url, options) => {
        count++
        assert.equal(options.redirect, 'error')
        if (count === 1)
          return Response.json({ configured: true, protected: true })
        if (count === 2) return new Response('', { status: 401 })
        throw new Error('lost HTTP response')
      },
    ),
    /lost HTTP/,
  )
  assert.equal(count, 3)
  await assert.rejects(
    verifyDeployment('https://app.example.com', 'token', false, async () =>
      Response.json({ configured: true, protected: false }),
    ),
    /configuration/,
  )
})
