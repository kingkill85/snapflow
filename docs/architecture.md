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

- **Tenants**: exactly one *distributor* tenant (runs SnapFlow, owns the catalog, home of the admins; created at startup, cannot be deactivated or deleted) and any number of *partner* tenants. Deleting a partner deletes its users; what happens to a tenant that has projects is decided in phase 2.
- **Roles** are fixed and ordered: `admin` > `tenant_admin` > `user`. Nobody assigns a role above their own or changes a user whose role is above their own. Nobody changes their own role, tenant, active flag or password (via user management; the profile is the place for that), or deletes themselves. At least one active admin always remains (`user.last_admin`): user updates and deletes run in one transaction that locks the active admin rows (in id order, then the target row) whenever an active admin would lose that status, so concurrent changes cannot remove the last one. `admin` requires the distributor tenant. On startup, if there is no active admin, `ADMIN_EMAIL`/`ADMIN_PASSWORD` creates one, or promotes the existing user with that email (moved to the distributor, activated, password reset, sessions ended, logged); without `ADMIN_EMAIL` a warning is logged.
- **Permission matrix** in `backend/internal/platform/auth` (pinned by `TestMatrix`): `catalog.read` (all), `catalog.write` (admin), `projects.read`/`write` (all), `projects.delete` (admin, tenant_admin), `users.manage` (admin, tenant_admin), `tenants.manage` and `tenants.access_all` (admin). `GET /api/roles` returns it; the Roles page shows it.
- **Where checks run**: every service operation starts with `auth.Require(ctx, permission)`, so the HTTP API and the MCP server share them. The HTTP middleware only authenticates and refuses anonymous calls to non-public operations (`auth.Public` marks the exceptions). Tenant scoping uses `actor.SeesTenant`; rows of other tenants look like 404.
- **The UI never re-implements rules**: `/api/auth/me` returns the user's permissions and assignable roles, and rows carry `can.update`/`can.delete`. The frontend gates pages, navigation and buttons with `useCan()` and those flags.
- **Sessions**: opaque random tokens; only their SHA-256 is stored. The browser gets an HttpOnly, SameSite=Lax cookie; `Authorization: Bearer` with the same token is accepted for API clients (MCP later). Sessions expire 14 days after last use (renewed at most hourly, which re-sends the cookie). User, role, tenant and active flags are read on every request, so changes apply at once. Changing a password ends the user's other sessions; an admin resetting someone's password ends all of theirs. `POST /api/auth/logout` ends the current session; `POST /api/auth/logout-all` ("sign out everywhere") ends all of the caller's sessions, the current one included. Passwords: argon2id, at least 8 characters, at most one hash per CPU at a time (a request that waits more than 5 s for a slot gets 503 `server.busy`); emails are case-insensitive.
- **CSRF**: every non-safe request that a browser marks as cross-site (`Sec-Fetch-Site` other than `same-origin`/`none`) is refused, whatever the credentials (cookie, bearer or none, e.g. login). Non-browser clients send no `Sec-Fetch-Site` and are unaffected.
- **Login limiting** (in memory, one instance): only *failed* logins count, so a stranger cannot lock an account's owner out. Limits per 5 minutes: 10 failures per (email, client IP), 50 per email (distributed guessing), 100 per client IP (password spraying). A successful login clears its (email, client IP) bucket. Wrong current passwords on the password change are limited to 10 per user. Every 429 `auth.too_many_attempts` carries `params.seconds` and a `Retry-After` header.
- **Client IP**: the connection's address, unless it comes from a proxy listed in `TRUSTED_PROXIES` (comma-separated CIDRs or addresses); then the rightmost `X-Forwarded-For` entry that is not itself a trusted proxy. Without trusted proxies `X-Forwarded-For` is ignored, as anyone could set it. Determined by HTTP middleware (`platform/clientip`) and passed to the service as an argument.
- **Disabled accounts**: with the *right* password, a disabled user (or a user of a disabled tenant) gets 403 `auth.account_disabled`, so they know to contact their admin (as in v1, deliberately). With a wrong password the answer is the usual `auth.invalid_credentials`, so the flag does not leak without the password.
- **Row-level security** arrives in phase 2 with projects, the first tenant-owned business data. Until then tenant isolation is enforced in the services.

## Catalog: product types and attribute schemas

- **Product types** (`features/producttypes`) are the kinds of device ("Dimmer actuator", "Gateway"). They replace SnapFlow 1's categories and item types; the old item type becomes an attribute such as `bus_system` (D14). Each has a key (lower snake case, 1–64 characters, unique), a translatable name (100 characters) and description (2000), an optional badge colour (`#rrggbb`, D38), a position in one global catalog order (`PUT /api/product-types/order` with every id, D25), an active flag (inactive types are hidden from lists unless `includeInactive=true`) and two attribute schemas stored as jsonb: `attributes` (values on the product, or per variant with `scope: "variant"`) and `instanceAttributes` (per installed unit, used from phase 2/3; their definitions have no scope). A type that products use cannot be deleted (`product_type.in_use`, 409); deactivate it instead.
- **Concurrency**: creates and reorders run in a transaction holding one advisory lock (`pg_advisory_xact_lock`), so sort orders never collide; a reorder also row-locks every type, so none is deleted underneath it. Updates are optimistic (D37): the body carries `expectedUpdatedAt`, the UPDATE matches it, and a mismatch is 409 `product_type.stale`.
- **Attribute schemas** (`platform/attrschema`, pure Go) are configuration, never migrations. A definition has a key, label (100 characters), optional description (500) and unit (display only, D20), a type (`text`, `number`, `integer`, `boolean`, `enum`, `list` of `text`/`number`/`integer`/`enum`), `required`, optional `min`/`max` (value range; length for text; item count for lists, D35) and `options` for enums. At most 200 attributes and 500 options (D40); integers within ±(2^53−1) (D30); schemas no value can satisfy are rejected (D34). `CheckSchema`/`CheckInstanceSchema` check and normalise a schema when it is saved (D22); `ValidateValues`/`ValidateInstanceValues` check and normalise the values of a product, variant or unit against it (D23) and are the one implementation products (1c), the import (1d, behind a lenient cell parser, D32) and instances use. With `Unknown: Keep` (product saves) values of keys the schema no longer has come back as stale instead of failing (D31); `Unknown: Reject` (imports) reports them.
- **Translatable texts** (`i18n.Text`) accept only `i18n.Locales` (en, de; the frontend's language list must match) and `en` is required (D36).
- **Errors**: all problems of a save come back in one 422 with per-field codes (`attribute.*`, `product_type.*`, `validation.*`) and params (e.g. `max`, `min`, `options`, `expected`, `scope`) at exact locations such as `body.attributes[2].options[0].key`, so the editor shows each next to its row (D24, D39). Fields with a fixed set of values (type, item type, scope) are checked by the API schema first (D33).

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
1. Catalog & tenants: auth, tenants, users, roles ← **done**; product types and attribute schemas ← **done (backend)**; products, schema-driven import
2. Projects & floorplan: editor, zones, placements, BOM, proposals (DOCX)
3. Distribution board: board editor, bus load, loads and channel assignment
4. MCP & cutover: MCP server, data migration from SnapFlow 1, go-live
