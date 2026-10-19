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

## 2b – Floorplan editor

### Model (tenant-owned, RLS like 2a, all queries through `database.InScope`)
- **plans**: `id`, `tenant_id`, `version_id`, `kind` (`floorplan`; `board` arrives in phase 3), `name` (1–100, unique per version ignoring case), `position` (order within the version, reorder endpoint like product types), `image_file_id` (tenant-scoped file, D79/D173), `image_width`, `image_height` (natural pixels of the stored image), `created_at`, `updated_at`, `content_updated_at` (the version of the content, D37), `scale` (optional: metres per pixel, set by a two-point calibration in the editor; used for a scale bar and sizes in metres later, nullable).
- **plan_zones**: `id` (uuid, generated by the client so undo/redo and selection keep identity), `plan_id`, `name` (1–100), `color` (`#rrggbb`), `opacity` (0–1), `points` (polygon in image pixels, 3–200 points, jsonb `[[x,y],…]`), `position` (draw order).
- **plan_placements**: `id` (client uuid), `plan_id`, `variant_id` (nullable: catalog deletions keep the placement, D59, flagged), `x`, `y` (centre, image px), `width`, `height` (> 0, ≤ image size), `rotation` [0,360) (360 normalised to 0, SnapFlow 1 bug 1), `label` (≤100, optional), `existing` (bool: the customer already has it — drawn hatched/badged, counts technically, never in BOM/prices/proposals; user, 2026-10-18), `addon_variant_ids` (chosen optional add-ons; required add-ons are implied and not stored), `instance_values` (jsonb, validated against the category's `instanceAttributes`), `zone_id` (computed by the backend, nullable), `position` (draw order).
- Plan content = zones + placements of one plan, saved as a whole: `PUT /api/plans/{id}/content` `{expectedContentUpdatedAt, zones[], placements[]}` replaces the stored content in one transaction (upsert by id, delete missing), returns the saved content with computed `zoneId`s and `warnings`.

### Backend rules
- Validation (field-located errors `body.placements[i].…`): geometry finite and inside the image (centre inside; boxes may overhang the edge), polygons simple enough (≥3 distinct points, inside the image), variant exists, every add-on id is an add-on link of the variant, instance values valid for the category's instance schema, ids unique. Limits: 2000 placements and 200 zones per plan.
- Warnings (not errors): variant/product/category/product type unavailable (D54), product type not chosen for the project, a required add-on is unavailable.
- Zone membership: the placement's centre in the smallest containing polygon (shoelace area), ray casting; recomputed on every save (zones and placements are saved together, so a zone move re-assigns).
- Read-only projects (D169) refuse every change; `projects.write` needed.
- **Edit lock** (Q2 assumption, now a decision): `POST /api/plans/{id}/lock` takes or renews the lock (heartbeat every 30 s; expires 2 min after the last heartbeat); held by another user → 409 `plan.locked` with the holder's name and expiry; `DELETE …/lock` releases; users with `projects.delete` may break a lock (`POST …/lock?force=true`). Content saves need the caller's live lock (`plan.lock_required`). `GET /api/plans/{id}` returns `lock {userId, name, expiresAt} | null`.
- Plans: `GET /api/versions/{versionId}/plans`, `POST` (multipart `name` + `image`), `PUT /api/plans/{id}` (rename, replace image: placements keep image-pixel coordinates; if the new image has another size, coordinates are scaled proportionally — decide and record), `DELETE`, `PUT /api/versions/{versionId}/plans/order`, `GET /api/plans/{id}/content`.
- Images: JPEG/PNG/WebP (magic bytes), up to 20 MB and 40 megapixels; stored re-encoded at most 4096 px on the long side (floorplans need more detail than catalog images, D80); tenant-scoped file. PDF upload is not in 2b (would need a PDF renderer; later).
- Version copy (`copyVersion`) copies plans, zones and placements (new ids; the image file is shared — files are immutable and content-addressed).
- Permissions as projects (read: `projects.read`; changes: `projects.write`).

### Editor (frontend, `src/features/plans`, react-konva on a shared canvas base for later plan kinds)
- Project page body: the version's plans as cards/tabs with thumbnail; Add plan (dialog: name + image via `ImageUpload`/drop/paste), rename, replace image, reorder, delete (confirm). Opening a plan opens the editor (route `/projects/:id/versions/:versionId/plans/:planId`).
- Layout: toolbar (select, pan, draw zone rectangle, draw zone polygon, calibrate scale, zoom −/+/fit, undo, redo, export PNG, save state), canvas, right panel with tabs **Products** (palette) / **Zones** / **Inspector** (selection). Phone: view-only canvas with zoom/pan and a list of zones and products (editing on phones is not a goal; tablets ≥ 768 px get the full editor).
- Palette: products of the project's product types (D41), grouped by category, search, thumbnails, `TypeBadge`; drag onto the canvas (or click then click to place). Default size: the last size used for that product in this project (from existing placements), else 60 px high at the image's aspect ratio of the variant image. Default variant: the product's first available variant.
- Canvas: zoom 10–800 % around the pointer (wheel / pinch), pan (space+drag, middle mouse, two fingers), fit to screen; select (click, shift-click, rubber band), move (drag, arrow keys 1 px / shift 10 px), resize with handles (aspect kept by default, shift = free), rotate handle (shift = 15° snap), duplicate (Ctrl/Cmd+D, alt-drag), delete (Del/Backspace), copy/paste within the plan, Esc deselects. Shortcuts never fire while typing in an input. Snap guides not required.
- "Resize all of this product" toggle in the inspector (smart sizing, accepted recommendation): applies the new size to every placement of the same product on the plan.
- Zones: draw rectangle or polygon (click points, double-click/Enter closes), move, edit vertices (drag; add a vertex by clicking an edge midpoint handle; remove with Alt-click or a button, min 3), properties in the inspector (name, colour from a palette or `ColorField`, opacity), list in the Zones tab with show/hide and device counts (counts from the backend's zone assignment after save; live estimate in the client is fine). New zones get "Zone n" (n = next free number) and the next palette colour.
- Placement rendering: the variant image fitted into the box (contain), border in the product type colour, label below when set, `existing` placements hatched with a badge, unavailable catalog references with a warning marker. Layers: toggle visibility per product type, per category and for zones.
- Inspector for a placement: product + variant select (switching keeps size), optional add-ons (checkboxes; required ones shown checked and disabled), instance attributes (`AttributeValuesEditor`, D65), label, existing switch, position/size/rotation numeric fields. Multi-selection: delete, existing toggle, align not required.
- Undo/redo of every content change (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z / Ctrl+Y), at least 100 steps, local to the session.
- Saving: autosave 1 s after the last change (and on leaving), one request in flight; visible state "Saved" / "Saving…" / "Unsaved changes" / "Save failed – Retry"; errors at the item (selecting it) and in a list; `plan.stale` (someone else saved) offers reload. The lock is taken when the editor opens and released on leave; without the lock the editor opens read-only with "Being edited by X until …" (and "Take over" for users who may break locks).
- Export PNG at natural resolution of the visible layers (zones with names, placements), file name from project number + plan name.
- Everything i18n (en + de), design-system components only (a canvas component set may be added to `components/ui` or a new `src/canvas` shared module, covered by the design-system test where it renders DOM).

### Tests
- Backend: plan CRUD/order/image replace, content save validation and limits, zone membership (nested zones, smallest wins, vertex on edge), warnings, lock lifecycle (take, renew, expire, conflict, force, save without lock), stale saves, read-only projects, RLS for the three tables, version copy including plans, image size limits.
- Frontend: Vitest for the plans list, dialogs, palette, inspector, undo/redo reducer, autosave state machine, lock banner; canvas interactions via the editor's state functions (geometry helpers unit-tested).
- E2E: create a plan with an image, place products, draw a zone, see the zone count, undo/redo, reload shows the saved content, second user sees the lock; layout matrix for the plans list and editor shell.

## 2c – BOM and pricing (outline)

- BOM computed by a backend service from the version's plans (plan kind `BOMLines`): one line per variant + per add-on variant, grouped by product + variant + snapshot price, quantities per plan and per zone; plus manual lines (catalog variant or free text, quantity, price). Placements marked `existing` produce no BOM lines (and no required add-on lines).
- **Price snapshots per version** (`version_items`: variant id → frozen name, model number, product type, category, unit price, image file): taken when a variant first appears in the version; "Update from catalog" previews the diff (price/name/availability changes) and applies selected or all. Catalog deletions keep snapshots with a null reference (D59).
- **Pricing per version** (accepted recommendation "invoice settings per version"): discount and services each as percent or absolute, computed once in the backend; project currency and rate (2a) convert; totals and rounding rules (money as integer cents or numeric, round half up per line in USD, converted total rounded to the currency's minor unit) defined once and tested.
- UI: BOM panel/page per version (grouped by product type/category, per-plan columns, zone filter), manual lines editor, pricing settings, update-from-catalog dialog with diff. Totals only from the API.

## 2d – Proposals (outline)

- Exporter registry in the backend (`GET /api/exporters`), canonical proposal document model built from project + version + BOM + pricing + plans, rendered by a DOCX exporter (Go, OOXML). Language = project language (Q1 assumption). Content: header with tenant and customer data, project number/name/version, quantity table with one column per plan and category rows, totals block (discount, services, grand total, local currency), zone summary per plan, plan images with placements (rendered server-side or uploaded from the editor's PNG export — decide).
- Split per product type (one document per selected type, discount/services handling decided and recorded — SnapFlow 1 applied them in full to every document).
- Each generated proposal is recorded (who, when, version, file) and downloadable again; tenant letterhead (logo, address) as tenant settings if cheap, else later.

---

## Outlook: phase 3 concept agreed with the user (2026-10-18/19)

Not built in phase 2; recorded so 2b–2d leave room for it. Customer-facing write-up: "SnapFlow – Distribution boards concept" PDF.

- **Zone needs**: each zone has a list of needs (function type, quantity, power per unit, load type, note); room templates fill it. Loads are not catalog products and not in the BOM.
- **Product capabilities** come from Excel columns (e.g. "Dimmer outputs", "Relay outputs", "Inputs", "Bus current (mA)", "Width (TE)"): the numbers live only in the product rows. A category holds no numbers; it has fields, and each field has a **meaning** for the board check (outputs of a kind supplied, limit per output, bus current used / supplied, rail space, wireless places …) or "just information".
- **Field meanings are defined once per column for the whole catalog** (user, 2026-10-19). The import checks each mapped column: known columns take their type and meaning automatically; unknown columns are listed on the mapping page ("New columns – what do they mean?") and the user sets type and meaning before the preview continues; the answers are saved for every later import and category. Categories created by the import therefore come out complete.
- **Mounting** per category (floorplan / board / both), overridable per product.
- **Matching and checks**: each need is connected to a channel whose output kind serves its function type and whose limits hold; several needs may share a channel (circuit). Checks: rooms covered, free/missing channels, overloads, bus current and devices per bus line (a bus line belongs to one system), rail space, Zigbee gateway places (gateway field "Max devices"; each Zigbee device uses 1 place; devices connected to a gateway, suggested by floor/nearness). Empty fields do not count; Zigbee products need nothing.
- **Existing devices** (placements flagged `existing`, 2b) count technically and are programmed later, but never invoiced.
- **Later**: programming export per system (Zigbee device list per gateway, KNX addresses for ETS, HDL subnet/device IDs) from the planned data plus per-unit fields filled in on site.
