# 02 — Projects & Floorplan Configurator (SnapFlow 1 inventory)

## Summary
A **project group** holds the customer data, status and invoice settings. Each group has one or more **versions** (`projects` rows). A version has ordered **floorplans** (uploaded images). Each floorplan carries **item placements** (each references a BOM entry) and **areas** (polygons stored as `placements.type='area'`).
The configurator page (`/projects/:id`) has a zoom/pan canvas with dnd-kit drag & drop, aspect-locked resize, rotation, polygon editing, layer toggles (category, item type, area) and PNG export. The right panel has the tabs Products / Areas / BOM / Summary.
Every edit is persisted right away through REST (optimistic UI, no undo, no realtime sync). Server-side containment assigns each item to the smallest area that contains its centre. Backend tenant isolation covers projects and groups only; floorplans, placements and areas have none.

Ref prefixes used below: `B/` = `backend/src/`, `F/` = `frontend/src/`.

---

## Entities & fields

**project_groups** (`B/scripts/migrate.ts:1024-1056`, `B/models/project-group.ts`)
- `id`, `customer_name` (req, ≤200), `customer_email` (null, email), `customer_phone` (≤50), `customer_address` (≤500), `tenant_id`, `created_at`
- `status` enum `active|completed|cancelled` (default `active`)
- Invoice settings: `discount_percentage` (0–100), `discount_usd` (≥0), `services_percentage` (0–100), `services_usd` (≥0), `local_currency_code` (3 chars, **no DB default → NULL**), `exchange_rate` (≥0, default 1.0)
- API adds `versions[]` = `{id, version_name, created_at}`, sorted `created_at DESC` (`B/repositories/project-group.ts:27-33`)
- No unique constraint since migration 035. The `name` column was dropped, but the frontend type still has it (`F/services/projectGroup.ts:6`).

**projects** (= "version") (`migrate.ts:1048-1066`, `B/models/index.ts:208-221`)
- `id`, `project_group_id` (NOT NULL, no FK), `version_name` (default `'v1'`, 1–100), `tenant_id`, `google_exchange_rate` (default 1.0), `created_at`
- UNIQUE(`project_group_id`, `version_name`) (migration 034)
- API joins in `customer_name/email/phone/address` from the group and adds `item_type_ids[]`
- **project_item_types** junction (`project_id`, `item_type_id`), PK on both columns

**floorplans** (`migrate.ts:142-151`)
- `id`, `project_id`, `name` (req), `image_path` (req, relative to the uploads dir, e.g. `floorplans/<unique>.png`), `sort_order` (int, default 0; new rows get max+1)

**placements** (`migrate.ts:678-702` migration 030)
- `id`, `bom_id` (FK project_bom ON DELETE CASCADE; NULL for areas), `floorplan_id` (FK ON DELETE CASCADE, NOT NULL), `type` `'item'|'area'`, `area_id` (int, no FK; the containing area placement id), `x`, `y`, `width`, `height` (REAL), `rotation` (REAL, CHECK 0 ≤ r < 360), `created_at`
- API joins in `item_id`, `item_variant_id` (= bom.variant_id) and `item_variant_image_path` (= bom.picture_path) (`B/repositories/placement.ts:22-45`)
- **Coordinates:** natural pixel space of the stored (resized) floorplan image. (0,0) is top-left. x/y is the top-left of the unrotated box. Rotation is in degrees, clockwise, around the box centre.

**area_properties**: `placement_id` UNIQUE FK CASCADE, `name` (default 'New Area'), `color` (default '#3b82f6'), `opacity` REAL (default 0.1), `created_at`, `updated_at`
**area_vertices**: `placement_id` FK CASCADE, `vertex_index`, `x`, `y`, UNIQUE(placement_id, vertex_index)
**Area API shape** (`B/models/index.ts:385-399`): `{id, floorplan_id, x, y, width, height (bbox), name, color, opacity, vertices[], device_count, created_at, updated_at}`. `device_count` = number of item placements with `area_id` = this area.

**project_bom.area_id** mirrors the containment of the placement that references the entry (BOM fields are covered elsewhere).

**Client-only state**
- `localStorage['snapflow_item_size_memory_<projectId>']`: `[[itemId,{width,height}],…]`
- `localStorage['snapflow_item_variant_memory_<projectId>']`: `[[itemId,{variant_id,addon_ids[]}],…]` (`F/hooks/useItemMemory.ts:16-17`)
- `placementAddons` ref (`Map<placementId, addonVariantIds[]>`), in memory only (`F/hooks/usePlacements.ts:55`)

---

## API endpoints (all under `/api`, all need a JWT `authMiddleware`)

