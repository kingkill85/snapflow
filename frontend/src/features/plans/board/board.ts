import type { BoardContent, BoardContentInput, BoardModule, Capabilities, VariantSearchItem } from '@/api/generated/model'

// The board editor's document (step 3c): what PUT /api/plans/{id}/board takes,
// without the server-computed widths and totals. Immutable like the floorplan
// document; `applyBoardAction` returns the same object when nothing changes.

export type BoardModuleDoc = Omit<BoardModule, 'widthTe'>
export type BoardRowDoc = { id: string; capacityTe: number }
export type BoardDocument = {
  enclosureVariantId: string | null
  rows: BoardRowDoc[]
  modules: BoardModuleDoc[]
}

export type ModulePatch = Partial<Omit<BoardModuleDoc, 'id'>>

export type BoardAction =
  | { type: 'addModules'; modules: BoardModuleDoc[] }
  | { type: 'updateModules'; changes: { id: string; patch: ModulePatch }[] }
  | { type: 'remove'; ids: string[] }
  /** Rows replaced as a whole (rows editor); modules of removed rows are dropped, so the editor removes only empty rows. */
  | { type: 'setRows'; rows: BoardRowDoc[] }
  /** The enclosure with the rows and modules fitted to it (`fitToEnclosure`), one step. */
  | { type: 'setEnclosure'; enclosureVariantId: string | null; rows: BoardRowDoc[]; modules: BoardModuleDoc[] }
  | { type: 'batch'; actions: BoardAction[] }

export const newId = () => crypto.randomUUID()

export function boardDocumentOf(content: BoardContent): BoardDocument {
  return {
    enclosureVariantId: content.enclosureVariantId,
    rows: content.rows.map((r) => ({ id: r.id, capacityTe: r.capacityTe })),
    modules: content.modules.map(({ widthTe: _width, ...m }) => m),
  }
}

export function toBoardInput(doc: BoardDocument, expectedContentUpdatedAt: string): BoardContentInput {
  return { expectedContentUpdatedAt, enclosureVariantId: doc.enclosureVariantId, rows: doc.rows, modules: doc.modules }
}

export const boardItemIds = (doc: BoardDocument) => new Set(doc.modules.map((m) => m.id))

export function applyBoardAction(doc: BoardDocument, action: BoardAction): BoardDocument {
  switch (action.type) {
    case 'addModules':
      return action.modules.length === 0 ? doc : { ...doc, modules: [...doc.modules, ...action.modules] }
    case 'updateModules': {
      if (action.changes.length === 0) return doc
      const byId = new Map(action.changes.map((c) => [c.id, c.patch]))
      let changed = false
      const modules = doc.modules.map((m) => {
        const patch = byId.get(m.id)
        if (!patch) return m
        const next = { ...m, ...patch }
        if ((Object.keys(patch) as (keyof ModulePatch)[]).every((k) => JSON.stringify(next[k]) === JSON.stringify(m[k]))) return m
        changed = true
        return next
      })
      return changed ? { ...doc, modules } : doc
    }
    case 'remove': {
      const ids = new Set(action.ids)
      const modules = doc.modules.filter((m) => !ids.has(m.id))
      return modules.length === doc.modules.length ? doc : { ...doc, modules }
    }
    case 'setRows': {
      if (JSON.stringify(action.rows) === JSON.stringify(doc.rows)) return doc
      const ids = new Set(action.rows.map((r) => r.id))
      return { ...doc, rows: action.rows, modules: doc.modules.filter((m) => ids.has(m.rowId)) }
    }
    case 'setEnclosure':
      if (action.enclosureVariantId === doc.enclosureVariantId && JSON.stringify(action.rows) === JSON.stringify(doc.rows)) return doc
      return { enclosureVariantId: action.enclosureVariantId, rows: action.rows, modules: action.modules }
    case 'batch':
      return action.actions.reduce(applyBoardAction, doc)
  }
}

// ---------------------------------------------------------------- widths and slots

/** Offsets and widths snap to half a TE (D356 stores one decimal). */
export const teStep = 0.5
const round1 = (n: number) => Math.round(n * 10) / 10
export const snapTe = (n: number) => round1(Math.round(n / teStep) * teStep)

/** A module's width: its variant's railWidthTe, 1 TE when unknown (as the backend counts it, D356). */
export function moduleWidth(variantId: string | null, caps: (variantId: string) => Capabilities | undefined): number {
  const width = variantId ? caps(variantId)?.railWidthTe : undefined
  return width && width > 0 ? width : 1
}

export type Interval = { start: number; end: number }

