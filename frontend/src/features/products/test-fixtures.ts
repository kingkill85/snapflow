import { HttpResponse } from 'msw'

import type { Category, Product, ProductListItem, ProductType, Variant } from '@/api/generated/model'

// Test data of the products tests (not shipped: only tests import it).

export const problem = (status: number, body: object) =>
  HttpResponse.json({ status, ...body }, { status, headers: { 'Content-Type': 'application/problem+json' } })

const at = '2026-01-01T00:00:00Z'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** A product type (system) with an abbreviation and a colour. */
export const zigbeeType: ProductType = {
  id: id(111),
  key: 'zigbee',
  name: { en: 'Zigbee', de: 'Zigbee' },
  abbreviation: 'ZB',
  reservePercent: 20,
  topology: 'wireless',
  color: '#1f6feb',
  sortOrder: 1,
  isActive: true,
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
}

/** A second product type, without abbreviation or colour. */
export const knxType: ProductType = { ...zigbeeType, id: id(112), key: 'knx', name: { en: 'KNX' }, abbreviation: undefined, color: undefined, sortOrder: 2 }

export const legacyType: ProductType = { ...knxType, id: id(113), key: 'legacy', name: { en: 'Legacy' }, sortOrder: 3, isActive: false }

export const types = [zigbeeType, knxType, legacyType]

/** A category with one product attribute of every kind, and variant attributes. */
export const dimmerCategory: Category = {
  id: id(101),
  key: 'dimmer_actuators',
  mounting: 'floorplan',
  name: { en: 'Dimmer actuators', de: 'Dimmaktoren' },
  sortOrder: 1,
  isActive: true,
  attributes: [
    { key: 'series', label: { en: 'Series', de: 'Serie' }, type: 'text', max: 20, scope: 'product' },
    { key: 'power', label: { en: 'Power' }, type: 'number', unit: 'W', min: 0, max: 500, scope: 'product' },
    { key: 'width_te', label: { en: 'Width' }, type: 'integer', unit: 'TE', required: true, min: 1, max: 12, scope: 'product' },
    { key: 'dali', label: { en: 'DALI' }, type: 'boolean', scope: 'product' },
    {
      key: 'bus_system',
      label: { en: 'Bus system' },
      type: 'enum',
      scope: 'product',
      options: [
        { key: 'zigbee', label: { en: 'Zigbee' } },
        { key: 'knx', label: { en: 'KNX' } },
      ],
    },
    {
      key: 'loads',
      label: { en: 'Loads' },
      type: 'list',
      itemType: 'enum',
      scope: 'product',
      options: [
        { key: 'led', label: { en: 'LED' } },
        { key: 'halogen', label: { en: 'Halogen' } },
        { key: 'motor', label: { en: 'Motor' } },
      ],
    },
    { key: 'protocols', label: { en: 'Protocols' }, type: 'list', itemType: 'text', max: 4, scope: 'product' },
    { key: 'currents', label: { en: 'Channel currents' }, type: 'list', itemType: 'number', unit: 'A', scope: 'product' },
    {
      key: 'colour',
      label: { en: 'Colour' },
      type: 'enum',
      scope: 'variant',
      options: [
        { key: 'white', label: { en: 'White' } },
        { key: 'black', label: { en: 'Black' } },
      ],
    },
    { key: 'gloss', label: { en: 'Gloss' }, type: 'boolean', scope: 'variant' },
  ],
  instanceAttributes: [],
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
}

/** A second category with a different schema, for category changes. */
export const gatewayCategory: Category = {
  ...dimmerCategory,
  id: id(102),
  key: 'gateways',
  name: { en: 'Gateways' },
  sortOrder: 2,
  attributes: [
    { key: 'series', label: { en: 'Series' }, type: 'text', scope: 'product' },
    { key: 'ports', label: { en: 'Ports' }, type: 'integer', scope: 'product' },
    { key: 'managed', label: { en: 'Managed' }, type: 'boolean', required: true, scope: 'product' },
  ],
}

export const inactiveCategory: Category = { ...gatewayCategory, id: id(103), key: 'retired', name: { en: 'Retired' }, isActive: false, attributes: [] }

export const categories = [dimmerCategory, gatewayCategory, inactiveCategory]

