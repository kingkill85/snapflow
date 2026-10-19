import type { FunctionType, LoadType, PlanNeed, PlanZone, RoomTemplate } from '@/api/generated/model'
import { clamp, type Point, type Size } from '@/canvas'
import type { LocalizedText } from '@/i18n/localized'

import { isSymbol, newId } from './document'
import { zoneAt } from './zones'

type Localize = (text: LocalizedText | undefined) => string

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

/** Copies of load symbols with new ids, moved by (dx, dy) and kept inside the image (duplicate, paste). */
export function duplicateSymbols(needs: PlanNeed[], dx: number, dy: number, image?: Size): PlanNeed[] {
  return needs.filter(isSymbol).map((n) => ({
    ...n,
    id: newId(),
    x: image ? clamp(n.x + dx, 0, image.width) : n.x + dx,
    y: image ? clamp(n.y + dy, 0, image.height) : n.y + dy,
    zoneId: null,
  }))
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
 * A need in plain words: "3 × Dimmable light · 60 W · LED · Ceiling"
 * (quantity only above 1, power, load type and label only when set).
 */
export function needText(
  need: Pick<PlanNeed, 'quantity' | 'functionTypeId' | 'powerW' | 'loadTypeId' | 'label'>,
  functionTypes: Map<string, FunctionType>,
  loadTypes: Map<string, LoadType>,
  localize: Localize,
  formatNumber: (n: number) => string,
  unknown: string,
): string {
  const ft = functionTypes.get(need.functionTypeId)
  const name = ft ? localize(ft.name) : unknown
  const parts = [need.quantity > 1 ? `${need.quantity} × ${name}` : name]
  if (need.powerW !== null) parts.push(`${formatNumber(need.powerW)} W`)
  const lt = need.loadTypeId ? loadTypes.get(need.loadTypeId) : undefined
  if (lt) parts.push(localize(lt.name))
  if (need.label) parts.push(need.label)
  return parts.join(' · ')
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
    const ft = functionTypes.get(line.functionTypeId)
    const lt = line.loadTypeId ? loadTypes.get(line.loadTypeId) : undefined
    const loadOk = line.loadTypeId === null || (lt?.isActive === true && (ft?.loadTypeIds.length === 0 || ft?.loadTypeIds.includes(line.loadTypeId)))
    if (!ft?.isActive || !loadOk) {
      skipped++
      continue
    }
    needs.push({ ...newNeed(ft.id, zoneId), quantity: line.quantity, powerW: line.powerW, loadTypeId: line.loadTypeId, label: line.label })
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
