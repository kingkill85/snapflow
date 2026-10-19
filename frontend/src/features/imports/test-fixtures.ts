import { http, HttpResponse } from 'msw'

import type {
  Category,
  ImportMapping,
  ImportChange,
  ImportCounts,
  ImportIssue,
  ImportItem,
  ImportProfile,
  ImportRun,
  ImportSourcePreview,
  ImportTarget,
  ProductType,
} from '@/api/generated/model'
import { server } from '@/test/server'

// Test data of the import tests (not shipped: only tests import it).

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = '2026-10-18T12:00:00Z'

export const problem = (status: number, body: object) =>
  HttpResponse.json({ status, ...body }, { status, headers: { 'Content-Type': 'application/problem+json' } })

export const zigbee: ProductType = {
  id: id(111),
  key: 'zigbee',
  name: { en: 'Zigbee' },
  abbreviation: 'ZB',
  reservePercent: 20,
  color: '#1f6feb',
  sortOrder: 1,
  isActive: true,
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
}

export const gateways: Category = {
  id: id(121),
  key: 'gateways',
  mounting: 'floorplan',
  name: { en: 'Gateways', de: 'Gateways' },
  sortOrder: 1,
  isActive: true,
  attributes: [{ key: 'width_te', label: { en: 'Width', de: 'Breite' }, type: 'integer', scope: 'product' }],
  instanceAttributes: [],
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
}

export const targets: ImportTarget[] = [
  { target: 'product.modelNumber', group: 'product', repeatable: false, constant: false, columnOptional: false, required: true },
  { target: 'product.name.en', group: 'product', repeatable: false, constant: true, columnOptional: false, required: false },
  { target: 'product.name.de', group: 'product', repeatable: false, constant: true, columnOptional: false, required: false },
  { target: 'product.productType', group: 'product', repeatable: false, constant: true, columnOptional: false, required: true },
  { target: 'product.category', group: 'product', repeatable: false, constant: true, columnOptional: false, required: true },
  { target: 'variant.name.en', group: 'variant', repeatable: false, constant: true, columnOptional: false, required: false },
  { target: 'variant.sku', group: 'variant', repeatable: false, constant: false, columnOptional: false, required: false },
  { target: 'variant.price', group: 'variant', repeatable: false, constant: true, columnOptional: false, required: false },
  { target: 'variant.image', group: 'variant', repeatable: false, constant: false, columnOptional: true, required: false },
  { target: 'addon.required', group: 'addon', repeatable: true, constant: false, columnOptional: false, required: false },
  { target: 'addon.optional', group: 'addon', repeatable: true, constant: false, columnOptional: false, required: false },
  {
    target: 'attribute.width_te',
    group: 'attribute',
    repeatable: false,
    constant: true,
    columnOptional: false,
    required: false,
    attribute: { key: 'width_te', label: { en: 'Width', de: 'Breite' }, categories: [{ categoryId: gateways.id, definition: gateways.attributes[0] }] },
  },
]

export const source: ImportSourcePreview = {
  sheets: ['Items', 'Notes'],
  sheet: 'Items',
  headerRow: 1,
  columns: [
    { letter: 'A', header: 'Model Number' },
    { letter: 'B', header: 'Name' },
    { letter: 'C', header: 'Category' },
    { letter: 'D', header: 'Price' },
  ],
  rows: [
    { number: 2, cells: ['GW-1', 'Gateway', 'Gateways', '108'], images: 1 },
    { number: 3, cells: ['GW-2', 'Gateway Pro', 'Gateways', '27,50'], images: 0 },
  ],
  dataRows: 2,
  images: 1,
}

export const counts = (over: Partial<ImportCounts> = {}): ImportCounts => ({
  rows: 3,
  rowsSkipped: 0,
  errors: 0,
  warnings: 0,
  categories: { new: 0, changed: 0, unchanged: 0, deactivate: 0 },
  products: { new: 2, changed: 1, unchanged: 4, deactivate: 1 },
  variants: { new: 3, changed: 0, unchanged: 5, deactivate: 0 },
  addons: { new: 1, changed: 0, unchanged: 0, removed: 0, unresolved: 0 },
  images: { new: 2, changed: 0, unchanged: 0, files: 2 },
  unmapped: [],
  ...over,
})

export const mapping = {
  sourceKind: 'xlsx' as const,
  headerRow: 1,
  dataStartRow: 2,
  productTypeId: zigbee.id,
  allOrNothing: true,
  createMissingCategories: false,
  fields: [
    { target: 'product.modelNumber', column: 'Model Number', columnLetter: 'A' },
    { target: 'product.name.en', column: 'Name', columnLetter: 'B' },
    { target: 'product.category', column: 'Category', columnLetter: 'C' },
  ],
}

export const run = (over: Partial<ImportRun> = {}): ImportRun => ({
  id: id(1),
  state: 'uploaded',
  fileId: id(901),
  fileName: 'supplier.xlsx',
  fileSize: 123_456,
  sourceKind: 'xlsx',
  userName: 'Ada Admin',
  allOrNothing: true,
  createdAt: at,
  can: { preview: true, apply: false, undo: false, delete: true },
  ...over,
})

