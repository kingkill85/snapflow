# Phase 2 – Projects & floorplan

Spec written 2026-10-18 at the start of phase 2. Source material: `docs/architecture.md`, `docs/decisions.md` (D12, D13, D18, D19, D37, D41, D59, D79, D99; Q1, Q2), `docs/inventory/02-projects-configurator.md`, `docs/inventory/03-bom-pricing-export.md`. Every decision taken while building goes into `docs/decisions.md` as usual; this file is the plan, the decision log wins where they differ.

Phase 2 runs as four steps, one PR each, in this order (each needs the previous one):

| Step | Content |
| --- | --- |
| 2a | Projects and versions: customer data, status, product types, tenant ownership, row-level security, file scopes, tenant soft delete, project list and project page shell |
| 2b | Floorplan editor: plans (kind `floorplan`) with an uploaded image, zones (polygons), placements of catalog variants with add-on choice and instance attributes, zone containment, undo/redo, edit lock, PNG export |
| 2c | BOM and pricing: BOM computed in the backend from placements plus manual lines, price snapshots per version with "Update from catalog" (diff preview), discount and services (percent or absolute), currency and rate, totals |
| 2d | Proposals: exporter registry, canonical document model, DOCX exporter (quantities per plan, totals, zone summary, plan images), split per product type, project language |

Not in phase 2: loads in zones and channel assignment, distribution boards, bus load (phase 3); revisions as snapshots (proposal / as-built / programmed) — 2d only records each generated proposal; MCP (phase 4).

---

## 2a – Projects and versions

### Model

**projects** (tenant-owned)
- `id` uuid, `tenant_id` (FK tenants), `number` (text, unique per tenant, generated, not editable: `<year>-<sequence per tenant and year, 4 digits>`, e.g. `2026-0007`; a counter table, concurrency-safe), `name` (1–200, required: what the project is called, e.g. "Villa Müller"), `status` `active | completed | cancelled` (default active), `language` (one of the content locales, default the creating user's UI language if it is a content locale, else `en`; used by proposals, Q1), `currency` (ISO 4217, 3 upper-case letters, default `USD`) and `exchange_rate` (numeric > 0, units of project currency per 1 USD, default 1; exactly 1 when the currency is USD) — catalog prices are USD (D19); stored now, used from 2c.
- Customer embedded: `customer_name` (≤200, optional), `customer_company` (≤200), `customer_email` (valid or empty), `customer_phone` (≤50), `customer_address` (≤500, multi-line), `notes` (≤5000). Empty strings clear a field (SnapFlow 1 bug 8).
- `product_type_ids`: the systems the project uses (D41/D99), at least one; a separate table `project_product_types`. Default on create: all active product types. Inactive types already chosen stay chosen and are shown as inactive; new choices offer active types only.
- `created_at`, `updated_at`, `created_by` (user, nullable on user delete). Optimistic concurrency (D37): updates send `expectedUpdatedAt`, 409 `project.stale`.

**project_versions** (tenant-owned through the project; carry `tenant_id` too, for RLS)
- `id`, `project_id`, `name` (1–100, unique per project case-insensitively, `project_version.name_taken`), `position` (display order: creation order), `created_at`, `updated_at`, `notes` (≤2000).
- A new project automatically gets one version, named `V1` (language-neutral; the create request has no version fields) (user, 2026-10-18).
- A new version is either a full copy of an existing version or a fresh, empty start (user, 2026-10-18): `POST /api/projects/{id}/versions` with `name` and optional `sourceVersionId`. With a source → deep copy in one transaction (everything a version owns; in 2a only the version row; 2b–2c extend the copy, each step adds its tables to it and to its test); without → an empty version. The dialog offers "Copy of" (a version select, default the current version) or "Start empty", copy being the default, and pre-fills the name with the next free `V<n>`.
- Rename, delete. The last version cannot be deleted (`project_version.last`); delete the project instead.
- Versions serve both as alternative offers and as rounds of changes; pricing settings per version arrive in 2c.

### Read-only rules (accepted recommendation: read-only by status plus permission)
- `projects.write` is needed for any change. A project whose status is `completed` or `cancelled` is read-only: every change to it, its versions and (later) its plans fails with 409 `project.read_only`, except changing the status back to `active` (which needs `projects.write`).
- Rows carry `can.update` / `can.delete` (`delete` = `projects.delete`), computed in the service from permission and status; the UI only uses those flags.

### Tenants
- Admins (`tenants.access_all`) see every tenant's projects, filter the list by tenant, choose the tenant on create and may move a project to another tenant (optional `tenantId` on create and update, as for users: defaults to the caller's / current tenant; another tenant without `tenants.access_all` → 403 `project.tenant_forbidden`; unknown or archived tenant → `project.tenant_not_found` at `body.tenantId`).
- Everybody else sees and creates only in their own tenant. Other tenants' projects look like 404.
- **D13 implemented**: deleting a partner tenant that has projects deactivates and archives it (`archived_at`), keeps its users and projects; archived tenants are hidden from the tenant list unless `includeArchived=true` and cannot be chosen for new users or projects; an admin can restore one (`POST /api/tenants/{id}/restore`: unarchived, stays inactive until activated as usual). Deleting an archived tenant again is refused while it has projects. Tenants without projects are hard-deleted as today. The confirm dialog says which of the two will happen (the API returns `projectCount` on the tenant).

