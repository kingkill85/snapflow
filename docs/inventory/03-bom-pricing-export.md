# 03 — BOM, Pricing, Proposals/Invoices, Settings (SnapFlow 1 inventory)

## Summary
- BOM = `project_bom` rows (per floorplan): one main entry plus addon child rows. Each row holds a frozen snapshot (name, type name, style, model #, unit price, its own copied image) and catalog references (item_id, variant_id). Quantity is the number of placements that point at the main entry. Prices are summed as plain floats with no rounding and no tax.
- Pricing on top of the BOM is per **project group** (customer), not per version: an absolute USD discount, an absolute USD services fee, and a manual exchange rate to a local currency (default PKR). The percentage fields only show a reference amount. The same arithmetic exists 5 times (backend service plus 4 frontend places) and the copies disagree on clamping at 0.
- The only proposal output is a **DOCX** generated in the browser (`docx` lib): a pivot of items by floorplan, a totals block, and an area/category count summary. It can be split into one document per item type. There is NO Excel/PDF proposal export (the PDF button is permanently disabled), NO branding/logo, and NO tenant settings. The only app setting is `last_sync_timestamp`, used for image cache busting.

## Entities & fields

### `project_bom` (final schema after migrations 023→026→030→032; `backend/src/scripts/migrate.ts:580-612,709,808`)
| field | type | notes |
|---|---|---|
| id | INTEGER PK | |
| project_id | INT NOT NULL → projects | no ON DELETE CASCADE after 026 |
| floorplan_id | INT NOT NULL → floorplans | no CASCADE after 026 (deletes are done manually in repo) |
| item_id | INT NULL → items | set to NULL when the catalog item is deleted (`bom-entry.ts:222`) |
| variant_id | INT NULL → item_variants | set to NULL when the variant is deleted (`bom-entry.ts:215`) |
| parent_bom_id | INT NULL → project_bom | NULL = main entry, otherwise addon child |
| area_id | INT NULL | added in 030; **never written by BOM code** (only copied when a version is created) |
| item_name | TEXT NOT NULL | snapshot of items.name |
| item_type_name | TEXT NULL | snapshot of item_types.name; legacy rows backfilled with `'Zigbee'` (`migrate.ts:811`) |
| style_name | TEXT NULL | snapshot of variant.style_name |
| model_number | TEXT NULL | main: `item.base_model_number \|\| variant.style_name`; addon: `item.base_model_number \|\| ''` |
| unit_price | REAL NOT NULL | snapshot of variant.price |
| picture_path | TEXT NULL | relative upload path, target form `projects/{projectId}/bom-images/{bomId}-{origFileName}` |
| created_at / updated_at | DATETIME | updated_at is bumped on every repo update |

- Unique index `(floorplan_id, variant_id) WHERE parent IS NULL` was dropped in 025. Many main entries per variant per floorplan are allowed (`migrations/025_*.sql`).
- Computed API-only fields: `is_available` (children), `children`, `placement_count` (declared in the type, never set) (`backend/src/models/index.ts:300-321`).

### `placements` (BOM-relevant part)
- `bom_id` → project_bom ON DELETE CASCADE; `type` ('item' | 'area'); `area_id` (area placement id). Item placements expose `item_id` and `item_variant_id` through an INNER JOIN on project_bom (`backend/src/repositories/placement.ts:13-38`). Quantity = COUNT(placements WHERE bom_id = main.id).

### `project_groups` invoice settings (migration 037; `migrate.ts:1031-1043`; model `backend/src/models/project-group.ts:10-16`)
| field | DB default | validation (`project-groups.ts:26-31`) |
|---|---|---|
| discount_percentage REAL | 0 | 0..100 |
| discount_usd REAL | 0 | ≥0 |
| services_percentage REAL | 0 | 0..100 |
| services_usd REAL | 0 | ≥0 |
| local_currency_code TEXT | NULL | exactly 3 chars (case not validated) |
| exchange_rate REAL | 1.0 | ≥0 |
- `projects.google_exchange_rate REAL DEFAULT 1.0`: legacy. It is read and copied when a version is created (`project-group.ts:170-192`), but never set or shown.

### `app_settings` (`migrations/029_add_app_settings.sql`)
- `key TEXT PK, value TEXT NOT NULL, updated_at`. The only key is `last_sync_timestamp` (ms epoch as a string, seeded with `'0'`).

### `bom_image_migration` (created at runtime, `backend/src/services/bom-image-migration.ts:20-32`)
- `id, bom_entry_id UNIQUE, old_picture_path, new_picture_path, migrated_at, status ∈ {pending, completed, failed}`.

### API/DTO shapes
- `BomGroup {mainEntry, children[], quantity, totalPrice, bomEntryIds[], isAvailable}`; `FloorplanBom {floorplanId, groups[], totalPrice}` (`backend/src/services/bom.ts:12-25`).
- `ChangeReport {updated[{entryId,name,oldPrice,newPrice}], invalid[{entryId,name,reason}], totalBefore, totalAfter}` (`bom.ts:27-41`).
- `InvoiceCalculationResult {bomTotal, discountAmount, discountPercentage, servicesAmount, servicesPercentage, totalAfterDiscount, grandTotalUsd, grandTotalLocal, localCurrencyCode, exchangeRate}` (`backend/src/services/invoice-calculation.ts:6-17`).
- FE `FloorplanItem {name, quantity, unitPrice, total, categoryId, categorySortOrder, categoryName, isAddon, parentItemName, itemTypeName}`; `FloorplanTotal {floorplan, total, items[]}` (`frontend/src/services/bom.ts:40-57`).

## API endpoints
| method + path | auth | purpose | ref |
|---|---|---|---|
| GET `/api/floorplans/:id/bom` | auth only, **no tenant check** | grouped BOM plus floorplan total | `backend/src/routes/floorplans.ts:292` |
| POST `/api/floorplans/:id/bom-entries` `{variant_id}` | auth, no tenant | get or create a main entry plus required addons (201) | `floorplans.ts:317` |
| PUT `/api/floorplans/:id/bom-entries/:entryId/variant` `{variant_id}` | auth, no tenant; `:id` ignored | switchVariant | `floorplans.ts:346` |
| DELETE `/api/floorplans/:id/bom-entries/:entryId` | auth, no tenant; `:id` ignored | delete the entry, its children, its placements and its images | `floorplans.ts:367` |
| POST `/api/floorplans/:id/bom/update-from-catalog` | auth, no tenant | re-snapshot prices; returns ChangeReport | `floorplans.ts:386` |
| GET `/api/bom-entries/:id` | auth; non-admin must match tenant via projects.tenant_id, else 404 (403 if there is no tenantId) | read a single entry | `backend/src/routes/bom-entries.ts:16-40` |
| POST `/api/placements` | auth, no tenant | createBomEntry (reuse), then the placement, then area containment | `backend/src/routes/placements.ts:114` |
| PUT `/api/placements/:id/variant` `{variant_id}` | auth | switchVariant on the placement's (shared) entry; 400 for an area placement | `placements.ts:189` |
| POST `/api/placements/:id/update-bom` `{variant_id, addon_ids[]=[]}` | auth | recreateBomEntry (new entry for this placement) | `placements.ts:232` |
| DELETE `/api/placements/:id` | auth | delete the placement; if the entry now has 0 placements, deleteBomEntry | `placements.ts:266`, `:12-18` |
| POST `/api/placements/:id/duplicate` `{x,y}` | auth | duplicate the entry (main + children) and add a new placement with the same size/rotation | `placements.ts:303` |
| GET `/api/projects/:id/total` | auth + tenant (project ctx) | `{totalPrice}` = sum of floorplan totals | `backend/src/routes/projects.ts:82` |
| GET `/api/projects/:id/invoice-calculation` | auth + tenant | backend invoice calculation using the group settings | `projects.ts:104-145` |
| PUT `/api/project-groups/:id/invoice-settings` | auth + tenant (group ctx); **no role check** | partial update of the 6 invoice fields; response is the full group | `backend/src/routes/project-groups.ts:126-160` |
| PUT `/api/project-groups/:id` | auth + tenant | same 6 fields accepted together with customer fields | `project-groups.ts:79-123` |
| GET `/api/currency/exchange-rate/:code` | auth | `{rate, fromCache, currencyCode(upper)}`; 500 on failure | `backend/src/routes/currency.ts:7-25` |
| GET `/api/settings/last-sync-timestamp` | auth | `{success:true, data:{timestamp}}` (non-standard envelope); 500 `{success:false,error}` | `backend/src/routes/settings.ts:17-34` |
| MCP `get_floorplan_bom`, `get_invoice_calculation`, `get_project_total`, `get_version_total` | OAuth token | proxies to the routes above, adding placement coordinates, areas and canvas size | `backend/src/services/mcp/tools/get-floorplan-bom.ts:103-238`, `get-invoice-calculation.ts:9-27` |

## Acceptance criteria

### A. BOM entry creation and snapshots
1. Creating a placement for variant V on floorplan F reuses ANY existing main entry with `floorplan_id=F AND variant_id=V AND parent_bom_id IS NULL`, whatever addon config that entry has (first row, no ORDER BY). Otherwise a new entry is created. `backend/src/services/bom.ts:89-97`, `backend/src/repositories/bom-entry.ts:45-59`
2. A new main entry snapshots `item_name=item.name`, `item_type_name=item_types.name or null`, `style_name=variant.style_name`, `model_number=item.base_model_number || variant.style_name`, `unit_price=variant.price`, and the catalog refs item_id/variant_id. `bom.ts:114-126`
3. Missing variant → error "Variant not found". Missing item → "Item not found". Routes map both to 500. `bom.ts:100-108`, `floorplans.ts:337-340`
4. On create, addon child rows are created only for addons with `is_required` (= NOT variant_addons.is_optional) AND `addon_variant.is_active`. Here is_active = variant.is_active AND addon item.is_active. Child snapshot: `model_number = addonItem.base_model_number || ''`, `unit_price = addon variant price`. `bom.ts:143-195`, `backend/src/repositories/variant-addon.ts:26,38`
5. Every entry (main or child) gets its own image copy at `projects/{projectId}/bom-images/{entryId}-{sourceFileName}`. If the source is missing, `copyFile` returns the source path and the entry keeps the catalog path. On any other copy error the catalog path is also kept. A null source image gives picture_path null. `bom.ts:51-77`, `backend/src/services/file-storage.ts:79-113`
6. FE drop flow: always calls POST /placements and then POST /placements/:id/update-bom with addon_ids. The addon_ids come from per-item localStorage memory (if not ignoreDefaults) or default to required+active addons. Net effect: every placement ends up with its own BOM entry. `frontend/src/hooks/useDragHandlers.ts:395-428`, `frontend/src/hooks/usePlacements.ts:92-113`

### B. Update BOM / switch variant / duplicate / delete
7. `recreateBomEntry(placement, variant, addonIds)` always creates a NEW main entry with fresh snapshots and one child per id in addonIds. Each id is a variant id, used without validation (not checked as linked, required or active; duplicates allowed). Unknown ids are skipped. The placement is re-pointed to the new entry. The old entry is deleted only if no placement references it any more. `bom.ts:306-423`
8. `switchVariant(entry, newVariant)` mutates the entry IN PLACE: variant_id, item_name, item_type_name, style_name, model_number, unit_price, and picture_path (a new copy, or null if the new variant has no image). It deletes all children and re-adds the required+active addons of the new variant. It changes every placement that shares the entry. `bom.ts:204-300`
9. Duplicate placement: copies the main entry and its children with identical snapshot values (incl. unit_price). New images are copied from the old entry images. Width, height and rotation of the placement are copied; x/y come from the request. Area containment is rechecked. `bom.ts:674-744`, `placements.ts:303-344`
10. Deleting the last placement of an entry deletes the entry, its children and their image files. Images are kept if any other project_bom row references the same path. `placements.ts:12-18,278-286`, `bom-entry.ts:164-203`
11. Deleting a BOM entry via the floorplan route also deletes all of its placements. `bom-entry.ts:177-186`
12. Deleting a catalog item or variant keeps BOM rows and sets item_id/variant_id to NULL (history kept). `bom-entry.ts:215-227`, `backend/src/repositories/item-variant.ts:166`, `backend/src/repositories/item.ts:387`
13. Deleting a floorplan deletes its BOM rows and placements. Images with prefix `projects/` that no longer have a reference are removed. `floorplans.ts:195-268`
14. Creating a project version copies all BOM rows (incl. item_type_name and area_id) with remapped parent ids and gives each row its own image copy. If the copy fails, picture_path is NULL. Placements are remapped to the new bom ids. `backend/src/repositories/project-group.ts:224-306,459-471`

### C. BOM grouping and totals (backend, the source of truth for display totals)
15. Main entries are ordered `parent_bom_id NULLS FIRST, created_at DESC` (newest first). Children are taken from the same query. `bom-entry.ts:22-32`
16. Quantity per main entry = COUNT(placements.bom_id = entry.id), default 0. `bom.ts:450-462,512`
17. Group key = `${main.variant_id}:${children.variant_id sorted (default string sort) joined by ','}`. Entries with the same key merge into one group: `quantity += qty`, the id is added to `bomEntryIds`. mainEntry, children and isAvailable are taken from the FIRST entry seen. `bom.ts:555-573`
18. **Group total = main.unit_price × quantity + (Σ children.unit_price) × quantity**, using the first entry's prices for the whole merged quantity. `bom.ts:576-589`
19. Floorplan total = Σ group totals. Project total = Σ floorplan totals over `floorplanRepository.findByProject`. No rounding anywhere. `bom.ts:592,614-626`
20. Main `isAvailable` = false if item_id or variant_id is null, the item is missing or inactive, or the variant is missing or inactive. Each child gets the same check as `is_available`. Group-level isAvailable does NOT consider children. `bom.ts:515-551`
21. Entries with quantity 0 still appear in groups (they add 0 to the total). The BOM panel hides groups with `quantity > 0` false. `frontend/src/components/configurator/BomPanel.tsx:153`

### D. Update from Catalog
22. For each row of the floorplan (main and children): if the variant is missing, or the item/variant is inactive, the row goes into `invalid` with reason `'Variant not found in catalog'` (no variant) or `'Item/variant inactive'`. In practice only variant.is_active is checked. `bom.ts:770-781`
23. The snapshot is updated ONLY when `variant.price !== entry.unit_price`. Then item_name, style_name, model_number and unit_price are re-snapshotted, and the image is re-copied (or the old one kept if the variant has no image). item_type_name is NOT updated. If only the name, style or image changed, nothing is updated. `bom.ts:784-811`
24. `totalBefore` and `totalAfter` = Σ(main.unit_price × placementCount) over main entries only, **excluding addons** (differs from the BOM total). `bom.ts:763-767,815-820`
25. UI: the button in the BOM panel is hard-disabled ("Update from catalog (coming soon)"). The report UI (price changes, invalid refs, before/after with 2 decimals) exists but cannot be reached. `BomPanel.tsx:40-54,99-150`

### E. BOM panel display (FE)
26. Header: "{n} product groups". Each card shows image (or "No img"), item_type_name under the image, `item_name - style_name`, model # (or "No model #"), badge `x{qty}`, `$unit each`, and area badges. Area badges are the distinct area_ids of the group's placements: area name in area colour, otherwise "Unassigned". `BomPanel.tsx:158-233`
27. The card's right-hand amount = main.unit_price × qty (addons excluded). When collapsed with addons: "+ N Add-On(s)" and group.totalPrice. Expanded: children each show `x{groupQty}`, `$unit each` and `unit×qty`, plus "Group Total". Footer shows "Floorplan Total" = bom.totalPrice. All amounts use en-US with 2 decimals. `BomPanel.tsx:235-321`
28. An unavailable item shows a red background tint and an AlertCircle "Product no longer available in catalog". An unavailable child shows "Add-on no longer available in catalog". `BomPanel.tsx:158,191-195,274-278`

### F. Item aggregation for Summary/DOCX (FE `useBomCalculations`)
29. Per floorplan, each group yields one main line and one line per child. Main name = `item_name` + ` (style_name)` if a style is set. Main key = `[typeName] name` if the type is known, else name. Addon key = `${mainKey} > ${childName}`. Lines with the same key are summed: `quantity += group.quantity`, `total += unit_price × group.quantity`. unitPrice stays the first one seen. `frontend/src/hooks/useBomCalculations.ts:17-92`
30. Category and type come from the LIVE catalog (`items.find(id === mainEntry.item_id)`), not from snapshots. If missing: categoryId 0, sortOrder MAX_SAFE_INTEGER, name 'Other', type null. Addons inherit the parent's category and type. `useBomCalculations.ts:22-27,69-74`
31. Floorplan total = backend `bom.totalPrice` (0 if there is no BOM or no groups). projectTotal = Σ floorplan totals in the order of the `floorplans` array. `useBomCalculations.ts:95-118`

### G. Invoice settings and calculation
32. Settings belong to the project group, so all versions share them. Save = PUT `/project-groups/{groupId}/invoice-settings` with all 6 fields. After saving, the FE merges the response into its group state and switches to the Summary tab. `frontend/src/services/invoice-settings.ts:32-39`, `frontend/src/pages/projects/ProjectDashboard.tsx:591-605`
33. Backend calculation: `discountAmount = discount_usd`; `servicesAmount = services_usd`; `totalAfterDiscount = bomTotal − discount_usd`; `grandTotalUsd = totalAfterDiscount + services_usd`; `grandTotalLocal = grandTotalUsd × exchange_rate`. Negative results are allowed. The percentages are passed through unchanged. `backend/src/services/invoice-calculation.ts:35-58`; test `backend/tests/services/invoice-calculation_test.ts:89-105`
34. The percentages are reference values only: `reference = bomTotal × pct/100`. They are shown next to the inputs and never applied, and the USD amounts are not auto-filled from them. `frontend/src/components/invoice/InvoiceSettingsModal.tsx:103-109`, `invoice-calculation.ts:66-78`
35. Modal: inputs for discount %/USD, services %/USD and "Your Rate (1 USD)". There is NO currency-code input: the code is `initial.local_currency_code || 'PKR'`. Zero values show as empty fields. Unparseable or empty input → 0. Title "Configure Invoice"; buttons Cancel / "Save Changes" ("Saving..."). Errors: the server message or "Failed to save invoice settings". `InvoiceSettingsModal.tsx:46-94,140-162,173-391`
36. Modal preview: Project Total; Discount row if >0 (`-$x USD`); Services row if >0; `Grand Total USD = max(0, max(0, bom − disc) + services)`; local row only if rate > 0: `grandUsd × rate`, 0 decimals + code. `InvoiceSettingsModal.tsx:112-122,332-368`
37. "Google Rate" refresh button: calls GET /currency/exchange-rate/{code} and only displays the rate (2 decimals). It is never saved or applied. Failure → "Failed to fetch exchange rate. Please try again." `InvoiceSettingsModal.tsx:124-138,288-310`
38. Exchange-rate service: fetches `https://open.er-api.com/v6/latest/USD`. The code is upper-cased. All returned rates are cached in memory for 5 min. On error the expired cached rate is used if present, otherwise the error propagates (500). An unknown code throws. `backend/src/services/currency.ts:26-84`
39. Summary tab: per-floorplan totals plus "Project Total" (2 decimals). `hasInvoiceSettings = settings && (discount_usd>0 || services_usd>0 || exchange_rate>0)`. If false: "Configure invoice settings to see breakdown." and NO DOCX button. Otherwise the summary shows Discount (if >0), Services (if >0), `Grand Total USD = (project − disc) + services` (not clamped), and `Grand Total {code}` (0 decimals) if rate > 0. `frontend/src/components/invoice/SummaryTab.tsx:71-83,166-260`
40. Role gating is FE-only: `canEdit = role !== 'user'`. Users get a no-op configure button but can still generate the DOCX. The backend invoice-settings route has no role check. `ProjectDashboard.tsx:79,806`, `project-groups.ts:126`

### H. DOCX proposal generation (`frontend/src/services/invoice-docx.ts`)
40a. Trigger "Create Invoice (DOCX)". If ≤1 item type is present among the aggregated lines (via the live-catalog type name), one unfiltered document is generated. Otherwise ExportTypeDialog opens ("Export Proposals", one checkbox per type with a colour dot, button "Export N Proposal(s)"), and one document is generated per selected type. `SummaryTab.tsx:52-61,85-137`, `frontend/src/components/invoice/ExportTypeDialog.tsx:16-49`
41. Area data for all floorplans is fetched on demand (areas and placements per floorplan, sequentially). `ProjectDashboard.tsx:437-447`
42. Document defaults: font "Bahnschrift Light", 9 pt. Header paragraphs, 11 pt bold: `Project: {customer} - {version}`, `Customer: {customer}`, `Ref: {YYYY-MM-DD of version created_at (UTC)}_{customer}_{address || 'No Address'}`. `invoice-docx.ts:660-689`, `ProjectDashboard.tsx:38-44,799-801`
43. Main table columns: `#` (8%), `Item Description` (28−2·nFloors %), one column per floorplan (name, 12% each, floorplans order), `Total\nQuantity` (8%), `Unit Price ($)` (8%), `Total` (8%). Header shading E0E0E0, single black borders. `invoice-docx.ts:316-371`
44. Pivot: per-floor quantities are summed by key. Main key = `item.name` (= "name (style)", **without type**). Addon key = `${parentItemName} > ${name}`. totalQuantity and total are summed; unitPrice = first seen. With a type filter, only lines whose itemTypeName === filter are kept (addons by their parent's type). `invoice-docx.ts:63-98`
45. Ordering: categories grouped by **name**, sorted by category sort_order ('Other'/unknown last). Within a category, main items are sorted A→Z (localeCompare), each followed directly by its addons A→Z. Addons whose parent is not in the category are appended at the end. `invoice-docx.ts:100-146`
46. Before the first item of each category a full-width category row is inserted (bold, shading D0D0D0, colSpan = nFloors+5 — the code writes nFloors+6 for a 5+nFloors-column table, see bug list). Row numbers `#` run 1..n across all data rows (addons included, category rows not counted). Addon descriptions are prefixed with `"  ↳ "`. Floor cells show the qty, 0 if none. `invoice-docx.ts:374-442`
47. Money in the table: `$` + `toLocaleString('en-US')` (0–3 decimals, NOT fixed at 2). `invoice-docx.ts:432-436`
48. Totals block (label colSpan = nFloors+3, value colSpan = 2, right-aligned, 10 pt bold):
    - `Total for all floors (USD)` = projectTotal, or, when filtered, Σ of the filtered pivot totals;
    - if discount_usd > 0: `DISCOUNT` (red FF0000) `-$disc`, then `Total after Discount (USD)` = **max(0, total − disc)**;
    - if services_usd > 0: italic `System Design, Programming & Commissioning` `$services`;
    - `Grand Total (USD)` = **max(0, afterDiscount + services)**;
    - if exchange_rate > 0: `Grand Total ({code||'PKR'})` = `{code} {Math.round(grandUsd × rate) en-US}`.
    `invoice-docx.ts:444-637`
49. Discount and services are applied in full to EACH per-type document (not prorated). `invoice-docx.ts:309-311,445-448`
50. Area summary: a second section (new page) containing, per floorplan, a heading `"{floorplan} — Area Summary"` (12 pt bold). Counts include only item placements (filtered by the live-catalog type when filtered); addons are not counted. Columns: `Area` (max(20, 40−2n)%) plus one column per category present (sorted by sort_order), header `"{cat} ({total})"`. Rows: areas in API order, skipped if they have 0 devices, then `Unassigned` if any. Zero cells are blank. With no categories present: "No devices placed in this floorplan." `invoice-docx.ts:149-303,644-695`
51. File name: `{projectName without /\:*?"<>|}{suffix with '_'→' '} Proposal.docx`. The suffix is `_{typeName stripped to [a-zA-Z0-9-_ ]}` for per-type documents. The file is downloaded via a temporary `<a>`. `invoice-docx.ts:699-707`, `SummaryTab.tsx:119`

### I. App settings and image cache busting
52. `last_sync_timestamp` is set to `Date.now()` after a successful Excel sync. GET returns 0 if it was never set. `backend/src/services/excel-sync.ts:203`, `backend/src/repositories/settings.ts:48-59`
53. The FE loads the timestamp once on app mount (only if an access token exists). `itemService.getImageUrl` appends `?t={ts}` when ts > 0, otherwise it returns the plain `/uploads/{path}`. Any fetch error → 0. `frontend/src/context/SyncContext.tsx:16-32`, `frontend/src/services/item.ts:209-215`, `frontend/src/services/settings.ts:19-30`

### J. BOM image migration
54. On server start (after migrations; failures do not stop the server): every row whose picture_path is not null, does not start with `projects/`, and has no 'completed' tracking row is copied to `projects/{pid}/bom-images/{id}-{file}`. picture_path is updated and the result recorded as completed. If the source is missing or an error occurs, it is recorded as failed and retried on every start. `backend/src/services/bom-image-migration.ts:37-58,63-99,122-180`, `backend/src/main.ts:268-277`
55. Script `migrate-bom-images.ts` (manual): the same copy, but only for `items/` paths. It skips `projects/` and other paths, and skips missing sources. There is no tracking table. It prints a summary. `backend/src/scripts/migrate-bom-images.ts:24-105`
56. Script `fix-shared-bom-images.ts` (dry run by default, `--apply` to write). Phase 1: for a path referenced by ≥2 rows, the oldest row (created_at, id) keeps the file and every other row gets its own copy (skipped if the source is missing). Phase 2: rows whose file is missing are recovered from `item_variants.image_path` if possible, otherwise counted as unrecoverable. It throws if copyFile fell back to the source. `backend/src/scripts/fix-shared-bom-images.ts:54-75,77-221`

## Duplicated logic (frontend vs backend)
| # | calculation | locations | differences |
|---|---|---|---|
| D1 | Invoice grand total | BE `invoice-calculation.ts:35-58`; FE `SummaryTab.tsx:71-77`; FE `InvoiceSettingsModal.tsx:112-122`; FE `invoice-docx.ts:445-451`; FE dead `InvoiceSummary.tsx:21-27` | BE and SummaryTab: no clamp (negatives allowed). Modal: clamps both afterDiscount and grand total at ≥0. DOCX: clamps both. InvoiceSummary: clamps only afterDiscount. Default rate: BE uses the raw value; FE uses `rate || 0`. Default currency: BE passes NULL through; FE uses `'PKR'`. **FE never calls the BE endpoint** (`invoiceSettingsService.getCalculation` is unused). |
| D2 | Percentage reference | BE `calculateDiscountReference/ServicesReference` (`invoice-calculation.ts:66-78`, unused); FE modal `:103-109` | Identical formula. The BE copy is dead. |
| D3 | Currency formatting | BE `formatAmount` (PKR 0 decimals, others 2; unused) `invoice-calculation.ts:86-93`; FE UI: local always 0 decimals, USD 2; DOCX: USD 0–3 decimals, local `Math.round` | Rules are inconsistent (BE: decimals by currency; FE UI: decimals by local vs USD). |
| D4 | Group/floorplan totals | BE `bom.ts:576-592`; FE BomPanel uses BE `totalPrice` but computes the per-row `unit_price × qty` itself (`BomPanel.tsx:237,297`); FE `useBomCalculations` recomputes line totals `unit_price × qty` (`:32,57`) | FE line totals use each group's own mainEntry price, the same simplification as BE. Mathematically equal to the BE totals. Float sum order may differ. |
| D5 | Project total | BE `getProjectTotal` (`bom.ts:614-626`, used by `/projects/:id/total`, invoice-calculation, MCP); FE `useBomCalculations.ts:116-118` | Same formula. FE sums only loaded BOMs (a floorplan whose BOM has not loaded yet counts as 0). |
| D6 | Required-addon defaulting | BE createBomEntry/switchVariant (`required && addon_variant.is_active`) `bom.ts:145-148,257-260`; FE drop (`is_required && is_active`) `useDragHandlers.ts:400-403`; FE edit modal on variant change (`is_required` only, inactive ones included) `ConfiguratorCanvas.tsx:743-745` | The edit modal can pre-select required-but-inactive addons. Its checkbox is disabled, so the user cannot remove them, and the BE accepts them (no validation in recreateBomEntry). |
| D7 | Availability | BE group `isAvailable` (`bom.ts:515-551`: item and variant active); BE updateFromCatalog (`bom.ts:773`: only variant active); FE edit modal (live items list: item missing, inactive, or variant not in the active list) `ConfiguratorCanvas.tsx:665-698` | Three different definitions. |
| D8 | Category/type for lines | FE aggregate uses the live catalog type/category; BomPanel shows the snapshot `item_type_name`; DOCX area summary uses the live catalog | Snapshot vs live disagree after a catalog change or item deletion. |
| D9 | Image copy naming `{bomId}-{file}` under `projects/{pid}/bom-images` | `bom.ts:51-77`, `bom-image-migration.ts:63-99`, `migrate-bom-images.ts:72-82`, `fix-shared-bom-images.ts:49-75`, `project-group.ts:459-471` | Five copies. Only fix-shared and project-group treat "copy returned source" as a failure. |

## Edge cases & quirks
- **Price divergence inside a group**: entries with the same variant and addon set but different snapshot prices are merged, and the total uses only the first entry's price × the merged qty (`bom.ts:558-579`). The FE aggregation (`useBomCalculations.ts:35-38`) and the DOCX pivot (`invoice-docx.ts:78-81`) keep the first unitPrice and sum totals, so `unitPrice × qty ≠ total` can appear in the DOCX.
- Entries whose variant was deleted (variant_id NULL) share the key `"null:…"`, so different deleted products with the same addon set merge into one group (`bom.ts:556`).
- The DOCX pivot key has no type: in an unfiltered export, same-named products of different item types merge into one row (`invoice-docx.ts:75`). Addons are keyed by parent name without type as well.
- `hasInvoiceSettings` is false when discount, services and rate are all 0. In that case the DOCX button is hidden, so a plain BOM proposal cannot be exported (`SummaryTab.tsx:79-83,260`). Because the DB default `exchange_rate = 1.0`, new groups count as configured and show "Grand Total PKR" = USD × 1.
- The currency code cannot be changed in the UI (no input). It stays 'PKR' unless set via the API (`InvoiceSettingsModal.tsx:79,88`).
- Validation rejects negative discount/services (`min(0)`), although the BE service comment and tests say negatives are allowed (`project-groups.ts:27-29` vs `invoice-calculation.ts:36`).
- The type-filtered DOCX drops lines whose item is no longer in the catalog (type null) from every per-type document.
- With ≥2 types, ExportTypeDialog's initial selection is computed at mount, when `availableTypes` is still `[]` (item types are fetched async). All boxes start unchecked and Export is disabled until the user ticks one (`ExportTypeDialog.tsx:17`, `SummaryTab.tsx:46-61,289-295`).
- SummaryTab `isLoading` (`floorplans.length>0 && floorplanTotals.length===0`) can never be true in the app because floorplanTotals maps floorplans one-to-one (`SummaryTab.tsx:140`).
- After the FE drop flow, every placement has its own BOM entry and image file. Placements created via a direct API call (no update-bom) share an entry, so a later `PUT /placements/:id/variant` changes all of them.
- `PUT /floorplans/:id/bom-entries/...` and DELETE ignore `:id`. The entry can belong to another floorplan or tenant.
- updateFromCatalog totals exclude addon prices; the BOM totals include them.
- The duplicate image name accumulates prefixes (`{newId}-{oldId}-{file}`) because the source is already a project path (`bom.ts:61-62,699-704`).
- switchVariant onto a variant without an image sets picture_path null and leaves the old file orphaned. Copies with the same entry id overwrite the old file (same name).
- The SyncContext timestamp is loaded only at mount with an existing token. After a fresh login, or an Excel sync in the same session, no refresh happens until reload (`refreshTimestamp` is never called).
- MCP `get_invoice_calculation` advertises "subtotal, tax"; no tax exists (`get-invoice-calculation.ts:11`).

## Suspected bugs / dead code
1. **Catalog image deletion risk**: `BomEntryRepository.delete` deletes the file at every picture_path, not only `projects/`, when no other BOM row references it (`bom-entry.ts:191-202`). Entries that still hold `items/...` paths (failed copy or migration fallback, `bom.ts:72-76`, `file-storage.ts:91-112`) can delete the catalog variant image. `deleteBomEntry` then runs a second, redundant cleanup (`bom.ts:642-667`).
2. Grouping prices merged entries by the first entry only (see quirks). Totals are wrong if snapshots differ (`bom.ts:576-579`).
3. FE `bomService.switchVariant` calls `PUT /bom-entries/:id/variant`, which does not exist (only GET is defined). The method is also unused (`frontend/src/services/bom.ts:88-93`, `bom-entries.ts:16`).
4. switchVariant does not update `item_id`. Passing a variant of a different item leaves item_id inconsistent (`bom.ts:235-243`).
5. updateFromCatalog: the item.is_active check is missing despite the reason text; item_type_name is not refreshed; only price changes trigger updates (`bom.ts:773-800`).
6. duplicateBomEntry drops `item_type_name` (not passed to create) (`bom.ts:685-696,715-726`).
7. Floorplan/placement BOM routes have no tenant isolation (cross-tenant read and write by id) (`floorplans.ts:292-411`, `placements.ts`).
8. Invoice-settings mutation has no role check (users can change it via the API) (`project-groups.ts:126`).
9. DOCX category header `columnSpan = nFloors + 6`, but the table has nFloors + 5 columns (`invoice-docx.ts:374`). The code comment counts 6.
10. DOCX column widths do not sum to 100% (e.g. 1 floor: 8+26+12+24 = 70%) (`invoice-docx.ts:316-319`).
11. DOCX area-summary comment says "each floorplan on a new page", but all floorplans are in one section (one page break total) (`invoice-docx.ts:690-694`).
12. The startup image migration retries failed rows forever (it excludes only 'completed') and does not restrict to `items/` (`bom-image-migration.ts:43-50`).
13. `project_bom.area_id` is never maintained (placements carry area_id). `projects.google_exchange_rate` is unused.
14. Dead code: FE `InvoiceSummary` component; `invoiceSettingsService.getCalculation`; FE `bomService.createBomEntry/switchVariant/deleteBomEntry`; BE `formatAmount`, `calculate*Reference`, `currencyService.getUSDtoPKRRate/getCacheStatus/clearCache` (tests only), `getMigrationStats`, `resetMigration`, `bomEntryRepository.findAll/findByItem`, `BomGroup` debug `console.log` noise (`bom.ts:594-602`, `:144-194`). The "Generate Presentation (PDF)" button is permanently disabled (`SummaryTab.tsx:262-269`). The Update-from-Catalog button is permanently disabled.
15. Migration 026 recreated `project_bom` without ON DELETE CASCADE on project_id, floorplan_id and parent_bom_id. Cleanup relies entirely on repository code (`migrate.ts:586-600`).
16. `PUT /project-groups/:id/invoice-settings` reuses `updateGroupSchema` and silently accepts and ignores customer fields (`project-groups.ts:126,131`).
17. E2E: the only feature file is an infrastructure tracer (`e2e/features/runtime-tracer.feature`). There is no e2e coverage for BOM, invoice or DOCX. Unit tests: `backend/tests/services/{bom,invoice-calculation,bom-image-migration}_test.ts`, `backend/tests/routes/{bom,bom_entries,invoice-settings,settings}_test.ts`, `frontend/tests/useBomCalculations.test.ts`, `frontend/src/components/invoice/__tests__/*`.
