# Phase 3 – Distribution boards, zone needs, channel assignment, checks

Spec written 2026-10-19. The user decided to build phase 3 as planned now and adjust after the customer has answered the open questions ("make phase 3 as planned, we change things after"). Sources: the agreed concept (`docs/decisions.md` D185–D192, the customer PDF "SnapFlow – Distribution boards concept"), the research report `docs/research/phase-3-research.md` (recommendations R1–R20), `docs/architecture.md` (plan kinds, `Supplies`/`Demands`/`Checks`). Every decision taken while building goes into `docs/decisions.md`; open customer questions are recorded as Q-entries with the assumption the code follows.

## Assumptions for open customer questions (record as Q6–Q12)

| Question | Assumption the code follows |
| --- | --- |
| HDL Buspro limits (devices per bus/subnet, cable length, PSU reserve) | No built-in constants: limits are product data (fields on power supplies / lines) or a per-system setting; defaults empty = not checked |
| Zigbee gateway device limit, repeaters | Gateway field "max devices" (no default); optional "Zigbee router" field; warning "many end devices, no router" |
| Relay pairs usable as blinds ("N relays or N/2 blinds", mixed) | Supported from the start: an output kind can have an alternative (2 relay outputs = 1 blind output), chosen per channel pair |
| Default reserve | 20 %, a tenant-independent setting per system (admin), amber above 100 − reserve %, red when exceeded |
| MCB / RCD / SPD | Can be placed on the board as products (rail space, BOM); no protection planning |
| Enclosures, "ways" vs TE | Enclosure products supply rows × TE per row (fields); width in decimal TE (17.5 mm); a board without enclosure has free rails |
| Installer outputs | Board report (rails, modules, channels → zone / need) and channel labels, as DOCX via the document model |

## Steps (one PR each, in order)

| Step | Content |
| --- | --- |
| 3a | Catalog capabilities: load types, output kinds (with alternatives), function type extensions, catalog-wide field meanings, mounting per category with product override, import asks for meanings of unknown columns |
| 3b | Zone needs: needs list per zone in the floorplan editor, room templates, optional load symbols on the plan |
| 3c | Distribution boards: plan kind `board`, board editor (enclosure, rows of TE, modules from the board palette), bus lines, Zigbee gateway assignment, board products in the BOM |
| 3d | Connections and checks: connect needs to channels (manual, auto-connect with preview), circuits, the checks engine with reserve thresholds, zone status on the floorplan, project-wide unconnected list, board header totals |
| 3e | Installer outputs and programming data: board report and channel labels (DOCX), per-unit programming fields, KNX group address export (CSV) |

---

## 3a – Catalog capabilities

### Model (global catalog configuration, admin = `catalog.write`)
- **Load types** (`load_types`): key, translatable name, position, active. Seed: resistive, LED, halogen / incandescent, inductive (transformer), capacitive, AC motor, DC motor, pushbutton contact. Admin-editable like function types.
- **Function types** (exist, D-catalog): add `allowsCircuit` (several needs may share one channel — lights, sockets: yes; blinds, inputs: no) and the load types a need of this function may have (subset; empty = any). Seed reasonable flags for existing keys if present (dimmer, switching, blind, input …).
- **Output kinds** (`output_kinds`): key, translatable name, position, active; the function types it serves (e.g. dimmer output → dimmer, switching; relay output → switching; blind output → blind; input → pushbutton/contact); alternatives: "N of kind X can act as 1 of this kind" (blind output ← 2 relay outputs), several per kind, in fixed groups (1+2, 3+4, …), so a module's relay pairs can be used as blinds per pair (mixed use) — only for products that opt in with a field of meaning `alternative_allowed` (D303). Universal channels ("each channel dimmer or relay") = relay output ← 1 dimmer output with the opt-in; channels count once.
- **Field meanings** (the core of D187/D188): a catalog-wide registry of known columns/fields (`catalog_fields`): key (lower snake case), translatable label, value type (number, whole number, text, yes/no, choice), unit (display), optional `etimFeature` code (R13, informational), and an optional **meaning** for the checks with parameters:
  - `channels_supplied` (output kind) — number of channels of that kind the product supplies
  - `channel_limit_w` (output kind, load type) — max W per channel for that load type
  - `channel_limit_a` (output kind, optional load type) — max A per channel
  - `channel_min_load_w` (output kind, optional load type) — minimum load per channel
  - `module_total_a` / `module_total_w` (optional load type) — limit for the whole module
  - `alternative_allowed` (output kind = target kind, yes/no) — the product's channels may act as that kind through its alternatives (D303)
  - counts (`channels_supplied`, `bus_devices_max`, `enclosure_rows`, `wireless_places_supplied`) are whole numbers (D307)
  - `bus_current_used_ma`, `bus_current_supplied_ma`, `bus_devices_max` (on power supplies / couplers / lines)
  - `rail_width_te`, `enclosure_rows`, `enclosure_te_per_row`
  - `wireless_places_supplied`, `wireless_place_used` (fixed value, may be limited to product types), `zigbee_router` (yes/no)
  - `motor_type` (choice with exactly `ac`/`dc`: which motors the blind outputs drive; `channel_limit_w` for motor load types is an optional limit on top, D310)
  - none = "just information"
  - A meaning may be limited to product types (D191: "uses 1 wireless place – only Zigbee").
