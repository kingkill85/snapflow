# CLAUDE.md

SnapFlow 2: smart home planning and proposals (floorplans, distribution boards, BOM, export). Rewrite of `kingkill85/snap-flow`. Architecture: `docs/architecture.md`. Decision log (every product/design decision, with reason): `docs/decisions.md`. Behaviour the old system had: `docs/inventory/`.

## Stack

- **Backend** (`backend/`): Go, huma (OpenAPI from code) on chi, sqlc + pgx, goose migrations, Postgres 17
- **Frontend** (`frontend/`): React 19, Vite, TypeScript, Tailwind 4, TanStack Query via orval-generated client, i18next, react-hook-form + zod
- **Tooling**: Nix dev shell (`flake.nix`, direnv). Run every command inside it: `nix develop -c <cmd>`

## Commands

```bash
make db             # start Postgres (docker compose)
make dev-backend    # API on :8000
make dev-frontend   # UI on :5173, /api proxied to :8000
make generate       # sqlc + OpenAPI export + TS client (run after any SQL or API change)
make lint           # golangci-lint, oxlint, tsc
make test           # Go tests (real Postgres via Testcontainers) + Vitest
make check          # everything CI runs, incl. "generated code is committed"
make e2e            # Playwright click-through on a fresh snapflow_e2e database (args="--ui" etc.)
make feature name=product_types   # scaffold a full feature, backend + frontend
```

Single tests: `cd backend && go test ./internal/features/functiontypes -run TestValidation` · `cd frontend && npx vitest run src/features/function-types`

## Rules

1. **Business rules live in the backend, once.** Prices, totals, BOM, checks: computed in a Go service, never in the frontend. The frontend displays what the API returns.
2. **A feature is a vertical slice.** Backend `internal/features/<pkg>/` (queries.sql, service.go, api.go, api_test.go, generated store/), frontend `src/features/<name>/` (page, dialogs, locales, tests). Start new features with `make feature`, then extend.
3. **Layers:** `api.go` only maps HTTP to service calls. `service.go` holds rules and validation. SQL lives in `queries.sql`; `store/` is generated (never edit). Features do not read each other's tables; call the other feature's service. sqlc generates models of all tables into every `store/`: never use the models of another feature's tables.
4. **Schema changes = new goose migration** in `backend/migrations/` (never edit an applied one). sqlc reads the same files.
5. **Never edit generated code:** `backend/internal/features/*/store/`, `api/openapi.json`, `frontend/src/api/generated/`. Change the source, run `make generate`, commit the result.
6. **Errors:** return `apperr` errors with a stable `code` (e.g. `function_type.key_taken`) and `params`. The frontend translates codes from `src/locales/<lang>/errors.json`; add the key in en and de.
7. **i18n everywhere:** no user-facing string in code. UI text in the feature's `locales/en.json` + `de.json` (en is the reference, keys are type-checked). Translatable data uses `i18n.Text` (jsonb, `en` required); display with `useLocalized()`.
8. **Design system only:** features use components from `@/components/ui` (Button, Field, DataTable, FormDialog, ConfirmDialog, Page, ...), never raw `<button>`, `<input>`, `<table>`, `<select>`, `<dialog>` (enforced by `src/test/design-system.test.ts`). Colours via tokens (`bg-surface`, `text-muted`, `border-line`, `bg-primary`, `text-danger`), never raw palette colours. Missing a component? Add it to `components/ui` first.
9. **UI patterns:** dialogs take `item: T | null` (null = create). Labels: Create / Update / Cancel / Delete / Edit (from `common`). Row actions: Edit (`secondary`) before Delete (`danger`), `size="sm"`, icon + text.
10. **Tests:** backend tests hit a real Postgres (`testdb.Run` in `TestMain`; `apptest.New(t)` for the whole API with a logged-in `api.Admin`, `api.NewUser(tenant, role)` for others). Frontend tests mock HTTP with MSW (`server.use(...)`); unhandled requests fail the test. `renderWithProviders(ui, { me })` sets the logged-in user (admin by default).
11. **Permissions:** every service method starts with `auth.Require(ctx, auth.Perm...)`; the matrix lives in `platform/auth` only. Tenant-owned data is scoped with `actor.SeesTenant`. All endpoints need login unless wrapped in `auth.Public`. The frontend gates with `useCan()` and the `can` flags the API returns, never with role names.

## Git

Feature branches (`feature/*`, `fix/*`, `refactor/*`, `docs/*`), PRs into `main`. Run `make check` before pushing.
