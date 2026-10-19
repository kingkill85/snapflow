import type { Bom, BOMLine, CatalogChanges, ManualLine } from '@/api/generated/model'

// Test data of the BOM tests (not shipped: only tests import it).

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const versionId = id(201)
export const projectId = id(300)
export const ground = { id: id(401), name: 'Ground floor', zones: [{ id: id(501), name: 'Kitchen' }, { id: id(502), name: 'Hall' }] }
export const upper = { id: id(402), name: 'Upper floor', zones: [] }

const zigbee = { id: id(111), key: 'zigbee', name: { en: 'Zigbee' }, abbreviation: 'ZB', color: '#1f6feb' }
const sensors = { id: id(601), name: { en: 'Sensors', de: 'Sensoren' } }
const switches = { id: id(602), name: { en: 'Switches' } }

const snapshot = (product: string, model: string, category: { id: string; name: { en: string; de?: string } } = sensors) => ({
  productName: { en: product },
  variantName: { en: '' },
  modelNumber: model,
  sku: `SKU-${model}`,
  productType: zigbee,
  category,
  imageUrl: null,
})
const ok = { available: true, deleted: false, inactive: false, outdated: false }

export const motion: BOMLine = {
  key: id(701),
  kind: 'catalog',
  variantId: id(701),
  productId: id(801),
  snapshot: snapshot('Motion sensor', 'MS-1'),
  name: '',
  unitPrice: '25.00',
  quantity: 4,
  quantities: { plans: { [ground.id]: 3, [upper.id]: 1 }, zones: { [id(501)]: 2 }, unzoned: { [ground.id]: 1, [upper.id]: 1 }, manual: 0 },
  total: '100.00',
  converted: null,
  status: { ...ok, outdated: true },
  addOnOf: [],
}
export const battery: BOMLine = {
  ...motion,
  key: id(702),
  kind: 'addOn',
  variantId: id(702),
  productId: id(802),
  snapshot: snapshot('Battery', 'BT-2'),
  unitPrice: '2.50',
  quantity: 6,
  quantities: { plans: { [ground.id]: 3, [upper.id]: 1 }, zones: { [id(501)]: 2 }, unzoned: { [ground.id]: 1, [upper.id]: 1 }, manual: 2 },
  total: '15.00',
  status: { ...ok, deleted: true, available: false },
  addOnOf: [id(701)],
}
export const dimmer: BOMLine = {
  ...motion,
  key: id(703),
  variantId: id(703),
  productId: id(803),
  snapshot: snapshot('Dimmer', 'DM-3', switches),
  unitPrice: '40.00',
  quantity: 1,
  quantities: { plans: { [upper.id]: 1 }, zones: {}, unzoned: { [upper.id]: 1 }, manual: 0 },
  total: '40.00',
  status: ok,
}
export const cabling: BOMLine = {
  key: id(901),
  kind: 'freeText',
  variantId: null,
  productId: null,
  snapshot: null,
  name: 'Cabling',
  unitPrice: '100.00',
  quantity: 1,
  quantities: { plans: {}, zones: {}, unzoned: {}, manual: 1 },
  total: '100.00',
  converted: null,
  status: null,
  addOnOf: [],
}

export const manualCabling: ManualLine = {
  id: id(901),
  kind: 'freeText',
  variantId: null,
  snapshot: null,
  name: 'Cabling',
  unitPrice: '100.00',
  quantity: 1,
  note: 'Cat 7',
  updatedAt: '2026-10-19T10:00:00Z',
}
export const manualBattery: ManualLine = {
  id: id(902),
  kind: 'catalog',
  variantId: id(702),
  snapshot: snapshot('Battery', 'BT-2'),
  name: '',
  unitPrice: '2.50',
  quantity: 2,
  note: '',
  updatedAt: '2026-10-19T10:00:00Z',
}

const pricing = {
  discountKind: 'percent' as const,
  discountValue: '10',
  servicesKind: 'amount' as const,
  servicesValue: '50',
  servicesLabel: { en: 'Programming', de: 'Programmierung' },
  updatedAt: '2026-10-19T09:00:00Z',
}

export const bom: Bom = {
  plans: [ground, upper],
  lines: [motion, battery, dimmer, cabling],
  groups: [
    {
      kind: 'productType',
      productType: zigbee,
      subtotal: '155.00',
      converted: null,
      categories: [
        { category: sensors, subtotal: '115.00', converted: null, lines: [motion.key, battery.key] },
        { category: switches, subtotal: '40.00', converted: null, lines: [dimmer.key] },
      ],
      lines: [],
    },
    { kind: 'freeText', productType: null, subtotal: '100.00', converted: null, categories: [], lines: [cabling.key] },
  ],
  totals: { subtotal: '255.00', discount: '25.50', services: '50.00', grandTotal: '279.50', currency: 'USD', rate: '1', converted: null },
  pricing,
  manualLines: [manualCabling, manualBattery],
  warnings: [],
}

/** The same BOM for a project in EUR at 0.9. */
export const bomEur: Bom = {
  ...bom,
  lines: bom.lines.map((l) => (l.key === motion.key ? { ...l, converted: { unitPrice: '22.50', total: '90.00' } } : l)),
  totals: { ...bom.totals, currency: 'EUR', rate: '0.9', converted: { subtotal: '229.50', discount: '22.95', services: '45.00', grandTotal: '251.55' } },
}

const values = (price: string) => ({
  unitPrice: price,
  productName: { en: 'Motion sensor' },
  variantName: { en: '' },
  modelNumber: 'MS-1',
  sku: 'SKU-MS-1',
  imageUrl: null,
  requiredAddons: [],
})
export const changes: CatalogChanges = {
  items: [
    {
      variantId: motion.key,
      productId: id(801),
      snapshot: snapshot('Motion sensor', 'MS-1'),
      fields: ['unitPrice'],
      before: values('25.00'),
      after: values('30.00'),
      deleted: false,
      available: true,
      canApply: true,
      effect: '18.00',
    },
    {
      variantId: battery.key,
      productId: id(802),
      snapshot: snapshot('Battery', 'BT-2'),
      fields: [],
      before: values('2.50'),
      after: null,
      deleted: true,
      available: false,
      canApply: false,
      effect: '0.00',
    },
  ],
  grandTotal: '279.50',
  grandTotalAfter: '297.50',
  effect: '18.00',
}
