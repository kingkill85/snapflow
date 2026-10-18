# Architecture

Decisions as of 2026-10-18. The full plan with diagrams lives in the "SnapFlow 2 – Rewrite Plan" document; this file is the in-repo summary and wins if they differ.

## Goals

The top priority is that new features, importers and exporters are easy to add in backend and frontend without breaking unrelated code. SnapFlow 1 failed here because logic was duplicated (invoice maths existed five times and the copies disagreed), the schema was rigid, and the UI bypassed its own components.

## Principles

1. Every business rule exists once, in the backend.
2. Layers: HTTP (`api.go`) → service (rules) → generated store (SQL). The domain knows no HTTP.
3. The API contract is generated from Go code (OpenAPI); the TypeScript client is generated from that. An API change breaks the frontend build, not production.
4. Extend with data, not code: product attributes and function types are configuration; plan kinds, bus systems, importers and exporters are modules behind interfaces.
5. Geometry and interaction run in the editor for live feedback; the backend validates the saved state and returns BOM and warnings.
6. Strict design system, enforced by a test.
7. Tenant isolation checked in code and by Postgres row-level security.
8. i18n from day one: UI, catalog content and exports. The API returns error codes, the client translates them.

## Domain model

- **Global catalog** (shared by all tenants): function types (dimmer, switching, blind, …), product types with an attribute schema, a channel template and an instance schema, products with variants and addons (attribute values as validated jsonb, translatable names).
- **Projects** (per tenant) with versions. A project has any number of **plans**: floorplans (image, zones, placements) and distribution boards (enclosure, rails, module instances), not tied to a floor.
- **Zones hold loads** ("ceiling light living room", dimmer, 60 W). **Channel assignment** wires each load to exactly one module channel on any board.
- **Project BOM** = BOM lines of all plans + manual lines; each line keeps a frozen snapshot and a catalog reference ("Update from catalog").
- **Checks**: bus load (current used vs. supplied, per bus system and board), channel balance, warnings.
- **Bus system adapters** (HDL first, KNX later): assign addresses, validate, export a config file for the vendor tool. Direct programming via a local bridge agent may come later.
- **Revisions**: proposal, as-built and programmed states as snapshots.
- Customers stay embedded in projects for now.

## Auth, tenants and permissions

- **Tenants**: exactly one *distributor* tenant (runs SnapFlow, owns the catalog, home of the admins; created at startup, cannot be deactivated or deleted) and any number of *partner* tenants. Deleting a partner deletes its users.
- **Roles** are fixed and ordered: `admin` > `tenant_admin` > `user`. Nobody assigns a role above their own or changes a user whose role is above their own. Nobody changes their own role, tenant or active flag, or deletes themselves, so the last admin cannot disappear. `admin` requires the distributor tenant.
- **Permission matrix** in `backend/internal/platform/auth` (pinned by `TestMatrix`): `catalog.read` (all), `catalog.write` (admin), `projects.read`/`write` (all), `projects.delete` (admin, tenant_admin), `users.manage` (admin, tenant_admin), `tenants.manage` and `tenants.access_all` (admin). `GET /api/roles` returns it; the Roles page shows it.
- **Where checks run**: every service operation starts with `auth.Require(ctx, permission)`, so the HTTP API and the MCP server share them. The HTTP middleware only authenticates and refuses anonymous calls to non-public operations (`auth.Public` marks the exceptions). Tenant scoping uses `actor.SeesTenant`; rows of other tenants look like 404.
- **The UI never re-implements rules**: `/api/auth/me` returns the user's permissions and assignable roles, and rows carry `can.update`/`can.delete`. The frontend gates pages, navigation and buttons with `useCan()` and those flags.
- **Sessions**: opaque random tokens; only their SHA-256 is stored. The browser gets an HttpOnly, SameSite=Lax cookie; `Authorization: Bearer` with the same token is accepted for API clients (MCP later). Sessions expire 14 days after last use. User, role, tenant and active flags are read on every request, so changes apply at once. Changing a password ends the user's other sessions. Cross-site writes are refused (`Sec-Fetch-Site`). Login is limited to 10 attempts per email in 5 minutes (in memory). Passwords: argon2id, at least 8 characters; emails are case-insensitive.
- **Row-level security** arrives in phase 2 with projects, the first tenant-owned business data. Until then tenant isolation is enforced in the services.

## Extension points

| Extension | Contract |
| --- | --- |
| Feature | Vertical slice; `make feature` scaffolds it |
| Plan kind | `Validate`, `BOMLines`, `Supplies`, `Demands`, `Checks` + an editor module on a shared canvas base (react-konva) |
| Bus system | `AssignAddresses`, `Validate`, `ExportConfig` (later `Program`) |
| Import source | Reads rows (Excel/CSV first, APIs later) → saved mapping profile → dry run with per-row errors → apply in one transaction |
| Exporter | Canonical document model → output (DOCX first; Excel, PDF, other systems later); registered in the backend, listed by the API |
| Integration | External references on every entity, scheduled jobs, outbox for reliable delivery and webhooks, per-tenant encrypted settings. ERP scope: items only, no ERP yet |
| MCP | On top of the same services, inherits every permission check |

## Decisions taken from the SnapFlow 1 inventory

All 16 recommendations were accepted, including: smart sizing (resize all instances, toggle); discount and services as percent or absolute, computed once in the backend; catalog base currency plus project currency and rate stored on the project; invoice settings per version; BOM grouped by product + variant + snapshot price; "Update from catalog" with a diff preview; read-only by project status plus permission; an explicit permission matrix; tenant admins cannot change higher roles; every read and file needs login; area assignment recomputed on change; Excel sync preview with per-row errors; missing items deactivated, not deleted; per-type documents split discount and services; undo/redo and visible save errors; versions kept with a correct deep copy. Details: `docs/inventory/`.

## Phases

0. Foundation: inventory, skeleton, CI, design system, i18n ← **done with this repo's first commit**
1. Catalog & tenants: auth, tenants, users, roles ← **done**; product types, attribute schemas, schema-driven import
2. Projects & floorplan: editor, zones, placements, BOM, proposals (DOCX)
3. Distribution board: board editor, bus load, loads and channel assignment
4. MCP & cutover: MCP server, data migration from SnapFlow 1, go-live