| Method | Path | Purpose | Ref |
|---|---|---|---|
| GET | /projects?search=&tenantId= | List versions with group customer data plus item_type_ids. Search uses LIKE on version_name or customer_name. Admin can filter with `tenantId`. Sorted created_at DESC | `B/routes/projects.ts:58` |
| GET | /projects/:id/total | `{totalPrice}` summed over the BOMs of all floorplans | :82 |
| GET | /projects/:id/invoice-calculation | Calculation from the BOM total and the group's invoice settings | :104 |
| GET | /projects/:id | Single version plus item_type_ids | :147 |
| POST | /projects | Creates a group and version `v1` (or `version_name`). Sets item types (default: all active types). Admin may set `tenant_id`. Returns 201 | :172 |
| PUT | /projects/:id | Update `version_name`, `item_type_ids` and `tenant_id` (admin only, silently ignored for others). Duplicate name → 400 | :219 |
| DELETE | /projects/:id | Cascading version delete. 403 for role `user`. 400 if it is the only version in the group | :267 |
| GET | /project-groups?search= | Groups with versions. Search on customer_name only | `B/routes/project-groups.ts:40` |
| GET | /project-groups/:id | Group with versions | :56 |
| PUT | /project-groups/:id | Customer fields, status and invoice fields | :79 |
| PUT | /project-groups/:id/invoice-settings | Invoice fields only | :126 |
| POST | /project-groups/:id/versions | `{version_name, source_project_id}` deep-copies a version (source must be in the group, name must be unique, exact match). Returns 201 | :164 |
| DELETE | /project-groups/:id | 403 for `user`. 400 if any version has floorplans or BOM rows. Otherwise deletes all versions and the group | :209 |
| GET | /floorplans?project_id= | Floorplans of a project, sorted `sort_order, id`. **Without project_id it returns ALL floorplans** | `B/routes/floorplans.ts:29` |
| GET | /floorplans/:id | Single floorplan | :47 |
| POST | /floorplans (multipart: `project_id`, `name`, `image`) | Upload. jpeg/png/webp, ≤5 MB, magic bytes checked, resized to ≤1920 px wide | :67 |
| PUT | /floorplans/:id (multipart: `name?`, `sort_order?`, `image?`) | Update. A new image deletes the old file. No fields → 400 | :125 |
| DELETE | /floorplans/:id | Deletes placements, BOM rows, the image file and unreferenced BOM pictures | :195 |
| PATCH | /floorplans/reorder?project_id= `{floorplan_ids[]}` | Sets sort_order to 1..n in array order | :270 |
| GET | /floorplans/:id/bom · POST /:id/bom-entries · PUT /:id/bom-entries/:entryId/variant · DELETE /:id/bom-entries/:entryId · POST /:id/bom/update-from-catalog | BOM endpoints (covered in the BOM inventory) | :292-407 |
| GET | /placements?floorplan_id= | Item placements only (inner join BOM), sorted created_at DESC. Without the parameter it returns ALL placements | `B/routes/placements.ts:48` |
| POST | /placements/bulk-update?floorplan_id=&item_id= `{width,height}` | Sets the size of every placement of that item on the floorplan (**the UI never calls it**) | :66 |
| GET | /placements/:id | Single placement (left join, so areas are included) | :93 |
| POST | /placements `{floorplan_id,item_variant_id,x,y,width>0,height>0,rotation?}` | Get-or-create the BOM entry (variant, no add-ons), create the placement, run the containment recheck. Returns 201 | :114 |
| PUT | /placements/:id `{x?,y?,width?,height?,rotation? 0–359.99, area_id?}` | Update. If x, y or area_id is present, the containment recheck runs | :152 |
| PUT | /placements/:id/variant `{variant_id}` | Switch variant on the shared BOM entry (unused by the UI). 400 for areas | :189 |
| POST | /placements/:id/update-bom `{variant_id, addon_ids[]}` | Always creates a **new** BOM entry plus the chosen add-ons, repoints the placement, deletes the old entry if it is now orphaned | :232 |
| DELETE | /placements/:id | Delete. The BOM entry (and its children/images) is removed when no placement references it any more | :266 |
| POST | /placements/:id/duplicate `{x,y}` | Deep-copies the BOM entry and its add-ons. New placement keeps size and rotation. Containment recheck. Returns 201. 400 for areas | :303 |
| GET | /areas?floorplan_id= (required, else 400) | Areas sorted `area_properties.created_at ASC` | `B/routes/areas.ts:32` |
| GET | /areas/:id | Single area | :49 |
| POST | /areas `{floorplan_id,x,y,width>0,height>0,name?,color?,opacity 0–1?}` | Creates a 4-vertex rectangle (TL, TR, BR, BL). Server defaults: name 'New Area', color '#3B82F6', opacity 0.2. Containment recheck | :69 |
| PUT | /areas/:id `{name?,color?,opacity?}` | Properties only | :98 |
| PUT | /areas/:id/vertices `{vertices[{x,y}] min 3}` | Replaces all vertices, recomputes the bbox x/y/w/h, containment recheck | :124 |
| DELETE | /areas/:id | Nulls `area_id` on BOM rows and placements, deletes the area (properties and vertices cascade) | :153 |
| GET | /uploads/* (no `/api`, **no auth**) | Static files with a path-traversal guard, `Cache-Control: immutable` for 1 year, ETag/304 | `B/main.ts:147` |

MCP tools (`B/services/mcp/tools/list-floorplans.ts`, `list-areas`, `get-floorplan-image`, `get-floorplan-bom`) read the same data. They are covered in the MCP inventory.

---

## Acceptance criteria

### A. Project list (`/projects`)
1. The page shows a table of **project groups** with the columns expander, Project Number, Customer, Tenant (admin only), Status and actions. `F/pages/projects/ProjectList.tsx:356-366`
2. Project Number = `YYYY-MM-DD_<customer_name|'Unknown'>_<customer_address|'No Address'>`. The date is the group's `created_at` in UTC (`toISOString`). `ProjectList.tsx:45-51`
3. Groups are sorted client-side by Project Number ascending (string compare, so effectively oldest first). `:279-288`
4. The status filter defaults to **Active**. Options: Active, Completed, Cancelled, All Statuses. Filtering is client-side. `:67,334-344`
5. Search: the input is debounced 300 ms and calls `GET /project-groups?search=`, which matches customer_name only. The placeholder reads "Search by project name or customer...". A spinner shows while searching. The first render does not trigger a search. `:135-148,326`
6. Status badges: Active is green with a check, Completed is blue with a check, Cancelled is red with an X. `:397-420`
7. Clicking a row or its chevron toggles the version sub-list. Versions are listed newest first. Each shows a GitBranch icon, the name and the date in `de-DE` format. `:377,455-516`
8. Group actions: **Open** opens `versions[0]` (most recently created). **Edit** and **Delete** are only visible when role ≠ `user`. `:424-451`
9. Version actions (visible to **every** role): Open, **Copy** (opens Create Version with this version as source), Edit (rename), Delete. `:478-513`
10. The empty state reads "No projects found. Create your first project to get started." `:371`
11. Navigating with `location.state.openCreateModal` (Home "Get Started") opens the Create modal and clears the state. `:151-157`
12. Admins also load the tenants list to fill the Tenant column and the tenant select. `:121-128`

### B. Create project (ProjectFormModal, create mode)
13. Fields: Product Types (checkboxes with a coloured dot, **all active types pre-checked**, the last checked box cannot be unchecked), Tenant select (admin only, defaults to the first tenant), Customer Name * , Email (type=email), Phone, Address. No version field, so the server uses `v1`. `F/components/projects/ProjectFormModal.tsx:63-95,163-267`
14. Empty optional fields are left out of the request. `tenant_id` is only sent by admins. `:110-117`
15. Server: `customer_name` is 1–200 chars, email must be valid or empty, phone ≤50, address ≤500. A new group is created with status `active`. If `item_type_ids` is empty or missing, all active item types are linked. `B/routes/projects.ts:39-47`, `B/repositories/project.ts:83-116`
16. The new project gets the caller's tenant. An admin can override it with `tenant_id`. `B/routes/projects.ts:179-185`
17. On success the modal closes and the list refetches. On error the server message shows in the modal. Button labels: Create / Creating... / Cancel. `ProjectFormModal.tsx:120-126,270-287`

### C. Edit group (EditGroupModal)
18. Fields: Customer Name * (trimmed, must not be empty), Email, Phone, Address, Status select. The button reads Update / Saving.... `F/components/projects/EditGroupModal.tsx:56-84`
19. Empty optional fields are **left out** of the request, so an existing value cannot be cleared (see bugs). `:72-74`

### D. Versions
20. Create Version modal: Version Name * is trimmed and must not be empty. A **case-insensitive** duplicate check runs client-side ("Version "x" already exists in this group"). `F/components/projects/CreateVersionModal.tsx:45-59`
21. Server: the source must belong to the group (404 otherwise). The duplicate check is exact match (400). `B/routes/project-groups.ts:179-189`
22. The copy runs in one transaction. It copies: floorplans (image files duplicated into `floorplans/`, same name and sort_order); BOM entries (snapshots kept, `parent_bom_id` remapped, pictures copied to `projects/<newId>/bom-images/<newBomId>-<file>`, or NULL if the source file is missing); item placements and area placements (geometry and rotation, `bom_id` remapped, placement `area_id` remapped); area_properties; area_vertices; project_item_types; `google_exchange_rate`. `B/repositories/project-group.ts:164-438`
23. The new version's `tenant_id` = the **caller's** tenant. `B/routes/project-groups.ts:191-192`
24. Edit Version modal (inline in ProjectList): Version Name * is required. A duplicate name in the group returns 400 "A project with this version name already exists in this group". `ProjectList.tsx:243-260,575-620`, `B/repositories/project.ts:151-156`
25. Delete Version: a confirm modal ("This will permanently delete the version…"). The modal stays open and shows the error on failure. `ProjectList.tsx:186-202,622-635`
26. Deleting the only version → 400 "Cannot delete the only version in a project group. Delete the group instead." `B/repositories/project.ts:187-191`
27. Version delete cascade: placements (items and areas), BOM rows (by floorplan and by project_id), floorplans, project_item_types. Floorplan image files are deleted unconditionally. BOM pictures are deleted only when no other `project_bom` row references them (ref-counted). Empty `projects/<id>/bom-images` and `projects/<id>` dirs are removed. `B/repositories/project.ts:208-272`
28. Role `user` → DELETE project or group returns 403. `B/routes/projects.ts:273-276`, `project-groups.ts:216-219`

### E. Delete group
29. Allowed only if **no version** has floorplans or BOM rows. Otherwise 400 "Cannot delete project group with versions that contain data. Please delete all versions first." `B/routes/project-groups.ts:229-233`, `B/repositories/project.ts:317-338`
30. When allowed, all (empty) versions are deleted, then the group. `B/routes/project-groups.ts:235-238`

### F. Configurator page shell (`/projects/:id`)
31. It is wrapped in an ErrorBoundary. A spinner shows while loading. A 404 shows "Project not found". `F/App.tsx:41-45`, `ProjectDashboard.tsx:607-629`
32. Data loaded in parallel: the project, its floorplans, active items (limit 1000), categories. The group (invoice settings) loads afterwards. Item types load separately (failures ignored). `F/hooks/useProjectData.ts:59-64`, `ProjectDashboard.tsx:224-232,401-409`
33. The first floorplan is auto-selected. After a refetch the active floorplan keeps its id (with fresh data) or falls back to the first one. With no floorplans the selection is null. `useProjectData.ts:83-101`
34. Header bar (32 px): back arrow to `/projects`, Project Number (**computed from the version's `created_at`**), version_name (truncated at 200 px), customer_name (truncated at 150 px). `F/components/projects/ProjectHeader.tsx:10-31`
35. Layout: the canvas column on the left. A fixed **400 px** right panel with the tabs **Products / Areas / BOM / Summary** (all force-mounted, hidden with CSS). `ProjectDashboard.tsx:651-812`
36. A "Project Total: $X" footer shows on the Products, Areas and BOM tabs (sum of all floorplan BOM totals). `:815-824`
37. Read-only mode = **role `user`**. A banner reads "This project is read-only because it is no longer active.". dnd sensors are disabled. Every edit callback is a no-op. Floorplan tab actions and the add button are hidden. Group status is **not** taken into account. `:79,638-642,645-707`
38. BOMs for **all** floorplans are fetched once floorplans load. They are refetched for all floorplans, debounced 300 ms, after every placement change (`placementsVersion`). `:121-157`
39. Saving invoice settings updates the local group and switches to the Summary tab. `:591-595`

### G. Floorplans
40. With no floorplans the page shows "No floorplans yet." and an "Add Your First Floorplan" button (a no-op when read-only). `F/components/projects/EmptyFloorplanState.tsx`
41. Tab strip: one tab per floorplan in `sort_order`. Click selects. The active tab gets a primary underline. Editable mode adds per-tab buttons: Pencil (title "Rename", opens the edit modal), ChevronLeft "Move Left" / ChevronRight "Move Right" (disabled at the ends), Trash "Delete". A trailing "+" adds a floorplan. `F/components/floorplans/FloorplanTabs.tsx`
42. Reorder swaps neighbours, sends the full id list to PATCH reorder (sort_order becomes 1..n) and refetches. Errors show in an alert. `ProjectDashboard.tsx:557-574`
43. Floorplan modal: Name * (placeholder "Ground Floor"). The image is required on create and optional on edit. Images can be added by click, drag & drop onto the drop zone, or **paste (Ctrl+V)** anywhere while the modal is open (except in inputs). Client validation: `image/*`, ≤5 MB. A preview is shown. Create mode has "Remove" and "Change" buttons, edit mode only "Change". Hint text: "JPG, PNG, WebP (max 5MB)". `F/components/floorplans/FloorplanFormModal.tsx:41-78,207-271`
44. Server-side upload: MIME must be jpeg/jpg/png/webp, ≤5 MB, magic bytes must match. Images wider than **1920 px** are downscaled with aspect ratio kept. JPEG/WebP are re-encoded at q80. Files are stored as `floorplans/<unique-name>`. `B/middleware/upload.ts:9-19,104-141`, `B/routes/floorplans.ts:67`
45. A floorplan created through the modal becomes the active floorplan. `ProjectDashboard.tsx:504-524`
46. Replacing the image deletes the old file. **Placements keep their absolute natural-pixel coordinates.** `B/routes/floorplans.ts:160-167`
47. Delete confirm dialog: "Are you sure you want to delete "<name>"?" with Cancel/Delete. Cascade: item placements, child then parent BOM entries, the floorplan, its area placements (FK cascade), the image file, and BOM pictures under `projects/` that nothing else references. Local BOM state is dropped. If the deleted floorplan was active, the first remaining one becomes active. `F/components/floorplans/DeleteFloorplanDialog.tsx`, `B/routes/floorplans.ts:195-267`, `B/repositories/floorplan.ts:89-107`, `ProjectDashboard.tsx:526-555`
48. Canvas image URL = `/uploads/<image_path>?v=<Date.now()>`. A new cache buster is set on every floorplan change or remount. A spinner overlay shows until the image loads. `ConfiguratorCanvas.tsx:1262-1266,1469,1507-1511`

### H. Canvas geometry, zoom & pan
49. The image is fitted with `min(containerW/naturalW, containerH/naturalH)`, top-aligned and horizontally centred. It is recalculated on window resize and on ResizeObserver events. `ConfiguratorCanvas.tsx:1303-1346,1499-1506`
50. Screen size = natural × fitScale × zoom. All persisted coordinates are natural image px. `:1348-1353,482-485`
51. Zoom range is **25 %–300 %** in 25 % steps. Controls: Zoom-in and Zoom-out buttons (disabled at the limits, they zoom without re-anchoring), reset (RotateCcw, sets zoom to 1 and pan to (0,0)), and a % readout. Controls sit bottom-right. `:1158-1160,1363-1374,1695-1741`
52. **Ctrl/Cmd + wheel** zooms one step per event, anchored to the mouse position. A plain wheel does nothing (no page scroll inside the canvas). `:1187-1260`
53. **Ctrl/Cmd + left/middle-drag** on empty canvas pans. It does not start on a placement or an area. Pan is unbounded. The cursor shows grabbing while panning. `:1385-1415`
54. **Ctrl/Cmd + Arrow keys** pan 50 px (window-level listener). **Ctrl/Cmd+0** resets zoom and pan. `:1418-1450`
55. Zoom and pan reset when switching floorplans (the canvas is keyed by floorplan id and image path). `ProjectDashboard.tsx:674`
56. **Esc** deselects the placement and the area. Clicking empty canvas deselects both. `ConfiguratorCanvas.tsx:1132-1135,1452-1455`
57. A "Shortcuts" help popover appears on hover (bottom-left) and lists every gesture in sections I–K. `:1767-1787`
58. The type legend (bottom-left) lists item types present on this floorplan that are not hidden. It only shows when **≥2** such types exist. `:1744-1764`

### I. Placing items (drag from the palette)
59. Palette (Products tab): categories that are active and have items, items in a 3-column grid, a 48 px thumbnail of `preview_image`, a top border in the item's type colour, and the name. `F/components/configurator/ItemPalette.tsx:17-83,271-322`
60. The palette only shows items whose `type_id` is among the project's `item_type_ids` (items without a type are always shown). If the project has more than one type, a filter row offers "All" plus per-type abbreviation chips (single select, clicking again deselects). `ItemPalette.tsx:209,250-277`
61. Drag starts after **8 px** of movement (PointerSensor). Collision detection is `pointerWithin`. The canvas droppable gets a `bg-primary/5` tint when hovered. `ProjectDashboard.tsx:112-118,649`, `ConfiguratorCanvas.tsx:1499-1501`
62. The drag overlay is a preview at the size the placement will get, scaled to the current canvas scale. `F/components/configurator/DragOverlayContent.tsx`
63. Drop position: the centre of the dragged element is converted to natural px, clamped to the image bounds, then the placement is centred on it and clamped fully inside the image. `F/hooks/useDragHandlers.ts:317-419`
64. Default size: height 60, width = 60 × aspect ratio of `preview_image` (taken from the palette preload cache). If a **remembered size** exists for this item in this project (localStorage), it is used instead. The size is clamped to **5–500 px** on each axis. `useDragHandlers.ts:367-393`
65. Variant: the remembered variant for this item if one exists, otherwise `variants[0]`. Add-ons: the remembered add-on ids if present, otherwise active required add-ons fetched for the variant. `:361-408`
66. **Ctrl/Cmd held when the palette drag starts** = "ignore defaults": memory for that item is cleared and the defaults are used (first variant, required add-ons, aspect-ratio size). The resulting size and variant are not stored back. `:93-95,355-359`, `F/hooks/usePlacements.ts:99-108`
67. Create flow: POST /placements, then POST /:id/update-bom with the add-ons (always runs, because add-on ids are always defined), so each new placement ends up with its own BOM entry. The size and variant are stored in memory. The placement is appended locally and BOM/areas refresh. `usePlacements.ts:68-114`
68. If the remembered variant no longer exists, the drop silently creates nothing. `useDragHandlers.ts:362-366`

### J. Item placement manipulation
69. Each placement is drawn as an absolute box with a 2 px border in the type colour (or primary when there is no type), rounded corners, and the image stretched to fill (`object-fill`). Image priority: BOM `picture_path`, then variant image, then preview image, then a "No image" placeholder. Hover shows the item name as a title. `ConfiguratorCanvas.tsx:464-516`
70. Click selects (deselecting any area). A selected box gets a ring in the type colour and renders on top. `:165-169,1618-1623,1636`
71. **Move:** drag an **unselected** placement and drop it on the canvas. The delta is divided by the display scale (zoom included), and the box is clamped so it stays fully inside the image. PUT x/y runs and the server recomputes containment. **A selected placement cannot be dragged** (drag is disabled while selected). `useDragHandlers.ts:149-211`, `ConfiguratorCanvas.tsx:156,477`
72. **Duplicate:** Ctrl/Cmd held at drag start on a placement. A temporary clone (id −1) stays at the original position. On drop, POST /:id/duplicate at the drop position deep-copies the BOM entry and add-ons and keeps size and rotation. A cancelled drop removes the clone. The cursor is `copy` while Ctrl is held. `useDragHandlers.ts:104-121,195-205`, `B/routes/placements.ts:303`
73. Selection adds controls: Edit (pencil, top-left, outside the box), Delete (X, top-right), Rotate handle (top centre), 4 corner resize handles, and a readout below: `W×H • R°` (rounded). `ConfiguratorCanvas.tsx:519-580`
74. **Resize** (any corner, the opposite corner stays fixed, works when rotated). The default keeps the **aspect ratio** by projecting onto the diagonal. **Shift** = free stretch. **Ctrl/Cmd** = snap to 5 px. Each axis is clamped to 5–500 natural px, and the box is clamped inside the image. Moves update the UI optimistically. Mouse-up sends one PUT {x,y,width,height}. Every move also writes the size into the item size memory (localStorage). `:171-226,270-406`, `usePlacements.ts:152-163`
75. **Rotate:** drag the handle and the item turns towards the cursor (compensating for the grab offset). **Ctrl/Cmd** snaps to 15°. The value is normalised to [0,360). Mouse-up sends one PUT {rotation}. `:228-268,408-462`
76. **Delete:** the X button deletes immediately (**no confirmation, no undo**). The placement list is refetched, BOM and areas refresh, and the BOM entry is removed when orphaned. `:537-541,1637-1640`, `usePlacements.ts:173-181`
77. **Edit (Style & Add-Ons modal):** shows the item image and name, model number and style, a Style select ("<style> - $price"), add-on rows (checkbox, image, name, style, price, a "Required" tag, inactive add-ons disabled with a warning icon), and the read-only Position/Size/Rotation. Switching to another style preselects that style's required add-ons. Switching back restores the original add-ons. Update sends POST update-bom and stores the variant memory. `ConfiguratorCanvas.tsx:598-1082`, `usePlacements.ts:129-146`
78. Current add-ons come from the in-memory `placementAddons` map, falling back to the children of the BOM group. `ConfiguratorCanvas.tsx:629-652`
79. If the item is missing, inactive, or its variant is inactive: an alert reads "This product is no longer available in the catalog…". The modal shows a read-only BOM snapshot (image, name, model, style, add-ons with prices) and only Cancel and **Delete Placement** (no confirmation). `:667-697,807-921,1042-1058`
80. Canvas interactions are mouse-only (resize and rotate use `mousedown/mousemove`). Touch is limited to dnd-kit pointer drags. The container sets `touch-action: none`. `:545-575,1489`

### K. Areas (zones)
81. Areas tab: a draggable "Area — Drag onto canvas to define a room area" block, and a "Placed Areas" list with a count badge and an eye toggle for hide-all/show-all. Each row has an eye toggle, colour swatch, name ("Untitled Area" when empty), device-count badge, Edit and Delete. Clicking a row toggles selection. Hidden rows are dimmed. Empty text: "No areas placed yet. Drag an area block onto the canvas to get started." `F/components/configurator/AreasPanel.tsx`
82. **Create:** drop the block on the canvas. The result is a **200×150** natural-px rectangle whose top-left is at the dropped block's top-left, clamped inside the image. Name = `Area <count+1>`. Colour cycles through `#3b82f6,#ef4444,#22c55e,#f59e0b,#8b5cf6,#06b6d4,#ec4899,#14b8a6,#f97316,#6366f1`. Opacity 0.1. While dragging, the overlay shows a "New Area" box. After creation, areas, placements and BOM refresh and the **Edit Area modal opens automatically**. `useDragHandlers.ts:219-287`, `ProjectDashboard.tsx:485-501,839-845`
83. Rendering: an SVG with viewBox = natural size, layered under the items. The fill uses the area colour at its opacity. The stroke shows only when selected. A name label sits in a dark pill at the middle of the **longest edge**, offset inward. Handles and font keep a constant screen size (divided by scale). The selected area is redrawn above the items (pointer-events none). `F/components/configurator/AreaPolygon.tsx:60-74,389-464`, `ConfiguratorCanvas.tsx:1529-1560,1659-1684`
84. While an item is being dragged, areas ignore pointer events so the drop reaches the canvas. `ConfiguratorCanvas.tsx:1532`
85. Click selects (deselecting any placement). Selection shows Edit (pencil) and Delete (X) HTML buttons at the top-left and top-right of the area's bbox. `AreaPolygon.tsx:318-327`, `ConfiguratorCanvas.tsx:1563-1606`
86. **Move:** mouse-drag an **unselected** area polygon with a >4 px threshold. All vertices are translated and clamped so the bbox stays inside the image. On release, PUT vertices runs, then areas, placements and BOM refresh (containment). A selected polygon body does not move. `AreaPolygon.tsx:278-316`, `ProjectDashboard.tsx:251-286,379-384`
87. **Vertex drag (selected area)** uses pointer capture. The modifier is read live on every move:
    - none = **proportional scale**: anchor = the vertex furthest from the dragged one, uniform factor = new distance / original distance.
    - **Shift** = stretch: the opposite vertex (index+2 for quads, otherwise the furthest) is fixed, X and Y scale independently.
    - **Ctrl/Cmd** = free move of that single vertex.
    - **Ctrl+Shift** = angle snap: the dragged vertex is placed at the intersection of rays from both neighbours, snapped to 5° steps.
    - Vertices are clamped to the image bounds. Release commits PUT vertices and runs the containment refresh. `AreaPolygon.tsx:82-273`, `ProjectDashboard.tsx:288-329`
88. **Add vertex:** Ctrl/Cmd + mousedown on an edge (invisible 12 px hit line, crosshair cursor) inserts a vertex after that edge's start and starts dragging it straight away. Release commits, and the following click is suppressed. `AreaPolygon.tsx:329-377,469-485`
89. **Remove vertex:** Ctrl/Cmd + right-click on a vertex. Only allowed when there are >3 vertices. The change is committed immediately. `AreaPolygon.tsx:509-516`, `ProjectDashboard.tsx:353-368`
90. Edit Area modal: Name (blank keeps the current name), 9 preset colour swatches, a native colour picker, a hex text input (accepts `#` plus up to 6 hex digits), a Transparency slider 0–100 % (stored as 0–1), and a checkerboard preview. Buttons: Update / Cancel. `F/components/configurator/AreaEditModal.tsx`
91. **Delete area** (canvas X or panel trash) deletes immediately with **no confirmation**. Contained items and BOM rows get `area_id = NULL`. Placements refetch. `ProjectDashboard.tsx:699-702,762-765`, `B/repositories/area.ts:229-242`
92. **Containment rule** (server): an item belongs to the area whose polygon (ray casting) contains the **centre of the item's unrotated bbox**. When several areas contain it, the **smallest polygon area** (shoelace) wins. Polygons with <3 vertices are skipped. The result is written to `placements.area_id` and to the item's main `project_bom.area_id`. It runs on placement create, move or resize (any PUT with x/y), duplicate, area create and area vertex update. `B/repositories/area.ts:268-332`
93. Hiding an area (eye) removes it from the canvas and from the export. Its contained items **stay visible** (despite the code comment). Area visibility is not persisted. `ProjectDashboard.tsx:184-200`, `ConfiguratorCanvas.tsx:1538,1608-1617`

### L. Layers / visibility
94. Category layers: each category header in the palette shows the number of placements on the current floorplan. The count turns orange when the category is hidden and has placements. An eye toggles visibility. Hidden categories' placements disappear from the canvas and the export. `ItemPalette.tsx:280-310`, `ProjectDashboard.tsx:414-433,450-459`
95. Type layers: abbreviation chips in the "Layers" header (only when the project has >1 type) toggle item types on the canvas and in the export. `ItemPalette.tsx:216-233`, `ConfiguratorCanvas.tsx:1615`
96. A "Hide All / Show All" button toggles all categories and all types together. `ItemPalette.tsx:234-245`
97. Initially every category of active items is visible. Visibility state **resets on every `fetchProjectData`** (for example after adding, editing, deleting or reordering a floorplan). `useProjectData.ts:80-81`
98. Placements whose item is not in the active items list (inactive or deleted items) are always shown. `ConfiguratorCanvas.tsx:1611`

### M. Floorplan image export
99. The Download button (canvas controls) produces a PNG at the floorplan's **natural resolution**. Filename: `<name with non [A-Za-z0-9-_] replaced by _>_floorplan.png`. `F/services/floorplan-export.ts:111-246`
100. Draw order: floorplan image, then visible areas (largest bbox first; fill at the area's opacity, **no border**; a label pill with bold 16 px white text at the longest edge), then visible placements in array order (rotated around the centre, image stretched, 2 px rounded border in `item.type_color` or the theme primary). A missing or failed image is drawn as a muted placeholder box. Images time out after 10 s and load with `crossOrigin=anonymous`. Failures are only logged to the console. `floorplan-export.ts:142-237,248-405`
101. The export applies the category, type and area-visibility filters. It ignores zoom and pan. `ConfiguratorCanvas.tsx:1376-1382`

### N. Persistence / sync
102. There is no undo or redo anywhere. There is no explicit save: every drop, mouse-up, modal submit or delete persists straight away. The UI is updated optimistically first. `usePlacements.ts:116-170`
103. There is no multi-user realtime sync or conflict handling (last write wins). `SyncContext` only fetches `last_sync_timestamp` once on mount (when authenticated) and appends `?t=<ts>` to item and BOM image URLs to bust the cache after an Excel sync. `F/context/SyncContext.tsx`, `F/services/item.ts:86-95,209-215`
104. Failed placement and area updates are only logged to the console. The UI is not rolled back. Exception: the Style modal shows "Failed to save changes". `usePlacements.ts:146-150`, `ConfiguratorCanvas.tsx:778-781`

### O. Permissions (backend)
105. Projects (GET, PUT, total, invoice-calculation) and project-groups (GET, PUT, versions, DELETE) are tenant-scoped: non-admins only see their own tenant, admins see everything. Only `GET /projects` honours admin `?tenantId=`. `B/routes/projects.ts:23-34`, `B/routes/project-groups.ts:13-18`
106. Role `user` may create projects and versions and edit versions and groups (backend and list UI). User may not delete projects or groups. User is read-only **only in the configurator UI**.
107. Floorplans, placements and areas have **no tenant or role checks** beyond being authenticated (see bugs).

---

## Edge cases & quirks
- Coordinates live in the natural pixels of the **server-resized** image (≤1920 px wide). They are not real-world units and there is no scale, grid or snapping to other objects.
- `rotation` is stored in [0,360), and the API rejects values over 359.99.
- Item containment uses the centre of the **unrotated** bbox.
- BOM entry reuse: POST /placements reuses an existing entry for (floorplan, variant, no add-ons). The UI then always calls update-bom, which gives each placement its own BOM entry. The BOM API groups them for display.
- Size memory is per **project and item**, applies only to **new** drops, and is written on every resize mousemove. README claims "Smart Sizing … automatically syncing all instances of the same item type". That is **not** wired: the `bulk-update` endpoint and `placementService.updateDimensions` exist, but nothing calls them. A rewrite must decide whether to implement it.
- Item drop uses the dragged element's **centre**. Area drop uses its **top-left**.
- A selected placement must be deselected (Esc or click the canvas) before it can be dragged. A selected area cannot be moved by its body.
- The Ctrl/Cmd+Arrow, Ctrl+0 and Esc handlers are on `window`. They also fire while typing in inputs (`preventDefault` breaks Ctrl+Arrow word-jump in palette and modal inputs).
- `PUT /placements/:id` with `area_id` is accepted, but the containment recheck immediately overwrites it.
- Area move clamps the whole polygon. Proportional and stretch vertex drags clamp each vertex independently, so a shape can distort at the image edge.
- Floorplan reorder ignores ids from other projects. A partial list leaves the other floorplans' sort_order untouched (duplicates are possible).
- POST /floorplans checks only that the project exists (no tenant context).
- Group search (UI) matches customer_name only. Project search (API) matches version_name or customer_name.
- New-area naming is count-based, so after a deletion two areas can be named "Area 3".
- Area hex input accepts partial values (`#3b`), which are saved as invalid colours.
- The floorplan image cache buster `?v=Date.now()` defeats the 1-year immutable cache on every floorplan switch.
- Group "Open" goes to the most recently **created** version, not the last edited one.
- Project Number differs between the list (group `created_at`) and the header and Summary (version `created_at`), and uses the UTC date.
- Version dates use `de-DE`. Prices use `$` with en-US formatting.

## Suspected bugs / dead code
1. **Rotation snap to 360°:** with Ctrl held, angles ≥352.5° round to `360`. PUT then fails validation (max 359.99, DB CHECK <360) with a silent 400, so the UI shows 0° while the DB keeps the old value. `ConfiguratorCanvas.tsx:432-434`, `B/routes/placements.ts:38`
2. **Version copy does not remap `project_bom.area_id`.** The copied BOM rows point at area placement ids from the source version. `B/repositories/project-group.ts:259-278`
3. **Version copy uses the caller's tenant_id**, so an admin copying another tenant's version creates it in the admin's tenant. `B/routes/project-groups.ts:191`
4. **No tenant isolation (IDOR)** on `/floorplans*`, `/placements*` and `/areas*`. `GET /floorplans` and `GET /placements` without a filter return the data of **all tenants**. `/uploads/*` is unauthenticated. `B/routes/floorplans.ts:29-44`, `B/routes/placements.ts:48-63`
5. **Area delete does not re-run containment.** Items inside a deleted nested area get `area_id=NULL` even when a larger area still contains them. Containment also never updates add-on child BOM rows' `area_id`. `B/repositories/area.ts:229-242,312-316`
6. `duplicateBomEntry` does not copy `item_type_name` to the new main or child entries. `B/services/bom.ts:674-745`
7. If a version's floorplan image copy fails, `copyFile` returns the source path, so both versions share one file. Deleting either version then deletes the file unconditionally ("always copied per version" is not guaranteed). `B/repositories/project.ts:248-251`, `B/services/file-storage.ts:copyFile`
8. **EditGroupModal cannot clear** email, phone or address (blank values are omitted). `EditGroupModal.tsx:72-74`
9. The **Delete Group confirm** shows `groupToDelete?.name`, a column removed in migration 035, so the item name is empty. `ProjectList.tsx:639`
10. A group whose only version has floorplans or a BOM **cannot be deleted** without first deleting every floorplan. The error says "delete all versions first", which is impossible for the last version.
11. The read-only banner says "no longer active", but read-only is role-based. Completed or cancelled projects stay editable. `ProjectDashboard.tsx:79,638-641`
12. ProjectList shows the version Copy, Edit and Delete buttons and "New Project" to role `user`. Delete then returns 403. That is inconsistent with the read-only configurator.
13. The comment says hidden areas hide their contained items, but they don't. `ProjectDashboard.tsx:184`
14. `isDraggingArea` is never reset when an area drag is dropped outside the canvas. `isCtrlDraggingItem` is not reset on the early-return paths. `useDragHandlers.ts:135-144`
15. Item drop silently does nothing if the remembered variant was deleted (no fallback to `variants[0]`). `useDragHandlers.ts:362-366`
16. The `placementAddons` map is never filled from server data, so after a reload the Style modal depends on BOM grouping. `usePlacements.ts:55`
17. **Dead code:**
    - `ProjectFormModal` edit mode (ProjectList never sets `projectToEdit`), so project item types cannot be edited after creation.
    - `project.group` normalisation (the API never returns `group`).
    - `placementService.switchVariant` and `updateDimensions`, `placementService.getById`, `areaService.getById`, `floorplanService.getById`/`getImageUrl` (unused).
    - `PUT /placements/:id/variant`, `POST /placements/bulk-update`.
    - `utils/point-in-polygon.ts` (tests only), `utils/dragPosition.ts`.
    - `fadeInKeyframes`, `newPlacementIdsRef`, the `isNew`/`typeName` props.
    - `ProjectRepository.findAllByTenant`.
    - The `TenantContext` "admin filter" hack in projects only.
    - BOM "Update from catalog" button (disabled, "coming soon").
    - `DragState.mode` (commented "unused").
18. Modals violate the CLAUDE.md "extract modals" rule: the inline Edit Version dialog (`ProjectList.tsx:575-620`) and `PlacementEditModal` inside `ConfiguratorCanvas.tsx:598`.
19. `project_groups.local_currency_code` can be NULL (no default since migration 037), but the frontend types expect a string.
20. The `PUT /project-groups/:id/invoice-settings` comment says it "MUST come before /:id", but it is defined after. It works anyway because the paths differ. `B/routes/project-groups.ts:126`
21. `ProjectFormModal` lists **all** item types returned by `itemTypeService.getAll` and preselects only the active ones. Inactive types can still be ticked.
22. Floorplan PUT with a new image and an empty name: `name !== ''` is required, so a cleared name is ignored silently. The modal blocks an empty name anyway.