/** The modules of a row as occupied intervals, sorted, without the excluded ones (the module being moved). */
export function occupied(doc: BoardDocument, rowId: string, width: (m: BoardModuleDoc) => number, exclude: Set<string> = new Set()): Interval[] {
  return doc.modules
    .filter((m) => m.rowId === rowId && !exclude.has(m.id))
    .map((m) => ({ start: m.offsetTe, end: round1(m.offsetTe + width(m)) }))
    .sort((a, b) => a.start - b.start)
}

/** Whether [offset, offset + width) stays free of the intervals and inside the row. */
export function fits(intervals: Interval[], capacity: number, offset: number, width: number): boolean {
  if (offset < 0 || round1(offset + width) > capacity) return false
  return intervals.every((i) => round1(offset + width) <= i.start || offset >= i.end)
}

/**
 * The free offset nearest to `desired` (snapped to 0.5 TE) where a module of
 * `width` fits without overlap inside the row; null when the row has no gap
 * wide enough. A drop or move never overlaps: it lands in the nearest gap.
 */
export function nearestSlot(intervals: Interval[], capacity: number, width: number, desired: number): number | null {
  const gaps: Interval[] = []
  let cursor = 0
  for (const i of intervals) {
    if (i.start > cursor) gaps.push({ start: cursor, end: i.start })
    cursor = Math.max(cursor, i.end)
  }
  if (capacity > cursor) gaps.push({ start: cursor, end: capacity })
  let best: number | null = null
  for (const g of gaps) {
    if (round1(g.end - g.start) < width) continue
    const lowest = Math.ceil(round1(g.start / teStep)) * teStep
    const highest = Math.floor(round1((g.end - width) / teStep)) * teStep
    // A gap whose bounds are off the half-TE grid (unusual widths) still takes the module at its start.
    const candidates = lowest <= highest ? [Math.min(Math.max(snapTe(desired), lowest), highest)] : [g.start]
    for (const c of candidates.map(round1)) {
      if (!fits(intervals, capacity, c, width)) continue
      if (best === null || Math.abs(c - desired) < Math.abs(best - desired)) best = c
    }
  }
  return best
}

/** Where a module (new or moved) lands in a row near `desired`; null when it does not fit. */
export function slotIn(doc: BoardDocument, rowId: string, width: number, desired: number, widthOf: (m: BoardModuleDoc) => number, exclude: Set<string> = new Set()): number | null {
  const row = doc.rows.find((r) => r.id === rowId)
  if (!row) return null
  return nearestSlot(occupied(doc, rowId, widthOf, exclude), row.capacityTe, width, desired)
}

/**
 * A place for a copy: in `rowId` near `desired`, else in the following rows,
 * then the rows before (from their start); null when the board is full.
 */
export function slotAnywhere(doc: BoardDocument, rowId: string, width: number, desired: number, widthOf: (m: BoardModuleDoc) => number): { rowId: string; offsetTe: number } | null {
  const index = Math.max(0, doc.rows.findIndex((r) => r.id === rowId))
  const order = [...doc.rows.slice(index), ...doc.rows.slice(0, index)]
  for (const [i, row] of order.entries()) {
    const offset = slotIn(doc, row.id, width, i === 0 ? desired : 0, widthOf)
    if (offset !== null) return { rowId: row.id, offsetTe: offset }
  }
  return null
}

/**
 * Copies of modules (duplicate, paste): each lands after its source in the
 * same row or the next row with room, one after another (earlier copies
 * count as occupied). Returns the copies placed and how many found no room.
 */
export function copyModules(doc: BoardDocument, sources: BoardModuleDoc[], widthOf: (m: BoardModuleDoc) => number): { modules: BoardModuleDoc[]; refused: number } {
  let working = doc
  const modules: BoardModuleDoc[] = []
  let refused = 0
  for (const s of sources) {
    const width = widthOf(s)
    const rowId = working.rows.some((r) => r.id === s.rowId) ? s.rowId : (working.rows[0]?.id ?? '')
    const slot = slotAnywhere(working, rowId, width, s.offsetTe + width, widthOf)
    if (!slot) {
      refused++
      continue
    }
    const copy = { ...s, id: newId(), ...slot, addonVariantIds: [...s.addonVariantIds], instanceValues: { ...s.instanceValues } }
    modules.push(copy)
    working = applyBoardAction(working, { type: 'addModules', modules: [copy] })
  }
  return { modules, refused }
}

/**
 * Keyboard move of one module: left/right by half a TE (refused when the
 * neighbour is in the way or at the row's end), up/down to the previous/next
 * row at the nearest free place. Returns the patch or null.
 */
