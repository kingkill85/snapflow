# Plans (floorplan editor)

Step 2b. Decisions: D193–D197 (backend), D198–D204 (editor core), D205–D210 (zones, inspector, layers, calibration, export), D211–D216 (review fixes: image URL, key scoping, clamping, lock lifecycle, leaving, product picker), D217–D226 (click-through and screenshot review: export sizing, paper colours, zone names above placements, docked calibration, compact card actions), D252 (resize a zone as a whole); step 3b (zone needs, load symbols): D324–D338, review fixes D339–D351, click-through D352–D354. Spec: `docs/specs/phase-2.md` → 2b, `docs/specs/phase-3.md` → 3b.

## Files

| Where | What |
| --- | --- |
| `PlansSection.tsx`, `PlanFormDialog.tsx`, `api.ts` | Plans on the project page: cards, add/edit (multipart with progress, D200), reorder, delete |
| `EditorRoute.tsx` | Lazy entry of the editor route `projects/:id/versions/:versionId/plans/:planId` (Konva stays out of the main bundle) |
| `editor/PlanEditorPage.tsx` | Loads plan, content, project and catalog; `PlanEditor` wires state, lock, autosave, shortcuts, toolbar, canvas and panel |
| `editor/document.ts` | The document model and `applyDocumentAction` (all content changes) |
| `editor/history.ts`, `editor/editor-state.ts` | Undo history and the editor reducer (document history + selection) |
| `editor/PlanCanvas.tsx` | The floorplan canvas: layers, pointer interactions, drop target |
| `editor/Palette.tsx`, `editor/catalog.ts` | Products tab, catalog loading, palette grouping, default sizes |
| `editor/Inspector.tsx` | Inspector tab: one placement (Change product, variant, add-ons, instance values, resize all, Delete), one zone (Delete), multi-selection (D219) |
| `editor/zones.ts`, `editor/ZonesPanel.tsx` | Zone geometry (area, ray casting, smallest containing zone, corner edits, `scaleZone` for the frame, names, colours) and the Zones tab |
| `editor/layers.ts`, `editor/LayersPanel.tsx` | Layer visibility (view state) and the Layers tab |
| `editor/calibration.ts`, `editor/CalibrateDialog.tsx` | Scale from two points, metres parsing, scale bar |
| `editor/export.ts` | PNG export at natural size (blob + object URL) with strokes and labels sized for the image (`exportPixel`, D217), file name |
| `editor/use-autosave.ts`, `editor/save-errors.ts`, `editor/SaveIndicator.tsx` | Autosave state machine and error mapping (D201) |
| `editor/use-plan-lock.ts`, `editor/LockBanner.tsx` | Edit lock (D202) |
| `editor/use-shortcuts.ts` | Keyboard shortcuts (plain keys only off controls, `isCanvasKeyTarget`, D212) |
| `editor/placements.ts` | New placements, duplicates, `clampMove` / `clampGeometry` (edits stay inside the image, D213), `changeProduct` (D216) |
| `editor/needs.ts`, `editor/need-catalog.ts`, `editor/NeedsSection.tsx` | Needs (3b): new needs and symbol copies, plain-words text, live zone of a symbol and counts per zone, applying a room template, symbol pictograms; the need catalog hook (function types, load types, active room templates); the zone inspector's Needs section, the need fields and the inspector of one load symbol |
| `editor/copies.ts` | `copyItems`: the one path of Ctrl+D, paste and alt-drag (placements and load symbols as one batch step; symbols whose function type or load type is no longer usable are skipped with a notice; refused as a whole above 2000 needs, D347–D348) |
| `src/canvas/` | Shared canvas base for all plan kinds: stage, viewport, image layer, geometry, theme (D198) |

## Document model

`PlanDocument = { scale, zones, placements, needs }` is exactly what `PUT /api/plans/{id}/content` takes
(`toContentInput` adds `expectedContentUpdatedAt` and drops the placements' server-computed `zoneId`; needs are
always sent, D331; `restoredNeedIds` lists the document needs whose ids the editor has received from the server in
this session, so a need brought back by undo keeps an inactive function type, D343). Power per unit is the API's
decimal string with 2 places; `parsePower` / `formatWatts` / `useNeedText` in `features/needs/format.ts` are the
only parser and formatters (editor, overview, save-error list via `itemName`, D349). A need without position belongs to its `zoneId`; one with `x`/`y` is a load symbol (`isSymbol`),
whose zone the backend computes (`needZoneId` computes it live the same way). Array order is
draw order. Documents are immutable; `applyDocumentAction(doc, action)` returns a new document, or the
same object when nothing changes. Ids are client uuids (`newId()`).