- **Category attribute schemas** keep working as today (D99), but an attribute definition can be linked to a catalog field (`fieldKey`), taking its type, unit and meaning from there (resolved when read, D308; links stored in `category_field_links`, D305); a category created by the import links its attributes to the known fields automatically.
- **Mounting** (`mounting`: floorplan | board | both) on categories, and an optional per-product override (product field + import target "mounting").
- **Empty values**: an empty field does not count (D187), except a bus product without `bus_current_used_ma` is reported later as "bus current unknown" (R3; the check, not the catalog, does this in 3d). A per-system default bus current (e.g. KNX 10 mA) is a product type setting (`defaultBusCurrentMa`, optional).
- Product types gain optional system settings: `topology` (bus / wireless / none), `defaultBusCurrentMa` (used for bus systems), `defaultWirelessPlacesUsed` (used for wireless systems), `reservePercent` (default 20), `busDevicesMax` (optional default per line) (D304).

### Import (D188)
- On the mapping page, every mapped column that targets a category attribute is matched against the catalog fields (by key / header text, ignoring case and spacing). Known → type, unit and meaning are taken over. Unknown → listed under "New columns – what do they mean?": the user chooses label, type, unit and meaning (or "just information"); saving creates the catalog field, and the preview continues. The mapping profile remembers the links.
- Categories created by the import get attributes linked to these fields (instead of text attributes, D133 amended). Existing categories with an unlinked attribute of the column's key get it linked at apply when the types match, shown in the preview as a category change; another type is a warning (D314). Answers can also link an existing field or override an automatic match (D315).

### API and UI
- CRUD + order for load types, output kinds, catalog fields (Catalog section: new pages "Output kinds", "Load types", "Fields"), function type editor gains the new flags; category editor: mounting select, and per attribute an optional link to a catalog field (showing its meaning read-only); product editor: mounting override.
- The capabilities a product has are computed by the backend from its attribute values and the linked meanings: `GET /api/products/{id}` (and variants) return a `capabilities` block (channels by output kind with limits, bus current used/supplied, rail width, wireless, mounting) — the frontend shows it read-only on the product page ("What SnapFlow knows about this product").

### Tests
Backend: CRUD/validation, meanings with parameters, capability computation (empty values, product type limitation, alternatives), import flow for unknown columns (blocked until answered, fields created, categories linked), permissions. Frontend: the new catalog pages, category/product editors, import "new columns" step, capabilities block. E2E: import an Excel with new capability columns → answer the meanings → product shows its capabilities.

---

## 3b – Zone needs (outline, detailed at the start of 3b)
- Needs per zone (stored with the plan content or as their own table per zone): function type, quantity, power per unit (W), load type, label/note; quantity n = n needs (each needs its own channel or shares one as a circuit later).
- Room templates (catalog configuration): name, optional equipment level, list of need lines; applying adds lines (no hidden link, research Q6).
- Editor: the zone inspector gets a "Needs" section (add line, apply template, edit, delete); the Zones tab shows needs per zone; optional load symbols placed on the plan (a need with a position, drawn as an icon; zone from position).
- BOM unaffected (needs are not products). Version copy copies needs.

## 3c – Distribution boards (outline)
- Plan kind `board` (architecture "Plan kind"): a board belongs to a version, has a name and optionally an enclosure product (rows × TE per row) — else free rails (rows and TE entered).
- Board editor (shared canvas base or a simpler grid UI): rows as rails, modules placed by drag from the board palette (categories with mounting board/both, project product types), position in TE, widths from `rail_width_te`; reorder, remove, existing flag (D185), labels.
- Bus lines: per system, default one per system and project; split possible; power supplies and bus devices (board modules and floorplan bus devices) belong to a line (automatic by system, editable). KNX area/line and HDL subnet stored on the line for later (R14).
- Zigbee: devices connected to a gateway (automatic with one gateway; suggestion by floor/nearness with several; editable) (D191).
- BOM: board modules contribute BOM lines like placements (plan kind `BOMLines`).

## 3d – Connections and checks (outline)
- Connections: each need (or circuit of needs) → one channel (board module + channel number), or a floorplan device that supplies channels in the room (Zigbee in-wall dimmer). Valid when the output kind serves the function type and the limits hold (per load type, minimum load, module total); blind → blind output or a relay pair used as blind (mixed use per pair).
- Auto-connect: never adds products; preview summary ("14 will be connected, 3 cannot: no free blind output"), one-step undo, pinned manual connections untouched, deterministic order (floor → zone → need order → board order → channel; prefer the same board, fill a module before the next).
- Checks engine (backend, plan kinds `Supplies`/`Demands`/`Checks`): rooms covered, unconnected needs, overloads (channel, module), free channels per board and kind, bus current used vs supplied per line (unknown currents reported), devices per line, rail space per row and board, wireless places per gateway, "many end devices, no router"; reserve thresholds (amber / red).
- UI: zone status on the floorplan (colour + text), project-wide "Unconnected needs" list grouped by floor/zone, board header totals, channel inspector ("Living room – ceiling lights, 3 × 60 W LED").

## 3e – Installer outputs and programming data (outline)
- Board report per board (rails, modules, channels → zone / need label, totals) and channel labels, as DOCX via the document model (2d), downloadable from the board.
- Programming data stored now (R18): per-unit fields for KNX individual address / HDL subnet + device id / Zigbee IEEE address (category instance attributes linked to catalog fields with meanings), bus line and gateway per device, channel ↔ needs.
- KNX group address export (CSV/XML importable by ETS) as the first programming export; HDL and Zigbee as commissioning sheets until import formats are known.
