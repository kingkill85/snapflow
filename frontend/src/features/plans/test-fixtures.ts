import type { Plan, PlanContent, PlanPlacement, VariantSearchItem } from '@/api/generated/model'

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
  image: { fileId: pid(600 + n), url: `/api/plans/${pid(500 + n)}/image`, width: 1000, height: 800 },
  zoneCount: 0,
  placementCount: 0,
  createdAt: at,
  updatedAt: at,
  contentUpdatedAt: at,
  lock: null as unknown as Plan['lock'],
  can: { update: true, breakLock: true },
  ...over,
})

export const content = (over: Partial<PlanContent> = {}): PlanContent => ({
  planId: pid(501),
  contentUpdatedAt: at,
  scale: null,
  zones: [],
  placements: [],
  warnings: [],
  ...over,
})

const zigbeeRef = { id: pid(111), key: 'zigbee', name: { en: 'Zigbee' }, abbreviation: 'ZB', color: '#1f6feb', isActive: true }
const knxRef = { id: pid(112), key: 'knx', name: { en: 'KNX' }, abbreviation: 'KX', color: '#0a7d33', isActive: true }
const switches = { id: pid(121), key: 'switch', name: { en: 'Switches', de: 'Schalter' }, isActive: true }
const sensors = { id: pid(122), key: 'sensor', name: { en: 'Sensors' }, isActive: true }

export const variant = (n: number, over: Partial<VariantSearchItem> = {}): VariantSearchItem => ({
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
