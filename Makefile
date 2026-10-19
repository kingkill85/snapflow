# All commands run inside the Nix dev shell (`nix develop` or direnv).
DATABASE_URL ?= postgres://snapflow:snapflow@localhost:5432/snapflow?sslmode=disable
export DATABASE_URL
# Development login, created on first start when no admin exists. Never use in production.
DEV_ADMIN_EMAIL ?= admin@snapflow.local
DEV_ADMIN_PASSWORD ?= snapflow-dev

.PHONY: help db dev-backend dev-frontend generate api sqlc test test-backend test-frontend test-db test-documents e2e e2e-visual e2e-db lint lint-backend lint-frontend check feature

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

db: ## Start Postgres for development
	docker compose up -d --wait db

dev-backend: ## Run the backend on :8000 (needs `make db`); login admin@snapflow.local / snapflow-dev
	cd backend && ADMIN_EMAIL=$(DEV_ADMIN_EMAIL) ADMIN_PASSWORD=$(DEV_ADMIN_PASSWORD) go run ./cmd/snapflow serve

dev-frontend: ## Run the frontend on :5173 with the API proxied
	cd frontend && npm run dev

generate: sqlc api ## Regenerate all generated code

sqlc: ## Generate Go code from SQL queries
	cd backend && sqlc generate

api: ## Export OpenAPI and regenerate the TypeScript client
	cd backend && go run ./cmd/snapflow openapi > ../api/openapi.json
	cd frontend && npx orval

test: test-backend test-frontend ## Run all tests

# The Go tests share one Postgres (compose service testdb, in memory, no fsync):
# each test package copies a migrated template into its own database
# (internal/platform/testdb). Without TEST_DATABASE_URL, go test starts a
# container per package instead.
TEST_DB_PORT ?= 55432
TEST_DATABASE_URL ?= postgres://snapflow:snapflow@localhost:$(TEST_DB_PORT)/postgres?sslmode=disable

test-backend: test-db
	cd backend && TEST_DATABASE_URL='$(TEST_DATABASE_URL)' go test ./...

test-documents: test-db ## Convert generated documents to PDF with LibreOffice (run in `nix develop .#documents`)
	cd backend && REQUIRE_SOFFICE=1 TEST_DATABASE_URL='$(TEST_DATABASE_URL)' go test -count=1 -run 'LibreOffice' ./internal/platform/document/... ./internal/features/proposals/ ./internal/features/installation/

test-db: ## Start the Postgres of the Go tests (kept running, shared by every checkout)
	docker compose up -d --wait --no-recreate testdb

test-frontend:
	cd frontend && npx vitest run

# End-to-end tests. Playwright starts its own backend and frontend on the
# ports of an e2e slot, against that slot's database, which is dropped and
# recreated first; the development servers and database are never touched.
# E2E_SLOT picks the slot (0: :8001/:5174/snapflow_e2e, n: :20000+10n/:20001+10n/
# snapflow_e2e_n); unset, CI uses 0 and a checkout a slot derived from its
# path, so worktrees running e2e in parallel do not collide (frontend/e2e/env.ts).
e2e: e2e-db ## End-to-end tests in Chromium against a fresh database (needs Docker); args="--ui" etc.
	cd frontend && npx playwright test -c e2e $(args)

e2e-visual: e2e-db ## The full layout matrix (widths x light/dark x en/de) with screenshots
	cd frontend && E2E_VISUAL=1 npx playwright test -c e2e $(args)

e2e-db:
	docker compose up -d --wait --no-recreate db
	@db=$$(cd frontend && node e2e/env.ts | sed -n 's/.*E2E_DB=\([a-z0-9_]*\).*/\1/p'); \
	case "$$db" in snapflow_e2e|snapflow_e2e_[0-9]*) ;; *) echo "refusing database '$$db'"; exit 1;; esac; \
	echo "e2e database: $$db"; \
	docker compose exec -T db psql -q -U snapflow -d postgres -v ON_ERROR_STOP=1 \
		-c "DROP DATABASE IF EXISTS $$db WITH (FORCE)" -c "CREATE DATABASE $$db"

lint: lint-backend lint-frontend ## Run all linters and type checks

lint-backend:
	cd backend && golangci-lint run ./...

lint-frontend:
	cd frontend && npm run lint && npx tsc -b

# Generate first (lint and tests read the generated code), then lint and test
# backend and frontend at the same time. CI runners have 4 vCPUs, which Vitest
# alone fills; in parallel there it took 2.5 times as long, so CI runs them in
# sequence (CHECK_JOBS=1).
CHECK_JOBS ?= $(if $(CI),1,4)

check: ## Everything CI runs; fails if generated code is stale
	$(MAKE) generate
	$(MAKE) -j$(CHECK_JOBS) --output-sync=target lint-backend lint-frontend test-backend test-frontend
	git diff --exit-code -- backend/internal/features api frontend/src/api

feature: ## Scaffold a feature: make feature name=product_types
	@test -n "$(name)" || (echo "usage: make feature name=<snake_case_plural>" && exit 1)
	cd backend && go run ./cmd/scaffold $(name)
	$(MAKE) generate