`DocumentAction` already covers zones: `addZones`, `updateZones`, `remove` (placements and zones by id),
`moveBy` (moves zone points and load symbols too) and `setScale`; needs: `addNeeds`, `updateNeeds`, `reorderNeeds`
(the given needs swap into the places they hold), `remove` (also needs; a removed zone takes its needs without
position along), and `batch` (several actions as one step, e.g. duplicating placements with symbols). The editor's UI dispatches these; new kinds of
change go into `DocumentAction` + `applyDocumentAction` (with a test in `editor-state.test.ts`).

## Reducer, history, selection

`editorReducer` holds `{ history, selection }`:

- `{ type: 'change', action, key?, select? }` applies a `DocumentAction` as one undo step. `key` merges
  consecutive changes with the same key (the inspector uses `${id}:${field}` so typing is one step);
  `select` sets the selection with the change (e.g. select what was just added).
- `undo` / `redo` (200 steps), `select`, `toggleSelect` (shift-click), `load` (reload: history starts over).
- The selection is not in the history; ids that disappear are dropped. It holds placement, zone and load symbol ids
  (needs without position are not selectable; their errors select their zone, `selectionFor`).

Canvas interactions keep a local preview (`Interaction` in `PlanCanvas`) and dispatch one `change` on
pointer up, so a drag is one undo step.

## Autosave and lock

`useAutosave({ document, save, enabled })` compares documents by reference with the last saved one:
1 s debounce, one request in flight, `flush()` on leave, `retry()`, `reset(doc)` after a reload, status
`saved | unsaved | saving | failed | stale`. `PlanEditor.save` sends the snapshot with the last
`contentUpdatedAt`, keeps the response (warnings, zone assignment) in `server`, and maps field errors to
items with `saveErrorsByItem`.

