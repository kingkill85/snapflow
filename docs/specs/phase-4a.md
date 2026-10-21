# Phase 4a – Catalog made understandable

Spec written 2026-10-21 after a review of the data model and the catalog UI with the user. Finding: the model is sound (needs ask for a function, a function is served by channel kinds, channels come from product fields, load types refine limits), but the UI presents seven catalog concepts as equal menu entries under names that do not say what they are, shows bus settings on wireless systems, and never tells an admin what is still missing before a system works in a project. The user approved the six-point plan below ("the plan is good") and asked for implementation in steps by subagents; while 4a-1 was running the user suggested a separate top menu item instead of a Rules page, which replaced it.

No schema changes. Code identifiers, API paths, i18n namespaces and feature folders keep their names (`product_types`, `function_types`, `output_kinds`); only user-facing labels change.

## Vocabulary (user-facing, en / de)

| Code name | Label before | Label after |
| --- | --- | --- |
| product type | Product types / Produkttypen | **Systems / Systeme** |
| function type | Function types / Funktionstypen | **Functions / Funktionen** |
| output kind | Output kinds / Ausgangsarten | **Channel kinds / Kanalarten** |
| catalog field | Fields / Felder | Fields / Felder (unchanged) |
| import profile | Profile / Profil | **Saved mapping / Gespeicherte Zuordnung** |

Error codes, API docs and OpenAPI operation names keep the code names. Where an error message or hint prints the concept to the user, use the new label.

## Steps (one PR each, in order)

| Step | Content |
| --- | --- |
| 4a-1 | Names and menu: the renames above; a new top-level section **Setup** (Einrichtung) holds Systems, Functions, Fields, Room templates, Channel kinds and Load types, each page starting with a one-line explanation; the Catalog section keeps Products, Categories, Import |
| 4a-2 | Editors: the Systems editor is topology-driven (only the fields of the chosen topology, voltage and reserve under "Advanced"); the Functions editor gains "Served by channel kinds" and hides KNX objects unless a KNX system exists; the Functions list shows what serves each function |
| 4a-3 | Meanings where the admin is, and readiness: meanings explained in plain words with an example wherever they are chosen (Import "New columns", category attribute, Fields page); a field can be created from the category attribute row; a readiness check per system on the Systems page and "Missing" lines on the product page |

## 4a-1 Names and menu

- Labels per the vocabulary table, in every feature's `locales/en.json` and `de.json`, in `common.json` and in the shell. Grep for the old words (also in hints, empty states, error messages in `errors.json`, e2e specs, the README if it mentions them).
- **Sections** (user suggestion 2026-10-21: "maybe a different top menu item?"): the header gets a fourth section `setup` between Catalog and Administration, label "Setup" / "Einrichtung". `FeatureModule.nav.section` gains `'setup'`; `AppShell` lists sections in the order projects, catalog, setup, admin. A section without visible entries (permissions) is not shown, as today.
- Catalog (section `catalog`, order): Products 1, Categories 2, Import 3.
- Setup (section `setup`, order, by how often they are touched): Systems 1, Functions 2, Fields 3, Room templates 4, Channel kinds 5, Load types 6. Paths stay as they are (`catalog/...`); only the menu changes. No Rules page, no tabs, no redirects.
- Each Setup page starts with a one-line explanation under its title (en/de), e.g. Systems: "The systems you sell (Zigbee, KNX, HDL Buspro). A system's topology decides which checks and addresses apply." Functions: "What a room asks for (light, blind, socket). A function is served by channel kinds." Fields: "The spreadsheet columns SnapFlow understands. A field with a meaning feeds the checks; without one it is just information." Room templates: "Default needs for a room, applied to a zone in one click." Channel kinds: "The kinds of channel a device has (dimmer, relay, blind, input). Each kind lists the functions it can serve. Seeded; rarely changed." Load types: "What a light or motor is electrically (LED, halogen, motor). Limits per channel can differ by load type. Seeded; rarely changed."
- The Import page says "Saved mapping" where it said "profile".
- Decision log: record D441 (vocabulary), D442 (Setup section and the split of Catalog into data and setup). Open questions: none expected.
- Tests: unit tests of the shell navigation (four sections in order, their entries and order, permission filtering, a section without entries is hidden); e2e `capabilities.spec.ts`, `product-types.spec.ts`, `misc.spec.ts`, `layout.spec.ts` and `i18n.spec.ts` updated to the new labels and menu; `layout.spec.ts`/`capabilities-visual.spec.ts` cover the header with four sections at every width (the phone sheet too).

