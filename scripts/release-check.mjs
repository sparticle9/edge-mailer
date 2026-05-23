import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const jsrJson = JSON.parse(readFileSync('jsr.json', 'utf8'))

const errors = []
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function check(condition, message) {
  if (!condition) {
    errors.push(message)
  }
}

const packageVersion = packageJson.version
const expectedTag = `v${packageVersion}`
const releaseTag =
  process.argv[2] ||
  process.env.RELEASE_TAG ||
  (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : '')

check(
  packageJson.name === 'edge-mailer',
  'package.json name must be edge-mailer',
)
check(!packageJson.private, 'package.json must not be private for release')
check(
  typeof packageVersion === 'string' && semverPattern.test(packageVersion),
  `package.json version must be valid SemVer, got ${String(packageVersion)}`,
)
check(
  jsrJson.name === '@sparticle9/edge-mailer',
  'jsr.json name must be @sparticle9/edge-mailer',
)
check(
  jsrJson.version === packageVersion,
  `jsr.json version ${jsrJson.version} must match package.json ${packageVersion}`,
)
check(
  packageJson.publishConfig?.access === 'public',
  'package.json publishConfig.access must be public',
)

if (releaseTag) {
  check(
    releaseTag === expectedTag,
    `release tag ${releaseTag} must match package version tag ${expectedTag}`,
  )
}

if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join('\n'))
  process.exit(1)
}

console.log(
  `Release metadata OK: edge-mailer@${packageVersion}, @sparticle9/edge-mailer@${jsrJson.version}, ${expectedTag}`,
)
