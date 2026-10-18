import { HttpResponse } from 'msw'

import type { Product, ProductListItem, ProductType, Variant } from '@/api/generated/model'

// Test data of the products tests (not shipped: only tests import it).

export const problem = (status: number, body: object) =>
  HttpResponse.json({ status, ...body }, { status, headers: { 'Content-Type': 'application/problem+json' } })

const at = '2026-01-01T00:00:00Z'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** A product type with one product attribute of every kind, and variant attributes. */
export const dimmerType: ProductType = {
  id: id(101),
  key: 'dimmer_actuator',
  name: { en: 'Dimmer actuator', de: 'Dimmaktor' },
  color: '#1f6feb',
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

/** A second type with a different schema, for type changes. */
export const gatewayType: ProductType = {
  ...dimmerType,
  id: id(102),
  key: 'gateway',
  name: { en: 'Gateway' },
  color: undefined,
  sortOrder: 2,
  attributes: [
    { key: 'series', label: { en: 'Series' }, type: 'text', scope: 'product' },
    { key: 'ports', label: { en: 'Ports' }, type: 'integer', scope: 'product' },
  ],
}

export const inactiveType: ProductType = { ...gatewayType, id: id(103), key: 'legacy', name: { en: 'Legacy' }, isActive: false, attributes: [] }

export const types = [dimmerType, gatewayType, inactiveType]

export const ivory: Variant = {
  id: id(301),
  productId: id(201),
  name: { en: 'Ivory White', de: 'Elfenbein' },
  sku: 'M485-IW',
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
  productTypeId: dimmerType.id,
  productType: { id: dimmerType.id, key: dimmerType.key, name: dimmerType.name, color: dimmerType.color, isActive: true },
  modelNumber: 'M485/DIM.4',
  name: { en: 'Dimmer 4ch', de: 'Dimmer 4-fach' },
  description: { en: 'Four channels' },
  attributes: { series: 'Pro', power: 300, width_te: 4, dali: true, bus_system: 'zigbee', loads: ['led', 'motor'], protocols: ['DALI'], currents: [1.5, 2] },
  staleAttributes: {},
  attributeErrors: [],
  isActive: true,
  available: true,
  variants: [ivory, black],
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
}

export const listItem = (overrides: Partial<ProductListItem> = {}): ProductListItem => ({
  id: dimmer.id,
  productTypeId: dimmerType.id,
  productType: dimmer.productType,
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
