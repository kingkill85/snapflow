import type { PlanContent, PlanContentInput, PlanNeed, PlanPlacement, PlanZone } from '@/api/generated/model'
import { normalizeAngle } from '@/canvas'

/**
 * The editable content of a plan: what PUT /api/plans/{id}/content takes.
 * Array order is draw order (D196). Immutable: every change makes a new
 * document, so history steps and the autosave compare by reference.
 */
export type PlanDocument = {
  scale: number | null
  zones: PlanZone[]
  /** zoneId is the backend's assignment as last loaded; it is not sent. */
  placements: PlanPlacement[]
  /**
   * What the zones need (3b): without a position a need belongs to its
   * `zoneId`; with x/y it is a load symbol on the plan (its zoneId is the
   * backend's assignment, like placements). Order = order within a zone.
   */
  needs: PlanNeed[]
}

export const documentOf = (content: PlanContent): PlanDocument => ({
  scale: content.scale,
  zones: content.zones,
  placements: content.placements,
  needs: content.needs ?? [],
})

/** A need drawn as a load symbol (it has a position). */
export const isSymbol = (n: PlanNeed): n is PlanNeed & { x: number; y: number } => n.x !== null && n.y !== null

/**
 * The body of a content save. `serverNeedIds` are the need ids the editor
 * has received from the server in this session (load and save responses):
 * those still in the document go as `restoredNeedIds`, so a need that undo
 * brings back after it was deleted and saved keeps an inactive function or
 * load type like a stored one (D343).
 */
export const toContentInput = (doc: PlanDocument, expectedContentUpdatedAt: string, serverNeedIds: ReadonlySet<string> = new Set()): PlanContentInput => ({
  expectedContentUpdatedAt,
  scale: doc.scale,
  zones: doc.zones,
  placements: doc.placements.map(({ zoneId: _zoneId, ...p }) => p),
  // Always sent (D326: a left-out list would keep the stored needs).
  needs: doc.needs,
  restoredNeedIds: doc.needs.filter((n) => serverNeedIds.has(n.id)).map((n) => n.id),
})

export type PlacementPatch = Partial<Omit<PlanPlacement, 'id' | 'zoneId'>>
export type ZonePatch = Partial<Omit<PlanZone, 'id'>>
export type NeedPatch = Partial<Omit<PlanNeed, 'id'>>

/** Every content change the editor makes. */
export type DocumentAction =
  | { type: 'addPlacements'; placements: PlanPlacement[] }
  | { type: 'updatePlacements'; changes: { id: string; patch: PlacementPatch }[] }
  | { type: 'moveBy'; ids: string[]; dx: number; dy: number }
  | { type: 'addZones'; zones: PlanZone[] }
  | { type: 'updateZones'; changes: { id: string; patch: ZonePatch }[] }
  | { type: 'addNeeds'; needs: PlanNeed[] }
  | { type: 'updateNeeds'; changes: { id: string; patch: NeedPatch }[] }
  /** The needs `ids` take the places they already hold in the list, in this order (reorder within a zone). */
  | { type: 'reorderNeeds'; ids: string[] }
  /** Removes placements, zones and needs by id; a removed zone takes its needs without position along. */
  | { type: 'remove'; ids: string[] }
  | { type: 'setScale'; scale: number | null }
  /** Several changes as one step (e.g. duplicating placements and load symbols together). */
  | { type: 'batch'; actions: DocumentAction[] }

const clean = (patch: PlacementPatch): PlacementPatch =>
  patch.rotation === undefined ? patch : { ...patch, rotation: normalizeAngle(patch.rotation) }

function changed<T extends object>(item: T, patch: Partial<T>): boolean {
  return Object.entries(patch).some(([k, v]) => JSON.stringify(item[k as keyof T]) !== JSON.stringify(v))
}

