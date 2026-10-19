import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Settings shared by the Playwright config and the specs. The end-to-end run
// owns its own backend, frontend and database; nothing here may point at the
// development setup (port 8000/5173, database "snapflow").
//
// Several checkouts (git worktrees, parallel agents) can run end-to-end tests
// at the same time: each uses a slot with its own ports, database and file
// store. `E2E_SLOT` picks one; without it CI uses slot 0 and a local checkout
// a slot derived from its path, so two checkouts do not share one.

/** The checkout this file belongs to. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function defaultSlot(): number {
  if (process.env.CI) return 0
  return 1 + (createHash('sha256').update(repoRoot).digest().readUInt32BE(0) % 99)
}

function parseSlot(value: string | undefined): number {
  if (value === undefined || value === '') return defaultSlot()
  const slot = Number(value)
  if (!Number.isInteger(slot) || slot < 0 || slot > 99) throw new Error(`E2E_SLOT must be an integer from 0 to 99, got "${value}"`)
  return slot
}

/** 0: ports 8001/5174, database snapflow_e2e. n: ports 20000+10n and 20001+10n, database snapflow_e2e_n. */
export const slot = parseSlot(process.env.E2E_SLOT)

export const backendPort = slot === 0 ? 8001 : 20000 + 10 * slot
export const frontendPort = slot === 0 ? 5174 : 20001 + 10 * slot
/** The stub exchange rate provider (e2e/rates-stub.ts), the backend's EXCHANGE_RATE_URL. */
export const ratesPort = slot === 0 ? 8002 : 20002 + 10 * slot
export const ratesURL = `http://localhost:${ratesPort}/v6/latest/USD`
export const backendURL = `http://localhost:${backendPort}`
export const frontendURL = `http://localhost:${frontendPort}`

/** The database `make e2e` drops and recreates before every run. */
export const databaseName = slot === 0 ? 'snapflow_e2e' : `snapflow_e2e_${slot}`
export const databaseURL =
  process.env.E2E_DATABASE_URL ?? `postgres://snapflow:snapflow@localhost:5432/${databaseName}?sslmode=disable`

// Refuse anything but the throwaway database: the specs create and delete data.
if (new URL(databaseURL).pathname !== `/${databaseName}`) {
  throw new Error(`E2E_DATABASE_URL must use the database "${databaseName}" (slot ${slot}), got ${databaseURL}`)
}

/** Uploaded files of the e2e backend: a temporary directory, emptied when the backend starts. */
export const storageDir = process.env.E2E_STORAGE_DIR ?? join(tmpdir(), `snapflow-e2e-files-${slot}`)

/** The backend binary: `go build` at the start of a run, which keeps it when nothing changed. */
export const backendBinary = join(repoRoot, 'frontend/e2e/.bin', `snapflow-${slot}`)

/** The admin the backend creates on its first start against the empty database. */
export const admin = { email: 'e2e-admin@snapflow.test', password: 'e2e-admin-password', name: '' }

export const distributorName = 'E2E Distributor'

export const adminStorageState = `e2e/.auth/admin-${slot}.json`

// `node e2e/env.ts` prints the slot's settings for the Makefile.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`E2E_SLOT=${slot} E2E_DB=${databaseName} E2E_BACKEND_PORT=${backendPort} E2E_FRONTEND_PORT=${frontendPort}`)
}
