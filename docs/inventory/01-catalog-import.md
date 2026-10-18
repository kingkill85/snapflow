# 01 — Catalog & Import (SnapFlow 1 feature inventory)

## Summary
A single global catalog (no tenant scoping) of Categories → Items ("Products") → Variants ("Styles"). Variants can link to other variants as required or optional add-ons. Items belong to an Item Type ("Product Type", e.g. Zigbee) and have soft-delete flags (`is_active`) that cascade downward.
Admins (`role='admin'` only; `tenant_admin` cannot) do all writes. Every logged-in user can browse the catalog pages read-only. Some catalog read endpoints need no login at all.
The Excel "Catalog Sync" (`POST /items/sync-catalog`) is the real import. It is scoped to one product type, runs as one transaction, treats Excel as the source of truth, deactivates instead of deleting, and pulls images out of the workbook. A legacy preview/import path still exists but is broken and unused.

Path shorthands: `R/` = `backend/src/routes/`, `Repo/` = `backend/src/repositories/`, `S/` = `backend/src/services/`, `F/` = `frontend/src/`.

---

## Entities & fields

| Entity (table) | Fields | Notes |
|---|---|---|
| Category (`categories`) | `id`, `name` TEXT NOT NULL, `sort_order` INT (default 0), `is_active` BOOL (default true) | Name is unique only at app level and case-sensitive (`R/categories.ts:72`). No DB unique index. |
| Item Type (`item_types`) | `id`, `name` UNIQUE NOT NULL, `abbreviation` NOT NULL, `color` NOT NULL default `#3b82f6`, `sort_order` default 1, `is_active` INT default 1, `created_at` | Migration 032 seeds `Zigbee`/`ZB`/`#3b82f6` as id 1. |
| Item (`items`) | `id`, `category_id` (FK categories, NULLABLE), `type_id` INT default 1 (**no FK**), `name` NOT NULL, `description`, `base_model_number` (indexed, **not unique**), `dimensions`, `created_at`, `is_active` | Legacy columns `model_number`, `price`, `image_path` are still in the table but unused. API adds joined `type_name`, `type_abbreviation`, `type_color`, `preview_image`, `variants[]`. |
| Variant (`item_variants`) | `id`, `item_id` (FK items, no cascade), `style_name` NOT NULL, `model_number` (unused), `price` REAL NOT NULL, `image_path` (relative to UPLOAD_DIR), `sort_order` default 0, `created_at`, `is_active` | `is_active` is converted to a boolean on read (`Repo/item-variant.ts:39`). |
| Variant Add-on (`variant_addons`) | `id`, `variant_id` FK, `addon_variant_id` FK (both ON DELETE CASCADE), `is_optional` BOOL default true, `sort_order`, `created_at` | The API exposes `is_required = !is_optional` (`Repo/variant-addon.ts:26`). The joined `addon_variant` contains `{id, item_id, item_name, style_name, price, image_path, is_active = variant.active && item.active}`. |
| App setting (`app_settings`) | `key` PK, `value`, `updated_at` | `last_sync_timestamp` (ms) is set after each successful sync and used to bust image caches. |
| Project ↔ type (`project_item_types`) | `project_id`, `item_type_id` | Used to filter the configurator palette (outside this area). Not cleaned up when a type is deleted. |
| Dead tables | `item_addons` (migration 010, superseded by 014; dropped in 017) | — |

Uploaded files live under `UPLOAD_DIR`:
- Manual variant images: `items/<timestamp>-<rand6>.<ext>`
- Excel images: `items/excel-import/<original media filename, e.g. image12.png>`
- Temporary Excel uploads: `imports/…` (deleted after use)

---

## API endpoints