## 4a-2 Editors

### Systems editor (`product-types` feature)

Order of the form:

1. Key, name, abbreviation, colour (as today).
2. **Topology** (Bus / Wireless / None) with the existing hint.
3. Fields of the chosen topology only:
   - Bus: Addressing (None / KNX individual address / HDL Buspro), Default bus current, Devices per line.
   - Wireless: Addressing (None / EUI-64), Default wireless places.
   - None: nothing.
   Switching the topology clears the fields that no longer apply (the database constraint `product_types_addressing_topology_check` rejects a mismatch; the form must never send one).
4. **Advanced** (collapsed by default; expanded when a value differs from its default): Switched voltage (default 230, hint as today) and Reserve (default 20, hint as today). Hidden entirely for topology None? No: voltage matters for amp limits on any system that switches mains; keep both under Advanced for every topology.
5. Active (last, D112).

The list page keeps its columns; the "Addressing" column shows "–" for None.

### Functions editor (`function-types` feature)

- Section 1: key, name, **Served by channel kinds** (checkbox group of active output kinds, ordered as the Channel kinds page; at least one is not required, but an unserved function gets a hint "No channel kind serves this function yet: needs of it cannot be connected"), **Shares a circuit** (the `allowsCircuit` switch, with its hint).
- Section 2 "Details" (collapsed when empty): Allowed load types (as today), KNX objects. The KNX objects editor is shown only when a product type with addressing `knx_individual` exists (the systems list is already loaded by the app; use `useProductTypes` or equivalent); when hidden, existing objects are kept untouched on update (the API keeps them when left out).
- Section 3: Active.
- The Functions list page gets a column "Served by" (channel kind names, comma separated; "–" with a warning badge when none).

### Backend for "served by" from the function side

- `FunctionType` (read) gains `outputKindIds []uuid.UUID` (the channel kinds whose `functionTypeIds` contain it). `FunctionTypeInput` / update gain optional `outputKindIds` (max 200; left out on update keeps the current links; empty list clears them).
- Features do not read each other's tables (rule 3). `functiontypes.Service` gets a small interface it calls inside its transaction, e.g. `type ServedBy interface { ListFor(ctx, tx, functionTypeID) ([]uuid.UUID, error); Set(ctx, tx, functionTypeID, kindIDs []uuid.UUID) error }`, registered by the capabilities service at wiring time (`functionTypesSvc.SetServedBy(capsSvc)`), the same pattern as `plans.ContentHook` (D243). `capabilities` already depends on `functiontypes`, so the interface avoids the import cycle. `Set` validates that every id is an existing output kind (`output_kind.not_found` as a field error on `outputKindIds[i]`), replaces the rows of `output_kind_function_types` for that function type, and bumps `updated_at` of the affected output kinds (their editors show stale otherwise, D56).
- Record D443 (systems editor), D444 (functions editor and served-by API).
- Tests: backend `functiontypes` API tests for read/write of `outputKindIds` (unknown id, clear, keep when left out, in_use of an output kind still enforced), capabilities tests unchanged plus one for the bump; frontend tests of both dialogs (topology switching clears fields, Advanced expands when non-default, served-by writes ids, KNX objects hidden without a KNX system); e2e `product-types.spec.ts` and a function types section in `capabilities.spec.ts` or `misc.spec.ts`, visual specs for both dialogs.

## 4a-3 Meanings where the admin is, readiness

### Meanings in plain words

