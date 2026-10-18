# All commands run inside the Nix dev shell (`nix develop` or direnv).
DATABASE_URL ?= postgres://snapflow:snapflow@localhost:5432/snapflow?sslmode=disable
export DATABASE_URL
# Development login, created on first start when no admin exists. Never use in production.
DEV_ADMIN_EMAIL ?= admin@snapflow.local
DEV_ADMIN_PASSWORD ?= snapflow-dev

.PHONY: help db dev-backend dev-frontend generate api sqlc test test-backend test-frontend e2e lint lint-backend lint-frontend check feature

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

test-backend:
	cd backend && go test ./...

test-frontend:
	cd frontend && npx vitest run

# The end-to-end database, dropped and recreated on every run. Playwright
# starts its own backend (:8001, on this database) and frontend (:5174), so the
# development servers and database are never touched.
E2E_DB := snapflow_e2e

e2e: ## End-to-end tests in Chromium against a fresh database (needs Docker); args="--ui" etc.
	docker compose up -d --wait db
	docker compose exec -T db psql -U snapflow -d postgres -v ON_ERROR_STOP=1 \
		-c 'DROP DATABASE IF EXISTS $(E2E_DB) WITH (FORCE)' -c 'CREATE DATABASE $(E2E_DB)'
	cd frontend && npx playwright test -c e2e $(args)

lint: lint-backend lint-frontend ## Run all linters and type checks

lint-backend:
	cd backend && golangci-lint run ./...

lint-frontend:
	cd frontend && npm run lint && npx tsc -b

check: generate lint test ## Everything CI runs; fails if generated code is stale
	git diff --exit-code -- backend/internal/features api frontend/src/api

feature: ## Scaffold a feature: make feature name=product_types
	@test -n "$(name)" || (echo "usage: make feature name=<snake_case_plural>" && exit 1)
	cd backend && go run ./cmd/scaffold $(name)
	$(MAKE) generate
