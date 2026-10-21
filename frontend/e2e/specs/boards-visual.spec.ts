import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { type Api, expect, test, unique, uniqueKey } from '../fixtures'

// The board editor, the Add board dialog, board cards and the Networks tab
// (step 3c) at phone, tablet and desktop width, light and dark, English and
// German: nothing overflows the viewport (D107). Screenshots land in
// e2e/screenshots/boards-*.png. Tagged @visual: it runs with `make e2e-visual`.

const assets = join(import.meta.dirname, '../assets')
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 }, wide: false },
  { name: 'tablet', size: { width: 768, height: 1024 }, wide: true },
  { name: 'desktop', size: { width: 1280, height: 800 }, wide: true },
]

const labels = {
  en: { addBoard: 'Add board', saved: 'Saved', board: 'Board', inspector: 'Inspector', networks: 'Networks', lineOf: 'Line of', boardName: 'Main distribution board' },
  de: { addBoard: 'Verteiler hinzufügen', saved: 'Gespeichert', board: 'Verteiler', inspector: 'Details', networks: 'Netzwerke', lineOf: 'Linie von', boardName: 'Hauptverteiler im Keller' },
}
type Lang = keyof typeof labels

async function json<T>(res: Awaited<ReturnType<Api['ctx']['get']>>): Promise<T> {
  expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

type Named = { id: string; key: string }
const L = (en: string, de: string) => ({ en, de })

/**
 * A realistic HDL Buspro + KNX + Zigbee project: a floorplan with Zigbee
 * gateways and devices and KNX/HDL bus devices; a main board (enclosure
 * 3 rows × 18 TE, marked existing) with power supplies, dimmer, relay with
 * the blind alternative, blind actuators (one existing, one overlapping
 * after a catalog width change), a dry-contact input, a module of unknown
 * width, a floorplan product on the board and an overflowing row; a sub-board
 * whose enclosure was deleted from the catalog; a manual board; a second KNX
 * line with a pinned member; a Zigbee device pinned to the second gateway;
 * and a completed (read-only) project with a board.
 */
async function seed(api: Api, lang: Lang) {
  const tag = uniqueKey('').replace(/^_+/, '').slice(-5)
  const post = async <T = Named,>(path: string, data: object) => json<T>(await api.ctx.post(path, { data }))
  const kinds = Object.fromEntries(
    (await json<{ items: Named[] }>(await api.ctx.get('/api/output-kinds', { params: { includeInactive: true } }))).items.map((k) => [k.key, k]),
  )
  const loads = Object.fromEntries((await json<{ items: Named[] }>(await api.ctx.get('/api/load-types', { params: { includeInactive: true } }))).items.map((k) => [k.key, k]))

  const type = (key: string, name: string, abbreviation: string, color: string, extra: object) =>
    post('/api/product-types', { key: `${key}_${tag}`, name: { en: name }, abbreviation, color, isActive: true, ...extra })
  const knx = await type('knx', 'KNX', 'KNX', '#0f766e', { topology: 'bus', defaultBusCurrentMa: 10, busDevicesMax: 64 })
  const hdl = await type('hdl', 'HDL Buspro', 'HDL', '#1d4ed8', { topology: 'bus', busDevicesMax: 64 })
  const zigbee = await type('zigbee', 'Zigbee', 'ZB', '#7c3aed', { topology: 'wireless', defaultWirelessPlacesUsed: 1 })
  const inst = await type('inst', 'Installation', 'INST', '#475569', { topology: 'none' })

  const field = async (key: string, label: { en: string; de: string }, typ: string, extra: object = {}) => ({
    ...(await post('/api/catalog-fields', { key: `${key}_${tag}`, label, type: typ, ...extra })),
    label,
    type: typ,
  })
  const f = {
    width: await field('width', L('Width', 'Breite'), 'number', { unit: 'TE', meaning: 'rail_width_te' }),
    rows: await field('enc_rows', L('Rows', 'Reihen'), 'integer', { meaning: 'enclosure_rows' }),
    perRow: await field('enc_te', L('TE per row', 'TE je Reihe'), 'number', { unit: 'TE', meaning: 'enclosure_te_per_row' }),
    busMa: await field('bus_ma', L('Bus current', 'Busstrom'), 'integer', { unit: 'mA', meaning: 'bus_current_used_ma' }),
    supplyMa: await field('supply_ma', L('Bus current output', 'Busstrom-Ausgang'), 'integer', { unit: 'mA', meaning: 'bus_current_supplied_ma' }),
    places: await field('places', L('Device places', 'Geräteplätze'), 'integer', { meaning: 'wireless_places_supplied' }),
    dimmerCh: await field('dimmer_ch', L('Dimmer channels', 'Dimmerkanäle'), 'integer', { meaning: 'channels_supplied', outputKindId: kinds.dimmer_output.id }),
    ledW: await field('led_w', L('LED load per channel', 'LED-Last je Kanal'), 'number', { unit: 'W', meaning: 'channel_limit_w', outputKindId: kinds.dimmer_output.id, loadTypeId: loads.led.id }),
    relayCh: await field('relay_ch', L('Switching channels', 'Schaltkanäle'), 'integer', { meaning: 'channels_supplied', outputKindId: kinds.relay_output.id }),
    relayA: await field('relay_a', L('Current per channel', 'Strom je Kanal'), 'number', { unit: 'A', meaning: 'channel_limit_a', outputKindId: kinds.relay_output.id }),
    blindOk: await field('blind_ok', L('Pairs as blind outputs', 'Paare als Jalousieausgänge'), 'boolean', { meaning: 'alternative_allowed', outputKindId: kinds.blind_output.id }),
    blindCh: await field('blind_ch', L('Blind channels', 'Jalousiekanäle'), 'integer', { meaning: 'channels_supplied', outputKindId: kinds.blind_output.id }),
  }
  const attrs = Object.values(f).map((x) => ({ key: x.key, fieldKey: x.key, label: x.label, type: x.type, scope: 'product' }))
  const category = (key: string, name: { en: string; de: string }, mounting: string) =>
    post('/api/categories', { key: `${key}_${tag}`, name, mounting, isActive: true, attributes: attrs, instanceAttributes: [] })
  const actuators = await category('actuators', L('Actuators', 'Aktoren'), 'board')
  const supplies = await category('supplies', L('Power supplies', 'Spannungsversorgungen'), 'board')
  const enclosures = await category('enclosures', L('Distribution boards', 'Verteilergehäuse'), 'board')
  const floor = await category('floor', L('Room devices', 'Raumgeräte'), 'floorplan')

  const products: Record<string, { productId: string; variantId: string; name: string }> = {}
  const product = async (key: string, t: Named, c: Named, name: { en: string; de: string }, values: Record<string, number | boolean>) => {
    const attributes = Object.fromEntries(Object.entries(values).map(([k, v]) => [f[k as keyof typeof f].key, v]))
    const p = await post<Named & { variants: { id: string }[] }>('/api/products', { productTypeId: t.id, categoryId: c.id, modelNumber: uniqueKey(key.slice(0, 4)).toUpperCase(), name, isActive: true, attributes, firstVariant: { name: L('Standard', 'Standard'), price: '120.00' } })
    products[key] = { productId: p.id, variantId: p.variants[0].id, name: name[lang] }
    return products[key]
  }
  await product('enclosure', inst, enclosures, L('Surface-mounted enclosure 3 rows × 18 TE', 'Aufputz-Verteiler 3-reihig 18 TE'), { rows: 3, perRow: 18 })
  await product('subEnclosure', inst, enclosures, L('Small enclosure 2 rows × 12 TE', 'Kleinverteiler 2-reihig 12 TE'), { rows: 2, perRow: 12 })
  await product('knxPsu', knx, supplies, L('KNX power supply 640 mA', 'KNX Spannungsversorgung 640 mA'), { width: 4, supplyMa: 640 })
  await product('hdlPsu', hdl, supplies, L('HDL Buspro power supply 2400 mA', 'HDL Buspro Netzteil 2400 mA'), { width: 4, supplyMa: 2400 })
  await product('dimmer', hdl, actuators, L('HDL dimmer 6-channel 1 A', 'HDL Dimmaktor 6-fach 1 A'), { width: 6, dimmerCh: 6, ledW: 150, busMa: 30 })
  await product('relay', knx, actuators, L('KNX switch actuator 12-fold 16 A with blind mode', 'KNX Schaltaktor 12-fach 16 A mit Jalousiebetrieb'), { width: 12, relayCh: 12, relayA: 16, blindOk: true, busMa: 12 })
  await product('blind', knx, actuators, L('KNX blind actuator 4-fold', 'KNX Jalousieaktor 4-fach'), { width: 4, blindCh: 4, busMa: 10 })
  await product('dry', hdl, actuators, L('HDL dry contact input 4-zone', 'HDL Binäreingang 4-fach'), { width: 2 })
  await product('router', knx, actuators, L('KNX IP router', 'KNX IP-Router'), { busMa: 10 })
  await product('presence', knx, floor, L('KNX presence detector', 'KNX Präsenzmelder'), { busMa: 10 })
  await product('panel', hdl, floor, L('HDL Granite panel 4-button', 'HDL Granite Taster 4-fach'), {})
  await product('gateway', zigbee, floor, L('Zigbee gateway', 'Zigbee-Gateway'), { places: 64 })
  await product('bulb', zigbee, floor, L('Zigbee bulb E27', 'Zigbee Leuchtmittel E27'), {})
  await product('sensor', zigbee, floor, L('Zigbee door sensor', 'Zigbee Türkontakt'), {})

  const types = [knx.id, hdl.id, zigbee.id, inst.id]
  const project = await api.createProject({ name: unique(lang === 'en' ? 'Villa Sommer' : 'Villa Sommerfeld'), productTypeIds: types })
  const version = project.versions[0].id
  const fp = await api.createPlan(version, lang === 'en' ? 'Ground floor' : 'Erdgeschoss', planImage())
  await api.savePlanContent(fp.id, {
    placements: [
      { variantId: products.gateway.variantId, x: 120, y: 100 },
      { variantId: products.gateway.variantId, x: 700, y: 120 },
      { variantId: products.bulb.variantId, x: 300, y: 300 },
      { variantId: products.bulb.variantId, x: 340, y: 300 },
      { variantId: products.sensor.variantId, x: 650, y: 400 },
      { variantId: products.presence.variantId, x: 200, y: 200 },
      { variantId: products.presence.variantId, x: 500, y: 200 },
      { variantId: products.panel.variantId, x: 420, y: 420 },
    ],
  })

  const board = async (name: string, data: object) => post<{ id: string }>(`/api/versions/${version}/boards`, { name, ...data })
  const putBoard = async (planId: string, build: (rows: { id: string; capacityTe: number }[]) => { modules: object[]; extra?: object }) => {
    await json(await api.ctx.post(`/api/plans/${planId}/lock`))
    const content = await json<{ contentUpdatedAt: string; enclosureVariantId: string | null; rows: { id: string; capacityTe: number }[] }>(await api.ctx.get(`/api/plans/${planId}/board`))
    const b = build(content.rows)
    await json(
      await api.ctx.put(`/api/plans/${planId}/board`, {
        data: { expectedContentUpdatedAt: content.contentUpdatedAt, enclosureVariantId: content.enclosureVariantId, rows: content.rows.map((r) => ({ id: r.id, capacityTe: r.capacityTe })), modules: b.modules, ...b.extra },
      }),
    )
    await api.ctx.delete(`/api/plans/${planId}/lock`)
  }
  const mod = (key: string, rowId: string, offsetTe: number, label = '', existing = false) => ({
    id: crypto.randomUUID(),
    variantId: products[key].variantId,
    rowId,
    offsetTe,
    label,
    existing,
    addonVariantIds: [],
    instanceValues: {},
  })

  const main = await board(labels[lang].boardName, { enclosureVariantId: products.enclosure.variantId })
  let relay2 = ''
  await putBoard(main.id, ([r1, r2, r3]) => {
    const r = mod('relay', r3.id, 9, 'Q3')
    relay2 = r.id
    return {
      extra: { enclosureExisting: true },
      modules: [
        mod('knxPsu', r1.id, 0, 'PS1'),
        mod('router', r1.id, 4),
        mod('relay', r1.id, 5, 'Q1'),
        mod('hdlPsu', r2.id, 0, 'PS2'),
        mod('dimmer', r2.id, 4, 'D1'),
        mod('dimmer', r2.id, 10, 'D2'),
        mod('dry', r2.id, 16),
        mod('blind', r3.id, 0, 'J1', true),
        mod('blind', r3.id, 4, 'J2'),
        mod('presence', r3.id, 8),
        r,
      ],
    }
  })
  // The catalog widens the blind actuator after the board was saved: J1 and J2 now overlap (D374).
  const blind = await api.product(products.blind.productId)
  await api.updateProduct(products.blind.productId, { attributes: { ...blind.attributes, [f.width.key]: 6 } })

  const sub = await board(lang === 'en' ? 'Garage sub-board' : 'Unterverteiler Garage', { enclosureVariantId: products.subEnclosure.variantId })
  await putBoard(sub.id, ([r1]) => ({ modules: [mod('relay', r1.id, 0, 'Q10')] }))
  const del = await api.ctx.delete(`/api/products/${products.subEnclosure.productId}`)
  expect(del.ok(), await del.text()).toBe(true)
  await board(lang === 'en' ? 'Attic' : 'Dachboden', { rows: [{ capacityTe: 12 }, { capacityTe: 12 }] })

  // Networks: a second KNX line with the row 3 relay pinned to it; a Zigbee bulb pinned to the second gateway.
  const line = await post('/api/versions/' + version + '/bus-lines', { productTypeId: knx.id, name: 'KNX 1.2', address: '1.2', devicesMax: 32 })
  const fpContent = await json<{ placements: { id: string; variantId: string }[] }>(await api.ctx.get(`/api/plans/${fp.id}/content`))
  const gateways = fpContent.placements.filter((p) => p.variantId === products.gateway.variantId)
  const bulb = fpContent.placements.find((p) => p.variantId === products.bulb.variantId)!
  await json(
    await api.ctx.put(`/api/versions/${version}/network-assignments`, {
      data: {
        assignments: [
          { planId: main.id, itemId: relay2, busLineId: line.id },
          { planId: fp.id, itemId: bulb.id, gatewayPlanId: fp.id, gatewayItemId: gateways[1].id },
        ],
      },
    }),
  )

  // A completed project (read-only) with a board.
  const done = await api.createProject({ name: unique(lang === 'en' ? 'Completed Meyer' : 'Abgeschlossen Meier'), productTypeIds: types })
  const doneVersion = done.versions[0].id
  const doneBoard = await post<{ id: string }>(`/api/versions/${doneVersion}/boards`, { name: labels[lang].boardName, rows: [{ capacityTe: 18 }, { capacityTe: 18 }] })
  await putBoard(doneBoard.id, ([r1, r2]) => ({ modules: [mod('knxPsu', r1.id, 0, 'PS1'), mod('relay', r1.id, 4, 'Q1'), mod('dimmer', r2.id, 0, 'D1')] }))
  const current = await json<{ updatedAt: string }>(await api.ctx.get(`/api/projects/${done.id}`))
  await json(await api.ctx.put(`/api/projects/${done.id}`, { data: { name: done.name, status: 'completed', expectedUpdatedAt: current.updatedAt } }))

  return { project, version, board: main, sub, done, doneVersion, doneBoard, products }
}

for (const lang of ['en', 'de'] as const) {
  test(`boards and networks fit the screen: ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
    test.setTimeout(600_000)
    const l = labels[lang]
    const s = await seed(api, lang)
    const editor = `/projects/${s.project.id}/versions/${s.version}/boards/${s.board.id}`
    const tab = (p: Page, name: string) => p.getByRole('tab', { name, exact: true }).click()

    const subEditor = `/projects/${s.project.id}/versions/${s.version}/boards/${s.sub.id}`
    const doneEditor = `/projects/${s.done.id}/versions/${s.doneVersion}/boards/${s.doneBoard.id}`
    const select = async (p: Page, label: string) => {
      await p.getByRole('button', { name: new RegExp(`^.*, ${label}, `) }).click()
      await expect(p.getByRole('tab', { name: l.inspector, exact: true })).toHaveAttribute('aria-selected', 'true')
    }

    type Step = { name: string; path: () => string; wide?: boolean; editor?: boolean; readOnly?: boolean; fullPage?: boolean; act?: (p: Page) => Promise<void> }
    const steps: Step[] = [
      { name: 'plan-cards', path: () => `/projects/${s.project.id}`, fullPage: true },
      {
        name: 'add-board',
        path: () => `/projects/${s.project.id}`,
        act: async (p) => {
          await p.getByRole('button', { name: l.addBoard }).click()
          await expect(p.getByRole('dialog')).toBeVisible()
        },
      },
      {
        name: 'add-board-enclosure',
        path: () => `/projects/${s.project.id}`,
        act: async (p) => {
          await p.getByRole('button', { name: l.addBoard }).click()
          const dialog = p.getByRole('dialog')
          await dialog.getByRole('combobox').click()
          await p.getByRole('option', { name: new RegExp(s.products.enclosure.name.slice(0, 12)) }).click()
          await expect(dialog.getByText(lang === 'en' ? '3 rows × 18 TE' : '3 Reihen × 18 TE', { exact: true })).toBeVisible()
        },
      },
      { name: 'editor', path: () => editor, editor: true },
      { name: 'editor-board-tab', path: () => editor, editor: true, wide: true, act: (p) => tab(p, l.board) },
      { name: 'editor-inspector', path: () => editor, editor: true, wide: true, act: (p) => select(p, 'Q1') },
      { name: 'editor-inspector-dimmer', path: () => editor, editor: true, wide: true, act: (p) => select(p, 'D1') },
      { name: 'editor-overlap', path: () => editor, editor: true, wide: true, act: (p) => select(p, 'J2') },
      {
        name: 'editor-focus',
        path: () => editor,
        editor: true,
        wide: true,
        act: async (p) => {
          await p.getByRole('button', { name: /^.*, D2, / }).focus()
        },
      },
      { name: 'editor-deleted-enclosure', path: () => subEditor, editor: true, wide: true, act: (p) => tab(p, l.board) },
      { name: 'networks', path: () => `/projects/${s.project.id}?tab=networks`, fullPage: true },
      {
        name: 'networks-reassign',
        path: () => `/projects/${s.project.id}?tab=networks`,
        wide: true,
        act: async (p) => {
          await p.getByRole('combobox', { name: new RegExp(`^${l.lineOf} ${s.products.relay.name}`) }).first().click()
          await expect(p.getByRole('option').first()).toBeVisible()
        },
      },
      { name: 'readonly-editor', path: () => doneEditor, editor: true, readOnly: true },
      { name: 'readonly-networks', path: () => `/projects/${s.done.id}?tab=networks`, fullPage: true },
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
          if (step.editor && viewport.wide && !step.readOnly) await expect(page.getByText(l.saved, { exact: true })).toBeVisible()
          await page.waitForLoadState('networkidle')
          if (step.act) await step.act(page)
          await page.waitForTimeout(300)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/boards-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          await page.keyboard.press('Escape')
        }
      }
    }
  })
}
