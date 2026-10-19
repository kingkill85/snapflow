import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { type Api, expect, test, unique, uniqueKey } from '../fixtures'

// The Checks tab, the auto-connect dialog, the connect picker (need and
// channel mode), the board inspector's channel list, the floorplan zone
// statuses, the Networks statuses and a read-only project (step 3d) at phone,
// tablet and desktop width, light and dark, English and German: nothing
// overflows the viewport (D107). Seed: an HDL Buspro villa in Lahore with one
// KNX line and Zigbee (D417). Screenshots land in
// e2e/screenshots/connections-*.png. Tagged @visual.

const assets = join(import.meta.dirname, '../assets')
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 }, wide: false },
  { name: 'tablet', size: { width: 768, height: 1024 }, wide: true },
  { name: 'desktop', size: { width: 1280, height: 800 }, wide: true },
]

const labels = {
  en: {
    auto: 'Auto-connect…',
    preview: 'Preview',
    apply: 'Apply',
    undo: 'Undo auto-connect',
    inspector: 'Inspector',
    zones: 'Zones',
    saved: 'Saved',
    connectChannel: /^Connect a need to /,
  },
  de: {
    auto: 'Automatisch verbinden…',
    preview: 'Vorschau',
    apply: 'Übernehmen',
    undo: 'Automatisches Verbinden rückgängig',
    inspector: 'Eigenschaften',
    zones: 'Zonen',
    saved: 'Gespeichert',
    connectChannel: /^Bedarf mit .* verbinden$/,
  },
}
type Lang = keyof typeof labels

const L = (en: string, de: string) => ({ en, de })
type T = ReturnType<typeof L>
type Named = { id: string; key: string }