`usePlanLock(planId, wanted, { beforeRelease, onPageHide })` takes the lock on open, beats every 30 s,
releases on unmount after `beforeRelease` (the autosave's flush). Only a heartbeat without an answer or with a 5xx
keeps the lock; `plan.locked` → `held` (taken over), `project.read_only` → `readOnly` (notice), anything else →
`error`. A lock that arrives after unmount is released at once (a generation counter drops late answers). On
`pagehide`, `onPageHide` sends pending changes with a keepalive PUT (`saveOnUnload`, ≤ 60 KB) and then the lock is
left to expire (a release could overtake the save); otherwise a keepalive DELETE releases it (D215). The editor is
`editable` only while the lock state is `mine`; everything else (held by another user, read-only project, no
permission, phone width) renders the same editor read-only.

Leaving in the app: a router blocker flushes pending changes and proceeds; only when they cannot be saved (failed,
stale) it asks "Discard unsaved changes?" (D28, D215).

Ordinary edits stay inside the image (D213): canvas drags and nudges use `clampMove`, duplicates/pastes clamp per
copy, `resizeBox(..., bounds)` caps sizes at the image, the inspector uses `clampGeometry`.

The plan image is served at `plan.image.url` = `/api/plans/{id}/images/{fileId}`: it changes when the image is
replaced, so it is cached immutably (D211).

## Canvas layers

`PlanCanvas` renders inside `CanvasStage` (zoom, pan, pointer events in image pixels):

1. `ImageLayer` (the plan image, not listening)
2. zones: `ZoneNode` per visible zone (`name="zone"`, `id=zone id`); for one selected zone `ZoneFrame` (its bounds
   10 screen px outside, `name="frame-nw|n|ne|e|se|s|sw|w"`, D252) and above it `VertexHandles`
   (`name="vertex-i"` corners, `name="mid-i"` edge midpoints)
3. placements: `PlacementNode` per visible placement (`name="placement"`; hit-testing uses
   `findAncestor('.placement')`), alt-drag copies, `Handles` for one selected placement
   (`name="handle-nw|ne|se|sw|rotate"`), then the rubber band, drawing drafts and the measured calibration line
4. zone names: `ZoneLabel` per visible zone, not listening, above the placements so a product never hides them (D224);
   a name a load symbol would cover moves just above that symbol (`zoneLabelPoint`, D352)
5. load symbols: `NeedNode` per visible load symbol (`name="need"`, hit-testing `findAncestor('.need')`, moved and
   copied with the placements; screen-sized pictogram from `symbolIcon(key)` or the first letter, caption below, D333),
   above the zone names (D352)

Nodes that are UI and not content are named `chrome` (`export.ts`): the PNG export hides them.
Strokes and labels are scaled by `k = 1 / viewport.scale` so they keep their screen size (while the PNG export draws, `k = exportPixel(image)`, D217).
The viewport keeps the image fitted while the stage changes size until the user zooms or pans (D218).
`useCanvasTheme()` gives token colours for Konva.

## Tools and interactions

`Tool = 'select' | 'pan' | 'zoneRect' | 'zonePolygon' | 'calibrate' | 'placeNeed'` ("Place need": the function type
is chosen in a floating select over the canvas, a click places a symbol and returns to Select, D333). Drags are `Interaction`s with a local
preview committed as one change on pointer up: `move` (placements and zones), `resize`, `rotate`, `band`,
`drawRect`, `vertex` (corner drag, also after inserting at an edge midpoint), `scaleZone` (a frame handle: a corner
scales proportionally around the opposite corner, Shift freely; a side stretches one axis; at least 10 image px
per axis, inside the image, D252). Click tools (polygon,
calibration) collect points in a `Draft` tied to the tool (switching tools drops it); Enter closes a
polygon, Esc drops a draft. Drawing a zone or picking the calibration points returns to Select.

## View state (not in the document)

`PlanEditor` keeps beside the reducer: `layers` (`Layers`: hidden product types, categories, zones, need symbols; hidden
items are filtered before drawing, so they are not hit-testable, and dropped from the selection),
`resizeAll` (inspector switch, also used by canvas resizes via `resizeChanges`), `activeVertex` (the
picked zone corner the inspector can remove) and the calibration points (open `CalibrateDialog`, docked non-modally over the right panel via
`FormDialog`'s `container`, so the measured line stays visible, D225).
Select-all uses `visibleIds`. Warnings per placement come from the last load/save (`server.warnings`).

## Zone counts

The Zones tab shows counts from `server.placements[].zoneId` (the last save's response) and, when
different, a live estimate from `zoneAt`, an exact port of the backend's `geometry.go` (a point on an edge or
corner is inside; smallest containing polygon by shoelace area, ties go to the zone drawn last).

## Needs (3b)

The zone inspector's Needs section (`ZoneNeeds`) lists the zone's needs without position, edits one inline
(`NeedFields`: every field one keyed undo step), adds needs (select of active function types), reorders, deletes and
applies a room template (`applyTemplate`: one `addNeeds`, lines with inactive references skipped and reported). A
selected symbol gets `NeedInspector`. Warnings come from `server.needWarnings`. The Zones tab shows the units per zone
(`needCounts`, live, D334). The version's needs overview is `features/needs` (D335), room templates
`features/room-templates` (D336).

## Tests

Vitest: `PlansSection.test.tsx` (list, dialogs), `editor/PlanEditorPage.test.tsx` (MSW; the Konva canvas
is replaced by a stand-in), `editor/editor-state.test.ts` (document, history, reducer),
`editor/use-autosave.test.ts`, `editor/Palette.test.tsx`, `editor/editor-helpers.test.ts`
(palette data, default size, save errors, shortcuts, clamping), `editor/use-shortcuts.test.ts` (key scoping, nudge at the edge), `editor/use-plan-lock.test.ts`, `src/canvas/geometry.test.ts`, `src/canvas/keyboard.test.ts`; part B: `editor/zones.test.ts`, `editor/part-b-helpers.test.ts` (calibration,
layers, export name, resize all), `editor/Inspector.test.tsx`, `editor/ZonesPanel.test.tsx` (with the Layers
tab), `editor/CalibrateDialog.test.tsx`; 3b: `editor/needs.test.ts` (document actions, undo of template and fields,
helpers, error mapping, layers), `editor/NeedsSection.test.tsx` (section, add/edit, reorder, delete, template,
symbol inspector), the Place need tool and layer in `editor/PlanEditorPage.test.tsx`.

E2E: `e2e/specs/needs.spec.ts` (room template, apply, add, place a symbol, reload, overview), `e2e/specs/plans.spec.ts` (place by click and drop, move/resize/rotate, rectangle and polygon zones,
zone counts, undo/redo, reload, zone corners (drag, add at a midpoint, Alt-click remove), resizing a zone by its frame (corner, side, undo), calibration, layers, PNG export, lock and
take-over, read-only project), the plans section and editor shell in `layout.spec.ts` (German tabs at 768 px), and
`plans-visual.spec.ts` (`make e2e-visual`: every state and dialog at 390/768/1280 px, light/dark, en/de, with the exported PNG).
The leave guard (save on leave, ask only when the save fails) is in `editor/PlanEditorPage.test.tsx`.