export const ivory: Variant = {
  id: id(301),
  productId: id(201),
  name: { en: 'Ivory White', de: 'Elfenbein' },
  sku: 'M485-IW',
  capabilities: { mounting: 'floorplan', channels: [], moduleTotalsW: [], busCurrentUsedMaDefault: false, wirelessPlacesUsedDefault: false },
  price: '27.00',
  imageFileId: id(901),
  attributes: { colour: 'white' },
  staleAttributes: {},
  attributeErrors: [],
  isActive: true,
  available: true,
  sortOrder: 1,
  addons: [
    {
      addonVariantId: id(311),
      required: true,
      modelNumber: 'FR-1',
      productId: id(211),
      productName: { en: 'Frame 1' },
      variantName: { en: 'White' },
      price: '5.00',
      available: true,
      sortOrder: 1,
    },
  ],
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
}

export const black: Variant = {
  ...ivory,
  id: id(302),
  name: { en: 'Black' },
  sku: undefined,
  price: '35.00',
  imageFileId: undefined,
  attributes: { colour: 'black' },
  isActive: false,
  available: false,
  sortOrder: 2,
  addons: [],
}

export const dimmer: Product = {
  id: id(201),
  productTypeId: zigbeeType.id,
  productType: {
    id: zigbeeType.id,
    key: zigbeeType.key,
    name: zigbeeType.name,
    abbreviation: zigbeeType.abbreviation,
    color: zigbeeType.color,
    isActive: true,
  },
  categoryId: dimmerCategory.id,
  category: { id: dimmerCategory.id, key: dimmerCategory.key, name: dimmerCategory.name, isActive: true },
  modelNumber: 'M485/DIM.4',
  mounting: 'board',
  capabilities: {
    mounting: 'board',
    channels: [
      {
        outputKindId: id(401),
        outputKindKey: 'dimmer_output',
        count: 6,
        limitsW: [
          { loadTypeId: id(501), loadTypeKey: 'led', value: 200 },
          { loadTypeId: id(502), loadTypeKey: 'halogen', value: 220 },
        ],
        limitsA: [{ value: 2.5 }],
        minLoadsW: [{ loadTypeId: id(501), loadTypeKey: 'led', value: 3 }],
        alternatives: [],
      },
    ],
    moduleTotalA: 6,
    moduleTotalsW: [{ value: 1200.5 }],
    busCurrentUsedMa: 20,
    busCurrentUsedMaDefault: true,
    railWidthTe: 6,
    wirelessPlacesUsedDefault: false,
  },
  name: { en: 'Dimmer 4ch', de: 'Dimmer 4-fach' },
  description: { en: 'Four channels' },
  attributes: { series: 'Pro', power: 300, width_te: 4, dali: true, bus_system: 'zigbee', loads: ['led', 'motor'], protocols: ['DALI'], currents: [1.5, 2] },
  staleAttributes: {},
  attributeErrors: [],
  isActive: true,
  available: true,
  variants: [ivory, black],
  variantsWithProblems: 0,
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
}

export const listItem = (overrides: Partial<ProductListItem> = {}): ProductListItem => ({
  id: dimmer.id,
  productTypeId: zigbeeType.id,
  productType: dimmer.productType,
  categoryId: dimmerCategory.id,
  category: dimmer.category,
  modelNumber: dimmer.modelNumber,
  name: dimmer.name,
  isActive: true,
  available: true,
  variantCount: 2,
  priceMin: '27.00',
  priceMax: '35.00',
  previewImageFileId: id(901),
  attributeErrors: 0,
  staleAttributes: 0,
  can: { update: true, delete: true },
  ...overrides,
})

export const ids = { id }

/** Output kinds and load types the capabilities name. */
export const outputKinds = [
  { id: id(401), key: 'dimmer_output', name: { en: 'dimmer output', de: 'Dimmerausgang' }, isActive: true, sortOrder: 1, functionTypeIds: [], createdAt: at, updatedAt: at, can: { update: true, delete: true } },
]
export const loadTypes = [
  { id: id(501), key: 'led', name: { en: 'LED' }, isActive: true, sortOrder: 1, createdAt: at, updatedAt: at, can: { update: true, delete: true } },
  { id: id(502), key: 'halogen', name: { en: 'halogen' }, isActive: true, sortOrder: 2, createdAt: at, updatedAt: at, can: { update: true, delete: true } },
]
