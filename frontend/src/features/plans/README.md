# Plans (floorplan editor)

Step 2b. Decisions: D193–D197 (backend), D198–D204 (editor). Spec: `docs/specs/phase-2.md` → 2b.

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
| `editor/Inspector.tsx` | Inspector tab (part A: one placement) |
| `editor/use-autosave.ts`, `editor/save-errors.ts`, `editor/SaveIndicator.tsx` | Autosave state machine and error mapping (D201) |
| `editor/use-plan-lock.ts`, `editor/LockBanner.tsx` | Edit lock (D202) |
| `editor/use-shortcuts.ts` | Keyboard shortcuts |
| `editor/placements.ts` | New placements, duplicates |
| `src/canvas/` | Shared canvas base for all plan kinds: stage, viewport, image layer, geometry, theme (D198) |

## Document model

`PlanDocument = { scale, zones, placements }` is exactly what `PUT /api/plans/{id}/content` takes
(`toContentInput` adds `expectedContentUpdatedAt` and drops the server-computed `zoneId`). Array order is
draw order. Documents are immutable; `applyDocumentAction(doc, action)` returns a new document, or the
same object when nothing changes. Ids are client uuids (`newId()`).

`DocumentAction` already covers zones: `addZones`, `updateZones`, `remove` (placements and zones by id),
`moveBy` (moves zone points too) and `setScale`. Part B mostly adds UI that dispatches these; new kinds of
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

`usePlanLock(planId, wanted, beforeRelease)` takes the lock on open, beats every 30 s, releases on
unmount after `beforeRelease` (the autosave flush) and with a keepalive request on `pagehide`. The editor
is `editable` only while the lock state is `mine`; everything else (held by another user, read-only
project, no permission, phone width) renders the same editor read-only.

## Canvas layers

`PlanCanvas` renders inside `CanvasStage` (zoom, pan, pointer events in image pixels):

1. `ImageLayer` (the plan image, not listening)
2. **zones layer — part B** (comment marks the spot, below the placements)
3. placements layer: `PlacementNode` per placement (`name="placement"`, `id=placement id`; hit-testing uses
   `findAncestor('.placement')`), alt-drag copies, `Handles` for one selected placement
   (`name="handle-nw|ne|se|sw|rotate"`), the rubber band

Strokes and labels are scaled by `k = 1 / viewport.scale` so they keep their screen size.
`useCanvasTheme()` gives token colours for Konva.

## Where part B plugs in

- **Zones**: a zone layer in `PlanCanvas` (between image and placements) and new tools in `Tool`
  (`'select' | 'pan'` today) with toolbar buttons in `PlanEditor` (marked "Part B"); drawing/vertex
  edits as new `Interaction` kinds committing `addZones` / `updateZones`. The Zones tab placeholder in
  `PlanEditor`'s `tabs`. Rubber band and select-all currently consider placements only.
- **Inspector**: `Inspector.tsx` handles one placement; add add-ons, instance attributes
  (`AttributeValuesEditor`), "resize all of this product" (one `updatePlacements` with many changes),
  multi-selection (delete, existing toggle) and zone properties there.
- **Layers** (visibility per product type, category, zones): view state beside the reducer (not
  in the document/history), passed to `PlanCanvas` as a filter.
- **Calibration**: `setScale` already exists in `DocumentAction`.
- **PNG export**: `PlanCanvas` has a `stageRef`; export at natural resolution by rendering with
  viewport `{ x: 0, y: 0, scale: 1 }` and the image size (or `stage.toDataURL({ pixelRatio })`).
- **Warnings**: per placement in `warnings` (from the last load/save); texts in `locales/*/warning.*`.
- **E2E**: `e2e/specs/plans-smoke.spec.ts` is a small part A smoke; part B writes the real spec.

## Tests

Vitest: `PlansSection.test.tsx` (list, dialogs), `editor/PlanEditorPage.test.tsx` (MSW; the Konva canvas
is replaced by a stand-in), `editor/editor-state.test.ts` (document, history, reducer),
`editor/use-autosave.test.ts`, `editor/Palette.test.tsx`, `editor/editor-helpers.test.ts`
(palette data, default size, save errors, shortcuts), `src/canvas/geometry.test.ts`.
