import { createRequire } from 'node:module'

import { defineConfig, devices } from '@playwright/test'

import { admin, adminStorageState, backendPort, backendURL, databaseURL, distributorName, frontendPort, frontendURL } from './env'

// Run with `make e2e`, which recreates the database first. Servers are always
// started fresh (against the e2e database) unless E2E_REUSE_SERVERS=1 is set,
// e.g. while writing specs with the servers running in another terminal.
const reuse = process.env.E2E_REUSE_SERVERS === '1'

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
  // Each spec opens several browser contexts; more workers only add contention.
  workers: process.env.CI ? 2 : 4,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
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
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: { storageState: adminStorageState },
    },
  ],
  webServer: [
    {
      name: 'backend',
      command: 'go run ./cmd/snapflow serve',
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
      },
    },
    {
      // The production build, served by `vite preview` with the same /api
      // proxy: what users get, and no dev-server module reloads mid-test.
      name: 'frontend',
      command: `npx vite build --outDir e2e/.dist --emptyOutDir --logLevel warn && npx vite preview --outDir e2e/.dist --port ${frontendPort} --strictPort`,
      cwd: '..',
      url: frontendURL,
      reuseExistingServer: reuse,
      timeout: 120_000,
      env: { API_PROXY_TARGET: backendURL },
    },
  ],
})