async function json<R>(res: Awaited<ReturnType<Api['ctx']['get']>>): Promise<R> {
  expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true)
  return (await res.json()) as R
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
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
async function catalog(api: Api, lang: Lang) {
  const tag = uniqueKey('').replace(/^_+/, '').slice(-5)
  const post = async <R = Named,>(path: string, data: object) => json<R>(await api.ctx.post(path, { data }))
  const loads = Object.fromEntries((await json<{ items: Named[] }>(await api.ctx.get('/api/load-types', { params: { includeInactive: true } }))).items.map((k) => [k.key, k]))

  const fn = (key: string, name: T, allowsCircuit: boolean, loadTypeIds: string[] = []) =>
    post('/api/function-types', { key: `${key}_${tag}`, name, allowsCircuit, loadTypeIds })
  const fns = {
    dimmable: await fn('dimmable', L('Dimmable light', 'Dimmbares Licht'), true, [loads.led.id, loads.halogen.id]),
    switched: await fn('switched', L('Switched light', 'Geschaltetes Licht'), true, [loads.led.id]),
    socket: await fn('socket', L('Switched socket', 'Geschaltete Steckdose'), true, [loads.resistive.id]),
    blind: await fn('blind', L('Blind', 'Jalousie'), false, [loads.ac_motor.id, loads.dc_motor.id]),
    curtain: await fn('curtain', L('Curtain', 'Vorhang'), false, [loads.ac_motor.id, loads.dc_motor.id]),
    button: await fn('button', L('Pushbutton', 'Taster'), false, [loads.pushbutton.id]),
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
  await product('presence', knx, room, L('KNX presence detector', 'KNX Präsenzmelder'), { busMa: 12 })
  await product('touch', knx, room, L('KNX touch panel 4.3"', 'KNX Touchpanel 4,3"'), { busMa: 45 })
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

type Catalog = Awaited<ReturnType<typeof catalog>>

/** The villa: Ground and First floor with four rooms each, a main board, one HDL and one KNX line and Zigbee. */
async function villa(api: Api, cat: Catalog, lang: Lang, name: string) {
  const post = async <R = Named,>(path: string, data: object) => json<R>(await api.ctx.post(path, { data }))
  const { products, templates, names } = cat
  const project = await api.createProject({ name: unique(name), productTypeIds: cat.types })
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
    const content = { zones: zones.map(({ key: _, ...z }) => z), placements: devices[i], needs }
    await api.savePlanContent(plan.id, content)
    plans.push({ id: plan.id, name: floor.name, zones, content })
  }

  const board = await post<{ id: string }>(`/api/versions/${version}/boards`, { name: lang === 'en' ? 'Main board' : 'Hauptverteiler', rows: [{ capacityTe: 24 }, { capacityTe: 16 }] })
  await json(await api.ctx.post(`/api/plans/${board.id}/lock`))
  const content = await json<{ contentUpdatedAt: string; rows: { id: string; capacityTe: number }[] }>(await api.ctx.get(`/api/plans/${board.id}/board`))
  const [r1, r2] = content.rows
  const mod = (key: string, rowId: string, offsetTe: number, label: string) => ({ id: crypto.randomUUID(), variantId: products[key].variantId, rowId, offsetTe, label, existing: false, addonVariantIds: [], instanceValues: {} })
  await json(
    await api.ctx.put(`/api/plans/${board.id}/board`, {
      data: {
        expectedContentUpdatedAt: content.contentUpdatedAt,
        enclosureVariantId: null,
        rows: content.rows.map((r) => ({ id: r.id, capacityTe: r.capacityTe })),
        modules: [
          mod('hdlPsu', r1.id, 0, 'PS1'),
          mod('dimmer', r1.id, 4, 'D1'),
          mod('dimmer', r1.id, 10, 'D2'),
          mod('dry', r1.id, 16, 'B1'),
          // Row 2 holds 18 TE on a 16 TE rail (board_row_over_capacity).
          mod('relay', r2.id, 0, 'Q1'),
          mod('curtain', r2.id, 12, 'C1'),
          mod('knxPsu', r2.id, 16, 'PS2'),
        ],
      },
    }),
  )
  await api.ctx.delete(`/api/plans/${board.id}/lock`)
  return { project, version, plans, board }
}

/** Auto-connects the whole version through the API (as the dialog does). */
async function autoConnect(api: Api, versionId: string) {
  const preview = await json<{ checksum: string }>(await api.ctx.post(`/api/versions/${versionId}/auto-connect/preview`, { data: { scope: 'all' } }))
  await json(await api.ctx.post(`/api/versions/${versionId}/auto-connect/apply`, { data: { scope: 'all', expectedChecksum: preview.checksum } }))
}

async function complete(api: Api, projectId: string, name: string) {
  const current = await json<{ updatedAt: string }>(await api.ctx.get(`/api/projects/${projectId}`))
  await json(await api.ctx.put(`/api/projects/${projectId}`, { data: { name, status: 'completed', expectedUpdatedAt: current.updatedAt } }))
}

for (const lang of ['en', 'de'] as const) {
  test(`connections and checks fit the screen: ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
    test.setTimeout(900_000)
    const l = labels[lang]
    const cat = await catalog(api, lang)
    const villaName = lang === 'en' ? 'Villa Gulberg, Lahore' : 'Villa Gulberg, Lahore'
    // Three villas: nothing connected; auto-connected and then changed; completed (read-only).
    const open = await villa(api, cat, lang, villaName)
    const done = await villa(api, cat, lang, villaName)
    const readOnly = await villa(api, cat, lang, villaName)
    await autoConnect(api, done.version)
    await autoConnect(api, readOnly.version)
    await complete(api, readOnly.project.id, readOnly.project.name)

    // After the auto-connect: the chandelier gets a bigger lamp (mixed LED + halogen circuit over the limit, D408) and
    // the first floor's second gateway is removed while a door sensor is pinned to it (dangling, D411).
    const [ground, first] = done.plans
    const placements = first.content.placements as { id: string; variantId: string; x: number; y: number }[]
    const gateways = placements.filter((p) => p.variantId === cat.products.gateway.variantId)
    const sensor = placements.find((p) => p.variantId === cat.products.sensor.variantId)!
    await json(
      await api.ctx.put(`/api/versions/${done.version}/network-assignments`, {
        data: { assignments: [{ planId: first.id, itemId: sensor.id, gatewayPlanId: first.id, gatewayItemId: gateways[1].id }] },
      }),
    )
    await api.savePlanContent(first.id, { ...first.content, placements: placements.filter((p) => p.id !== gateways[1].id) })
    await api.savePlanContent(ground.id, {
      ...ground.content,
      needs: ground.content.needs!.map((n) => (n.label === (lang === 'en' ? 'Chandelier' : 'Kronleuchter') ? { ...n, powerW: '200' } : n)),
    })

    const checks = (s: typeof open) => `/projects/${s.project.id}/versions/${s.version}?tab=checks`
    const board = (s: typeof open) => `/projects/${s.project.id}/versions/${s.version}/boards/${s.board.id}`
    const floor = (s: typeof open) => `/projects/${s.project.id}/versions/${s.version}/plans/${s.plans[0].id}`
    const selectModule = async (p: Page, label: string) => {
      await p.getByRole('button', { name: new RegExp(`^.*, ${label}, `) }).click()
      await expect(p.getByRole('tab', { name: l.inspector, exact: true })).toHaveAttribute('aria-selected', 'true')
    }
    const selectZone = async (p: Page, name: string) => {
      await p.getByRole('tab', { name: l.zones, exact: true }).click()
      await p.getByRole('tabpanel', { name: l.zones }).getByRole('button', { name, exact: true }).click()
    }
    const preview = async (p: Page) => {
      await p.getByRole('button', { name: l.auto }).click()
      const dialog = p.getByRole('dialog')
      await dialog.getByRole('button', { name: l.preview }).click()
      await expect(dialog.getByRole('status')).toBeVisible()
    }
    const unconnected = (needLabel: string) => async (p: Page) => {
      await p.getByRole('button', { name: new RegExp(`· ${needLabel}`) }).first().click()
      await expect(p.getByRole('dialog')).toBeVisible()
      await p.waitForLoadState('networkidle')
    }
    const de = lang === 'de'

    type Step = { name: string; path: () => string; wide?: boolean; editor?: boolean; readOnly?: boolean; fullPage?: boolean; act?: (p: Page) => Promise<void>; after?: (p: Page) => Promise<void> }
    const steps: Step[] = [
      { name: 'checks-missing', path: () => checks(open), fullPage: true },
      { name: 'auto-connect-preview', path: () => checks(open), act: preview },
      {
        name: 'checks-applied',
        path: () => checks(open),
        fullPage: true,
        act: async (p) => {
          await preview(p)
          await p.getByRole('dialog').getByRole('button', { name: l.apply }).click()
          await expect(p.getByRole('button', { name: l.undo })).toBeVisible()
          await p.waitForLoadState('networkidle')
        },
        after: async (p) => {
          await p.getByRole('button', { name: l.undo }).click()
          await expect(p.getByRole('button', { name: l.undo })).toBeHidden()
        },
      },
      { name: 'connect-picker-need', path: () => checks(open), act: unconnected(de ? 'Downlights' : 'Downlights') },
      { name: 'connect-picker-nothing-fits', path: () => checks(open), act: unconnected(de ? 'Warmwasserbereiter' : 'Water heater') },
      { name: 'checks-findings', path: () => checks(done), fullPage: true },
      { name: 'board-dimmer', path: () => board(done), editor: true, wide: true, act: (p) => selectModule(p, 'D1') },
      { name: 'board-relay-pairs', path: () => board(done), editor: true, wide: true, act: (p) => selectModule(p, 'Q1') },
      {
        name: 'connect-picker-channel',
        path: () => board(open),
        editor: true,
        wide: true,
        act: async (p) => {
          await selectModule(p, 'C1')
          await p.getByRole('region', { name: de ? 'Kanäle' : 'Channels' }).getByRole('button', { name: l.connectChannel }).first().click()
          await expect(p.getByRole('dialog')).toBeVisible()
          await p.waitForLoadState('networkidle')
        },
      },
      { name: 'floorplan-zones', path: () => floor(done), editor: true, wide: true, act: (p) => p.getByRole('tab', { name: l.zones, exact: true }).click() },
      { name: 'floorplan-zone-needs', path: () => floor(done), editor: true, wide: true, act: (p) => selectZone(p, cat.names.drawing[lang]) },
      { name: 'networks', path: () => `/projects/${done.project.id}?tab=networks`, fullPage: true },
      { name: 'readonly-checks', path: () => checks(readOnly), fullPage: true, readOnly: true },
      { name: 'readonly-board', path: () => board(readOnly), editor: true, wide: true, readOnly: true, act: (p) => selectModule(p, 'Q1') },
    ]

    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const step of steps) {
          if (step.wide && !viewport.wide) continue
          await page.goto(step.path())
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          if (step.editor && !step.readOnly) await expect(page.getByText(l.saved, { exact: true })).toBeVisible()
          await page.waitForLoadState('networkidle')
          if (step.act) await step.act(page)
          await page.waitForTimeout(300)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/connections-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          await page.keyboard.press('Escape')
          if (step.after) await step.after(page)
        }
      }
    }
  })
}