export const previewed = (over: Partial<ImportRun> = {}) =>
  run({ state: 'previewed', mapping, counts: counts(), previewedAt: at, can: { preview: true, apply: true, undo: false, delete: true }, ...over })

export const applied = (over: Partial<ImportRun> = {}) =>
  run({ state: 'applied', mapping, counts: counts(), applied: counts(), previewedAt: at, appliedAt: at, can: { preview: false, apply: false, undo: true, delete: false }, ...over })

export const profile = (over: Partial<ImportProfile> = {}): ImportProfile => ({
  id: id(301),
  name: 'Supplier A',
  mapping,
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
  ...over,
})

export const productItem: ImportItem = {
  seq: 2,
  entity: 'product',
  status: 'changed',
  skipped: false,
  rows: [2, 3, 4, 7],
  id: id(501),
  modelNumber: 'GW-1',
  name: { en: 'Gateway' },
  productType: { id: zigbee.id, key: 'zigbee', name: { en: 'Zigbee' }, abbreviation: 'ZB', color: '#1f6feb' },
  category: { id: gateways.id, key: 'gateways', name: { en: 'Gateways' } },
  changes: [
    { field: 'name.en', before: 'Old gateway', after: 'Gateway' },
    { field: 'attributes.width_te', before: 2, after: 4 },
  ],
}

export const variantItem: ImportItem = {
  seq: 3,
  entity: 'variant',
  status: 'new',
  skipped: true,
  rows: [5],
  productId: id(501),
  modelNumber: 'GW-1',
  name: { en: 'Black' },
  sku: 'GW-1 Black',
  changes: [
    { field: 'price', after: '27.50' },
    { field: 'image', after: id(902) },
    { field: 'addons', after: [{ label: 'PSU-1', required: true }] },
  ],
}

export const issue: ImportIssue = {
  severity: 'error',
  row: 5,
  column: 'D',
  header: 'Price',
  target: 'variant.price',
  modelNumber: 'GW-1',
  code: 'import.duplicate_sku',
  params: { sku: 'GW-1 Black' },
}

export const changes: ImportChange[] = [
  {
    seq: 1,
    entity: 'product',
    action: 'update',
    entityId: id(501),
    label: 'GW-1',
    before: { id: id(501), modelNumber: 'GW-1', name: { en: 'Old gateway' }, attributes: {}, isActive: true, updatedAt: at },
    after: { id: id(501), modelNumber: 'GW-1', name: { en: 'Gateway' }, attributes: {}, isActive: true, updatedAt: at },
  },
  {
    seq: 2,
    entity: 'variant',
    action: 'create',
    entityId: id(601),
    label: 'GW-1 Black',
    after: { id: id(601), productId: id(501), name: { en: 'Black' }, sku: 'GW-1 Black', price: '27.50', attributes: {}, isActive: true },
  },
]

/** The lookups every run page loads: product types, categories, targets, profiles. */
export function lookups(profiles: ImportProfile[] = [profile()]) {
  server.use(
    http.get('/api/product-types', () => HttpResponse.json({ items: [zigbee] })),
    http.get('/api/categories', () => HttpResponse.json({ items: [gateways] })),
    http.get('/api/import-targets', () => HttpResponse.json(targets)),
    http.get('/api/import-profiles', () => HttpResponse.json(profiles)),
  )
}

/**
 * Serves the run (as `current()` says) and its source preview (`answer` may
 * answer a source query instead, e.g. for a sheet the file lacks); records
 * source queries.
 */
export function runHandlers(current: () => ImportRun, answer?: (query: URLSearchParams) => Response | undefined) {
  const sourceQueries: URLSearchParams[] = []
  server.use(
    http.get(`/api/imports/${id(1)}`, () => HttpResponse.json(current())),
    http.get(`/api/imports/${id(1)}/source`, ({ request }) => {
      const q = new URL(request.url).searchParams
      sourceQueries.push(q)
      const answered = answer?.(q)
      if (answered) return answered
      const headerRow = Number(q.get('headerRow'))
      return HttpResponse.json({ ...source, headerRow, sheet: q.get('sheet') || source.sheet })
    }),
  )
  return { sourceQueries }
}

/** Records preview requests and answers with `answer`. */
export function previewHandler(answer: (body: { mapping?: ImportMapping; profileId?: string }) => Response | Promise<Response>) {
  const bodies: { mapping?: ImportMapping; profileId?: string }[] = []
  server.use(
    http.post(`/api/imports/${id(1)}/preview`, async ({ request }) => {
      const body = (await request.json()) as { mapping?: ImportMapping; profileId?: string }
      bodies.push(body)
      return answer(body)
    }),
  )
  return bodies
}

export function previewLists(items = [productItem, variantItem], issues = [issue], total?: number) {
  const itemQueries: URLSearchParams[] = []
  const issueQueries: URLSearchParams[] = []
  server.use(
    http.get(`/api/imports/${id(1)}/items`, ({ request }) => {
      itemQueries.push(new URL(request.url).searchParams)
      return HttpResponse.json({ items, total: total ?? items.length })
    }),
    http.get(`/api/imports/${id(1)}/issues`, ({ request }) => {
      issueQueries.push(new URL(request.url).searchParams)
      return HttpResponse.json({ items: issues, total: issues.length })
    }),
  )
  return { itemQueries, issueQueries }
}
