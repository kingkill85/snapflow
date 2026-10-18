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

Set `POSTGRES_PASSWORD` for anything beyond local use, and `ADMIN_EMAIL` + `ADMIN_PASSWORD` for the first start: the server creates that admin when no active admin exists. Other settings: `DISTRIBUTOR_NAME` (name of the distributor tenant on first start, default "Distributor") and `COOKIE_SECURE=false` (only for plain HTTP on a host other than localhost).

## Adding a feature

```bash
make feature name=product_types
```

This creates the migration, SQL queries, Go service and API with tests, plus the frontend page, form dialog, translations and tests, and wires everything in. Extend it from there; `make check` must stay green.
