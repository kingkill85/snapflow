// Builds the frontend for the end-to-end run into e2e/.dist, unless the build
// there was made from the same inputs: everything vite reads (sources, public
// files, index.html, configs, the lock file) is hashed, and the hash is kept
// next to the build. E2E_REBUILD=1 builds anyway.
// Run from frontend/: `node e2e/build-frontend.ts`.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const outDir = 'e2e/.dist'
const stamp = join(outDir, '.inputs-sha256')
const inputs = ['src', 'public', 'index.html', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']

function files(path: string): string[] {
  if (!existsSync(path)) return []
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path)
    .sort()
    .flatMap((name) => files(join(path, name)))
}

const hash = createHash('sha256')
for (const file of inputs.flatMap(files)) {
  hash.update(relative('.', file)).update('\0').update(readFileSync(file)).update('\0')
}
const digest = hash.digest('hex')

const built = existsSync(stamp) && readFileSync(stamp, 'utf8') === digest
if (built && process.env.E2E_REBUILD !== '1') {
  console.log('e2e: frontend build is up to date')
} else {
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], { stdio: 'inherit' })
  writeFileSync(stamp, digest)
}
