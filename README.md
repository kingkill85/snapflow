# SnapFlow 2

Smart home planning and proposals: place devices on floorplans, design distribution boards, wire loads to module channels, and export proposals.

Rewrite of [snap-flow](https://github.com/kingkill85/snap-flow). See [docs/architecture.md](docs/architecture.md) for the design and [CLAUDE.md](CLAUDE.md) for conventions.

## Quick start

Requires Nix (with flakes) and Docker.

```bash
nix develop          # or: direnv allow
cd frontend && npm ci && cd ..
make db              # Postgres on localhost:5432
make dev-backend     # http://localhost:8000/api/docs
make dev-frontend    # http://localhost:5173
```

Sign in as `admin@snapflow.local` / `snapflow-dev` (created by `make dev-backend` on an empty database).

Production-like stack in one container:

```bash
docker compose --profile app up --build   # http://localhost:8000
```

CI publishes the image to `ghcr.io/kingkill85/snapflow` after the checks pass: every push to `main` as `main`, `latest` and `sha-<short>`, every tag `v1.2.3` as `1.2.3` and `1.2`. Run the published image instead of building it:

```bash
docker compose --profile app pull && docker compose --profile app up   # SNAPFLOW_TAG=1.2.3 for a release
```

Set `POSTGRES_PASSWORD` for anything beyond local use, and `ADMIN_EMAIL` + `ADMIN_PASSWORD` for the first start: the server creates that admin when no active admin exists. Other settings: `DISTRIBUTOR_NAME` (name of the distributor tenant on first start, default "Distributor"), `COOKIE_SECURE=false` (only for plain HTTP on a host other than localhost) `TRUSTED_PROXIES` (comma-separated CIDRs or addresses of reverse proxies whose `X-Forwarded-For` header determines the client address for login rate limits; empty by default, i.e. the header is ignored) `DATABASE_MAX_CONNS` (size of the database connection pool, default 20) and `STORAGE_DIR` (where uploaded files such as product images are stored, content-addressed by SHA-256; default `./data/files` relative to the working directory, i.e. `backend/data/files` for `make dev-backend` and `/data/files` on the `app-files` volume in the container; back it up together with the database). If no active admin exists and `ADMIN_EMAIL` belongs to an existing user, that user is promoted to admin with `ADMIN_PASSWORD`.

## End-to-end tests

```bash
make e2e                       # needs Docker; recreates this checkout's e2e database every run
make e2e args="--ui"           # Playwright UI mode; any Playwright CLI arguments work, e.g. args="users.spec.ts"
make e2e-visual                # the full layout matrix (widths x light/dark x en/de) with screenshots
E2E_SLOT=3 make e2e            # pick the slot (ports and database) yourself
SNAPFLOW_V1_WORKBOOK=/path/to/workbook.xlsx make e2e args=imports-v1-workbook   # the real SnapFlow 1 workbook (not in the repository; skipped without it)
```

Playwright (Chromium from the Nix shell, `PLAYWRIGHT_BROWSERS_PATH`) starts its own backend and serves a production build of the frontend, against its own database, so the development servers and database are never touched. Specs live in `frontend/e2e/specs/`; seed data through the `api` fixture, test behaviour through the UI; specs run in parallel (half the CPU cores, 2 per shard in CI, `E2E_WORKERS` overrides), so they only rely on data they create. The `@playwright/test` version in `frontend/package.json` must equal nixpkgs' `playwright-driver` version (`echo $PLAYWRIGHT_DRIVER_VERSION`); bump both together when updating `flake.lock`. Report: `cd frontend && npx playwright show-report e2e/playwright-report`.

- **Slots.** Each run uses a slot, so checkouts (git worktrees, parallel agents) never share ports or a database: slot 0 is backend :8001, frontend :5174, database `snapflow_e2e`; slot n (1-99) is :20000+10n, :20001+10n, `snapflow_e2e_n`. `E2E_SLOT` picks one; unset, CI uses 0 and a local checkout a slot derived from its path (`cd frontend && node e2e/env.ts` prints it). Only an e2e database is ever dropped.
- **Default run vs. visual.** `make e2e` runs a slim layout smoke (phone 390 and desktop 1280 in light mode, every list at 1280 px in English and German). The rest of the matrix is tagged `@visual` and runs with `make e2e-visual`, which also saves screenshots of key pages to `frontend/e2e/screenshots/`. CI runs it on pull requests labelled `visual` or by hand (workflow_dispatch); the default run happens on every pull request, in two shards.
- **Builds.** The backend is built once per run with `go build` (incremental) and started as a binary; the frontend production build in `frontend/e2e/.dist` is reused while its inputs are unchanged (`E2E_REBUILD=1` forces a rebuild). `E2E_REUSE_SERVERS=1` uses servers you started yourself.

## Adding a feature

```bash
make feature name=product_types
```

This creates the migration, SQL queries, Go service and API with tests, plus the frontend page, form dialog, translations and tests, and wires everything in. Extend it from there; `make check` must stay green.

## Licence

[MIT](LICENSE)
