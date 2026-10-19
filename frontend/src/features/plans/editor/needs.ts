import type { FunctionType, LoadType, PlanNeed, PlanZone, RoomTemplate } from '@/api/generated/model'
import { clamp, type Point, type Size } from '@/canvas'

import { isSymbol, newId } from './document'
import { zoneAt } from './zones'

/** At most this many needs per plan (the backend's MaxNeeds, validation.too_many). */
export const maxNeeds = 2000

/** A new need of a zone (no position), or a load symbol at a point (kept inside the image). */
export function newNeed(functionTypeId: string, zoneId: string | null, at?: Point, image?: Size): PlanNeed {
  return {
    id: newId(),
    zoneId,
    functionTypeId,
    quantity: 1,
    powerW: null,
    loadTypeId: null,
    label: '',
    note: '',
    x: at ? Math.round(image ? clamp(at.x, 0, image.width) : at.x) : null,
    y: at ? Math.round(image ? clamp(at.y, 0, image.height) : at.y) : null,
  }
}

/**
 * Copies of load symbols with new ids, moved by (dx, dy) and kept inside the
 * image (duplicate, paste, alt-drag). Pass `functionTypes` to leave out
 * symbols whose function type is inactive or gone (a new need must have an
 * active one); the caller reports them.
 */
export function duplicateSymbols(needs: PlanNeed[], dx: number, dy: number, image?: Size, keep: (n: PlanNeed) => boolean = () => true): PlanNeed[] {
  return needs
    .filter(isSymbol)
    .filter(keep)
    .map((n) => ({
      ...n,
      id: newId(),
      x: image ? clamp(n.x + dx, 0, image.width) : n.x + dx,
      y: image ? clamp(n.y + dy, 0, image.height) : n.y + dy,
      zoneId: null,
    }))
}

/**
 * Whether a new need with these references would be accepted: an active
 * function type, no load type or an active one the function type allows
 * (the backend's rule for new needs; stored and restored ones may keep
 * inactive references, D343). Template lines and copies that fail it are
 * skipped and reported.
 */
export function usableForNewNeed(
  need: Pick<PlanNeed, 'functionTypeId' | 'loadTypeId'>,
  functionTypes: Map<string, FunctionType>,
  loadTypes: Map<string, LoadType>,
): boolean {
  const ft = functionTypes.get(need.functionTypeId)
  if (!ft?.isActive) return false
  if (need.loadTypeId === null) return true
  const lt = loadTypes.get(need.loadTypeId)
  return lt?.isActive === true && (ft.loadTypeIds.length === 0 || ft.loadTypeIds.includes(need.loadTypeId))
}

/** The load types a need of this function type may have: its list, or every load type when it lists none. */
export function allowedLoadTypes(functionType: FunctionType | undefined, loadTypes: LoadType[]): LoadType[] {
  if (!functionType || functionType.loadTypeIds.length === 0) return loadTypes
  const allowed = new Set(functionType.loadTypeIds)
  return loadTypes.filter((l) => allowed.has(l.id))
}

/** Changing a need's function type drops a load type the new one does not allow. */
export function functionTypePatch(need: Pick<PlanNeed, 'loadTypeId'>, functionType: FunctionType | undefined) {
  const keep = need.loadTypeId === null || !functionType || functionType.loadTypeIds.length === 0 || functionType.loadTypeIds.includes(need.loadTypeId)
  return { functionTypeId: functionType?.id ?? '', ...(keep ? {} : { loadTypeId: null }) }
}

/**
 * The zone of a need: its zoneId without position; for a load symbol the
 * smallest zone containing it, computed live like the backend does on save
 * (`zoneAt`, D325).
 */
export function needZoneId(n: PlanNeed, zones: PlanZone[]): string | null {
  if (!isSymbol(n)) return n.zoneId
  return zoneAt({ x: n.x, y: n.y }, zones)?.id ?? null
}

/** Units per zone (Σ quantity), symbols counted in the zone they lie in. */
export function needCounts(needs: PlanNeed[], zones: PlanZone[]): Map<string | null, number> {
  const counts = new Map<string | null, number>()
  for (const n of needs) {
    const zone = needZoneId(n, zones)
    counts.set(zone, (counts.get(zone) ?? 0) + n.quantity)
  }
  return counts
}

export type TemplateApplication = {
  needs: PlanNeed[]
  /** Lines left out: their function type or load type is inactive or gone. */
  skipped: number
}

/** The needs a room template adds to a zone; lines with inactive or unknown references are skipped. */
export function applyTemplate(template: RoomTemplate, zoneId: string, functionTypes: Map<string, FunctionType>, loadTypes: Map<string, LoadType>): TemplateApplication {
  const needs: PlanNeed[] = []
  let skipped = 0
  for (const line of template.lines) {
    if (!usableForNewNeed(line, functionTypes, loadTypes)) {
      skipped++
      continue
    }
    needs.push({ ...newNeed(line.functionTypeId, zoneId), quantity: line.quantity, powerW: line.powerW, loadTypeId: line.loadTypeId, label: line.label })
  }
  return { needs, skipped }
}

/** The pictogram of a load symbol, from the function type's key; others show the name's first letter. */
export type SymbolIcon = 'lamp' | 'dimmer' | 'blind' | 'socket' | 'pushbutton'

const iconRules: [RegExp, SymbolIcon][] = [
  [/dimm/, 'dimmer'],
  [/blind|shutter|jalous|rollo|shade|awning|curtain/, 'blind'],
  [/socket|outlet|plug|steckdose/, 'socket'],
  [/push|button|taster|keypad/, 'pushbutton'],
  [/switch|relay|light|lamp|lighting|schalt|licht/, 'lamp'],
]

export function symbolIcon(key: string | undefined): SymbolIcon | undefined {
  if (!key) return undefined
  return iconRules.find(([re]) => re.test(key))?.[1]
}

/** The fallback mark: the first letter of the function type's name. */
export const symbolLetter = (name: string) => (name.trim()[0] ?? '?').toLocaleUpperCase()
