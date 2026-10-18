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

Set `POSTGRES_PASSWORD` for anything beyond local use, and `ADMIN_EMAIL` + `ADMIN_PASSWORD` for the first start: the server creates that admin when no active admin exists. Other settings: `DISTRIBUTOR_NAME` (name of the distributor tenant on first start, default "Distributor"), `COOKIE_SECURE=false` (only for plain HTTP on a host other than localhost) `TRUSTED_PROXIES` (comma-separated CIDRs or addresses of reverse proxies whose `X-Forwarded-For` header determines the client address for login rate limits; empty by default, i.e. the header is ignored) and `STORAGE_DIR` (where uploaded files such as product images are stored, content-addressed by SHA-256; default `./data/files` relative to the working directory, i.e. `backend/data/files` for `make dev-backend` and `/data/files` on the `app-files` volume in the container; back it up together with the database). If no active admin exists and `ADMIN_EMAIL` belongs to an existing user, that user is promoted to admin with `ADMIN_PASSWORD`.

## End-to-end tests

```bash
make e2e                       # needs Docker; recreates the database snapflow_e2e every run
make e2e args="--ui"           # Playwright UI mode; any Playwright CLI arguments work, e.g. args="users.spec.ts"
```

Playwright (Chromium from the Nix shell, `PLAYWRIGHT_BROWSERS_PATH`) starts its own backend on :8001 against `snapflow_e2e` and serves a production build of the frontend on :5174, so the development servers and database are never touched. Specs live in `frontend/e2e/specs/`; seed data through the `api` fixture, test behaviour through the UI. The `@playwright/test` version in `frontend/package.json` must equal nixpkgs' `playwright-driver` version (`echo $PLAYWRIGHT_DRIVER_VERSION`); bump both together when updating `flake.lock`. Report: `cd frontend && npx playwright show-report e2e/playwright-report`; screenshots of key pages in light/dark mode and at phone width land in `frontend/e2e/screenshots/`.

## Adding a feature

```bash
make feature name=product_types
```

This creates the migration, SQL queries, Go service and API with tests, plus the frontend page, form dialog, translations and tests, and wires everything in. Extend it from there; `make check` must stay green.
