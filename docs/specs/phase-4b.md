# Phase 4b – Planning made understandable, model cleanups

Spec written 2026-10-21, after phase 4a. Source: the same data-model and UI review with the user (the "more" list and the cleanup list), parked as 4b candidates in `docs/specs/phase-4a.md`. The user asked to build all of it ("mach b noch"). Every decision taken while building goes into `docs/decisions.md` (Decided table, step `4b-N`, author "Claude" unless the user decided it); fix rounds amend existing rows instead of adding new ones, so the numbering stays sequential across the stacked branches.

## Steps (one PR each, in order)

| Step | Content | Schema |
| --- | --- | --- |
| 4b-1 | Empty states with the next step; a first variant on product create; Documents tab split by audience | no |
| 4b-2 | Bus lines without manual setup: "Line 1" created automatically, devices of a system with one line assigned to it | no |
| 4b-3 | One problem list: plan and board warnings and the checks findings share codes, severities and one component | no |
| 4b-4 | Needs tab as room overview | no |
| 4b-5 | Model cleanups: drop `network_assignments.pinned`, one document counter table, no presentation facts in `version_items` | yes |
| 4b-6 | **Parked** (user, 2026-10-21: "6 weiß ich nicht, klingt wild"): attributes and fields as one concept. Re-evaluate after go-live with real catalog data; the section below stays as the design if it is picked up | yes |

Rules that hold for every step: CLAUDE.md (business rules in Go services once, design-system components, i18n en + de, generated code only via `make generate`, new goose migrations only), the 4a vocabulary (Systems, Functions, Channel kinds, Setup), and frontend parity with the backend.

## 4b-1 Empty states, first variant, Documents

### Empty states that name the next step

Every empty state below says what is missing and offers the action that fixes it (a button or a link), en + de. Use the design-system `EmptyState` (with an action); add the action slot if it is missing.

| Where | Condition | Text (en) | Action |
| --- | --- | --- | --- |
| Floorplan and board palette | the project has no systems ticked | "This project has no systems yet. Choose the systems you plan with to see their products." | "Choose systems" → opens the project's edit dialog (systems field focused); read-only users see the text only |
| Floorplan and board palette | systems ticked, but no active product of them fits this plan kind | "No products of the project's systems go on a floorplan / on a board." | link "Open the catalog" (catalog.read) |
| Plans section of a version | no plans | "Start with a floorplan (an image of the building) or a distribution board." | the existing add buttons |
| Networks tab | no bus or wireless devices on the plans | existing text plus "Place products of a bus or wireless system on a floorplan or board; they appear here." | link to the Plans tab |
| Networks tab | bus devices but no line of their system (only until 4b-2 removes this state) | "These devices need a bus line." | "Create line" |
| Checks tab | nothing to check (no needs and no devices) | "Nothing to check yet. Add needs to the rooms of a floorplan and devices to a board." | link to the Plans tab |
| Checks tab | everything fine | "No problems found." with the success icon | none |
| BOM tab | empty | "The bill of materials fills itself from the products on the plans. Add lines by hand for anything else." | the existing "Add line" |
| Proposals / documents | none yet | keep the existing texts, see the split below |

### A first variant on product create

- `products.Service.Create` creates the product together with its first variant in the same transaction. `ProductInput` gains an optional `firstVariant` (`{ name?, sku?, price, attributes? }`); left out on create = a variant named "Standard" in every content locale (the word is the same in en and de) with price 0. The API returns the product with that variant.
- The product create form (new product page) asks for **Price** (required, USD) and optional **SKU** in its first section and sends them as `firstVariant`. Variant-scope attributes of the category appear in the same form under "Variant" when the category has any.
- The product page shows the variant list only from two variants on: with one variant, its price, SKU, image and variant attributes appear in a "Price and variant" section of the product page itself, editing that variant through the variant API. "Add variant" stays available (a button in that section) and turns the section into the list.
- The import is unchanged (it always creates variants explicitly). The product delete and the "no variants yet" empty state stay for products that lost their last variant.
- Tests: backend create with and without `firstVariant`, validation of its fields, transaction (a failing variant leaves no product); frontend create form, one-variant section, switch to the list on the second variant.

### Documents tab split by audience

- Two sections with a heading and one line each: **For the customer** ("Proposals with prices for this version.") holding Proposals; **For the installer** ("Manual, channel labels and programming data for the site.") holding the installation documents and the programming exports.
- Order: customer first. No behaviour change.

### Decisions and tests

Record the empty-state rule (D448), first variant on create (D449), Documents split (D450). Tests: Vitest for every empty state above (condition and action), e2e `projects.spec.ts`/`plans.spec.ts`/`products.spec.ts`/`proposals.spec.ts` updated, visual screenshots of the new empty states and the product page with one variant.

## 4b-2 Bus lines without manual setup

Goal: a KNX or HDL project works on the Networks and Checks tabs without anyone creating a line first.