### Row-level security (D12)
- Every tenant-owned table (`projects`, `project_versions`, `project_product_types`, and later plans/zones/placements/BOM) has `tenant_id` and `ENABLE` + `FORCE ROW LEVEL SECURITY` with a policy `tenant_id = current_setting('app.tenant_id', true)::uuid OR current_setting('app.access_all', true) = 'on'` (for SELECT, INSERT, UPDATE, DELETE; WITH CHECK the same).
- The app runs tenant-scoped work in a transaction that does `SET LOCAL ROLE snapflow_app` (a NOLOGIN role created by the migration, granted to the connecting user; not a superuser, so RLS applies even when the connecting user is a superuser as in dev) and `set_config('app.tenant_id', …, true)` / `app.access_all` from the actor. One platform helper does this (e.g. `database.InScope(ctx, pool, actor, fn)`); features never set these themselves.
- Services still check tenants (`actor.SeesTenant`); RLS is the second wall. Tests prove that a query with another tenant's scope sees no rows and cannot insert/update rows of another tenant, also when the service check is bypassed (call the store directly).
- Tables without tenant data (catalog, users, tenants, files metadata) stay as they are.

### File scopes (D79)
- `files` gains `tenant_id` (NULL = catalog). Deduplication per scope (unique `(tenant_id, sha256)` with NULLs not distinct, or two partial unique indexes); `file_sources` likewise per scope.
- `Open`/download checks: catalog files for every logged-in user; tenant files only for that tenant or `tenants.access_all`; others 404.
- No tenant upload exists yet in 2a (floorplans come in 2b), but the API and service take a scope now and are tested with one.

### Permissions
`projects.read` (all roles), `projects.write` (all), `projects.delete` (admin, tenant_admin) as in the matrix already. Version create/copy/rename/delete need `projects.write` (deleting a version is editing the project; deleting the project needs `projects.delete`).

