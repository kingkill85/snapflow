import { http, HttpResponse } from 'msw'

import type { Checks, FunctionType, LoadType, OutputKind, Plan, Wiring } from '@/api/generated/model'
import { server } from '@/test/server'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const projectId = id(900)
export const versionId = id(901)
export const floorId = id(10)
export const boardId = id(11)
export const kitchen = id(20)
export const living = id(21)
export const spots = id(30)
export const blinds = id(31)
export const ceiling = id(32)
export const dimmer = id(40)
export const relay = id(41)
export const lineId = id(50)
export const batchId = id(60)

export const dimmerKind = id(1)
export const relayKind = id(2)
export const blindKind = id(3)
export const light = id(5)
export const blind = id(6)

const stamp = '2026-10-01T00:00:00Z'
const kind = (kid: string, key: string, en: string, de: string, fts: string[], order: number): OutputKind => ({
  id: kid,
  key,
  name: { en, de },
  functionTypeIds: fts,
  alternatives: [],
  isActive: true,
  sortOrder: order,
  can: { update: false, delete: false },
  createdAt: stamp,
  updatedAt: stamp,
})
export const outputKinds: OutputKind[] = [
  kind(dimmerKind, 'dimmer_output', 'Dimmer output', 'Dimmerausgang', [light], 1),
  kind(relayKind, 'relay_output', 'Relay output', 'Relaisausgang', [light], 2),
  kind(blindKind, 'blind_output', 'Blind output', 'Jalousieausgang', [blind], 3),
]
export const functionTypes: FunctionType[] = [
  { id: light, key: 'light', name: { en: 'Light', de: 'Licht' }, allowsCircuit: true, isActive: true, loadTypeIds: [], createdAt: stamp, updatedAt: stamp },
  { id: blind, key: 'blind', name: { en: 'Blind', de: 'Jalousie' }, allowsCircuit: false, isActive: true, loadTypeIds: [], createdAt: stamp, updatedAt: stamp },
]
export const loadTypes: LoadType[] = []

const plan = (pid: string, name: string, kindName: 'floorplan' | 'board', position: number) =>
  ({ id: pid, name, kind: kindName, position, projectId, versionId, board: null, image: null, lock: null, can: {}, contentUpdatedAt: stamp, createdAt: stamp, updatedAt: stamp, needCount: 0, placementCount: 0, zoneCount: 0 }) as unknown as Plan
export const plans: Plan[] = [plan(floorId, 'Ground floor', 'floorplan', 1), plan(boardId, 'Main board', 'board', 2)]

const conn = (cid: number, needId: string, units: number, item: string, kindId: string, no: number, batch: string | null = null) => ({
  id: id(cid),
  versionId,
  needPlanId: floorId,
  needId,
  units,
  targetPlanId: boardId,
  targetItemId: item,
  outputKindId: kindId,
  channelNo: no,
  pinned: batch === null,
  batchId: batch,
  createdAt: stamp,
})