/** Applies a change; returns the same document when nothing changes (no history step). */
export function applyDocumentAction(doc: PlanDocument, action: DocumentAction): PlanDocument {
  switch (action.type) {
    case 'addPlacements':
      if (action.placements.length === 0) return doc
      return { ...doc, placements: [...doc.placements, ...action.placements.map((p) => ({ ...p, rotation: normalizeAngle(p.rotation) }))] }
    case 'updatePlacements': {
      const patches = new Map(action.changes.map((c) => [c.id, clean(c.patch)]))
      let any = false
      const placements = doc.placements.map((p) => {
        const patch = patches.get(p.id)
        if (!patch || !changed(p, patch)) return p
        any = true
        return { ...p, ...patch }
      })
      return any ? { ...doc, placements } : doc
    }
    case 'moveBy': {
      if ((action.dx === 0 && action.dy === 0) || action.ids.length === 0) return doc
      const ids = new Set(action.ids)
      let any = false
      const placements = doc.placements.map((p) => {
        if (!ids.has(p.id)) return p
        any = true
        return { ...p, x: p.x + action.dx, y: p.y + action.dy }
      })
      const zones = doc.zones.map((z) => {
        if (!ids.has(z.id)) return z
        any = true
        return { ...z, points: z.points.map(([x, y]) => [x + action.dx, y + action.dy]) }
      })
      const needs = doc.needs.map((n) => {
        if (!ids.has(n.id) || !isSymbol(n)) return n
        any = true
        return { ...n, x: n.x + action.dx, y: n.y + action.dy }
      })
      return any ? { ...doc, placements, zones, needs } : doc
    }
    case 'addNeeds':
      if (action.needs.length === 0) return doc
      return { ...doc, needs: [...doc.needs, ...action.needs] }
    case 'updateNeeds': {
      const patches = new Map(action.changes.map((c) => [c.id, c.patch]))
      let any = false
      const needs = doc.needs.map((n) => {
        const patch = patches.get(n.id)
        if (!patch || !changed(n, patch)) return n
        any = true
        return { ...n, ...patch }
      })
      return any ? { ...doc, needs } : doc
    }
    case 'reorderNeeds': {
      const byId = new Map(doc.needs.map((n) => [n.id, n]))
      const moved = action.ids.filter((id) => byId.has(id))
      const slots = doc.needs.flatMap((n, i) => (moved.includes(n.id) ? [i] : []))
      if (slots.every((slot, i) => doc.needs[slot].id === moved[i])) return doc
      const needs = [...doc.needs]
      slots.forEach((slot, i) => {
        needs[slot] = byId.get(moved[i])!
      })
      return { ...doc, needs }
    }
    case 'addZones':
      if (action.zones.length === 0) return doc
      return { ...doc, zones: [...doc.zones, ...action.zones] }
    case 'updateZones': {
      const patches = new Map(action.changes.map((c) => [c.id, c.patch]))
      let any = false
      const zones = doc.zones.map((z) => {
        const patch = patches.get(z.id)
        if (!patch || !changed(z, patch)) return z
        any = true
        return { ...z, ...patch }
      })
      return any ? { ...doc, zones } : doc
    }
    case 'remove': {
      const ids = new Set(action.ids)
      const placements = doc.placements.filter((p) => !ids.has(p.id))
      const zones = doc.zones.filter((z) => !ids.has(z.id))
      // The backend drops the needs of a zone that no longer exists (D326); so does the editor.
      const needs = doc.needs.filter((n) => !ids.has(n.id) && (isSymbol(n) || n.zoneId === null || !ids.has(n.zoneId)))
      if (placements.length === doc.placements.length && zones.length === doc.zones.length && needs.length === doc.needs.length) return doc
      return { ...doc, placements, zones, needs }
    }
    case 'setScale':
      return doc.scale === action.scale ? doc : { ...doc, scale: action.scale }
    case 'batch':
      return action.actions.reduce(applyDocumentAction, doc)
  }
}

/** All ids of the document's selectable items (placements, zones, load symbols). */
export const itemIds = (doc: PlanDocument) => new Set([...doc.placements.map((p) => p.id), ...doc.zones.map((z) => z.id), ...doc.needs.filter(isSymbol).map((n) => n.id)])

export const newId = () => crypto.randomUUID()
