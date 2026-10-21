import type { Capabilities, FunctionType, LoadType, Plan, PlanContent, PlanPlacement, RoomTemplate, VariantSearchItem } from '@/api/generated/model'

// Test data of the plans tests (not shipped: only tests import it).

const at = '2026-10-18T10:00:00Z'
export const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const projectId = pid(300)
export const versionId = pid(201)

export const placement = (n: number, over: Partial<PlanPlacement> = {}): PlanPlacement => ({
  id: pid(900 + n),
  variantId: pid(701),
  x: 100 * n,
  y: 100,
  width: 60,
  height: 60,
  rotation: 0,
  label: '',
  existing: false,
  addonVariantIds: [],
  instanceValues: {},
  zoneId: null,
  ...over,
})

export const plan = (n: number, over: Partial<Plan> = {}): Plan => ({
  id: pid(500 + n),
  versionId,
  projectId,
  kind: 'floorplan',
  name: n === 1 ? 'Ground floor' : `Floor ${n}`,
  position: n,
  image: { url: `/api/plans/${pid(500 + n)}/images/${pid(600 + n)}`, width: 1000, height: 800 },
  board: null,
  zoneCount: 0,
  placementCount: 0,
  needCount: 0,
  createdAt: at,
  updatedAt: at,
  contentUpdatedAt: at,
  lock: null,
  can: { update: true, breakLock: true },
  ...over,
})

export const content = (over: Partial<PlanContent> = {}): PlanContent => ({
  planId: pid(501),
  contentUpdatedAt: at,
  scale: null,
  zones: [],
  placements: [],
  needs: [],
  needWarnings: [],
  warnings: [],
  ...over,
})

const zigbeeRef = { id: pid(111), key: 'zigbee', name: { en: 'Zigbee' }, abbreviation: 'ZB', color: '#1f6feb', isActive: true }
const knxRef = { id: pid(112), key: 'knx', name: { en: 'KNX' }, abbreviation: 'KX', color: '#0a7d33', isActive: true }
const switches = { id: pid(121), key: 'switch', name: { en: 'Switches', de: 'Schalter' }, isActive: true }
const sensors = { id: pid(122), key: 'sensor', name: { en: 'Sensors' }, isActive: true }

/** Capabilities of a plain floorplan product; `boardCaps` of a board module of `te` TE. */
export const floorCaps: Capabilities = { mounting: 'floorplan', channels: [], moduleTotalsW: [], busCurrentUsedMaDefault: false, wirelessPlacesUsedDefault: false }
export const boardCaps = (te: number, over: Partial<Capabilities> = {}): Capabilities => ({ ...floorCaps, mounting: 'board', railWidthTe: te, ...over })

export const variant = (n: number, over: Partial<VariantSearchItem> = {}): VariantSearchItem => ({
  capabilities: floorCaps,
  id: pid(700 + n),
  productId: pid(800 + n),
  productName: { en: `Product ${n}` },
  name: { en: 'Standard' },
  modelNumber: `M-${n}`,
  price: '10.00',
  available: true,
  productType: zigbeeRef,
  productTypeId: zigbeeRef.id,
  category: switches,
  categoryId: switches.id,
  ...over,
})

/** A small catalog: a Zigbee switch with two variants, a Zigbee sensor, a KNX switch (not in the project). */
export const catalog: VariantSearchItem[] = [
  variant(1, { productName: { en: 'Wall switch', de: 'Wandschalter' }, name: { en: 'White' } }),
  variant(2, { productId: pid(801), productName: { en: 'Wall switch', de: 'Wandschalter' }, name: { en: 'Black' } }),
  variant(3, { productName: { en: 'Motion sensor' }, category: sensors, categoryId: sensors.id }),
  variant(4, { productName: { en: 'KNX switch' }, productType: knxRef, productTypeId: knxRef.id }),
]
export const zigbeeId = zigbeeRef.id

// Needs (3b): function types, load types, a room template.
export const loadType = (n: number, over: Partial<LoadType> = {}): LoadType => ({
  id: pid(1100 + n),
  key: `load_${n}`,
  name: { en: n === 1 ? 'LED' : `Load ${n}` },
  isActive: true,
  powerFactor: 1,
  sortOrder: n,
  can: { update: true, delete: true },
  createdAt: at,
  updatedAt: at,
  ...over,
})

export const functionType = (n: number, over: Partial<FunctionType> = {}): FunctionType => ({
  id: pid(1000 + n),
  key: n === 1 ? 'dimmable_light' : `function_${n}`,
  name: { en: n === 1 ? 'Dimmable light' : `Function ${n}` },
  allowsCircuit: false,
  knxObjects: [],
  isActive: true,
  loadTypeIds: [],
  outputKindIds: [],
  createdAt: at,
  updatedAt: at,
  ...over,
})

export const functionTypes = [
  functionType(1, { loadTypeIds: [pid(1101)] }),
  functionType(2, { key: 'blind', name: { en: 'Blind' } }),
  functionType(3, { key: 'old', name: { en: 'Old function' }, isActive: false }),
]
export const loadTypes = [loadType(1), loadType(2)]

export const roomTemplate = (n: number, over: Partial<RoomTemplate> = {}): RoomTemplate => ({
  id: pid(1200 + n),
  key: `room_${n}`,
  name: { en: n === 1 ? 'Living room' : `Room ${n}` },
  equipmentLevel: { en: 'Comfort' },
  sortOrder: n,
  isActive: true,
  lines: [
    { functionTypeId: functionTypes[0].id, quantity: 3, powerW: '7.50', loadTypeId: loadTypes[0].id, label: 'Ceiling', warnings: [] },
    { functionTypeId: functionTypes[1].id, quantity: 2, powerW: null, loadTypeId: null, label: '', warnings: [] },
    { functionTypeId: functionTypes[2].id, quantity: 1, powerW: null, loadTypeId: null, label: '', warnings: ['function_type_inactive'] },
  ],
  can: { update: true, delete: true },
  createdAt: at,
  updatedAt: at,
  ...over,
})

/** The editor's need catalog as `useNeedCatalog` returns it. */
export const needCatalog = {
  functionTypes,
  functionTypeById: new Map(functionTypes.map((f) => [f.id, f])),
  loadTypes,
  loadTypeById: new Map(loadTypes.map((l) => [l.id, l])),
  templates: [roomTemplate(1)],
}