### API (huma, `features/projects`)
- `GET /api/projects?search=&status=&tenantId=&offset=&limit=` — paged (same paging pattern as products), search over number, name, customer name/company (ILIKE, ≤200 chars), status filter (default: active; `all`), sorted by `updated_at` desc. Rows: id, number, name, customer name/company, status, tenant (id + name for admins), version count, product type ids, updatedAt, `can`.
- `GET /api/projects/{id}` — full project with versions (ordered by position) and `can`.
- `POST /api/projects` (201), `PUT /api/projects/{id}` (expectedUpdatedAt), `DELETE /api/projects/{id}` (cascades everything, also later plan files' references; files themselves stay, as D58).
- `POST /api/projects/{id}/versions`, `PUT /api/projects/{id}/versions/{versionId}`, `DELETE /api/projects/{id}/versions/{versionId}`.
- Errors: `project.not_found`, `project.stale`, `project.read_only`, `project.product_types_required`, `project.product_type_not_found`, `project.currency_format`, `project.exchange_rate`, `project_version.*` — en + de in `errors.json`.

### Frontend (`src/features/projects`)
- Nav: section "Projects" (first section, D97), page "Projects". The home page links there.
- **List** (`<Page width="wide">`): search, status filter (Active default, Completed, Cancelled, All), tenant filter for admins; columns number, name, customer, tenant (admins), status badge, versions, updated; row click opens the project; row actions Edit, Delete (D115/D117 rules). Empty state with a "New project" call to action. Phone: cards.
- **Create / edit dialog** (`FormDialog`, `item: Project | null`): name*, tenant (admins, create and edit), customer section (name, company, email, phone, address), product types (`CheckboxGroupField` with `TypeBadge`, at least one), language (`SelectField` of content locales), currency + exchange rate, status (edit only), notes. 
- **Project page** `/projects/:id`: header with number, name, customer, status badge, Edit action; version switcher (tabs or select; URL `/projects/:id/versions/:versionId`, default the first) with New version (a copy of a chosen version, or empty), Rename, Delete (ConfirmDialog; disabled with tooltip on the last version); body: placeholder area for plans ("Plans arrive with the floorplan editor" is NOT shown to users — show an empty state "No plans yet" without an action in 2a; 2b adds the action). Read-only banner when the project is completed/cancelled (notice with "Reopen" for users who may write).
- **Tenants page**: delete dialog explains archive vs delete using `projectCount`; "Show archived" filter, an "Archived" badge and a Restore row action.
- Full parity: everything the API offers is reachable in the UI.

### Tests
- Backend: CRUD, validation, paging/search/filter, tenant isolation via service and via RLS (store called directly with a foreign scope), read-only rules, stale updates, version copy/delete-last, project number sequence under concurrency (parallel creates, unique numbers), tenant archive vs delete, file scope checks, permission matrix unchanged (`TestMatrix`).
- Frontend: Vitest + MSW for list, dialog, project page, version actions, tenants delete dialog.
- E2E: a `projects.spec.ts` click-through (create, edit, versions, read-only, delete) and layout matrix entries for the new pages.

---

## 2b – Floorplan editor (outline, detailed at the start of 2b)

- **Plans**: `plans` table (tenant-owned, per version, `kind` = `floorplan` now, `board` in phase 3; name, position, image file (tenant-scoped, D79), image natural size). Upload JPEG/PNG/WebP (and PDF first page? decide), limits as images (D80: re-encode, max width – decide a larger limit for plans, e.g. 4000 px), paste/drag-drop. Plan kind as a backend module interface (`Validate`, `BOMLines`, later `Supplies`/`Demands`/`Checks`, architecture "Plan kind").
- **Plan content** saved as one document per plan: zones (name, colour, opacity, polygon ≥3 points in image px) and placements (variant id, chosen optional add-on variant ids, x/y centre, width/height, rotation [0,360), instance attribute values validated against the category's `instanceAttributes`, label). `PUT /api/plans/{id}/content` with `expectedUpdatedAt`; the backend validates (geometry inside the image, variant exists, add-ons are links of the variant, instance attributes valid), computes zone membership (centre of the box in the smallest containing polygon) and returns the saved content with warnings. Unknown/unavailable catalog references stay valid but are flagged (D54 availability).
- **Edit lock** (Q2 assumption): opening the editor takes a lock (heartbeat, expires after ~2 min without heartbeat); others see the plan read-only with "being edited by X"; admins/tenant admins may break a lock. Saves without the lock fail.
- **Editor** (react-konva on a shared canvas base): zoom (25–400 %), pan, fit; palette of the project's product types grouped by category with search; drag to place (default size from the image aspect, remembered size per product per project); select, multi-select, move, resize (aspect kept, Shift free), rotate (snap with modifier; never 360), duplicate, delete, keyboard shortcuts that do not fire inside inputs; zones: draw rectangle or polygon, edit vertices (add/remove), properties (name, colour, opacity); layers (by product type, category, zones); inspector panel for the selection (variant switch with required add-ons, optional add-ons, instance attributes, label); "smart sizing" toggle: resizing one placement resizes all placements of the same product on the plan (accepted recommendation); undo/redo (client-side history of the document); autosave (debounced) with visible save state and errors; PNG export at natural resolution; touch-friendly where cheap.
- **Version copy** extends to plans (file references shared — files are immutable and content-addressed, so no copy is needed).

## 2c – BOM and pricing (outline)

- BOM computed by a backend service from the version's plans (plan kind `BOMLines`): one line per variant + per add-on variant, grouped by product + variant + snapshot price, quantities per plan and per zone; plus manual lines (catalog variant or free text, quantity, price).
- **Price snapshots per version** (`version_items`: variant id → frozen name, model number, product type, category, unit price, image file): taken when a variant first appears in the version; "Update from catalog" previews the diff (price/name/availability changes) and applies selected or all. Catalog deletions keep snapshots with a null reference (D59).
- **Pricing per version** (accepted recommendation "invoice settings per version"): discount and services each as percent or absolute, computed once in the backend; project currency and rate (2a) convert; totals and rounding rules (money as integer cents or numeric, round half up per line in USD, converted total rounded to the currency's minor unit) defined once and tested.
- UI: BOM panel/page per version (grouped by product type/category, per-plan columns, zone filter), manual lines editor, pricing settings, update-from-catalog dialog with diff. Totals only from the API.

## 2d – Proposals (outline)

- Exporter registry in the backend (`GET /api/exporters`), canonical proposal document model built from project + version + BOM + pricing + plans, rendered by a DOCX exporter (Go, OOXML). Language = project language (Q1 assumption). Content: header with tenant and customer data, project number/name/version, quantity table with one column per plan and category rows, totals block (discount, services, grand total, local currency), zone summary per plan, plan images with placements (rendered server-side or uploaded from the editor's PNG export — decide).
- Split per product type (one document per selected type, discount/services handling decided and recorded — SnapFlow 1 applied them in full to every document).
- Each generated proposal is recorded (who, when, version, file) and downloadable again; tenant letterhead (logo, address) as tenant settings if cheap, else later.
