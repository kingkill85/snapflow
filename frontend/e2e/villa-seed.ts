import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Api, expect, unique, uniqueKey } from './fixtures'

// The villa of the step 3d/3e visual specs: an HDL Buspro villa in Lahore
// with one KNX line and Zigbee (D417); with `knx` a third board row holds KNX
// actuators (group addresses, D434) on a 20 TE rail with free TE.

const assets = join(import.meta.dirname, 'assets')
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })

export type Lang = 'en' | 'de'

export const L = (en: string, de: string) => ({ en, de })
type T = ReturnType<typeof L>
type Named = { id: string; key: string }

export async function json<R>(res: Awaited<ReturnType<Api['ctx']['get']>>): Promise<R> {
  expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true)
  return (await res.json()) as R
}

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

/**
 * The catalog of an HDL Buspro installer: own function types and output kinds
 * (so other specs' data does not take part), HDL power supply 2400 mA, two
 * 6-ch dimmers (LED/halogen limits, minimum load), a 12-ch relay with blind
 * mode (16 A), a 2-ch curtain actuator (AC motors), a 4-zone dry-contact
 * module, HDL panels; KNX 160 mA supply and room devices; a Zigbee gateway
 * with bulbs and sensors; room templates whose lines become the zones' needs.
 */
export async function catalog(api: Api, lang: Lang) {
  const tag = uniqueKey('').replace(/^_+/, '').slice(-5)
  const post = async <R = Named,>(path: string, data: object) => json<R>(await api.ctx.post(path, { data }))
  const loads = Object.fromEntries((await json<{ items: Named[] }>(await api.ctx.get('/api/load-types', { params: { includeInactive: true } }))).items.map((k) => [k.key, k]))

  // KNX objects (catalog data, D436): the group addresses of a need.
  const o = (key: string, name: T, dpst: string) => ({ key, name, dpst })
  const sw = [o('switch', L('Switch', 'Schalten'), 'DPST-1-1'), o('switch_status', L('Switch status', 'Status Schalten'), 'DPST-1-1')]
  const dim = [...sw, o('dim', L('Dim relative', 'Dimmen relativ'), 'DPST-3-7'), o('brightness', L('Brightness value', 'Helligkeitswert'), 'DPST-5-1')]
  const motor = [o('up_down', L('Up/Down', 'Auf/Ab'), 'DPST-1-8'), o('stop_step', L('Stop/Step', 'Stopp/Lamellen'), 'DPST-1-7'), o('position', L('Position', 'Position'), 'DPST-5-1')]
  const fn = (key: string, name: T, allowsCircuit: boolean, loadTypeIds: string[] = [], knxObjects: object[] = sw) =>
    post('/api/function-types', { key: `${key}_${tag}`, name, allowsCircuit, loadTypeIds, knxObjects })
  const fns = {
    dimmable: await fn('dimmable', L('Dimmable light', 'Dimmbares Licht'), true, [loads.led.id, loads.halogen.id], dim),
    switched: await fn('switched', L('Switched light', 'Geschaltetes Licht'), true, [loads.led.id]),
    socket: await fn('socket', L('Switched socket', 'Geschaltete Steckdose'), true, [loads.resistive.id]),
    blind: await fn('blind', L('Blind', 'Jalousie'), false, [loads.ac_motor.id, loads.dc_motor.id], motor),
    curtain: await fn('curtain', L('Curtain', 'Vorhang'), false, [loads.ac_motor.id, loads.dc_motor.id], motor),
    button: await fn('button', L('Pushbutton', 'Taster'), false, [loads.pushbutton.id], [sw[0]]),
    fan: await fn('fan', L('Ceiling fan', 'Deckenventilator'), false),
  }
  const kind = (key: string, name: T, functionTypeIds: string[], alternatives: object[] = []) =>
    post('/api/output-kinds', { key: `${key}_${tag}`, name, isActive: true, functionTypeIds, alternatives })
  const dimmerKind = await kind('dim', L('Dimmer output', 'Dimmerausgang'), [fns.dimmable.id])
  const relayKind = await kind('rel', L('Relay output', 'Schaltausgang'), [fns.switched.id, fns.socket.id])
  const blindKind = await kind('bli', L('Blind output', 'Jalousieausgang'), [fns.blind.id], [{ outputKindId: relayKind.id, count: 2 }])
  const curtainKind = await kind('cur', L('Curtain output', 'Vorhangausgang'), [fns.curtain.id])
  const inputKind = await kind('inp', L('Dry contact input', 'Potenzialfreier Eingang'), [fns.button.id])

  const type = (key: string, name: string, abbreviation: string, color: string, extra: object) =>
    post('/api/product-types', { key: `${key}_${tag}`, name: { en: name }, abbreviation, color, isActive: true, ...extra })
  const hdl = await type('hdl', 'HDL Buspro', 'HDL', '#1d4ed8', { topology: 'bus', busDevicesMax: 64, reservePercent: 20 })
  const knx = await type('knx', 'KNX', 'KNX', '#0f766e', { topology: 'bus', defaultBusCurrentMa: 10, busDevicesMax: 64, reservePercent: 20 })
  const zigbee = await type('zigbee', 'Zigbee', 'ZB', '#7c3aed', { topology: 'wireless', defaultWirelessPlacesUsed: 1, reservePercent: 20 })

  const field = async (key: string, label: T, typ: string, extra: object = {}) => ({
    ...(await post('/api/catalog-fields', { key: `${key}_${tag}`, label, type: typ, ...extra })),
    label,
    type: typ,
  })
  const f = {
    width: await field('width', L('Width', 'Breite'), 'number', { unit: 'TE', meaning: 'rail_width_te' }),
    busMa: await field('bus_ma', L('Bus current', 'Busstrom'), 'integer', { unit: 'mA', meaning: 'bus_current_used_ma' }),
    supplyMa: await field('supply_ma', L('Bus current output', 'Busstrom-Ausgang'), 'integer', { unit: 'mA', meaning: 'bus_current_supplied_ma' }),
    places: await field('places', L('Device places', 'Geräteplätze'), 'integer', { meaning: 'wireless_places_supplied' }),
    dimCh: await field('dim_ch', L('Dimmer channels', 'Dimmerkanäle'), 'integer', { meaning: 'channels_supplied', outputKindId: dimmerKind.id }),
    ledW: await field('led_w', L('LED load per channel', 'LED-Last je Kanal'), 'number', { unit: 'W', meaning: 'channel_limit_w', outputKindId: dimmerKind.id, loadTypeId: loads.led.id }),
    halW: await field('hal_w', L('Halogen load per channel', 'Halogenlast je Kanal'), 'number', { unit: 'W', meaning: 'channel_limit_w', outputKindId: dimmerKind.id, loadTypeId: loads.halogen.id }),
    minW: await field('min_w', L('Minimum load', 'Mindestlast'), 'number', { unit: 'W', meaning: 'channel_min_load_w', outputKindId: dimmerKind.id }),
    relCh: await field('rel_ch', L('Switching channels', 'Schaltkanäle'), 'integer', { meaning: 'channels_supplied', outputKindId: relayKind.id }),
    relA: await field('rel_a', L('Current per channel', 'Strom je Kanal'), 'number', { unit: 'A', meaning: 'channel_limit_a', outputKindId: relayKind.id }),
    blindOk: await field('blind_ok', L('Pairs as blind outputs', 'Paare als Jalousieausgänge'), 'boolean', { meaning: 'alternative_allowed', outputKindId: blindKind.id }),
    curCh: await field('cur_ch', L('Curtain channels', 'Vorhangkanäle'), 'integer', { meaning: 'channels_supplied', outputKindId: curtainKind.id }),
    inCh: await field('in_ch', L('Inputs', 'Eingänge'), 'integer', { meaning: 'channels_supplied', outputKindId: inputKind.id }),
    motor: await field('motor', L('Motor type', 'Motortyp'), 'enum', {
      meaning: 'motor_type',
      options: [
        { key: 'ac', label: L('AC motor', 'AC-Motor') },
        { key: 'dc', label: L('DC motor', 'DC-Motor') },
      ],
    }),
  }
  const attrs = Object.values(f).map((x) => ({ key: x.key, fieldKey: x.key, label: x.label, type: x.type, scope: 'product' }))
  const motorOptions = [
    { key: 'ac', label: L('AC motor', 'AC-Motor') },
    { key: 'dc', label: L('DC motor', 'DC-Motor') },
  ]
  const attributes = attrs.map((a) => (a.key === f.motor.key ? { ...a, options: motorOptions } : a))
  const category = (key: string, name: T, mounting: string) =>
    post('/api/categories', { key: `${key}_${tag}`, name, mounting, isActive: true, attributes, instanceAttributes: [] })
  const actuators = await category('actuators', L('Actuators', 'Aktoren'), 'board')
  const room = await category('room', L('Room devices', 'Raumgeräte'), 'floorplan')

  const products: Record<string, { productId: string; variantId: string; name: string }> = {}
  const product = async (key: string, t: Named, c: Named, name: T, values: Record<string, number | boolean | string>) => {
    const attributes = Object.fromEntries(Object.entries(values).map(([k, v]) => [f[k as keyof typeof f].key, v]))
    const p = await post('/api/products', { productTypeId: t.id, categoryId: c.id, modelNumber: uniqueKey(key.slice(0, 4)).toUpperCase(), name, isActive: true, attributes })
    const v = await post(`/api/products/${p.id}/variants`, { name: L('Standard', 'Standard'), price: '120.00', isActive: true })
    products[key] = { productId: p.id, variantId: v.id, name: name[lang] }
  }
  await product('hdlPsu', hdl, actuators, L('HDL power supply 2400 mA', 'HDL Netzteil 2400 mA'), { width: 4, supplyMa: 2400 })
  await product('dimmer', hdl, actuators, L('HDL dimmer 6-channel 1 A', 'HDL Dimmaktor 6-fach 1 A'), { width: 6, dimCh: 6, ledW: 200, halW: 230, minW: 10, busMa: 30 })
  await product('relay', hdl, actuators, L('HDL relay 12-channel 16 A with blind mode', 'HDL Schaltaktor 12-fach 16 A mit Jalousiebetrieb'), { width: 12, relCh: 12, relA: 16, blindOk: true, busMa: 30 })
  await product('curtain', hdl, actuators, L('HDL curtain actuator 2-channel', 'HDL Vorhangaktor 2-fach'), { width: 4, curCh: 2, motor: 'ac', busMa: 25 })
  await product('dry', hdl, actuators, L('HDL dry contact module 4-zone', 'HDL Binäreingang 4-fach'), { width: 2, inCh: 4, busMa: 20 })
  await product('panel', hdl, room, L('HDL Granite panel 4-button', 'HDL Granite Taster 4-fach'), { busMa: 25 })
  await product('knxPsu', knx, actuators, L('KNX power supply 160 mA', 'KNX Spannungsversorgung 160 mA'), { width: 2, supplyMa: 160 })
  await product('knxRelay', knx, actuators, L('KNX switch actuator 8-fold 16 A', 'KNX Schaltaktor 8-fach 16 A'), { width: 8, relCh: 8, relA: 16, blindOk: true, busMa: 10 })
  await product('knxDimmer', knx, actuators, L('KNX universal dimmer 4-fold', 'KNX Universaldimmer 4-fach'), { width: 4, dimCh: 4, ledW: 200, halW: 300, minW: 5, busMa: 12 })
  await product('presence', knx, room, L('KNX presence detector', 'KNX Präsenzmelder'), { busMa: 12 })
  await product('touch', knx, room, L('KNX touch panel 4.3"', 'KNX Touchpanel 4,3"'), { busMa: 55 })
  await product('thermostat', knx, room, L('KNX room thermostat', 'KNX Raumthermostat'), {})
  await product('gateway', zigbee, room, L('Zigbee gateway', 'Zigbee-Gateway'), { places: 64 })
  await product('bulb', zigbee, room, L('Zigbee bulb E27', 'Zigbee Leuchtmittel E27'), {})
  await product('sensor', zigbee, room, L('Zigbee door sensor', 'Zigbee Türkontakt'), {})

  // Room templates; their lines become the zones' needs (as the zone editor applies them).
  type Line = { functionTypeId: string; quantity: number; powerW: string | null; loadTypeId: string | null; label: string }
  const line = (fnId: string, quantity: number, powerW: string | null, loadTypeId: string | null, label: T): Line => ({ functionTypeId: fnId, quantity, powerW, loadTypeId, label: label[lang] })
  const led = loads.led.id
  const ac = loads.ac_motor.id
  const btn = loads.pushbutton.id
  const templates: Record<string, Line[]> = {
    drawing: [
      line(fns.dimmable.id, 8, '6', led, L('Downlights', 'Downlights')),
      line(fns.dimmable.id, 1, '120', loads.halogen.id, L('Chandelier', 'Kronleuchter')),
      line(fns.blind.id, 2, null, ac, L('Windows', 'Fenster')),
      line(fns.button.id, 2, null, btn, L('Door', 'Tür')),
    ],
    dining: [
      line(fns.dimmable.id, 1, null, led, L('Pendant', 'Pendelleuchte')),
      line(fns.switched.id, 4, '10', led, L('Cove light', 'Voutenlicht')),
      line(fns.curtain.id, 1, null, ac, L('Garden window', 'Gartenfenster')),
    ],
    kitchen: [
      line(fns.switched.id, 6, '8', led, L('Ceiling', 'Decke')),
      line(fns.socket.id, 1, '4000', loads.resistive.id, L('Water heater', 'Warmwasserbereiter')),
      line(fns.button.id, 1, null, btn, L('Door', 'Tür')),
    ],
    lounge: [
      line(fns.dimmable.id, 2, '24', led, L('LED strips', 'LED-Streifen')),
      line(fns.blind.id, 1, null, ac, L('Terrace', 'Terrasse')),
      line(fns.curtain.id, 1, null, loads.dc_motor.id, L('Projector screen', 'Leinwand')),
      line(fns.button.id, 1, null, btn, L('Sofa', 'Sofa')),
    ],
    master: [
      line(fns.dimmable.id, 6, '6', led, L('Downlights', 'Downlights')),
      line(fns.curtain.id, 2, null, ac, L('Windows', 'Fenster')),
      line(fns.button.id, 2, null, btn, L('Bedside', 'Bett')),
    ],
    bedroom: [
      line(fns.dimmable.id, 1, '3', led, L('Reading light', 'Leselicht')),
      line(fns.switched.id, 2, '10', led, L('Ceiling', 'Decke')),
      line(fns.blind.id, 1, null, ac, L('Window', 'Fenster')),
    ],
    guest: [line(fns.switched.id, 2, '10', led, L('Ceiling', 'Decke')), line(fns.blind.id, 1, null, ac, L('Window', 'Fenster'))],
    family: [line(fns.dimmable.id, 4, '12', led, L('Downlights', 'Downlights')), line(fns.fan.id, 1, '75', null, L('Fan', 'Ventilator'))],
  }
  const names: Record<string, T> = {
    drawing: L('Drawing room', 'Salon'),
    dining: L('Dining room', 'Esszimmer'),
    kitchen: L('Kitchen', 'Küche'),
    lounge: L('TV lounge', 'TV-Lounge'),
    master: L('Master bedroom', 'Elternschlafzimmer'),
    bedroom: L('Children’s room', 'Kinderzimmer'),
    guest: L('Guest room', 'Gästezimmer'),
    family: L('Family lounge', 'Familienwohnzimmer'),
  }
  for (const [key, lines] of Object.entries(templates)) {
    await post('/api/room-templates', { key: `${key}_${tag}`, name: names[key], isActive: true, lines })
  }
  return { products, templates, names, fns, types: [hdl.id, knx.id, zigbee.id] }
}