export function keyboardMove(doc: BoardDocument, id: string, direction: 'left' | 'right' | 'up' | 'down', widthOf: (m: BoardModuleDoc) => number): { rowId: string; offsetTe: number } | null {
  const m = doc.modules.find((x) => x.id === id)
  if (!m) return null
  const width = widthOf(m)
  const exclude = new Set([id])
  if (direction === 'left' || direction === 'right') {
    const row = doc.rows.find((r) => r.id === m.rowId)
    if (!row) return null
    const offset = round1(m.offsetTe + (direction === 'left' ? -teStep : teStep))
    return fits(occupied(doc, m.rowId, widthOf, exclude), row.capacityTe, offset, width) ? { rowId: m.rowId, offsetTe: offset } : null
  }
  const index = doc.rows.findIndex((r) => r.id === m.rowId)
  const target = doc.rows[index + (direction === 'up' ? -1 : 1)]
  if (!target) return null
  const offset = slotIn(doc, target.id, width, m.offsetTe, widthOf, exclude)
  return offset === null ? null : { rowId: target.id, offsetTe: offset }
}

// ---------------------------------------------------------------- totals

export function rowUsed(doc: BoardDocument, rowId: string, widthOf: (m: BoardModuleDoc) => number): number {
  return round1(doc.modules.filter((m) => m.rowId === rowId).reduce((sum, m) => sum + widthOf(m), 0))
}

/** Whether a row's modules reach beyond its capacity (the backend's row_overflow warning). */
export function rowOverflows(doc: BoardDocument, rowId: string, widthOf: (m: BoardModuleDoc) => number): boolean {
  const row = doc.rows.find((r) => r.id === rowId)
  if (!row) return false
  return doc.modules.some((m) => m.rowId === rowId && round1(m.offsetTe + widthOf(m)) > row.capacityTe)
}

export const boardCapacity = (doc: BoardDocument) => round1(doc.rows.reduce((sum, r) => sum + r.capacityTe, 0))
export const boardUsed = (doc: BoardDocument, widthOf: (m: BoardModuleDoc) => number) => round1(doc.modules.reduce((sum, m) => sum + widthOf(m), 0))

// ---------------------------------------------------------------- enclosure

/** The rows × TE an enclosure gives, or null when its size is not known (rows stay manual). */
export function enclosureSize(caps: Capabilities | undefined): { rows: number; te: number } | null {
  if (!caps?.enclosureRows || !caps.enclosureTePerRow) return null
  return { rows: caps.enclosureRows, te: caps.enclosureTePerRow }
}

/**
 * The D357 rule, as the backend applies it on save, so the editor shows the
 * result at once: the first `rows` rows keep their ids and get `te`; missing
 * rows are added; modules of rows beyond move to the end of the last row, one
 * after another (they may overflow, which warns).
 */
export function fitToEnclosure(doc: BoardDocument, size: { rows: number; te: number }, widthOf: (m: BoardModuleDoc) => number): { rows: BoardRowDoc[]; modules: BoardModuleDoc[] } {
  const rows: BoardRowDoc[] = []
  for (let i = 0; i < size.rows; i++) rows.push({ id: doc.rows[i]?.id ?? newId(), capacityTe: size.te })
  const kept = new Set(rows.map((r) => r.id))
  const last = rows[rows.length - 1]
  let end = round1(Math.max(0, ...doc.modules.filter((m) => m.rowId === last.id).map((m) => m.offsetTe + widthOf(m))))
  const modules = doc.modules.map((m) => {
    if (kept.has(m.rowId)) return m
    const moved = { ...m, rowId: last.id, offsetTe: end }
    end = round1(end + widthOf(m))
    return moved
  })
  return { rows, modules }
}

/** Enclosures to offer: available variants of the project's types with an enclosure size and board mounting. */
export function enclosureVariants(variants: VariantSearchItem[], productTypeIds: string[]): VariantSearchItem[] {
  const types = new Set(productTypeIds)
  return variants.filter((v) => v.available && types.has(v.productTypeId) && onBoard(v.capabilities) && enclosureSize(v.capabilities) !== null)
}

/** Effective mounting board or both (D-capabilities): offered in the board palette. */
export const onBoard = (caps: Capabilities | undefined) => caps?.mounting === 'board' || caps?.mounting === 'both'

/** A new module of a variant at a place. */
export function newModule(variantId: string, rowId: string, offsetTe: number): BoardModuleDoc {
  return { id: newId(), variantId, rowId, offsetTe, label: '', existing: false, addonVariantIds: [], instanceValues: {} }
}
