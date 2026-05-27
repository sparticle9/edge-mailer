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
check(
  packageJson.files?.includes('llms.txt'),
  'package.json files must include llms.txt',
)
check(
  packageJson.files?.includes('.agents/skills/edge-mailer/SKILL.md'),
  'package.json files must include .agents/skills/edge-mailer/SKILL.md',
)
check(
  !packageJson.files?.some(
    entry => entry === 'sample' || entry.startsWith('sample/'),
  ),
  'package.json files must not include sample/; samples are repo-only',
)
check(
  !packageJson.files?.some(
    entry => entry === 'test' || entry.startsWith('test/'),
  ),
  'package.json files must not include test/; tests are repo-only',
)
check(
  jsrJson.publish?.include?.includes('llms.txt'),
  'jsr.json publish.include must include llms.txt',
)
check(
  jsrJson.publish?.include?.includes('.agents/skills/edge-mailer/SKILL.md'),
  'jsr.json publish.include must include .agents/skills/edge-mailer/SKILL.md',
)
check(
  !jsrJson.publish?.include?.some(
    entry => entry === 'sample' || entry.startsWith('sample/'),
  ),
  'jsr.json publish.include must not include sample/; samples are repo-only',
)
check(
  !jsrJson.publish?.include?.some(
    entry => entry === 'test' || entry.startsWith('test/'),
  ),
  'jsr.json publish.include must not include test/; tests are repo-only',
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
