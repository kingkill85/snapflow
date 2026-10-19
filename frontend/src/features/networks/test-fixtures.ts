import type { AddressedItem, Addresses, BusMember, Gateway, Networks, WirelessDevice } from '@/api/generated/model'

export const versionId = '00000000-0000-4000-8000-000000000301'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const groundFloor = id(10)
export const firstFloor = id(11)
export const knx = { id: id(1), key: 'knx', name: { en: 'KNX', de: 'KNX' }, abbreviation: 'KNX', color: '#2e7d32' }
export const zigbee = { id: id(2), key: 'zigbee', name: { en: 'Zigbee', de: 'Zigbee' }, abbreviation: 'ZB', color: '#ffcc00' }

const knx1 = id(100)
const knx2 = id(101)

const member = (n: number, extra: Partial<BusMember>): BusMember => ({
  itemId: id(n),
  planId: groundFloor,
  planKind: 'floorplan',
  planName: 'Ground floor',
  productName: { en: 'Switch actuator', de: 'Schaltaktor' },
  variantName: { en: '8-fold' },
  modelNumber: 'SA-8',
  variantId: id(n + 1000),
  label: '',
  existing: false,
  pinned: false,
  powerSupply: false,
  busCurrentUsedMa: 12,
  busCurrentUsedMaDefault: false,
  ...extra,
})

export const supply = member(200, { productName: { en: 'Power supply' }, variantName: {}, modelNumber: 'PS-640', busCurrentUsedMa: undefined, busCurrentSuppliedMa: 640, powerSupply: true })
export const actuator = member(201, { label: 'Kitchen' })
export const pinnedSensor = member(202, { productName: { en: 'Presence sensor' }, variantName: {}, modelNumber: 'PIR-1', label: 'Hall', pinned: true, planId: firstFloor, planName: 'First floor', busCurrentUsedMa: undefined })

const device = (n: number, extra: Partial<WirelessDevice>): WirelessDevice => ({
  itemId: id(n),
  planId: groundFloor,
  planKind: 'floorplan',
  planName: 'Ground floor',
  productName: { en: 'Door sensor' },
  variantName: {},
  modelNumber: 'DS-1',
  variantId: id(n + 1000),
  label: '',
  existing: false,
  pinned: false,
  wirelessPlacesUsed: 1,
  wirelessPlacesUsedDefault: true,
  ...extra,
})

export const doorSensor = device(300, { label: 'Front door' })
export const pinnedBulb = device(301, { productName: { en: 'Bulb' }, modelNumber: 'B-1', label: 'Desk', pinned: true, planId: firstFloor, planName: 'First floor' })

const gateway = (n: number, extra: Partial<Gateway>): Gateway => ({
  itemId: id(n),
  planId: groundFloor,
  planKind: 'floorplan',
  planName: 'Ground floor',
  productName: { en: 'Zigbee gateway' },
  variantName: {},
  modelNumber: 'GW-1',
  variantId: id(n + 1000),
  label: '',
  existing: false,
  wirelessPlacesSupplied: 50,
  wirelessPlacesUsed: 1,
  unknownPlacesCount: 0,
  devices: [],
  ...extra,
})

export const gatewayGround = gateway(400, { devices: [doorSensor] })
export const gatewayFirst = gateway(401, { planId: firstFloor, planName: 'First floor', devices: [pinnedBulb], unknownPlacesCount: 1, wirelessPlacesUsed: 0 })

const line = (lineId: string, name: string, position: number, members: BusMember[], extra: Partial<Networks['busSystems'][number]['lines'][number]> = {}) => ({
  id: lineId,
  versionId,
  productTypeId: knx.id,
  name,
  address: '',
  devicesMax: null,
  position,
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  members,
  deviceCount: members.length,
  busCurrentUsedMa: 0,
  busCurrentSuppliedMa: 0,
  unknownCurrentCount: 0,
  ...extra,
})

export const lineOne = line(knx1, 'KNX 1', 1, [supply, actuator], { address: '1.1', busCurrentUsedMa: 12, busCurrentSuppliedMa: 640 })
export const lineTwo = line(knx2, 'KNX 2', 2, [pinnedSensor], { unknownCurrentCount: 1, devicesMax: 32 })

export const networks: Networks = {
  versionId,
  busSystems: [{ productType: knx, lines: [lineOne, lineTwo], unassigned: [] }],
  wirelessSystems: [{ productType: zigbee, gateways: [gatewayGround, gatewayFirst], unassigned: [device(302, { productName: { en: 'Leak sensor' }, label: 'Bath' })] }],
  can: { update: true },
}

export const readOnlyNetworks: Networks = {
  ...networks,
  busSystems: [{ productType: knx, lines: [], unassigned: [actuator] }],
  can: { update: false },
}

export const emptyNetworks: Networks = { versionId, busSystems: [], wirelessSystems: [], can: { update: true } }

const addressed = (m: BusMember | WirelessDevice, extra: Partial<AddressedItem>): AddressedItem => ({
  planId: m.planId,
  itemId: m.itemId,
  planKind: m.planKind,
  planName: m.planName,
  productName: m.productName,
  variantName: m.variantName,
  modelNumber: m.modelNumber,
  variantId: m.variantId,
  label: m.label,
  existing: m.existing,
  systemId: knx.id,
  scheme: 'knx',
  gateway: false,
  powerSupply: false,
  ...extra,
})

/** Addresses (3e): the actuator automatic, the sensor pinned, the door sensor without IEEE, the bulb with one. */
export const addresses: Addresses = {
  versionId,
  items: [
    addressed(supply, { busLineId: knx1, powerSupply: true }),
    addressed(actuator, { busLineId: knx1, address: { knx: '1.1.1', pinned: false } }),
    addressed(pinnedSensor, { busLineId: knx2, address: { knx: '1.2.7', pinned: true } }),
    addressed(doorSensor, { systemId: zigbee.id, scheme: 'ieee' }),
    addressed(pinnedBulb, { systemId: zigbee.id, scheme: 'ieee', address: { ieee: '00124B001CA1B2C3', pinned: true } }),
  ],
  lines: [
    { busLineId: knx1, scheme: 'knx', prefix: '1.1', default: false, invalid: false },
    { busLineId: knx2, scheme: 'knx', prefix: '1.2', default: true, invalid: false },
  ],
  can: { update: true },
}