Auth key: **public** = no auth middleware; **opt** = optional auth (admin only matters for `include_inactive`); **auth** = any logged-in user; **admin** = role `admin`. All are under `/api`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/categories?include_inactive=true` | public | List categories, ordered by `sort_order`, then `name`. `include_inactive` is honoured for anyone (`R/categories.ts:33`). |
| GET | `/categories/:id` | public | Get one category (inactive ones too). |
| POST | `/categories` | admin | Create `{name (1-100), sort_order?}`. |
| PUT | `/categories/:id` | admin | Update `{name?, sort_order?, is_active?}`. Deactivating cascades. |
| DELETE | `/categories/:id` | admin | Delete. Items in it are set to `category_id = NULL`. |
| PATCH | `/categories/reorder` | admin | `{category_ids:[...]}` sets `sort_order` to 1..n. Returns all categories, inactive included. |
| PATCH | `/categories/:id/deactivate` | admin | Deactivate, cascading to items and variants. |
| PATCH | `/categories/:id/activate` | admin | Activate. No cascade. |
| GET | `/item-types?include_inactive=true` | auth | List types, ordered by `sort_order`, then `name`. |
| POST | `/item-types` | admin | `{name 1-100, abbreviation 1-10, color? #RRGGBB, sort_order?}` |
| PATCH | `/item-types/reorder` | admin | `{ids:[...]}` sets 1..n. Returns all types. |
| GET | `/item-types/:id` | auth | Get one type. |
| PUT | `/item-types/:id` | admin | Partial update, including `is_active`. |
| DELETE | `/item-types/:id` | admin | Delete. Blocked if any item (active or inactive) uses the type. |
| PATCH | `/item-types/:id/deactivate` and `/activate` | admin | Toggle `is_active`. No cascade. |
| GET | `/items?category_id=&type_id=&search=&page=&limit=&include_inactive=` | opt | Paginated list. `category_id=null` means uncategorized. |
| GET | `/items/:id/variants/:variantId/addons` | **public** | List a variant's add-ons. |
| POST | `/items/:id/variants/:variantId/addons` | admin | `{addon_variant_id, is_required?}` |
| DELETE | `/items/:id/variants/:variantId/addons/:addonId` | admin | Remove an add-on link. |
| GET | `/items/:id` | **public** | Item with its active variants (also works for inactive items). |
| POST | `/items` | admin | JSON `{category_id, type_id, name, description?, base_model_number?, dimensions?}` |
| PUT | `/items/:id` | admin | Partial update, including `is_active`. |
| DELETE | `/items/:id` | admin | Hard-delete the item, its variants, add-on links and image files. |
| GET | `/items/:id/variants?include_inactive=true` | opt | List the item's variants. |
| POST | `/items/:id/variants` | admin | Multipart: `style_name`, `price`, optional `image`. |
| PUT | `/items/:id/variants/:variantId` | admin | Multipart: `style_name?`, `price?`, `image?`, `remove_image=true?`, `is_active=true|false?` |
| DELETE | `/items/:id/variants/:variantId` | admin | Hard-delete the variant. |
| PATCH | `/items/:id/variants/reorder` | admin | `{variant_ids:[...]}`. No UI uses it. |
| PATCH | `/items/:id/deactivate` and `/activate` | admin | Toggle. Deactivate cascades to variants. No UI uses these. |
| PATCH | `/items/:id/variants/:variantId/deactivate` and `/activate` | admin | Toggle. No UI uses these. |
| POST | `/items/import-preview` | admin | Legacy Excel preview. Broken and unused (see bugs). |
| POST | `/items/import` | admin | Legacy import from a preview JSON. Unused by the UI. |
| POST | `/items/sync-catalog?type_id=N` | admin | Multipart `file` (.xlsx/.xls). Full catalog sync. |
| GET | `/currency/exchange-rate/:code` | auth | `{rate, fromCache, currencyCode}` for USD→code. |
| GET | `/settings/last-sync-timestamp` | auth | `{success, data:{timestamp}}`. Non-standard envelope. |
| GET | `/uploads/*` (no `/api`) | public | Serves uploaded files, including catalog images. |

Frontend routes, each wrapped in `ProtectedRoute` (any logged-in user): `/catalog/products`, `/catalog/item-types`, `/catalog/categories`. They appear in the header "Catalog" dropdown for all authenticated users (`F/components/layout/Header.tsx:70`).

---

## Acceptance criteria

### A. Permissions & visibility
1. Every catalog write endpoint returns 401 without a token and 403 `Forbidden - Admin access required` for any role other than `admin`, including `tenant_admin` (`backend/src/middleware/auth.ts:73`).
2. `GET /categories`, `GET /categories/:id`, `GET /items`, `GET /items/:id`, `GET /items/:id/variants` and `GET /items/:id/variants/:vid/addons` work without login (`R/items.ts:45,105,244,499`; `R/categories.ts:31,45`).
3. `GET /item-types` and `GET /item-types/:id` require login (`R/item-types.ts:29,71`).
4. `include_inactive=true` on items and variants is honoured only when the caller has a valid admin token. Otherwise it is silently ignored (`R/items.ts:53,505`; test `backend/tests/routes/security_test.ts:54`).
5. `include_inactive=true` on categories and item types is honoured for any caller (`R/categories.ts:33`, `R/item-types.ts:31`).
6. Catalog pages are visible to every logged-in user. Create/Edit/Delete/Import/reorder controls render only when `user.role === 'admin'` (`F/pages/catalog/ItemManagement.tsx:60,366`; `CategoryManagement.tsx:23,128`; `ItemTypeManagement.tsx:24,113`).
7. The catalog is global and shared by all tenants. There is no tenant column on any catalog table (migrations 002/003/009/032).

### B. Categories
8. Create needs `name` of 1–100 characters (zod). An empty name or one over 100 characters gives 400 (`R/categories.ts:10`).
9. Create is rejected with 400 `Category with this name already exists` when the exact name already exists (case-sensitive, inactive categories included) (`R/categories.ts:72`).
10. Create with no `sort_order` uses `MAX(sort_order)+1`, or 1 if there are no categories. New categories are active (`Repo/category.ts:120-127`).
11. Update returns 404 for an unknown id and 400 for a non-numeric id. Renaming to a name that another category already has gives 400 (`R/categories.ts:95-113`).
12. Update with `is_active:false` on an active category deactivates the category, all its items and all their variants. Message: "…All items and variants in this category have been deactivated." (`R/categories.ts:125`; `Repo/category.ts:79-107`).
13. Update with `is_active:true`, or `PATCH /:id/activate`, reactivates the category only. Items and variants stay inactive. Message says so (`R/categories.ts:220-238`).
14. `PATCH /:id/deactivate` always cascades to items and variants, even if the category is already inactive (`R/categories.ts:196-212`).
15. Delete always succeeds for an existing category. All items in it get `category_id = NULL` and are not deleted (`Repo/category.ts:171-177`).
16. Reorder takes an ordered id list and sets `sort_order = index+1` in one transaction. Unknown ids are ignored. Returns the full list, inactive included (`Repo/category.ts:180-191`; `R/categories.ts:176-186`).
17. Lists are ordered by `sort_order ASC, name ASC` (`Repo/category.ts:41`).
18. UI: the Category page lists Position (sort_order), Name and Status. The "Show inactive" switch refetches with `include_inactive`. Up/down arrows swap neighbours and call reorder. The first row's up button and the last row's down button are disabled (`F/pages/catalog/CategoryManagement.tsx:78-96,183-199`).
19. UI: the Category modal has a Name field (required). The Active switch appears only in edit mode. Create sends only the name. Buttons are Create/Update/Cancel (`F/components/categories/CategoryFormModal.tsx`).
20. UI: the delete confirmation shows "Note: You cannot delete a category that has items assigned to it." (`CategoryManagement.tsx:264`). The backend does not actually enforce this (see quirks).

### C. Item Types (Product Types)
21. Create needs `name` (1–100) and `abbreviation` (1–10). `color` must match `^#[0-9a-fA-F]{6}$` if given, default `#3b82f6`. `sort_order` defaults to max+1 (`R/item-types.ts:9`; `Repo/item-type.ts:31-43,99`).
22. A duplicate exact name gives 400 `Item type with this name already exists` on create and on rename (`R/item-types.ts:44,92`).
23. Update of an unknown id returns 404, but only after the name-uniqueness check (`R/item-types.ts:101`).
24. Delete is blocked with 400 `Cannot delete item type that has items assigned to it` if any item, active or inactive, references the type (`Repo/item-type.ts:76-80`; `R/item-types.ts:119`).
25. Deactivate/activate only flip the flag. There is no cascade to items, and items of an inactive type still show in item lists (`Repo/item-type.ts:68-74`).
26. Reorder `{ids}` sets 1..n in a transaction and returns all types (`R/item-types.ts:58`).
27. UI: the Product Types page lists Order, a color dot with the name, and an abbreviation badge. Up/down reorder. Only active types are shown and there is no Show-inactive or Active toggle, so an inactive type cannot be seen or reactivated from the UI (`F/pages/catalog/ItemTypeManagement.tsx:36`).
28. UI: the type modal upper-cases the abbreviation and limits it to 10 characters. There are 9 preset colors plus a native color picker and a hex text input (accepts partial `#` + up to 6 hex). A live badge preview is shown (`F/components/items/ItemTypeFormModal.tsx`).
29. The badge is rendered as white text on a `color` background, 10px, semibold (`F/components/items/ItemTypeBadge.tsx`).

### D. Items (Products)
30. Create needs `category_id`, `name` and `type_id` (not null or undefined). If any is missing: 400 `Missing required fields: category_id, type_id, name` (`R/items.ts:283`).
31. A non-numeric `category_id` gives 400 `Invalid category_id`. An unknown category gives 400 `Category not found`. Inactive categories are allowed (`R/items.ts:289-298`).
32. A duplicate exact item name anywhere in the catalog (any type or status) gives 400 `An item with this name already exists` (`R/items.ts:301`).
33. A duplicate `base_model_number` anywhere in the catalog (if one is given) gives 400 `An item with this model number already exists` (`R/items.ts:307`).
34. A non-numeric `type_id` gives 400 `Invalid type_id`. A type id that does not exist is not checked (`R/items.ts:318`).
35. New items are active. Empty `description`, `base_model_number` and `dimensions` are stored as NULL (`Repo/item.ts:219-238`).
36. Update returns 404 for an unknown id. If `category_id` is given it must parse and exist (400 otherwise) (`R/items.ts:367-381`).
37. Update with `is_active:true` while the item's current category is inactive gives 400 "Cannot activate item while its category is inactive. Please activate the category first." (`R/items.ts:384-393`).
38. Update repeats the name and model uniqueness checks only when the value actually changes (`R/items.ts:397-420`).
39. Update with `is_active:false` on an active item also deactivates all its variants. Message: "Item deactivated successfully. All variants of this item have been deactivated." (`R/items.ts:439-447`).
40. Activating an item does not reactivate its variants (`R/items.ts:853`).
41. Delete removes each variant's image file, sets BOM `item_id` and `variant_id` to NULL so BOM history is kept, deletes add-on links in both directions, then deletes the variants and the item. The database part runs in one transaction (`R/items.ts:461-490`; `Repo/item.ts:384-394`; `Repo/item-variant.ts:161-174`).
42. List defaults: `page=1`, `limit=20`, limit capped at 100. Response is `{data, pagination:{total, page, totalPages, limit}}` (`R/items.ts:50-93`).
43. List filters combine with AND: active only (unless admin `include_inactive`), `category_id` (or `IS NULL` for `"null"`), `type_id`, and `search` as `LIKE %q%` on name, description or base_model_number (`Repo/item.ts:38-62`).
44. List is ordered by `name ASC` (`Repo/item.ts:103`).
45. Each listed item includes only **active** variants (`variants[]`), even with `include_inactive` (`Repo/item.ts:119`).
46. `preview_image` is the `image_path` of the first variant by `sort_order, id`, active variants only. For admin `include_inactive` requests inactive variants count too, so a NULL image on the first variant gives a NULL preview (`Repo/item.ts:77-99`).
47. `GET /items/:id` returns the item with joined type fields and active variants only. Inactive items are returned too (`Repo/item.ts:132-162`).
48. UI: the Products page has search (300 ms debounce, resets to page 1), a category filter (All / Uncategorized / every category including inactive), a type filter (All / every type including inactive) and a Show-inactive switch. It shows 10 items per page with Previous/Next and "Page X of Y" when there is more than one page (`F/pages/catalog/ItemManagement.tsx:93,387-441,682-704`).
49. UI: table columns are expand chevron, image thumbnail (placeholder icon if none), Name, Model (`-` if empty), Type badge (`-` if none), Category name (`Unknown` if not found or uncategorized), Status (Active/Inactive), and admin Edit/Delete. Inactive rows are drawn at 60% opacity (`ItemManagement.tsx:463-566`).
50. UI: expanding a row lazy-loads its variants (with `include_inactive` if Show-inactive is on) and caches them. Toggling Show-inactive clears the cache and collapses all rows (`ItemManagement.tsx:166-202`).
51. UI: the item modal has Name\* and Category\* (defaults to the first category), and Type (only if types exist; defaults to the first type). Description, Model Number and Dimensions are optional. The Active switch is in edit mode only. Submit is disabled when no category is selected (`F/components/items/ItemFormModal.tsx`).
52. UI: product delete asks for confirmation ("Delete Product …cannot be undone"). On failure the error appears in a page alert (`ItemManagement.tsx:204-227,708`).

### E. Variants (Styles)
53. Create needs multipart `style_name` and a numeric `price`. Otherwise 400 `Missing required fields: style_name, price` and any uploaded file is deleted (`R/items.ts:554-566`).
54. Create returns 404 `Item not found` for an unknown item, deleting the uploaded file (`R/items.ts:542-548`).
55. `style_name` must be unique within the item, case-insensitive, inactive variants included. Otherwise 400 "A variant with this style name already exists for this item" (`R/items.ts:569-583`).
56. A new variant's `is_active` copies the parent item's status, so variants of an inactive item are created inactive (`R/items.ts:590`).
57. A new variant gets `sort_order = 0` and is not appended to the end (`Repo/item-variant.ts:70`).
58. The image is optional. Upload rules are in section H. The stored `image_path` is `items/<unique>` (`R/items.ts:593`).
59. Update returns 404 if the item is missing, or if the variant is missing or belongs to another item. Any upload is deleted (`R/items.ts:626-640`).
60. Update with `is_active=true` while the item is inactive gives 400 "Cannot activate variant while its item is inactive. Please activate the item first." (`R/items.ts:656-664`).
61. Update repeats the case-insensitive style uniqueness check when the style name changes (`R/items.ts:667-685`).
62. Uploading a new image deletes the old image file and stores the new path. `remove_image=true` without a new file deletes the file and sets the path to NULL. A new upload takes precedence over `remove_image` (`R/items.ts:696-708`).
63. Delete sets BOM `variant_id` to NULL, deletes add-on links where the variant is parent or add-on, deletes its image file, then deletes the row (`R/items.ts:746-757`).
64. Reorder `{variant_ids}` sets `sort_order = 1..n`, only for ids that belong to the item. A non-array gives 400 `variant_ids must be an array` (`R/items.ts:780-791`; `Repo/item-variant.ts:186-197`).
65. Variants are listed by `sort_order ASC, id ASC` (`Repo/item-variant.ts:30`).
66. `PATCH …/variants/:vid/activate` does **not** check whether the item is active, unlike PUT (`R/items.ts:906-938`).
67. UI: the expanded row shows a "N Styles" badge, an admin "Add Style" button, and a table of Image, Style, Price (`$x.xx`), Status, and admin Edit/Delete. Inactive variants are at 60% opacity (`ItemManagement.tsx:570-668`).
68. UI: the variant modal has Style Name\*, Price\* (number, step 0.01, min 0; the client rejects NaN or negative with "Please enter a valid price"), an image drop zone (click or drag; only `image/*` accepted; preview; an X button sets `remove_image`), and an Active switch in edit mode only (`F/components/items/VariantFormModal.tsx:162-233`).
69. UI: style delete asks for confirmation ("The variant will be permanently removed.") and then refreshes that item's variants (`ItemManagement.tsx:247-258,719`).

### F. Variant add-ons
70. POST needs `addon_variant_id`. If missing: 400 `addon_variant_id is required` (`R/items.ts:148`).
71. POST returns 404 if the item is missing or the variant is not that item's (`R/items.ts:152-160`).
72. A variant cannot be its own add-on: 400 "Variant cannot be an add-on of itself" (`R/items.ts:163`).
73. A duplicate (variant, add-on) pair gives **409** "Add-on already exists for this variant" (`R/items.ts:171-176`).
74. `is_required` defaults to **true** when omitted. It is stored inverted as `is_optional` (`R/items.ts:181`; `Repo/variant-addon.ts:60`).
75. DELETE returns 404 unless the add-on exists and belongs to that variant (`R/items.ts:221-224`).
76. GET lists add-ons by `sort_order, id` with joined add-on variant and item data. `addon_variant.is_active` is the add-on variant's flag AND its item's flag (`Repo/variant-addon.ts:9-41`).
77. Add-ons may point to a variant of any item, including the same item, and cycles are allowed. The add-on variant's existence is not checked; an unknown id fails on the foreign key and returns 500.
78. Downstream rule (BOM area): placing a variant automatically adds only add-ons where `is_required && addon_variant.is_active` (`S/bom.ts:142-148`).
79. UI: the Add-ons section appears only when editing a style. The dropdown lists active variants of active items, excluding the style itself and already-linked add-ons. Each entry shows thumbnail, "model or name", "style - $price". A Required switch defaults to **off**. The "+" button adds immediately (not on Update). Each listed add-on shows thumbnail, "item - style", price and a Req/Opt badge, and a trash icon removes it immediately with no confirmation (`VariantFormModal.tsx:118-160,344-495`).

### G. Excel Catalog Sync (`POST /items/sync-catalog`)
Request and validation:
80. Needs a multipart field `file`. If missing: 400 with the upload error or `No file uploaded` (`R/items.ts:1049-1062`).
81. Needs `type_id` matching `^[1-9]\d*$` and being a safe integer. Missing gives 400 `type_id is required`. Otherwise invalid (e.g. `1junk`, `1.0`, `+1`, ` 1`, `0`, `-1`, `2^53`) gives 400 `Invalid type_id`. The uploaded file is deleted and nothing changes (`R/items.ts:1065-1078`; test `backend/tests/routes/item-types-integration_test.ts:225`).
82. The file must start with ZIP (`PK\x03\x04`) or OLE (`D0CF11E0`) magic bytes, otherwise "Invalid file format". The original name must end in `.xlsx` or `.xls` (case-insensitive), otherwise 400 "Invalid file type. Only .xlsx and .xls files are allowed". There is no server-side size limit (`backend/src/middleware/upload.ts:449-484`; `R/items.ts:1081-1090`).
83. The response is always HTTP 200 with `data: SyncResult {success, phases{categories{added,activated,deactivated,total}, items{added,updated,deactivated,total}, variants{added,updated,deactivated,imagesExtracted,total}, addons{linked,skipped,notFound,total}}, log[], errors[{row,message,details?}]}`. A fatal failure gives `success:false`, all counters reset to 0, and one error `{row:0, message:"Fatal error: …"}` (`S/excel-sync.ts:142-225`).
84. The uploaded workbook is deleted after the sync (`R/items.ts:1099`).

Workbook format, matching the sample `2026-02-14 ZIGBEE Website Item List - v2.0.xlsx`. Used range is B1:U222, headers are in row 3, data starts at row 4:
85. Only the first worksheet is read. Rows 1–3 are skipped and data starts at Excel row 4 (`S/excel-sync.ts:240-254`).
86. Column positions are relative to the sheet's used-range start (B in the sample): B Category, C `#` (ignored), D Item Photo (image), E Item Name, F Description, G Model Number (the item key), H Dimensions, I Style, J "Model Number + Style" (**not read**), K Price (USD), L ignored, M/N/O mandatory add-ons 1–3, P ignored, Q–U optional add-ons 4–8 (`S/excel-sync.ts:313-374`).
87. A row whose cells are all blank or whitespace is skipped. Sample rows 7 and 15 only contain `" "` in J (`S/excel-sync.ts:258-260`).
88. A non-blank row with fewer than 9 cells (nothing at or after column J) fails the **whole** sync: `Invalid catalog row N: incomplete workbook schema` (`S/excel-sync.ts:261-265`).
89. A row missing category, item name or model number fails the whole sync: `Invalid catalog row N: missing category, item name, model number` (`S/excel-sync.ts:269-280`).
90. All cell values are trimmed. A non-numeric or missing price becomes 0. An empty style is allowed and gives a variant with `style_name ''` (the sample has 5 such rows, 211–218) (`S/excel-sync.ts:332-371`).
91. Rows are grouped by exact trimmed Model Number. The first row of a group supplies name, category, description and dimensions; later rows only add variants (`S/excel-sync.ts:282-303`).
92. A workbook with no valid rows fails with "Workbook contains no valid catalog rows". An unknown `typeId` fails with "Product type not found: N". Both fail before any change (`S/excel-sync.ts:155-162`).
93. An unreadable or missing file gives `success:false` with nothing committed (test `backend/tests/routes/data-integrity_test.ts:338`).

Phases (all inside one BEGIN/COMMIT; any thrown error rolls back) (`S/excel-sync.ts:179-209`):
94. Categories: Excel categories are matched to DB categories by **case-insensitive** name, inactive included. Inactive matches are reactivated (counted as `activated`; their items are not cascaded). New names are created at the end of the sort order (`added`). `total` is the number of distinct Excel categories (`S/excel-sync.ts:533-582`).
95. Items: existing items are matched by exact `base_model_number` **among items of the selected type only** (active and inactive). A match is updated: category, type, name, description, dimensions, and `is_active=true`. Otherwise a new active item of the selected type is created (`S/excel-sync.ts:629-707`).
96. Items: the category is looked up by exact name (`findByName`). If not found, `Failed to sync item …: Category not found` aborts the whole sync (`S/excel-sync.ts:656-663`).
97. Items: every active item of the selected type whose `base_model_number` is not in the workbook (or is NULL) is deactivated, together with all its variants. Items of other types are never touched. The `deactivated` count is the number of rows actually changed (`Repo/item.ts:324-366`; `openspec/specs/excel-sync-runtime-parity/spec.md`).
98. Items: `deactivateMissingForType` refuses an empty import set ("Cannot deactivate missing products without a validated import set") (`Repo/item.ts:328`).
99. Variants: for each synced item, workbook rows are matched to existing variants (inactive included) by **case-insensitive** style. A match gets `price`, `is_active=true`, and `image_path` only if the workbook has an image for it; the style name casing is not updated. Otherwise a new variant is created (active, `sort_order 0`) (`S/excel-sync.ts:798-829`).
100. Variants: any variant of a synced item whose style is not in the workbook is deactivated (`S/excel-sync.ts:839-871`).
101. Variants: `total` is the number of distinct item:style keys. `imagesExtracted` counts variants whose own row has an image (`S/excel-sync.ts:792,873`).
102. Images: a row's own image is used. Otherwise the variant inherits the first image found among its item's rows, in Excel row order ("shared image"). A variant with neither keeps its current image (`S/excel-sync.ts:768-797,807`).
103. Add-ons: first, every **outgoing** add-on link of every variant of every synced item is deleted (`S/excel-sync.ts:924-949`).
104. Add-ons: each non-empty add-on cell is whitespace-collapsed and looked up exactly (case-sensitive) in an index of `"<model> <style>"`, or `"<model>"` when the style is empty. The index is built **from the current workbook only** (`S/excel-sync.ts:902-921,981-986`).
105. Add-ons: when found, the link goes to the add-on item's variant with the matching style (case-insensitive), with `is_required = slot ≤ 3` and `sort_order = slot number` (`S/excel-sync.ts:1041-1068`).
106. Add-ons: an unresolved reference increments `notFound` and adds to `errors` (with row number) and to the log, but does **not** set `success=false` (`S/excel-sync.ts:988-1059`).
107. Category cleanup: after products are synced, every active category that is not in the workbook (case-insensitive, trimmed) and has no active items of **any** type is deactivated (`deactivated` count) (`S/excel-sync.ts:584-621`; spec "Shared category is preserved").
108. On success, `app_settings.last_sync_timestamp` is set to `Date.now()` inside the transaction (`S/excel-sync.ts:203`).
109. `log[]` holds human-readable progress lines with emoji (📖, ✓, ✗, ⚠, 🗑️, ✅/❌) for each phase and action (`S/excel-sync.ts`).
110. Any thrown error inside the transaction (item create/update, variant create/update/deactivate) rolls back **all** catalog changes (tests `backend/tests/services/excel-sync_test.ts:657,730,798`).

Image extraction (`S/excel-sync.ts:381-525`):
111. The workbook is unzipped with the system `unzip` binary into `/tmp/excel-sync-<ts>`. Images are mapped from `xl/drawings/drawing1.xml` plus its `.rels`. A `twoCellAnchor` takes precedence over a `oneCellAnchor` on the same row. The anchor row is converted to an Excel row with `from.row + 1`. Anchors in any column count.
112. Each mapped image is processed (max width 1200, see H) and written to `UPLOAD_DIR/items/excel-import/<media filename>`, overwriting any existing file with the same name.
113. Any extraction failure (no drawing, not a zip, e.g. `.xls`) is logged and the sync continues with no images.

UI (`F/components/items/ImportModal.tsx`):
114. The "Import Catalog" button (admin only) opens a modal. Product Type\* is preselected to the first active type. A drop zone or file picker takes the file; the client accepts the xlsx/xls MIME types or a `.xlsx`/`.xls` name and at most 50 MB. The error is "Please select a valid Excel file (.xlsx or .xls)" or "File size must be less than 50MB".
115. A "What will happen" info box lists the five sync effects (lines 278-286).
116. "Import Catalog" is disabled with no file or no type. Syncing shows a spinner and a simulated progress bar (10 → ~90%, then 100%).
117. The complete step shows a header ("Sync Completed Successfully!" if `success`, else "Sync Completed with Warnings"), "N errors occurred", and four cards: Categories (added/activated/deactivated/total), Base Items (added/updated/deactivated/total), Styles (added/updated/images/total), Addons (references/"resolved"/links/not found). It also shows the first 100 log entries plus "… and N more", and an error list "Row r: message".
118. "Done" refreshes the product list only when `success`. "Import Another" resets to the upload step. A request failure returns to the upload step with an error alert.

### H. Images, uploads & cache-busting
119. Variant image uploads accept only `image/jpeg|jpg|png|webp` MIME, at most 5 MB, with JPEG/PNG/WebP magic bytes (`backend/src/middleware/upload.ts:9-19,449-484`).
120. Uploaded images wider than 1200 px are resized to 1200 px wide with aspect ratio kept and no upscaling. The original format is kept: PNG compression 3 with transparency kept, JPEG quality 80 baseline mozjpeg, WebP quality 80 effort 4 (`S/image-processing.ts:80-161`).
121. Non-image buffers pass through unchanged (`processImageSafe`). If processing fails during upload, the original bytes are saved (`S/image-processing.ts:170-190`; `upload.ts:489-503`).
122. Stored filenames are `<Date.now()>-<6 random base36>.<original extension>` under the subdirectory. The original name is sanitised for `<>"|?*`, `..`, `/`, `\` (`S/file-storage.ts:225-260`).
123. `/uploads/*` is served publicly with path-traversal protection (404), a content type by extension, `Cache-Control: public, max-age=31536000, immutable`, an ETag (mtime+size) with 304 support, and CORS `*` (`backend/src/main.ts:147-213`).
124. The frontend image URL is `/uploads/<path>`, with `?t=<last_sync_timestamp>` appended when the timestamp is greater than 0. The timestamp is loaded once at app start when a token exists (`F/services/item.ts:261-267`; `F/context/SyncContext.tsx:27-32`).

### I. Currency
125. `GET /currency/exchange-rate/:code` fetches `https://open.er-api.com/v6/latest/USD` and returns the USD→CODE rate. The code is upper-cased (`S/currency.ts:41-93`; `R/currency.ts`).
126. Results are cached in memory per process for 5 minutes. One fetch caches every currency. A cache hit returns `fromCache:true` (`S/currency.ts:33-77`).
127. If the API fails or the code is unknown, a stale cached value is returned if one exists. Otherwise 500 `Failed to fetch exchange rate` (`S/currency.ts:80-91`; `R/currency.ts:22`).
128. Catalog prices are stored and shown in USD (`$x.xx`). Conversion happens only in invoice settings: the "fetch rate" button and the project default `local_currency_code` 'PKR' (`F/components/invoice/InvoiceSettingsModal.tsx:131`; migration 026 area).

### J. Legacy Excel import (`/items/import-preview` and `/items/import`, unused by the UI)
129. The preview parses the first sheet, skips header row 1, and uses columns A=Category, D=Name, E=Desc, F=Model, G=Dims, H=Style, J=Price, L–O=add-ons 1–4 (slots 1–2 required). Rows without a name (column D) are skipped (`S/excel-import.ts:81-145,276-291`).
130. Per-row errors: Category, Item Name, Model Number and Style are required. Price must be ≥ 0. Required add-on slots 1–2 must be present (`S/excel-import.ts:296-361`).
131. The base model is the model number with its last space-separated token removed (`S/excel-import.ts:368-376`).
132. Execute creates missing categories (with the warning "Created new category: X") and creates items with **type_id 1**. It updates name, description and dimensions of existing items, **always creates** variants (no matching), and creates no add-ons (`S/excel-import.ts:182-271`).

---

## Edge cases & quirks
- Category delete never fails because of items: items become uncategorized. The `FOREIGN KEY` error branch (`R/categories.ts:166`) and the UI warning text are effectively dead or misleading.
- Category names are case-sensitive in the CRUD API but case-insensitive in the sync. A DB category "gateways" vs Excel "Gateways" is treated as existing in phase 1, then the exact-name lookup fails in phase 2, and the whole sync aborts (`S/excel-sync.ts:555` vs `:656`).
- Item uniqueness differs by path. Manual create/update enforces a globally unique name and `base_model_number`. The sync matches model numbers per type only, so it can create a second item with the same model number under a different type, and it never checks name uniqueness.
- The sync matches only items of the selected type. An item that already exists under another type is duplicated rather than moved.
- The sync deactivates selected-type items that have a NULL `base_model_number` (manually created items without a model) on every sync (`Repo/item.ts:336`).
- The sync loads existing items with `limit: 10000`. Beyond 10k items of a type, matches are missed and duplicates are created (`S/excel-sync.ts:640-643`).
- A duplicate style for the same model within one workbook creates two variants. The existing-variant map is built before the loop.
- Re-sync never renames styles (case kept from the first creation), never deletes anything, and never clears an image when the workbook lacks one.
- Excel images are written to fixed names (`image1.png` …) shared across workbooks and types. They are written **before** the transaction, so a failed or rolled-back sync still overwrites the image files that existing variants point to. This is also why the `?t=` cache-buster exists.
- Every variant of a model shares one image file. Deleting or replacing the image of one variant (manually or by deleting the item) deletes the file for all siblings and for any other item using the same Excel filename.
- If an Excel image fails processing (sharp error, not "not an image"), the copy is skipped but `imageMap` still holds the row. The variant gets an `image_path` to a file that does not exist (`S/excel-sync.ts:467-490`).
- `.xls` files can be parsed by xlsx, but image extraction (unzip) fails silently, so there are no images.
- The temp dir `/tmp/excel-sync-*` is removed only on the success path. Unzip failures leak it.
- Column mapping depends on the sheet's used-range start. If anything is typed in column A, every column shifts by one and the sync breaks or misreads data.
- Add-on references resolve only against the current workbook. Add-ons pointing to products of another type or workbook always come back as "not found". The legacy column J is ignored; the index is rebuilt from G+I.
- Add-on links are cleared only for items present in the workbook. Links on deactivated items stay.
- Add-on errors leave `success:true`, so the UI says "Completed Successfully!" next to "N errors occurred". Fatal errors return HTTP 200 with `success:false` and the UI shows "Completed with Warnings" with all counters at 0.
- The UI "Resolved" and "Links" both show `addons.linked`. Variant `deactivated` is never displayed. The info box says "missing [categories] deactivated" but only empty ones are.
- `GET /items` with `limit=0` behaves as 20 but reports `limit:0`. A negative `limit` (e.g. -1) passes `Math.min` and SQLite treats `LIMIT -1` as unlimited, so it bypasses the 100 cap. `page` is not validated.
- Search uses `LIKE`, so `%` and `_` in the query act as wildcards. Matching is case-insensitive for ASCII only. Style names are not searched.
- PUT item activation checks the item's **current** category, not a new `category_id` sent in the same request. PATCH `/items/:id/activate` skips the category check entirely.
- Item-type deactivation hides the type from type lists (palette and import selector), but its items stay active and visible.
- Non-admins see the "Show inactive" switch on Products; the server silently ignores it for them. On Categories, non-admins do see inactive categories.
- Category reorder with Show-inactive off sends only active ids, so inactive categories keep their old `sort_order`, which can collide. The reorder response includes inactive categories, so they appear in the list even with the switch off.
- A variant upload with an invalid image (wrong type, too big, bad magic bytes) does not fail. The variant is created or updated without the image and no error is shown.
- A variant PUT with a non-numeric `price` gives `NaN`, which hits the NOT NULL constraint and returns 500. Backend create accepts negative prices; only the UI blocks them.
- Image uploads are processed before the item or variant is validated. Files are cleaned up on most error paths, but not on the `No form data provided` paths.

## Suspected bugs / dead code
- **Bug:** configurator palette, project data and add-on picker request `limit:1000`, but the API caps at 100. Only the first 100 active items alphabetically are available. The sample workbook has 80 models, so this is close to biting (`F/components/configurator/ItemPalette.tsx:170`; `F/hooks/useProjectData.ts:62`; `ItemManagement.tsx:299`; `R/items.ts:51`).
- **Bug:** `ItemFormModal` calls `item.category_id.toString()`, which crashes when editing an uncategorized item (category_id NULL after a category delete) (`F/components/items/ItemFormModal.tsx:75`).
- **Bug:** in the item edit form, emptying Description, Model Number or Dimensions sends `undefined`, so the field cannot be cleared (`ItemFormModal.tsx:105-107`).
- **Bug:** after create, update, delete or import, the product list refetch drops the `type_id` filter, so the list no longer matches the selected type (`ItemManagement.tsx:210,278,346`).
- **Bug:** after an item update that deactivates it, the cached expanded variants are not refreshed and still show as Active.
- **Bug:** `SyncContext.refreshTimestamp` is never called after a sync, so cache-busting for new Excel images only applies after a full page reload.
- **Bug:** a category delete failure is swallowed silently: `ConfirmDeleteModal` catches the error and the Category and Type pages pass no error. The modal stays open with no message (`CategoryManagement.tsx:72`; `ItemTypeManagement.tsx:66`; `F/components/common/ConfirmDeleteModal.tsx:162-168`).
- **Bug:** the `ImportModal` progress `setInterval` is not cleared when the request throws (`ImportModal.tsx:147-166`).
- **Bug:** the add-on "Required" default is inconsistent: UI false, API true (`VariantFormModal.tsx:62` vs `R/items.ts:181`).
- **Bug / security:** `/uploads/*` and `GET …/addons` are fully public. Workbooks in `uploads/imports/` are publicly reachable while they are being processed.
- **Bug:** the hex color text input allows partial values (`#3b`), which the server rejects with a generic zod 400.
- **Bug:** item type delete leaves orphan `project_item_types` rows. `items.type_id` has no FK, so items can reference a non-existent type.
- **Dead/broken:** `POST /items/import-preview` uses `uploadMiddleware("imports")` with the default field `image` and image MIME validation, so Excel files are rejected ("No file uploaded"). `parseExcel` also calls `xlsx.readFile` on an `UPLOAD_DIR`-relative path without the prefix (`R/items.ts:989`; `S/excel-import.ts:82`). The whole `S/excel-import.ts` and `/items/import` are unused by the frontend. `matchImages` is a TODO stub (`S/excel-import.ts:385`).
- **Dead:** `ExcelSyncService.setProgressCallback` and the SSE `ProgressCallback`, which are never wired. `addons.skipped` is never incremented. Errors from `variantAddonRepository.create` in the sync are swallowed (`S/excel-sync.ts:1077`).
- **Dead:** `variantAddonRepository.addAddonIfNotExists`, `itemRepository.findByCategory`, `findOrCreateByBaseModelNumber` (would create `type_id 0`), `updateByBaseModelNumber`, `itemTypeRepository.hasItems`, `itemVariantRepository.deleteByItemId`, `currencyService.getUSDtoPKRRate`, `getCacheStatus`, `UpdateItemVariantDTO.model_number`, the legacy columns `items.model_number/price/image_path` and `item_variants.model_number`.
- **Unused by the UI:** PATCH item and variant activate/deactivate, variant reorder, and item-type activate/deactivate (no UI path to reactivate a type).
- **Inconsistency:** the stale comment in `S/excel-sync.ts:1085` ("links to ALL variants") and the Phase 4 doc header contradict the code, which links only the matching style.
- **Inconsistency:** `/settings/last-sync-timestamp` returns `{success, data}` instead of the standard `{data}` envelope.
- **Inconsistency:** category deactivation via PUT responds with the category row read before the cascade (fine). The "Inactive" item-type flag is stored as an INT while categories, items and variants use BOOLEAN.
