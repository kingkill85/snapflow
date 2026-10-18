import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Settings shared by the Playwright config and the specs. The end-to-end run
// owns its own backend, frontend and database; nothing here may point at the
// development setup (port 8000/5173, database "snapflow").

export const backendPort = 8001
export const frontendPort = 5174
export const backendURL = `http://localhost:${backendPort}`
export const frontendURL = `http://localhost:${frontendPort}`

/** The database `make e2e` drops and recreates before every run. */
export const databaseName = 'snapflow_e2e'
export const databaseURL =
  process.env.E2E_DATABASE_URL ?? `postgres://snapflow:snapflow@localhost:5432/${databaseName}?sslmode=disable`

// Refuse anything but the throwaway database: the specs create and delete data.
if (new URL(databaseURL).pathname !== `/${databaseName}`) {
  throw new Error(`E2E_DATABASE_URL must use the database "${databaseName}", got ${databaseURL}`)
}

/** Uploaded files of the e2e backend: a temporary directory, emptied when the backend starts. */
export const storageDir = process.env.E2E_STORAGE_DIR ?? join(tmpdir(), 'snapflow-e2e-files')

/** The admin the backend creates on its first start against the empty database. */
export const admin = { email: 'e2e-admin@snapflow.test', password: 'e2e-admin-password', name: '' }

export const distributorName = 'E2E Distributor'

export const adminStorageState = 'e2e/.auth/admin.json'
