# Plans (floorplan editor)

Step 2b. Decisions: D193–D197 (backend), D198–D204 (editor core), D205–D210 (zones, inspector, layers, calibration, export), D211–D216 (review fixes: image URL, key scoping, clamping, lock lifecycle, leaving, product picker). Spec: `docs/specs/phase-2.md` → 2b.

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
| `editor/Inspector.tsx` | Inspector tab: one placement (Change product, variant, add-ons, instance values, resize all), one zone, multi-selection |
| `editor/zones.ts`, `editor/ZonesPanel.tsx` | Zone geometry (area, ray casting, smallest containing zone, corner edits, names, colours) and the Zones tab |
| `editor/layers.ts`, `editor/LayersPanel.tsx` | Layer visibility (view state) and the Layers tab |
| `editor/calibration.ts`, `editor/CalibrateDialog.tsx` | Scale from two points, metres parsing, scale bar |
| `editor/export.ts` | PNG export at natural size (blob + object URL), file name |
| `editor/use-autosave.ts`, `editor/save-errors.ts`, `editor/SaveIndicator.tsx` | Autosave state machine and error mapping (D201) |
| `editor/use-plan-lock.ts`, `editor/LockBanner.tsx` | Edit lock (D202) |
| `editor/use-shortcuts.ts` | Keyboard shortcuts (plain keys only off controls, `isCanvasKeyTarget`, D212) |
| `editor/placements.ts` | New placements, duplicates, `clampMove` / `clampGeometry` (edits stay inside the image, D213), `changeProduct` (D216) |
| `src/canvas/` | Shared canvas base for all plan kinds: stage, viewport, image layer, geometry, theme (D198) |

## Document model

`PlanDocument = { scale, zones, placements }` is exactly what `PUT /api/plans/{id}/content` takes
(`toContentInput` adds `expectedContentUpdatedAt` and drops the server-computed `zoneId`). Array order is
draw order. Documents are immutable; `applyDocumentAction(doc, action)` returns a new document, or the
same object when nothing changes. Ids are client uuids (`newId()`).

`DocumentAction` already covers zones: `addZones`, `updateZones`, `remove` (placements and zones by id),
`moveBy` (moves zone points too) and `setScale`. The editor's UI dispatches these; new kinds of
change go into `DocumentAction` + `applyDocumentAction` (with a test in `editor-state.test.ts`).

## Reducer, history, selection

`editorReducer` holds `{ history, selection }`:

- `{ type: 'change', action, key?, select? }` applies a `DocumentAction` as one undo step. `key` merges
  consecutive changes with the same key (the inspector uses `${id}:${field}` so typing is one step);
  `select` sets the selection with the change (e.g. select what was just added).
- `undo` / `redo` (200 steps), `select`, `toggleSelect` (shift-click), `load` (reload: history starts over).
- The selection is not in the history; ids that disappear are dropped. It holds placement **and zone** ids.

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
2. zones: `ZoneNode` per visible zone (`name="zone"`, `id=zone id`), `VertexHandles` for one selected zone
   (`name="vertex-i"` corners, `name="mid-i"` edge midpoints)
3. placements: `PlacementNode` per visible placement (`name="placement"`; hit-testing uses
   `findAncestor('.placement')`), alt-drag copies, `Handles` for one selected placement
   (`name="handle-nw|ne|se|sw|rotate"`), then the rubber band and drawing drafts

Nodes that are UI and not content are named `chrome` (`export.ts`): the PNG export hides them.
Strokes and labels are scaled by `k = 1 / viewport.scale` so they keep their screen size.
`useCanvasTheme()` gives token colours for Konva.

## Tools and interactions

`Tool = 'select' | 'pan' | 'zoneRect' | 'zonePolygon' | 'calibrate'`. Drags are `Interaction`s with a local
preview committed as one change on pointer up: `move` (placements and zones), `resize`, `rotate`, `band`,
`drawRect`, `vertex` (corner drag, also after inserting at an edge midpoint). Click tools (polygon,
calibration) collect points in a `Draft` tied to the tool (switching tools drops it); Enter closes a
polygon, Esc drops a draft. Drawing a zone or picking the calibration points returns to Select.

## View state (not in the document)

`PlanEditor` keeps beside the reducer: `layers` (`Layers`: hidden product types, categories, zones; hidden
items are filtered before drawing, so they are not hit-testable, and dropped from the selection),
`resizeAll` (inspector switch, also used by canvas resizes via `resizeChanges`), `activeVertex` (the
picked zone corner the inspector can remove) and the calibration points (open `CalibrateDialog`).
Select-all uses `visibleIds`. Warnings per placement come from the last load/save (`server.warnings`).

## Zone counts

The Zones tab shows counts from `server.placements[].zoneId` (the last save's response) and, when
different, a live estimate from `zoneAt`, an exact port of the backend's `geometry.go` (a point on an edge or
corner is inside; smallest containing polygon by shoelace area, ties go to the zone drawn last).

## Tests

Vitest: `PlansSection.test.tsx` (list, dialogs), `editor/PlanEditorPage.test.tsx` (MSW; the Konva canvas
is replaced by a stand-in), `editor/editor-state.test.ts` (document, history, reducer),
`editor/use-autosave.test.ts`, `editor/Palette.test.tsx`, `editor/editor-helpers.test.ts`
(palette data, default size, save errors, shortcuts, clamping), `editor/use-shortcuts.test.ts` (key scoping, nudge at the edge), `editor/use-plan-lock.test.ts`, `src/canvas/geometry.test.ts`, `src/canvas/keyboard.test.ts`; part B: `editor/zones.test.ts`, `editor/part-b-helpers.test.ts` (calibration,
layers, export name, resize all), `editor/Inspector.test.tsx`, `editor/ZonesPanel.test.tsx` (with the Layers
tab), `editor/CalibrateDialog.test.tsx`.

E2E: `e2e/specs/plans.spec.ts` (place by click and drop, move/resize/rotate, rectangle and polygon zones,
zone counts, undo/redo, reload, calibration, layers, PNG export, lock and take-over, read-only project) and
the plans section and editor shell in `layout.spec.ts`.
