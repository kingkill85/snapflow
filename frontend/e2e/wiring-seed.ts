import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Api, expect, unique, uniqueKey } from './fixtures'

// The step 3d project (connections specs): own function types (light with circuits, blind) and output kinds
// (dimmer, relay, blind with the relay-pair alternative), a KNX product type, a floorplan with Kitchen and
// Living room needs, and a board with a 160 mA power supply, a 2-ch dimmer, a 4-ch relay with blind mode and
// a 2-ch blind actuator (80 mA bus current used).

const assets = join(import.meta.dirname, 'assets')
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

type Id = { id: string }

/** `systemKey`: the bus system's key prefix (`knx` → KNX addresses, `hdl` → HDL Buspro, D419). */
export async function wiringSeed(api: Api, { systemKey = 'knx' }: { systemKey?: 'knx' | 'hdl' } = {}) {
  const post = async <T = Id,>(path: string, data: object) => {
    const res = await api.ctx.post(path, { data })
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const text = (en: string) => ({ en })
  // Own function types and output kinds, so other specs' catalog data does not take part.
  const lightName = unique('Light')
  const blindName = unique('Blind')
  // KNX objects (catalog data, D422): the group addresses of a need.
  const object = (key: string, en: string, dpst: string) => ({ key, name: { en }, dpst })
  const light = await post('/api/function-types', {
    key: uniqueKey('light'),
    name: text(lightName),
    allowsCircuit: true,
    knxObjects: [object('switch', 'Switch', 'DPST-1-1'), object('switch_status', 'Switch status', 'DPST-1-1')],
  })
  const blind = await post('/api/function-types', {
    key: uniqueKey('blind'),
    name: text(blindName),
    knxObjects: [object('up_down', 'Up/Down', 'DPST-1-8'), object('stop_step', 'Stop/Step', 'DPST-1-7')],
  })
  const kind = (key: string, en: string, functionTypeIds: string[], alternatives: object[] = []) =>
    post('/api/output-kinds', { key: uniqueKey(key), name: text(unique(en)), isActive: true, functionTypeIds, alternatives })
  const dimmerKind = await kind('dim', 'Dimmer output', [light.id])
  const relayKind = await kind('rel', 'Relay output', [light.id])
  const blindKind = await kind('bli', 'Blind output', [blind.id], [{ outputKindId: relayKind.id, count: 2 }])

  const knxName = unique('KNX')
  const knx = await post('/api/product-types', { key: uniqueKey(systemKey), name: text(knxName), abbreviation: 'KNX', color: '#0a7d33', isActive: true, topology: 'bus' })
  const field = async (key: string, type: string, meaning: string, outputKindId?: string) => {
    const k = uniqueKey(key)
    await post('/api/catalog-fields', { key: k, label: text(k), type, meaning, outputKindId })
    return { key: k, type }
  }
  const f = {
    width: await field('width', 'number', 'rail_width_te'),
    busMa: await field('busma', 'number', 'bus_current_used_ma'),
    supply: await field('supply', 'number', 'bus_current_supplied_ma'),
    dimCh: await field('dimch', 'integer', 'channels_supplied', dimmerKind.id),
    relCh: await field('relch', 'integer', 'channels_supplied', relayKind.id),
    blindOk: await field('blindok', 'boolean', 'alternative_allowed', blindKind.id),
    blindCh: await field('blindch', 'integer', 'channels_supplied', blindKind.id),
  }
  const attributes = Object.values(f).map((x) => ({ key: x.key, label: text(x.key), type: x.type, fieldKey: x.key }))
  const category = await post('/api/categories', { key: uniqueKey('act'), name: text(unique('Actuators')), isActive: true, mounting: 'board', attributes, instanceAttributes: [] })
  const product = async (name: string, values: Partial<Record<keyof typeof f, number | boolean>>) => {
    const attrs = Object.fromEntries(Object.entries(values).map(([k, v]) => [f[k as keyof typeof f].key, v]))
    const p = await post<Id & { variants: Id[] }>('/api/products', { productTypeId: knx.id, categoryId: category.id, modelNumber: uniqueKey('m'), name: text(name), isActive: true, attributes: attrs, firstVariant: { name: text('Std'), price: '50.00' } })
    return { id: p.id, name, variantId: p.variants[0].id, attrs }
  }
  const psu = await product(unique('Power supply'), { width: 2, supply: 160 })
  const dimmer = await product(unique('Dimmer'), { width: 4, dimCh: 2, busMa: 30 })
  const relay = await product(unique('Switch actuator'), { width: 4, relCh: 4, blindOk: true, busMa: 30 })
  const blindAct = await product(unique('Blind actuator'), { width: 4, blindCh: 2, busMa: 20 })

  const project = await api.createProject({ name: unique('Wiring project'), productTypeIds: [knx.id] })
  const versionId = project.versions[0].id
  const floor = await api.createPlan(versionId, 'Ground floor', planImage())
  const kitchen = { id: crypto.randomUUID(), name: 'Kitchen', color: '#22c55e', opacity: 0.25, points: rect(100, 100, 500, 500) }
  const living = { id: crypto.randomUUID(), name: 'Living room', color: '#3b82f6', opacity: 0.25, points: rect(600, 100, 1100, 500) }
  await api.savePlanContent(floor.id, {
    zones: [kitchen, living],
    placements: [],
    needs: [
      { zoneId: kitchen.id, functionTypeId: light.id, quantity: 3, powerW: '7.00', label: 'Spots' },
      { zoneId: kitchen.id, functionTypeId: blind.id, quantity: 2, label: 'Windows' },
      { zoneId: living.id, functionTypeId: light.id, quantity: 1, powerW: '40.00', label: 'Ceiling' },
      { zoneId: living.id, functionTypeId: blind.id, quantity: 1, label: 'Door' },
    ],
  })

  const board = await post(`/api/versions/${versionId}/boards`, { name: 'Main board', rows: [{ capacityTe: 24 }] })
  await post(`/api/plans/${board.id}/lock`, {})
  const content = (await (await api.ctx.get(`/api/plans/${board.id}/board`)).json()) as { contentUpdatedAt: string; rows: { id: string; capacityTe: number }[] }
  const row = content.rows[0].id
  const mod = (p: { variantId: string }, offsetTe: number, label: string) => ({
    id: crypto.randomUUID(),
    variantId: p.variantId,
    rowId: row,
    offsetTe,
    label,
    existing: false,
    addonVariantIds: [],
    instanceValues: {},
  })
  const res = await api.ctx.put(`/api/plans/${board.id}/board`, {
    data: {
      expectedContentUpdatedAt: content.contentUpdatedAt,
      enclosureVariantId: null,
      rows: [{ id: row, capacityTe: 24 }],
      modules: [mod(psu, 0, 'PS1'), mod(dimmer, 2, 'D1'), mod(relay, 6, 'Q1'), mod(blindAct, 10, 'J1')],
    },
  })
  expect(res.ok(), await res.text()).toBe(true)
  await api.ctx.delete(`/api/plans/${board.id}/lock`)
  return { project, versionId, floor, kitchen, living, board, lightName, blindName, dimmer, relay, blindAct, f }
}