- **Automatic first line.** When a plan content save (floorplan or board) leaves a version with devices of a bus system (topology bus) and no bus line of that system, the networks feature creates one line named "Line 1" (i18n: the version's project language; en "Line 1", de "Linie 1") for that system in the same transaction. Implement as a `plans.ContentHook` registered by the networks service (the pattern of the BOM snapshot hook, D243: catalog facts read in `Prepare` outside the transaction, only inserts in `Apply`). The version copy copies lines as today. A deleted line is not recreated until the next save that again finds devices without any line of their system (deleting the last line of a system with devices is refused instead: `bus_line.last_with_devices`, 409, with the count; the user can move the devices first or delete the plans).
- **Default assignment.** A bus device without an explicit assignment counts as a member of its system's line when the system has exactly one line in the version (the view and the checks; no row is written, like the default gateway of a wireless device). With two or more lines, unassigned devices stay unassigned (`bus_device_unassigned` as today). The view marks such members as "automatic" (not pinned), the same way wireless members of a default gateway are shown.
- **Networks tab.** The line form stays for renaming, address and limits and for adding further lines. The 4b-1 empty state "These devices need a bus line" disappears with this step.
- Decisions: D451 (automatic first line, hook, refusal to delete the last line), D452 (default assignment with one line).
- Tests: backend hook (first bus device creates the line, a second save does not create another, two systems create two lines, wireless and none create nothing, version copy), delete refusal, default membership in the networks view and in the checks (`bus_line_*` capacity checks count the default members); e2e: place a KNX device on a board, the Networks tab shows "Line 1" with the device, Checks report the power supply check for that line.

## 4b-3 One problem list

Today the plan and board editors show their own warnings (`plans` warning codes: `module_width_unknown`, `row_overflow`, `need_outside_zones`, `variant_inactive`, ...) and the Checks tab shows findings (`wiring`). Goal: one list with one vocabulary, filtered by place.

- **Backend.** The checks endpoint (`GET /api/versions/{versionId}/checks`) includes the plan content warnings of every plan of the version as findings: `{severity, code, refs, params}` with refs naming the plan and the item. The plans service exposes its warnings per plan through a method the wiring service calls (rule 3); severities are assigned once in the plans feature (a table next to the codes, like `capabilities.MissingSeverity`). Codes stay as they are; there is one namespace of finding codes (document it in the checks model).
- `GET /api/versions/{versionId}/checks?planId=…` returns the findings that refer to that plan (as need plan, target plan or item plan).
- **Frontend.** One `FindingsList` component (in the `checks` feature, exported) renders findings: severity icon and colour, translated text, refs as links into the editor (selecting the item) or to the tab. The Checks tab uses it for all findings, grouped by plan then severity; the floorplan and board editors use it in their side panel for `?planId=` instead of their own warning lists. Texts of the former plan warnings move to the checks locales (one place), en + de.
- The editors refresh the plan's findings after each save (TanStack invalidation).
- Decisions: D453 (one finding vocabulary, plan warnings as findings, severity table in plans), D454 (FindingsList in editors and Checks tab).
- Tests: backend checks endpoint includes plan warnings with the right severity, `planId` filter; Vitest for `FindingsList` and for both editors' panels; e2e `boards.spec.ts`/`connections.spec.ts` updated; visual screenshots of the editor panel and the Checks tab.

## 4b-4 Needs tab as room overview

Today the Needs tab is a flat list of the same rows the floorplan editor edits. Goal: an overview of the rooms.

- One row per zone of every floorplan of the version (grouped by plan, in plan and zone order), plus "Outside every zone" per plan when needs lie outside: zone name and short name, the needs as compact chips (function, quantity, power), the units connected out of needed (e.g. "6 of 8 connected"), and a status (all connected / some missing / none). A zone without needs shows "No needs yet" with the action "Apply a room template".
- Counts come from the backend: extend the needs or checks API with a per-zone summary (`{planId, zoneId, needs: [...], units, connectedUnits}`) computed in the service that owns connections (wiring), reading needs through the plans service. No counting in the frontend (rule 1).
- Actions per row: "Open in editor" (the floorplan editor with the zone selected), "Apply a room template" (the existing template flow, for that zone), "Connect automatically" (the existing auto-connect, limited to that zone's needs if the API supports it; else the whole version, labelled so).
- Totals at the top: needs, units, connected, by function.
- Decisions: D455 (room overview and the summary endpoint).
- Tests: backend summary (zones, outside, connected counts with circuits and partial units); Vitest for the tab; e2e `needs.spec.ts` updated; visual screenshots.

## 4b-5 Model cleanups

Three changes from the data-model review, one migration each (goose, never edit applied ones), Down migrations best effort and tested by `migrations_test.go`.

1. **Drop `network_assignments.pinned`.** It is always true (the only insert writes true; the view computes "pinned" from the existence of the row). Remove the column, its sqlc params and the copy query's use; the API field `pinned` on members stays (computed). Down: add it back, default true.
2. **One document counter table.** `proposal_counters` and `generated_document_counters` become `document_counters (version_id, kind, tenant_id, last_seq)` with kind `proposal` for proposals. The migration copies both tables' rows, creates RLS like the other tenant tables, and drops the old ones. Proposals and installation use the new table through their own queries (each feature keeps its own `NextSeq` query, a table may be written by two features only if one owns it: the owner is `installation`, and proposals call `installation.Service.NextSeq(ctx, tx, versionID, kind)` instead of their own query, rule 3). Numbers continue without gaps or reuse.
3. **No presentation facts in `version_items`.** Drop `product_type_abbreviation`, `product_type_color`, `product_type_position`, `category_position` (keep ids, keys and names: a frozen name belongs to the proposal; colour, badge and order follow the catalog). The BOM reads badge, colour and order live from the product types and categories services when building the view and the proposal; a deleted system or category (only possible when unused) falls back to the frozen name, no badge, last position.
- Decisions: D456 (the three cleanups and why).
- Tests: migrations up/down with data; BOM order and badges follow a reorder and a recolour in the catalog; proposal and installation numbers continue across the migration; networks members still report pinned correctly.

## 4b-6 Attributes and fields as one concept (parked)

Not built in phase 4b. The user was unsure about the migration's reach; 4a-3's "Create a new field…" from the attribute row and the readiness checks cover the daily need. Kept as the design for a later decision.


Today a category has its own attribute list (`categories.attributes`, `instance_attributes`: key, label, description, type, unit, options, min, max, required, scope, optional `fieldKey`) and the catalog has fields (`catalog_fields`: key, label, type, unit, options, meaning). An admin defines "Channels" on the category and links it to a field. Goal: one concept. A **field** says what a value is (key, label, type, unit, options, meaning); a **category** says which fields its products have and how (order, scope, required, min, max, description).

### Model

- Every category attribute names a catalog field (`fieldKey` required). The attribute's own `key`, `label`, `type`, `unit`, `options` and `itemType` are removed from the stored schema; they come from the field when read (as linked attributes already do, D308). Kept per attribute: `fieldKey`, `scope` (product / variant), `required`, `min`, `max`, `description` (optional help text per category), position. Instance attributes the same (`fieldKey`, `required`, `min`, `max`, `description`).
- Attribute values on products and variants stay keyed by the field key (the attribute key equals the field key from now on).
- `list` type: catalog fields gain `list` with `itemType` (they had only text, number, integer, boolean, enum), so every existing attribute type has a field type.
- `category_field_links` stays as the integrity table (now one row per attribute, always).
- The API keeps returning the resolved attribute (key, label, type, unit, options from the field) so readers (products, plans, capabilities, imports, exports) do not change; only the category write input changes (`fieldKey` instead of key/label/type/unit/options).

### Migration (one goose migration, Down best effort)

For each category attribute and instance attribute without `fieldKey`:
1. If a catalog field with the attribute's key exists and has the same type, unit and options (an enum's options as a set of keys), link it.
2. Else if no field with that key exists, create one from the attribute (key, label, type, unit, options, item type; no meaning) and link it.
3. Else (a field with that key but another type): create a field `<key>_<category key>` (truncated to 64, made unique with a number), link it, and rename the key in that category's products' and variants' `attributes` jsonb and in the instance values of placements and board modules of products of that category (plan contents keep values by instance attribute key).
Attributes that were linked keep their link and lose their duplicated properties. The migration must be idempotent on an empty database and tested with data covering all three cases.

### UI

- Category editor: the attribute list becomes a list of fields: "Add field" opens a picker of catalog fields (search, with their meaning in plain words from 4a-3) plus "Create a new field…" (the 4a-3 dialog). Per row: the field's label, type and unit (read-only, with a link "Edit field" to the Fields page), scope, required, min/max where the type has them, description. Reorder as today.
- Fields page (Setup): shows in which categories a field is used (count with a popover list), and editing a field's label, unit or options changes every category that uses it (explain this in the dialog: "Used in N categories").
- Import: the "New columns" step's "Just information" answer creates a field without meaning (instead of a text attribute without a field), so every imported column is a field. Categories created by the import name the fields. The step's options become "A new field (just information)", "A new field with a meaning", "An existing field".

### Decisions and tests

D457 (one concept: categories name fields; what stays per category), D458 (migration rules, the rename case), D459 (import answers). Tests: migration with the three cases and the value rename; categories API write/read; products, imports and capabilities tests unchanged in behaviour (adjust fixtures); Vitest for the category editor picker and the Fields page usage; e2e `categories.spec.ts`, `imports.spec.ts`, `imports-v1-workbook.spec.ts`, `capabilities.spec.ts`, `products.spec.ts`; visual screenshots of the category editor and the Fields page.