- One source of truth in the frontend `capabilities` feature: `describeMeaning(meaning)` returning `{ title, description, example }` from `locales` (en/de), e.g. `channels_supplied`: title "Number of channels", description "How many channels of one kind the device has", example "4 dimmer channels"; `bus_current_used_ma`: "Bus current the device draws", "mA taken from the bus line; used for the line's power supply check", "10 mA"; `rail_width_te`: "Width on the DIN rail", "In TE (17.5 mm); used for the board's capacity", "4 TE"; the same for every meaning in `MeaningSpec`.
- Used in: the Import "New columns" step (meaning select shows title + description, example as placeholder), the Fields page under Setup (list column and editor), the category attribute row (the linked field's meaning shown as title + one line, instead of the raw key).
- **Create a field from the category attribute row**: the "Catalog field" select in `SchemaEditor` gets an entry "Create a new field…" that opens the field dialog (reuse the Fields page's `CatalogFieldFormDialog`), prefilled with the attribute's key, label, type and unit; on save the attribute is linked to it. The Fields page is then reference material.

### Readiness

- Backend, `capabilities` feature: `GET /api/catalog/readiness` (perm `catalog.read`), computed on request (no table):
  ```
  { "systems": [{ "productTypeId", "key", "name", "topology", "items": [Item] }], "global": [Item] }
  Item = { "code", "severity": "error" | "warning" | "info", "count", "refs": [{ "kind": "product" | "category" | "function" | "system" | "channel_kind", "id", "label" }] (max 20, count says the rest) }
  ```
  Codes, each a one-liner the UI translates (en/de):
  - global: `functions_none` (error: no active function), `function_not_served` (error, one ref per function), `function_no_load_types` (info), `function_no_knx_objects` (warning, only when a KNX system exists), `channel_kind_unused` (info: no field with `channels_supplied` points at it), `categories_without_mounting_board` (warning: a category whose products carry a `rail_width_te` value but mounting is floorplan).
  - per system (products of that product type): `topology_none` (info: no bus or wireless checks), `product_bus_current_missing` (warning, bus systems without default bus current: products with no `bus_current_used_ma` value), `system_no_power_supply` (warning, bus: no product supplies bus current), `system_no_gateway` (warning, wireless: no product supplies wireless places), `product_board_without_width` (error: mounting board/both and no `rail_width_te`), `product_channels_missing` (warning: category has a `channels_supplied` field, value empty), `product_channel_without_limit` (info: channels but no limit field of any kind), `system_no_enclosure` (info: no product with `enclosure_rows`).
  Inactive products, categories and systems are skipped. Reuse the existing capability computation (`compute.go`) per product; one pass over the catalog.
- `GET /api/products/{id}` capabilities block gains `missing: [{ code }]` for that product (the product-level subset above), shown on the product page under "What SnapFlow knows about this product" as "Still missing" lines with the plain-words text.
- Frontend: the Systems list page gets a **Readiness** section above the table: one card per active system (name, badge, topology) with its items grouped by severity (icon, text, count), each ref a link to the product, category or function; and a "General" card for the global items. All green: "Ready: nothing missing". A header line explains: "What SnapFlow still needs before this system works in a project."
- Record D445 (meaning texts and create-from-attribute), D446 (readiness endpoint and codes), D447 (product "missing" lines).
- Tests: backend readiness tests per code with a small fixture catalog, product `missing`; frontend tests of `describeMeaning` coverage (every meaning has texts in en and de, type-checked), the create-from-attribute flow (MSW), the Readiness section (grouping, links, all-green); e2e `capabilities.spec.ts` (import a sheet with a new column, see the plain-words meaning), `product-types.spec.ts` (readiness card shows a missing width, fix it on the product, card goes green); visual spec for the Readiness section and the product page.

## Out of scope (phase 4b candidates, from the same review)

Empty states with next-step hints in the planner (palette without systems, Networks tab without a line), auto-created "Line 1" for bus systems, default variant on product create, Needs tab as room overview, Documents tab split by audience, Checks and editor warnings as one list, attributes and fields as one concept (the only schema change discussed).
