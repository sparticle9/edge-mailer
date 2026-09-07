import { execFileSync } from 'node:child_process'

const [archive] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }),
)
const docs = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'CLIENT-INTEGRATION.md',
  'llms.txt',
  'USE-CASES.md',
  'SECURITY.md',
  '.agents/skills/edge-mailer/SKILL.md',
])
const unexpected = archive.files.filter(
  ({ path }) =>
    !docs.has(path) &&
    !/^dist\/[A-Za-z0-9_-]+\.(?:js|mjs|d\.ts|d\.mts)$/.test(path),
)
if (unexpected.length) {
  throw new Error(
    `Unexpected package files: ${unexpected.map(file => file.path).join(', ')}`,
  )
}
for (const path of [
  ...docs,
  'dist/index.mjs',
  'dist/cloudflare.mjs',
  'dist/deno.mjs',
]) {
  if (!archive.files.some(file => file.path === path))
    throw new Error(`Missing package file: ${path}`)
}
console.log(
  `Package contents OK: ${archive.files.length} files, ${archive.size} bytes packed`,
)
