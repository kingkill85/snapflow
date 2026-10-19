import { HttpResponse } from 'msw'

import type { CatalogField, LoadType, MeaningSpec, OutputKind } from '@/api/generated/model'

export const problem = (status: number, body: object) =>
  HttpResponse.json({ status, ...body }, { status, headers: { 'Content-Type': 'application/problem+json' } })

const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', can: { update: true, delete: true } }
const readOnly = { update: false, delete: false }

export const loadType = (over: Partial<LoadType>): LoadType => ({
  ...base,
  id: '00000000-0000-4000-8000-0000000000a1',
  key: 'led',
  name: { en: 'LED' },
  sortOrder: 1,
  isActive: true,
  powerFactor: 1,
  ...over,
})

export const outputKind = (over: Partial<OutputKind>): OutputKind => ({
  ...base,
  id: '00000000-0000-4000-8000-0000000000b1',
  key: 'relay_output',
  name: { en: 'Relay output' },
  sortOrder: 1,
  isActive: true,
  functionTypeIds: [],
  alternatives: [],
  ...over,
})

export const catalogField = (over: Partial<CatalogField>): CatalogField => ({
  ...base,
  id: '00000000-0000-4000-8000-0000000000c1',
  key: 'width_te',
  label: { en: 'Width' },
  type: 'number',
  unit: 'TE',
  meaning: 'rail_width_te',
  options: [],
  productTypeIds: [],
  sortOrder: 1,
  inUse: 0,
  usedBy: [],
  ...over,
})

export const meanings: MeaningSpec[] = [
  { meaning: 'channels_supplied', outputKind: true, loadType: false, loadTypeRequired: false, options: [], types: ['integer'] },
  { meaning: 'channel_limit_w', outputKind: true, loadType: true, loadTypeRequired: true, options: [], types: ['number', 'integer'] },
  { meaning: 'channel_limit_a', outputKind: true, loadType: true, loadTypeRequired: false, options: [], types: ['number', 'integer'] },
  { meaning: 'rail_width_te', outputKind: false, loadType: false, loadTypeRequired: false, options: [], types: ['number', 'integer'] },
  { meaning: 'motor_type', outputKind: false, loadType: false, loadTypeRequired: false, options: ['ac', 'dc'], types: ['enum'] },
]

export { readOnly }