export const wiring: Wiring = {
  can: { update: true },
  items: [
    {
      planId: boardId,
      planName: 'Main board',
      planKind: 'board',
      itemId: dimmer,
      label: 'D1',
      productName: { en: 'Dimmer', de: 'Dimmer' },
      variantName: { en: '2-fold' },
      zoneId: null,
      channels: [
        { outputKindId: dimmerKind, outputKindKey: 'dimmer_output', channelNo: 1, alternative: false, baseKindKey: 'dimmer_output', baseFrom: 1, baseTo: 1, blocked: false, connectionIds: [id(70)] },
        { outputKindId: dimmerKind, outputKindKey: 'dimmer_output', channelNo: 2, alternative: false, baseKindKey: 'dimmer_output', baseFrom: 2, baseTo: 2, blocked: false, connectionIds: [] },
      ],
    },
    {
      planId: boardId,
      planName: 'Main board',
      planKind: 'board',
      itemId: relay,
      label: '',
      productName: { en: 'Switch actuator', de: 'Schaltaktor' },
      variantName: { en: '4-fold' },
      zoneId: null,
      channels: [
        { outputKindId: relayKind, outputKindKey: 'relay_output', channelNo: 1, alternative: false, baseKindKey: 'relay_output', baseFrom: 1, baseTo: 1, blocked: true, connectionIds: [] },
        { outputKindId: blindKind, outputKindKey: 'blind_output', channelNo: 1, alternative: true, baseKindKey: 'relay_output', baseFrom: 1, baseTo: 2, blocked: false, connectionIds: [id(71)] },
      ],
    },
  ],
  needs: [
    { planId: floorId, planName: 'Ground floor', needId: spots, zoneId: kitchen, zoneName: 'Kitchen', label: 'Spots', functionTypeId: light, functionTypeKey: 'light', quantity: 5, connectedUnits: 2, powerW: '7.00' },
    { planId: floorId, planName: 'Ground floor', needId: blinds, zoneId: kitchen, zoneName: 'Kitchen', label: 'Window', functionTypeId: blind, functionTypeKey: 'blind', quantity: 1, connectedUnits: 1, powerW: null },
    { planId: floorId, planName: 'Ground floor', needId: ceiling, zoneId: living, zoneName: 'Living room', label: '', functionTypeId: light, functionTypeKey: 'light', quantity: 1, connectedUnits: 0, powerW: null },
  ],
  connections: [conn(70, spots, 2, dimmer, dimmerKind, 1), conn(71, blinds, 1, relay, blindKind, 1, batchId)],
}

export const checks: Checks = {
  versionId,
  counts: { errors: 1, warnings: 2, infos: 0, units: 7, connectedUnits: 3, zonesWithNeeds: 2, zonesCovered: 0 },
  zones: [
    { planId: floorId, zoneId: kitchen, name: 'Kitchen', units: 6, connectedUnits: 3, status: 'partial' },
    { planId: floorId, zoneId: living, name: 'Living room', units: 1, connectedUnits: 0, status: 'missing' },
  ],
  boards: [
    {
      planId: boardId,
      name: 'Main board',
      channels: [
        { outputKindId: dimmerKind, outputKindKey: 'dimmer_output', alternative: false, total: 2, used: 1, free: 1 },
        { outputKindId: blindKind, outputKindKey: 'blind_output', alternative: true, total: 2, used: 1, free: 1 },
      ],
      rows: [],
      usedTe: 8,
      capacityTe: 12,
      status: 'ok',
    },
  ],
  busLines: [
    { busLineId: lineId, name: 'KNX 1', productTypeId: id(80), reservePercent: 20, currentUsedMa: 612, currentDefaultMa: 0, currentSuppliedMa: 640, unknownCurrentCount: 0, currentStatus: 'amber', devices: 12, devicesMax: 64, devicesStatus: 'ok' },
  ],
  gateways: [],
  findings: [
    { severity: 'error', code: 'channel_overload_w', refs: { targetPlanId: boardId, itemId: dimmer, outputKindId: dimmerKind, channelNo: 1, connectionIds: [id(70)] }, params: { loadW: 140, limitW: 100 } },
    { severity: 'warning', code: 'need_unconnected', refs: { planId: floorId, zoneId: living, needId: ceiling }, params: { missing: 1, quantity: 1, label: '' } },
    { severity: 'warning', code: 'bus_line_current_reserve', refs: { busLineId: lineId }, params: { name: 'KNX 1', usedMa: 612, suppliedMa: 640, reservePercent: 20 } },
  ],
}

/** The handlers the Checks tab and the wiring model need. */
export function serveChecks(overrides: { checks?: Checks; wiring?: Wiring } = {}) {
  server.use(
    http.get('/api/versions/:versionId/checks', () => HttpResponse.json(overrides.checks ?? checks)),
    http.get('/api/versions/:versionId/wiring', () => HttpResponse.json(overrides.wiring ?? wiring)),
    http.get('/api/versions/:versionId/plans', () => HttpResponse.json(plans)),
    http.get('/api/output-kinds', () => HttpResponse.json({ items: outputKinds })),
    http.get('/api/function-types', () => HttpResponse.json({ items: functionTypes })),
    http.get('/api/load-types', () => HttpResponse.json({ items: loadTypes })),
  )
}
