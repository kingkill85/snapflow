import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'

import { defineConfig, devices } from '@playwright/test'

import { admin, adminStorageState, backendBinary, backendPort, backendURL, databaseURL, distributorName, frontendPort, frontendURL, storageDir } from './env'

// Run with `make e2e`, which recreates the database first. Servers are always
// started fresh (against the e2e database) unless E2E_REUSE_SERVERS=1 is set,
// e.g. while writing specs with the servers running in another terminal.
const reuse = process.env.E2E_REUSE_SERVERS === '1'

// The default run leaves out the layout matrix (every page at several widths,
// light and dark, English and German, tagged @visual); `make e2e-visual`
// (E2E_VISUAL=1) runs the whole layout spec and the import's visual spec
// instead, with screenshots.
const visual = process.env.E2E_VISUAL === '1'

// Specs only share the server; each seeds its own uniquely named data. A CI
// runner (4 vCPUs) also runs the backend, Postgres and vite: with 4 workers the
// longest spec ran past its timeout there, so CI uses 2 per shard.
const workers = process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : process.env.CI ? 2 : Math.max(2, Math.floor(availableParallelism() / 2))

// The Nix shell provides the browsers of nixpkgs' playwright-driver; they only
// fit the @playwright/test release with the same version.
const driver = process.env.PLAYWRIGHT_DRIVER_VERSION
const { version } = createRequire(import.meta.url)('@playwright/test/package.json') as { version: string }
if (driver && driver !== version) {
  throw new Error(`@playwright/test is ${version} but the Nix shell's browsers are for ${driver}: pin "@playwright/test": "${driver}" in package.json`)
}

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers,
  // CI also writes a blob report per shard, merged into one HTML report on failure.
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ...(process.env.CI ? [['blob', { outputDir: 'blob-report' }] as const] : [])],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices['Desktop Chrome'],
    // Nix provides the full Chromium (no headless shell): run it headless.
    channel: 'chromium',
    baseURL: frontendURL,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testDir: '.', testMatch: /global\.setup\.ts/ },
    visual
      ? { name: 'visual', dependencies: ['setup'], testMatch: /(layout|imports-visual|projects-visual)\.spec\.ts/, use: { storageState: adminStorageState } }
      : { name: 'chromium', dependencies: ['setup'], grepInvert: /@visual/, use: { storageState: adminStorageState } },
  ],
  webServer: [
    {
      name: 'backend',
      // Built once and started directly (no `go run` per start; `go build` is
      // incremental). Starts with an empty file store, like the database.
      command: `go build -o '${backendBinary}' ./cmd/snapflow && rm -rf '${storageDir}' && exec '${backendBinary}' serve`,
      cwd: '../../backend',
      url: `${backendURL}/api/health`,
      reuseExistingServer: reuse,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        DATABASE_URL: databaseURL,
        PORT: String(backendPort),
        ADMIN_EMAIL: admin.email,
        ADMIN_PASSWORD: admin.password,
        DISTRIBUTOR_NAME: distributorName,
        TRUSTED_PROXIES: '',
        STATIC_DIR: '',
        STORAGE_DIR: storageDir,
      },
    },
    {
      // The production build, served by `vite preview` with the same /api
      // proxy: what users get, and no dev-server module reloads mid-test.
      // Rebuilt only when its inputs changed (e2e/build-frontend.ts).
      name: 'frontend',
      command: `node e2e/build-frontend.ts && npx vite preview --outDir e2e/.dist --port ${frontendPort} --strictPort`,
      cwd: '..',
      url: frontendURL,
      reuseExistingServer: reuse,
      timeout: 120_000,
      env: { API_PROXY_TARGET: backendURL },
    },
  ],
})
