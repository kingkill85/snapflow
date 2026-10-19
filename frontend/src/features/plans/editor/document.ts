import type { PlanContent, PlanPlacement, PlanZone } from '@/api/generated/model'
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
}

export const documentOf = (content: PlanContent): PlanDocument => ({
  scale: content.scale,
  zones: content.zones,
  placements: content.placements,
})

/** The body of a content save. */
export const toContentInput = (doc: PlanDocument, expectedContentUpdatedAt: string) => ({
  expectedContentUpdatedAt,
  scale: doc.scale,
  zones: doc.zones,
  placements: doc.placements.map(({ zoneId: _zoneId, ...p }) => p),
})

export type PlacementPatch = Partial<Omit<PlanPlacement, 'id' | 'zoneId'>>
export type ZonePatch = Partial<Omit<PlanZone, 'id'>>

/** Every content change the editor makes. Part B adds zone tools on top of the zone actions. */
export type DocumentAction =
  | { type: 'addPlacements'; placements: PlanPlacement[] }
  | { type: 'updatePlacements'; changes: { id: string; patch: PlacementPatch }[] }
  | { type: 'moveBy'; ids: string[]; dx: number; dy: number }
  | { type: 'addZones'; zones: PlanZone[] }
  | { type: 'updateZones'; changes: { id: string; patch: ZonePatch }[] }
  /** Removes placements and zones by id. */
  | { type: 'remove'; ids: string[] }
  | { type: 'setScale'; scale: number | null }

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
      return any ? { ...doc, placements, zones } : doc
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
      if (placements.length === doc.placements.length && zones.length === doc.zones.length) return doc
      return { ...doc, placements, zones }
    }
    case 'setScale':
      return doc.scale === action.scale ? doc : { ...doc, scale: action.scale }
  }
}

/** All ids of the document's items (placements and zones). */
export const itemIds = (doc: PlanDocument) => new Set([...doc.placements.map((p) => p.id), ...doc.zones.map((z) => z.id)])

export const newId = () => crypto.randomUUID()
