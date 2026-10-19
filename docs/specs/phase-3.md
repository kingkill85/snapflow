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

## 3b – Zone needs

What a room needs (D186): lights, blinds, sockets, pushbuttons — not catalog products, never in the BOM. Entered per zone in the floorplan editor, fast through room templates; optionally drawn as load symbols on the plan.

### Model
- **Needs are part of the plan content** (saved with zones and placements in `PUT /api/plans/{id}/content`, same lock, stale check, undo/redo and autosave as 2b). Table `plan_needs` (tenant-owned, RLS, composite keys like `plan_zones`): `id` (client uuid), `plan_id`, `zone_id` (nullable), `function_type_id`, `quantity` (1–100), `power_w` (`numeric(9,2)`, ≥ 0, ≤ 100000, optional; a decimal string in the API, D341), `load_type_id` (optional; must be one of the function type's allowed load types when that list is not empty), `label` (≤ 100), `note` (≤ 500), `x`/`y` (optional: set = a load symbol on the plan), `position` (order).
  - A need without a position belongs to the zone given by `zone_id` (required then). A need with a position is a **load symbol**: its zone is computed by the backend like placements (centre in the smallest containing zone), `zone_id` from the client is ignored; outside every zone = "no zone" (reported, not an error).
  - Quantity n means n separate needs for the later connection (each needs a channel or shares one as a circuit if the function type allows it, 3d).
- **Room templates** (catalog configuration, `catalog.write`; read for everyone with `projects.read`): key, translatable name, optional equipment level text (e.g. "Basic", "Comfort"), position, active, lines [{function type, quantity, power W, load type, label}]. Seed none.
- Validation per need (field errors at `body.needs[i].…`): function type exists and is active (inactive kept for existing rows with a warning), load type allowed, numbers in range, zone exists in the same content. Limit 2000 needs per plan.
- Warnings in the content response: `need_function_type_inactive`, `need_outside_zones` (symbol), `need_load_type_not_allowed` (after a function type change).
- Version copy copies needs, keeping their ids (D339). Project read-only rules as 2b.

### API
- Content GET/PUT gain `needs[]`.
- `GET/POST/PUT/DELETE /api/room-templates[/{id}]`, `PUT /api/room-templates/order`.
- `GET /api/versions/{versionId}/needs` → all needs of the version grouped by plan → zone (with zone names, function type, totals per function type), for the version overview now and for 3d later.

### Editor (frontend)
- Zone inspector: a **Needs** section — rows "3 × Dimmable light · 60 W · LED · Ceiling", add (inline row or small dialog: function type select, quantity, power W (D144 decimals), load type select filtered by the function type, label, note), edit, delete, reorder, **Apply template** (select of active room templates → adds its lines, one undo step).
- Zones tab: per zone a needs summary ("7 needs") next to the device count.
- **Load symbols**: a toolbar tool "Place need" (choose function type, then click on the plan); drawn as a small round icon with a short function-type mark (letter or icon from a small fixed icon set per function type key; fallback initial), label below; select/move/delete/duplicate like placements; inspector shows the need fields; hidden with a new "Needs" layer switch.
- Version page: a read-only **Needs** overview in the BOM tab or a new sub-section ("Needs by room": plan → zone → lines, totals per function type) — decide and record.
- Catalog: **Room templates** page (list, editor with lines repeater, reorder, active).
- en + de texts, design-system components.

### Tests
Backend: content save/load with needs (validation, warnings, symbol zone computation, limits), templates CRUD, version needs summary, version copy, RLS on `plan_needs`. Frontend: needs section, template apply (one undo step), symbol tool, layers, templates page. E2E: create a template, open a plan, apply it to a zone, add a need, place a load symbol in another zone, reload shows everything, the version needs overview lists them.

## 3c – Distribution boards

A version gets board plans next to its floorplans: DIN rails in rows, modules placed on them from the board palette, an optional enclosure. Bus lines group the bus devices of a system; Zigbee devices are assigned to gateways. Connections of needs to channels and all checks come in 3d — 3c stores what they need.

### Model (tenant-owned, RLS like plans; ids stable across saves and version copy, D339)
- **Board plans**: `plans.kind = 'board'` (D195's image fields are null for boards). Board settings on the plan: `enclosure_variant_id` (optional catalog variant whose capabilities give rows × TE per row) or manual rows.
- **Board content** (saved as one document like floorplan content, same lock / `contentUpdatedAt` stale check / autosave / undo, D193, D201): `board_rows` (`id` client uuid, `position`, `capacity_te` decimal(5,1) — from the enclosure (read-only then) or entered), `board_modules` (`id` client uuid, `row_id`, `offset_te` decimal(5,1) ≥ 0, `variant_id` + `catalog_variant_id` (D229), `label`, `existing` (D185), `addon_variant_ids`, `instance_values` (category instance schema), `position`).
  - Width of a module = its capability `railWidthTe`; unknown width → treated as 1 TE with a warning `module_width_unknown`.
  - Validation (field errors `body.modules[i].…`): variant exists, row exists, offset ≥ 0, no overlap with another module in the same row (error `board.overlap`), add-ons/instance values as placements. Not errors but warnings: `module_mounting_floorplan` (product not meant for the board), `row_overflow` (offset + width > capacity), the D54 availability warnings.
  - Enclosure: when set, rows are created/kept to match its `enclosureRows × enclosureTePerRow`; changing the enclosure keeps modules on rows that still exist, others move to the end of the last row as overflow (warning) — record the rule.
- **BOM**: board modules contribute BOM lines exactly like placements (one column per plan in the BOM, existing excluded, required/optional add-ons, snapshot hook D230 extended to boards); the enclosure contributes one line.
- **Networks** (per version): 
  - **Bus lines** (`bus_lines`: id, version, product type (system with topology `bus`), name, KNX area/line or HDL subnet as optional text for later programming, position). One default line per bus system is created by the first content save (floorplan or board) that gives the system a member (a networks content hook in the save's transaction, D372); `GET /networks` never writes and lists members of a system without a line as `unassigned`; more lines can be added (an active bus type of the project, D377). Optional `devices_max` per line overrides the system's `busDevicesMax` for 3d.
  - **Membership** of bus devices: every placement (floorplan) and module (board) whose product type has topology `bus` belongs to a line — by default the system's first line; an explicit assignment (`network_assignments`: plan_id, item_id, bus_line_id, pinned) overrides it. Power supplies (capability `busCurrentSuppliedMa`) are members like any device and supply their line.
  - **Gateways** (wireless): items whose capability `wirelessPlacesSupplied` > 0 are gateways; every wireless device (topology `wireless`, uses places) is assigned to a gateway — default: the gateway on the same floorplan, else the nearest by plan order, else the first; explicit assignment overrides (same `network_assignments` table with `gateway_plan_id` + `gateway_item_id`).
  - Assignments reference items by (plan_id, item_id) without FKs to content rows (same reasoning as D340); dangling assignments are ignored and reported by 3d's checks.
- Version copy: boards, rows, modules, bus lines, assignments with ids kept (plan id map via `OnCopyPlans`, D339).

### API
- Plans: create with `kind: board` (name, optional enclosure variant, or rows); `GET/PUT /api/plans/{id}/board` (content: rows, modules, enclosure) with lock/stale like floorplan content; responses carry each module's capability summary (width, channels by output kind, bus current) via the products capability service (D243: loaded before transactions).
- `GET/POST/PUT/DELETE /api/versions/{versionId}/bus-lines[/{id}]`, `PUT …/order`.
- `GET /api/versions/{versionId}/networks` → bus lines with members (item ref, plan, product, bus current used/supplied, pinned) and gateways with their wireless devices; `PUT /api/versions/{versionId}/network-assignments` (set/clear explicit assignments, `projects.write`, read-only rules).
- Errors `board.*`, `bus_line.*`, `network.*` en + de.

### Frontend
- Plans tab: "Add board" next to "Add plan" (name, enclosure from board-mounted enclosure products or rows × TE entered); board cards show a schematic thumbnail and "n modules · x of y TE".
- **Board editor** (route like the floorplan editor; DOM/SVG grid or the canvas base — choose what gives the better keyboard a11y; record): rows drawn as DIN rails with TE ticks (1 TE = 17.5 mm, scale to fit), modules as boxes with product name/badge/label, width in TE; palette of board products (effective mounting board/both, the project's product types, grouped by category, search); drag from the palette onto a rail (snap to 0.5 TE, collision-free placement, auto-shift on drop if needed), move within/between rows, keyboard move, duplicate, delete, existing flag, label; inspector with product/variant change, add-ons, instance values, and a read-only capability summary (channels by kind with limits, bus current, width) — channel connections are 3d; header totals "x / y TE" per row and board; undo/redo, autosave, lock, read-only — same patterns as the floorplan editor (reuse hooks).
- Version tab **Networks**: bus lines per system (add, rename, KNX/HDL address fields, delete when empty), member list with move-to-line, power supplies marked; gateways with their devices, reassign; default vs pinned shown. Totals shown here are informational (bus current sum, device count) — the checks with reserve come in 3d.
- en + de, design-system components only.

### Tests
Backend: board content validation (overlap, overflow warning, mounting warning, width unknown), enclosure rows, BOM with board modules and enclosure, snapshot hook for boards, bus lines CRUD, default membership and explicit assignments, gateway defaults (same plan / nearest / first), version copy with ids, RLS on the new tables, lock/stale/read-only. Frontend: board editor reducer/undo, placement snapping/collision, palette filter by mounting, inspector, networks tab. E2E: add a board with an enclosure, place a power supply and two actuators, see TE totals and the BOM lines, open Networks and move a device to a second bus line, assign a Zigbee device to another gateway, reload keeps everything.

## 3d – Connections and checks

Needs (3b) are connected to channels of devices (board modules 3c, or floorplan devices that supply channels in the room, e.g. a Zigbee in-wall dimmer); the checks engine evaluates the whole version. Data model fixed earlier: D340 (connections keyed by need + units, no FK to needs), D378 (channel identity), D372 (one membership function in networks).

### Model
- **`connections`** (tenant-owned, RLS, per version): `id`, `version_id`, `need_plan_id`, `need_id`, `units` (≥ 1), target `target_plan_id`, `target_item_id` (board module id or floorplan placement id), `output_kind_id`, `channel_no` (1..count of that kind on the item; for an alternative kind, e.g. blind output from relay pairs, channel_no counts in the alternative's numbering and consumes the fixed pair 2k−1, 2k of the base kind, D303), `pinned` (true = made by hand; auto-connect never moves pinned rows), `batch_id` (auto-connect run, for one-step undo), `created_at`. No FKs to needs/modules/placements (D340, D378); FK to plans (cascade with the plan) and versions.
- A channel may hold several connections (a **circuit**) only if every connected need's function type `allowsCircuit` and they share the function type; blinds and inputs: one need unit per channel.
- Connections are version data, not plan content: editing them does not need a plan lock; writes lock the version (project row) briefly; read-only projects refuse changes. Version copy copies connections with the plan id map (D339/D362).
- W → A: I = P / (V · PF): V = the channel's `channel_voltage` (catalog field meaning per output kind), else the product type's switched (mains) voltage `nominalVoltage` (default 230 V); PF per load type (`powerFactor`, default 1.00; motors and inductive 0.70, LED 0.90). DC motors without a channel voltage → `limit_unknown` (D407).

### Validity of a connection (backend, one function used by connect, auto-connect and checks)
- The target item exists, has the output kind (or its allowed alternative) with `channel_no` in range; the pair of an alternative channel is not used by base-kind connections and vice versa.
- The output kind serves the need's function type.
- Load type: if the channel limits are per load type, the need's load type must have a limit (else warning "limit unknown for this load type"); the sum of (units × power W) per channel ≤ channel limit for that load type (mixed load types on one channel: Σ (W of a type ÷ limit of that type) ≤ 1, utilisation % reported, D408); unknown power where limits apply → warning `power_unknown`; ≥ minimum load when the channel has one and powers are known (warning, not error); module totals per load type and in A not exceeded, counting only connections valid on their own (a need without load type against per-load-type totals → `limit_unknown`).
- Blinds: need load type AC/DC motor must match the output's `motorType` when both are known; a relay pair used as a blind output without `motorType` counts as AC (D414).
- Alternative channels are stored by base kind and group, so catalog changes cannot rewire them (D410).
- Units: Σ units over a need's connections ≤ quantity.
- Invalid on create → field error; data that became invalid later (catalog change, need edited, module removed) → reported by the checks, never deleted silently.

### Checks engine (backend, `GET /api/versions/{versionId}/checks`)
- Uses: needs (plans service), boards/placements and capabilities (plans + products), membership (networks `Membership`), connections, product type settings (reserve %, default bus current, busDevicesMax, nominal voltage), line `devicesMax`.
- Results: list of findings `{severity: error|warning|info, code, refs (zone, need, board, module, channel, line, gateway), params}` plus summaries:
  - per zone: needs units, connected units, status covered / partial (n of m) / missing / no needs;
  - per board: channels per output kind used/free (alternatives shown), TE per row used/capacity;
  - per bus line: current used (known + defaults) vs supplied, devices vs max, unknown currents count, status ok / amber (above 100 − reserve %) / red (exceeded);
  - per gateway: places used vs supplied with reserve status; "many end devices, no router" (≥ 20 non-router devices on a gateway and none with `zigbee_router` — record threshold);
  - findings: unconnected needs; dangling connections (need removed, units > quantity, target item/channel gone, function or load type no longer served); overloads (channel, module); minimum load not reached; motor type mismatch; bus line without power supply; devices with unknown bus current; wireless devices without gateway; unassigned bus devices; dangling network assignments; board rows over capacity (D411, D412).
- Deterministic, computed on demand (no stored results); fast enough for ~2000 needs (one load of all inputs, in-memory evaluation, no N+1).

### Auto-connect
- `POST /api/versions/{versionId}/auto-connect/preview {scope: all | zoneIds[] | needIds[]}` → planned connections + needs that cannot be connected with reasons ("no free blind output", "no channel serves Towel heater", "limits exceeded") + counts; `POST …/auto-connect/apply {scope, expectedChecksum}` creates them (pinned = false, one batch id); `DELETE /api/versions/{versionId}/auto-connect/{batchId}` undoes a batch (only rows still from that batch).
- Never adds products; never moves pinned connections; deterministic order: plan order → zone order → need order → unit; targets: same floor's in-room devices first, then boards in plan order → module order (row, offset) → channel number; prefer filling a module before the next and keeping a circuit for needs of the same zone and function type when allowed (record the exact rule: D391 as amended by D409 — most constrained function types first; native before alternative channels, specific kinds first, relay pairs kept whole; one-step repair).

### API (connections)
- `GET /api/versions/{versionId}/connections`; `POST` (connect `{needPlanId, needId, units, targetPlanId, targetItemId, outputKindId, channelNo}`, pinned = true); `PUT /…/{id}` (units, or move to another channel); `DELETE /…/{id}`; `POST …/connections/disconnect {needId | channel}` convenience.
- Errors `connection.*` en + de.

### Frontend
- Version tab **Checks**: overview cards (zones covered x/y, unconnected units, boards, bus lines, gateways with ok/amber/red), the findings list grouped by severity and area with links to the right editor/item, the **Unconnected needs** list grouped by floor/zone with "Connect…" (picker of compatible free channels, with the reason when none fits) and **Auto-connect** (scope: all / selected zones) with the preview dialog ("14 will be connected, 3 cannot: …") and Apply; after apply an "Undo auto-connect" action.
- Floorplan editor: zone status on the canvas (badge with colour + text, e.g. "✓", "2/5", "!"), Zones tab statuses; the zone inspector's needs rows show their connections ("2 × → Dimmer 1, ch 3 (Board EG)") with connect/disconnect.
- Board editor: channels in the inspector list their connections (need label, zone, units, power) with disconnect and "connect a need" (picker of compatible unconnected needs); module badges with used/free channels; board header totals with reserve colours.
- Networks tab: line and gateway totals get the reserve status colours.
- en + de, design system only; update nav specs if nav changes.

### Tests
Backend: validity rules table-driven (output kind/function type, per-load-type W limits, circuits allowed/not, min load, module totals W/A via voltage, motor type, alternatives consuming pairs, units ≤ quantity), checks summaries and findings (dangling cases, reserve thresholds, unknown currents with defaults, routers), auto-connect determinism (same input → same output), pinned untouched, batch undo, version copy, RLS, read-only. Frontend: Checks tab, picker, auto-connect dialog, editor statuses/rows. E2E: realistic project → auto-connect preview/apply → zone covered → move one connection by hand → bus line amber when near limit → undo batch.

### Notes carried over from 3c
- **Membership (D372)**: the checks use `networks.Service.Membership` (default line / default gateway + pins → line or gateway per item), the same function the Networks view and line deletes use; members of a system without a line yet are "no line" for the view and the checks alike. A line's device limit is its `devicesMax`, else the system's `busDevicesMax`.
- **Channel identity (D378)**: a connection's target is `(board_plan_id, module_id, output_kind_id, channel_no 1..count)` without a foreign key to `board_modules` (like D340); a variant change to fewer channels or a module delete leaves the connection dangling — reported by the checks, restored by undo. Cut/paste of a module between boards gives it a new id on the target board, so its connections are lost (documented in the editor).

## 3e – Installer outputs and programming data (outline)
- Board report per board (rails, modules, channels → zone / need label, totals) and channel labels, as DOCX via the document model (2d), downloadable from the board.
- Programming data stored now (R18): per-unit fields for KNX individual address / HDL subnet + device id / Zigbee IEEE address (category instance attributes linked to catalog fields with meanings), bus line and gateway per device, channel ↔ needs.
- KNX group address export (CSV/XML importable by ETS) as the first programming export; HDL and Zigbee as commissioning sheets until import formats are known.