export type Catalog = Awaited<ReturnType<typeof catalog>>

/** The villa: Ground and First floor with four rooms each, a main board, one HDL and one KNX line and Zigbee. */
export async function villa(api: Api, cat: Catalog, lang: Lang, name: string, { knx = false }: { knx?: boolean } = {}) {
  const post = async <R = Named,>(path: string, data: object) => json<R>(await api.ctx.post(path, { data }))
  const { products, templates, names } = cat
  const project = await post<{ id: string; number: string; name: string; versions: { id: string }[] }>('/api/projects', {
    name: unique(name),
    language: lang,
    productTypeIds: cat.types,
    customer: { name: 'Ahmed Raza', address: lang === 'en' ? '14 Main Boulevard\nGulberg III, Lahore' : 'Main Boulevard 14\nGulberg III, Lahore' },
  })
  const version = project.versions[0].id
  const floors = [
    { name: lang === 'en' ? 'Ground floor' : 'Erdgeschoss', rooms: ['drawing', 'dining', 'kitchen', 'lounge'] },
    { name: lang === 'en' ? 'First floor' : 'Obergeschoss', rooms: ['master', 'bedroom', 'guest', 'family'] },
  ]
  const boxes = [rect(40, 40, 580, 380), rect(620, 40, 1160, 380), rect(40, 420, 580, 760), rect(620, 420, 1160, 760)]
  const colors = ['#22c55e', '#3b82f6', '#f59e0b', '#a855f7']
  const placed = (key: string, x: number, y: number, label = '') => ({ id: crypto.randomUUID(), variantId: products[key].variantId, x, y, label })
  const devices = [
    [placed('panel', 300, 80), placed('presence', 900, 200), placed('touch', 900, 80), placed('panel', 300, 460), placed('presence', 900, 600), placed('thermostat', 980, 600)],
    [placed('presence', 300, 200), placed('thermostat', 380, 200), placed('gateway', 900, 80, 'GW1'), placed('gateway', 1100, 700, 'GW2'), placed('presence', 900, 600), placed('bulb', 860, 200), placed('bulb', 940, 200), placed('sensor', 300, 600)],
  ]
  const plans: { id: string; name: string; zones: { id: string; key: string }[]; content: Parameters<Api['savePlanContent']>[1] }[] = []
  for (const [i, floor] of floors.entries()) {
    const plan = await api.createPlan(version, floor.name, planImage())
    const zones = floor.rooms.map((key, z) => ({ id: crypto.randomUUID(), key, name: names[key][lang], color: colors[z], opacity: 0.25, points: boxes[z] }))
    const needs = zones.flatMap((z) => templates[z.key].map((l) => ({ id: crypto.randomUUID(), zoneId: z.id, ...l })))
    const content = { zones: zones.map((z) => ({ id: z.id, name: z.name, color: z.color, opacity: z.opacity, points: z.points })), placements: devices[i], needs }
    await api.savePlanContent(plan.id, content)
    plans.push({ id: plan.id, name: floor.name, zones, content })
  }

  const board = await post<{ id: string }>(`/api/versions/${version}/boards`, { name: lang === 'en' ? 'Main board' : 'Hauptverteiler', rows: [{ capacityTe: 24 }, { capacityTe: 16 }, ...(knx ? [{ capacityTe: 20 }] : [])] })
  await json(await api.ctx.post(`/api/plans/${board.id}/lock`))
  const content = await json<{ contentUpdatedAt: string; rows: { id: string; capacityTe: number }[] }>(await api.ctx.get(`/api/plans/${board.id}/board`))
  const [r1, r2, r3] = content.rows
  const mod = (key: string, rowId: string, offsetTe: number, label: string) => ({ id: crypto.randomUUID(), variantId: products[key].variantId, rowId, offsetTe, label, existing: false, addonVariantIds: [], instanceValues: {} })
  const modules = [
          mod('hdlPsu', r1.id, 0, 'PS1'),
          mod('dimmer', r1.id, 4, 'D1'),
          mod('dimmer', r1.id, 10, 'D2'),
          mod('dry', r1.id, 16, 'B1'),
          // Row 2 holds 18 TE on a 16 TE rail (board_row_over_capacity).
          mod('relay', r2.id, 0, 'Q1'),
          mod('curtain', r2.id, 12, 'C1'),
          mod('knxPsu', r2.id, 16, 'PS2'),
          // Row 3 (KNX actuators, 12 of 20 TE): the labels continue with free TE only.
          ...(knx ? [mod('knxRelay', r3.id, 0, 'Q2'), mod('knxDimmer', r3.id, 8, 'D3')] : []),
  ]
  await json(
    await api.ctx.put(`/api/plans/${board.id}/board`, {
      data: {
        expectedContentUpdatedAt: content.contentUpdatedAt,
        enclosureVariantId: null,
        rows: content.rows.map((r) => ({ id: r.id, capacityTe: r.capacityTe })),
        modules,
      },
    }),
  )
  await api.ctx.delete(`/api/plans/${board.id}/lock`)
  return { project, version, plans, board, modules }
}

/** Auto-connects the whole version through the API (as the dialog does). */
export async function autoConnect(api: Api, versionId: string) {
  const preview = await json<{ checksum: string }>(await api.ctx.post(`/api/versions/${versionId}/auto-connect/preview`, { data: { scope: 'all' } }))
  await json(await api.ctx.post(`/api/versions/${versionId}/auto-connect/apply`, { data: { scope: 'all', expectedChecksum: preview.checksum } }))
}

export async function complete(api: Api, projectId: string, name: string) {
  const current = await json<{ updatedAt: string }>(await api.ctx.get(`/api/projects/${projectId}`))
  await json(await api.ctx.put(`/api/projects/${projectId}`, { data: { name, status: 'completed', expectedUpdatedAt: current.updatedAt } }))
}

