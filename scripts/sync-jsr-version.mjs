import { readFileSync, writeFileSync } from 'node:fs'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const jsrJsonPath = 'jsr.json'
const jsrJson = JSON.parse(readFileSync(jsrJsonPath, 'utf8'))

if (jsrJson.version === packageJson.version) {
  console.log(`jsr.json already at ${jsrJson.version}`)
  process.exit(0)
}

jsrJson.version = packageJson.version
writeFileSync(jsrJsonPath, `${JSON.stringify(jsrJson, null, 2)}\n`)
console.log(`Synced jsr.json to ${jsrJson.version}`)
