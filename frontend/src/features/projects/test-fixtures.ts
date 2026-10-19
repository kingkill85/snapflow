import { HttpResponse } from 'msw'

import type { CurrencyList, ProductType, Project, ProjectListItem, ProjectVersion, Tenant } from '@/api/generated/model'

// Test data of the projects tests (not shipped: only tests import it).

export const problem = (status: number, body: object) =>
  HttpResponse.json({ status, ...body }, { status, headers: { 'Content-Type': 'application/problem+json' } })

const at = '2026-10-18T10:00:00Z'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const acmeId = '00000000-0000-4000-8000-0000000000a1'
export const distributorId = '00000000-0000-4000-8000-0000000000d1'

export const zigbee: ProductType = {
  id: id(111),
  key: 'zigbee',
  name: { en: 'Zigbee' },
  abbreviation: 'ZB',
  reservePercent: 20,
  nominalVoltage: 230,
  topology: 'wireless',
  addressing: 'eui64',
  color: '#1f6feb',
  sortOrder: 1,
  isActive: true,
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
}
export const knx: ProductType = { ...zigbee, id: id(112), key: 'knx', name: { en: 'KNX' }, abbreviation: 'KX', sortOrder: 2 }
export const legacy: ProductType = { ...zigbee, id: id(113), key: 'legacy', name: { en: 'Legacy' }, abbreviation: 'LG', sortOrder: 3, isActive: false }
export const productTypes = [zigbee, knx, legacy]

export const tenant = (over: Partial<Tenant>): Tenant => ({
  id: acmeId,
  name: 'Acme',
  isDistributor: false,
  isActive: true,
  createdAt: at,
  updatedAt: at,
  projectCount: 0,
  letterhead: { companyName: '', address: '', phone: '', email: '', website: '', logoFileId: null, logoUrl: null },
  can: { update: true, delete: true },
  ...over,
})
export const tenants = [tenant({ id: distributorId, name: 'Distributor', isDistributor: true }), tenant({})]

export const version = (n: number, over: Partial<ProjectVersion> = {}): ProjectVersion => ({
  id: id(200 + n),
  projectId: id(300),
  name: `V${n}`,
  notes: '',
  position: n,
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
  ...over,
})

export const villa: Project = {
  id: id(300),
  tenantId: acmeId,
  tenant: { id: acmeId, name: 'Acme', archived: false },
  number: '2026-0001',
  name: 'Villa Müller',
  status: 'active',
  language: 'en',
  currency: 'EUR',
  exchangeRate: '0.92',
  exchangeRateDate: '2026-10-18T00:00:00Z',
  exchangeRateSource: 'manual',
  exchangeRateProvider: '',
  exchangeRateAgeDays: 1,
  exchangeRateStale: false,
  exchangeRateMaxAgeDays: 7,
  customer: { name: 'Max Müller', company: 'Müller GmbH', email: 'max@example.com', phone: '+49 1', address: 'Street 1\nCity' },
  notes: 'Gate code 1234',
  productTypeIds: [zigbee.id],
  versions: [version(1), version(2)],
  nextVersionName: 'V3',
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true, reopen: false },
}

export const villaRow: ProjectListItem = {
  id: villa.id,
  tenantId: acmeId,
  tenant: { id: acmeId, name: 'Acme', archived: false },
  number: villa.number,
  name: villa.name,
  customerName: 'Max Müller',
  customerCompany: 'Müller GmbH',
  status: 'active',
  versionCount: 2,
  productTypeIds: [zigbee.id],
  updatedAt: at,
  can: { update: true, delete: true, reopen: false },
}

/** GET /api/currencies: a few codes, EUR and PKR recently used by the tenant; the provider has no CHF. */
export const currencies: CurrencyList = {
  items: ['CHF', 'EUR', 'JPY', 'PKR', 'USD'].map((code) => ({ code, minorUnits: code === 'JPY' ? 0 : 2, online: code !== 'CHF' })),
  recent: ['PKR', 'EUR'],
  onlineKnown: true,
}
