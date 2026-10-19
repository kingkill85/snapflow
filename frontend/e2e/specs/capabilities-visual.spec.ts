import { type Page } from '@playwright/test'

import { type Api, expect, row, test, uniqueKey } from '../fixtures'

// Catalog capabilities (step 3a) at phone, tablet and desktop width, light and
// dark, English and German, with a realistic catalog: KNX, HDL and Zigbee with
// their system settings, the seeded output kinds and load types, a dozen
// catalog fields with meanings, categories linking them, products with values,
// and an import that asks what its new columns mean. Nothing may overflow the
// viewport; screenshots land in e2e/screenshots/cap3a-*.png for a look by eye.
// Tagged @visual: it runs with `make e2e-visual`, not in the default run (D107).

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'tablet', size: { width: 768, height: 1024 } },
  { name: 'desktop', size: { width: 1280, height: 800 } },
]

type Lang = 'en' | 'de'
type Named = { id: string; key: string; updatedAt: string; allowsCircuit?: boolean }
const L = (en: string, de: string) => ({ en, de })

async function json<T>(res: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<unknown> }): Promise<T> {
  expect(res.ok(), await res.text()).toBe(true)
  return (await res.json()) as T
}

async function list<T extends { key: string }>(api: Api, path: string): Promise<T[]> {
  return (await json<{ items: T[] }>(await api.ctx.get(path, { params: { includeInactive: true } }))).items
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

async function seed(api: Api) {
  const tag = uniqueKey('').replace(/^_+/, '').slice(-5)
  const loads = Object.fromEntries((await list<Named>(api, '/api/load-types')).map((l) => [l.key, l]))
  const kinds = Object.fromEntries((await list<Named & { name: object; isActive: boolean }>(api, '/api/output-kinds')).map((k) => [k.key, k]))

  // Function types with their capability flags.
  const fn = async (key: string, name: { en: string; de: string }, allowsCircuit: boolean, loadKeys: string[]) =>
    json<Named>(await api.ctx.post('/api/function-types', { data: { key: `${key}_${tag}`, name, allowsCircuit, loadTypeIds: loadKeys.map((k) => loads[k].id) } }))
  const dimmer = await fn('dimmer', L('Dimmable light', 'Dimmbares Licht'), true, ['resistive', 'led', 'halogen'])
  expect(dimmer).toMatchObject({ allowsCircuit: true })
  const switching = await fn('switching', L('Switched light', 'Geschaltetes Licht'), true, [])
  const blind = await fn('blind', L('Blind', 'Jalousie'), false, ['ac_motor', 'dc_motor'])

  // Output kinds: served function types; relay outputs act as blind outputs in pairs, dimmer outputs as relay outputs.
  const kind = async (key: string, functionTypeIds: string[], alternatives: { outputKindId: string; count: number }[]) => {
    const k = kinds[key]
    await json(await api.ctx.put(`/api/output-kinds/${k.id}`, { data: { key, name: k.name, isActive: true, functionTypeIds, alternatives, expectedUpdatedAt: k.updatedAt } }))
  }
  await kind('dimmer_output', [dimmer.id, switching.id], [])
  await kind('relay_output', [switching.id], [{ outputKindId: kinds.dimmer_output.id, count: 1 }])
  await kind('blind_output', [blind.id], [{ outputKindId: kinds.relay_output.id, count: 2 }])

  // Systems.
  const type = async (key: string, name: string, abbreviation: string, color: string, extra: object) =>
    json<Named>(await api.ctx.post('/api/product-types', { data: { key: `${key}_${tag}`, name: { en: name }, abbreviation, color, isActive: true, ...extra } }))
  const knx = await type('knx', 'KNX', 'KNX', '#0f766e', { topology: 'bus', defaultBusCurrentMa: 10, busDevicesMax: 64, reservePercent: 20 })
  const hdl = await type('hdl', 'HDL Buspro', 'HDL', '#1d4ed8', { topology: 'bus', defaultBusCurrentMa: 15, reservePercent: 25 })
  const zigbee = await type('zigbee', 'Zigbee', 'ZB', '#7c3aed', { topology: 'wireless', defaultWirelessPlacesUsed: 1, reservePercent: 20 })
  const general = await type('installation', L('Installation material', 'Installationsmaterial').en, 'INST', '#475569', { topology: 'none' })

  // Catalog fields.
  const field = async (key: string, label: { en: string; de: string }, typ: string, extra: object = {}) =>
    json<Named>(await api.ctx.post('/api/catalog-fields', { data: { key: `${key}_${tag}`, label, type: typ, ...extra } }))
  const f = {
    dimmerChannels: await field('dimmer_channels', L('Dimmer channels', 'Dimmerkanäle'), 'integer', { meaning: 'channels_supplied', outputKindId: kinds.dimmer_output.id }),
    relayChannels: await field('switch_channels', L('Switching channels', 'Schaltkanäle'), 'integer', { meaning: 'channels_supplied', outputKindId: kinds.relay_output.id }),
    ledW: await field('dimmer_led_w', L('Max. LED load per channel', 'Max. LED-Last je Kanal'), 'number', {
      unit: 'W',
      meaning: 'channel_limit_w',
      outputKindId: kinds.dimmer_output.id,
      loadTypeId: loads.led.id,
      etimFeature: 'EF000040',
    }),
    halogenW: await field('dimmer_halogen_w', L('Max. halogen load per channel', 'Max. Halogenlast je Kanal'), 'number', {
      unit: 'W',
      meaning: 'channel_limit_w',
      outputKindId: kinds.dimmer_output.id,
      loadTypeId: loads.halogen.id,
    }),
    relayA: await field('switch_current_a', L('Rated current per channel', 'Nennstrom je Kanal'), 'number', { unit: 'A', meaning: 'channel_limit_a', outputKindId: kinds.relay_output.id }),
    moduleA: await field('module_current_a', L('Total current of the module', 'Summenstrom des Moduls'), 'number', { unit: 'A', meaning: 'module_total_a' }),
    blindMode: await field('blind_mode', L('Channel pairs usable as blind outputs', 'Kanalpaare als Jalousieausgänge nutzbar'), 'boolean', {
      meaning: 'alternative_allowed',
      outputKindId: kinds.blind_output.id,
    }),
    motor: await field('motor_type', L('Motor type', 'Motortyp'), 'enum', {
      meaning: 'motor_type',
      options: [
        { key: 'ac', label: L('AC motor', 'AC-Motor') },
        { key: 'dc', label: L('DC motor', 'DC-Motor') },
      ],
    }),
    busMa: await field('bus_current_ma', L('Bus current consumption', 'Busstromaufnahme'), 'integer', { unit: 'mA', meaning: 'bus_current_used_ma', productTypeIds: [knx.id, hdl.id] }),
    supplyMa: await field('bus_supply_ma', L('Bus current output', 'Busstrom-Ausgang'), 'integer', { unit: 'mA', meaning: 'bus_current_supplied_ma' }),
    width: await field('width_te', L('Width', 'Breite'), 'integer', { unit: 'TE', meaning: 'rail_width_te' }),
    rows: await field('enclosure_rows', L('Rows', 'Reihen'), 'integer', { meaning: 'enclosure_rows' }),
    perRow: await field('te_per_row', L('Modules per row', 'Teilungseinheiten je Reihe'), 'integer', { unit: 'TE', meaning: 'enclosure_te_per_row' }),
    router: await field('zigbee_router', L('Zigbee router', 'Zigbee-Router'), 'boolean', { meaning: 'zigbee_router', productTypeIds: [zigbee.id] }),
    ip: await field('ip_rating', L('IP rating', 'Schutzart'), 'text', { etimFeature: 'EF005474' }),
  }

  // Categories linking the fields (and one attribute without a link).
  const attr = (fl: Named, label: { en: string; de: string }, typ: string, extra: object = {}) => ({ key: fl.key, fieldKey: fl.key, label, type: typ, scope: 'product', ...extra })
  const category = async (key: string, name: { en: string; de: string }, mounting: string, attributes: object[]) =>
    json<Named>(await api.ctx.post('/api/categories', { data: { key: `${key}_${tag}`, name, mounting, isActive: true, attributes, instanceAttributes: [] } }))
  const dimmers = await category('dimming_actuators', L('Dimming actuators', 'Dimmaktoren'), 'board', [
    attr(f.dimmerChannels, L('Channels', 'Kanäle'), 'integer'),
    attr(f.ledW, L('Max. LED load per channel', 'Max. LED-Last je Kanal'), 'number'),
    attr(f.halogenW, L('Max. halogen load per channel', 'Max. Halogenlast je Kanal'), 'number'),
    attr(f.moduleA, L('Total current', 'Summenstrom'), 'number'),
    attr(f.busMa, L('Bus current consumption', 'Busstromaufnahme'), 'integer'),
    attr(f.width, L('Width', 'Breite'), 'integer'),
    { key: 'colour', label: L('Colour', 'Farbe'), type: 'text', scope: 'product' },
  ])
  const switches = await category('switch_actuators', L('Switch actuators', 'Schaltaktoren'), 'board', [
    attr(f.relayChannels, L('Channels', 'Kanäle'), 'integer'),
    attr(f.relayA, L('Rated current per channel', 'Nennstrom je Kanal'), 'number'),
    attr(f.blindMode, L('Channel pairs as blind outputs', 'Kanalpaare als Jalousieausgänge'), 'boolean'),
    attr(f.motor, L('Motor type', 'Motortyp'), 'enum', { options: [{ key: 'ac', label: L('AC motor', 'AC-Motor') }, { key: 'dc', label: L('DC motor', 'DC-Motor') }] }),
    attr(f.busMa, L('Bus current consumption', 'Busstromaufnahme'), 'integer'),
    attr(f.width, L('Width', 'Breite'), 'integer'),
    { key: f.ip.key, label: L('IP rating', 'Schutzart'), type: 'text', scope: 'product' },
    { key: `colour_${tag}`, label: L('Colour', 'Farbe'), type: 'text', scope: 'product' },
  ])
  const supplies = await category('power_supplies', L('Power supplies', 'Spannungsversorgungen'), 'board', [
    attr(f.supplyMa, L('Bus current output', 'Busstrom-Ausgang'), 'integer'),
    attr(f.width, L('Width', 'Breite'), 'integer'),
  ])
  const enclosures = await category('enclosures', L('Distribution boards', 'Verteilergehäuse'), 'floorplan', [
    attr(f.rows, L('Rows', 'Reihen'), 'integer'),
    attr(f.perRow, L('Modules per row', 'Teilungseinheiten je Reihe'), 'integer'),
  ])
  const sensors = await category('motion_sensors', L('Motion sensors', 'Bewegungsmelder'), 'floorplan', [
    attr(f.router, L('Zigbee router', 'Zigbee-Router'), 'boolean'),
    attr(f.ip, L('IP rating', 'Schutzart'), 'text'),
  ])

  // Products with capability values.
  const product = async (modelNumber: string, name: { en: string; de: string }, productTypeId: string, categoryId: string, attributes: Record<string, unknown>, extra: object = {}) =>
    json<Named>(await api.ctx.post('/api/products', { data: { modelNumber: `${modelNumber}-${tag}`.toUpperCase(), name, productTypeId, categoryId, isActive: true, attributes, ...extra } }))
  const k = (fl: Named) => fl.key
  const dimmerProduct = await product('DA4-230', L('Universal dimming actuator, 4-fold', 'Universal-Dimmaktor, 4-fach'), knx.id, dimmers.id, {
    [k(f.dimmerChannels)]: 4,
    [k(f.ledW)]: 200,
    [k(f.halogenW)]: 300,
    [k(f.moduleA)]: 6,
    [k(f.busMa)]: 12,
    [k(f.width)]: 4,
    colour: 'light grey',
  })
  const relayProduct = await product('SA8-16', L('Switch / blind actuator, 8-fold, 16 A', 'Schalt-/Jalousieaktor, 8-fach, 16 A'), knx.id, switches.id, {
    [k(f.relayChannels)]: 8,
    [k(f.relayA)]: 16,
    [k(f.blindMode)]: true,
    [k(f.motor)]: 'ac',
    [k(f.width)]: 4,
  })
  const supply = await product('PS640', L('Bus power supply 640 mA', 'Spannungsversorgung 640 mA'), knx.id, supplies.id, { [k(f.supplyMa)]: 640, [k(f.width)]: 4 })
  const enclosure = await product('DB3-12', L('Distribution board, 3 rows', 'Verteiler, 3-reihig'), general.id, enclosures.id, { [k(f.rows)]: 3, [k(f.perRow)]: 12 }, { mounting: 'board' })
  const sensor = await product('ZB-PIR', L('Motion sensor', 'Bewegungsmelder'), zigbee.id, sensors.id, { [k(f.router)]: false, [k(f.ip)]: 'IP44' })

  // An import with a profile: new columns, known columns, an attribute that will be linked.
  const csvHeader = 'Model;Name;Price;Channels;Rated current (A);Width;IP rating;Colour;Standby power (W);Manual operation;Motor;Bus current'
  const csv = `${csvHeader}\nSA4-${tag};Switch actuator 4-fold;180.00;4;10;2;IP20;white;0.3;yes;ac;10\nSA12-${tag};Switch actuator 12-fold;390.00;12;16;6;IP20;white;0.5;yes;ac;12\n`
  const attrCol = (column: string, key: string) => ({ target: `attribute.${key}`, column })
  const known = [attrCol('Channels', f.relayChannels.key), attrCol('Rated current (A)', f.relayA.key), attrCol('Width', f.width.key), attrCol('IP rating', f.ip.key), attrCol('Colour', `colour_${tag}`)]
  const base = (fields: object[]) => ({
    sourceKind: 'csv',
    headerRow: 1,
    dataStartRow: 2,
    productTypeId: knx.id,
    categoryId: switches.id,
    fields: [
      { target: 'product.modelNumber', column: 'Model' },
      { target: 'product.name.en', column: 'Name' },
      { target: 'variant.name.en', column: 'Model' },
      { target: 'variant.price', column: 'Price' },
      ...fields,
    ],
  })
  const askMapping = base([
    ...known,
    attrCol('Standby power (W)', `standby_w_${tag}`),
    attrCol('Manual operation', `manual_${tag}`),
    attrCol('Motor', `motor_${tag}`),
    attrCol('Bus current', `bus_ma_${tag}`),
  ])
  const profile = await json<{ id: string }>(await api.ctx.post('/api/import-profiles', { data: { name: `Switch actuators ${tag}`, mapping: askMapping } }))
  const upload = async (name: string) =>
    json<{ id: string }>(await api.ctx.post('/api/imports', { multipart: { file: { name, mimeType: 'text/csv', buffer: Buffer.from(csv) } } }))
  const asking = await upload('switch-actuators-2026.csv')
  const previewed = await upload('switch-actuators-known.csv')
  await json(await api.ctx.post(`/api/imports/${previewed.id}/preview`, { data: { mapping: base(known) } }))

  return {
    tag,
    f,
    products: { dimmerProduct, relayProduct, supply, enclosure, sensor },
    dimmers,
    knx,
    dimmer,
    import: { asking, previewed, profile },
  }
}

const t = {
  en: { edit: 'Edit', mode: 'This column is', existing: 'An existing catalog field', info: 'Just information', meaning: 'Meaning for the checks', key: 'Field key', save: 'Save answers and preview', change: 'Change what column', motor: 'Motor type (AC/DC)', field: 'Catalog field' },
  de: { edit: 'Bearbeiten', mode: 'Diese Spalte ist', existing: 'Ein vorhandenes Katalogfeld', info: 'Nur Information', meaning: 'Bedeutung für die Prüfungen', key: 'Feldschlüssel', save: 'Antworten speichern und Vorschau', change: 'Ändern, was Spalte', motor: 'Motortyp (AC/DC)', field: 'Katalogfeld' },
}

async function choose(page: Page, scope: ReturnType<Page['getByRole']>, label: string, option: string | RegExp) {
  await scope.getByRole('combobox', { name: label }).first().click()
  await page.getByRole('option', { name: option }).first().click()
}

test('the capability pages fit the screen in both themes and languages', { tag: '@visual' }, async ({ page, api }) => {
  test.setTimeout(process.env.CAP3A_ONLY ? 150_000 : 900_000)
  const s = await seed(api)
  const column = (name: string, lang: Lang) => page.getByRole('listitem', { name: new RegExp(`^${lang === 'de' ? 'Spalte „' : 'Column "'}${name.replace(/[()]/g, '\\$&')}`) })

  const editRow = (text: string, lang: Lang) => async (p: Page) => {
    await row(p, text).getByRole('button', { name: t[lang].edit }).first().click()
    await expect(p.getByRole('dialog')).toBeVisible()
  }
  const steps: { name: string; path: string; act?: (page: Page, lang: Lang) => Promise<void>; full?: boolean }[] = [
    { name: 'fields', path: '/catalog/fields' },
    { name: 'field-editor', path: '/catalog/fields', act: (p, l) => editRow(s.f.ledW.key, l)(p), full: false },
    { name: 'field-motor', path: '/catalog/fields', act: (p, l) => editRow(s.f.motor.key, l)(p), full: false },
    { name: 'output-kinds', path: '/catalog/output-kinds' },
    { name: 'output-kind-editor', path: '/catalog/output-kinds', act: (p, l) => editRow('blind_output', l)(p), full: false },
    { name: 'load-types', path: '/catalog/load-types' },
    { name: 'function-type-dialog', path: '/catalog/function-types', act: (p, l) => editRow(s.dimmer.key, l)(p), full: false },
    { name: 'product-type-dialog', path: '/catalog/product-types', act: (p, l) => editRow(s.knx.key, l)(p), full: false },
    { name: 'category-editor', path: `/catalog/categories/${s.dimmers.id}` },
    { name: 'product-dimmer', path: `/catalog/products/${s.products.dimmerProduct.id}` },
    { name: 'product-relay', path: `/catalog/products/${s.products.relayProduct.id}` },
    { name: 'product-supply', path: `/catalog/products/${s.products.supply.id}` },
    { name: 'product-enclosure', path: `/catalog/products/${s.products.enclosure.id}` },
    { name: 'product-zigbee', path: `/catalog/products/${s.products.sensor.id}` },
    {
      name: 'import-new-columns',
      path: `/catalog/imports/${s.import.asking.id}?profile=${s.import.profile.id}`,
      act: async (_p, l) => {
        // The profile's mapping is previewed at once and asks.
        await expect(column('Standby power (W)', l)).toBeVisible()
      },
    },
    {
      name: 'import-answered',
      path: `/catalog/imports/${s.import.asking.id}?profile=${s.import.profile.id}`,
      act: async (p, l) => {
        // The profile's mapping is previewed at once and asks.
        const standby = column('Standby power (W)', l)
        await expect(standby).toBeVisible()
        await choose(p, column('Manual operation', l), t[l].mode, t[l].info)
        await choose(p, column('Motor', l), t[l].meaning, t[l].motor)
        await choose(p, column('Bus current', l), t[l].mode, t[l].existing)
        await choose(p, column('Bus current', l), t[l].field, new RegExp(s.f.busMa.key))
        // A key that is taken: the server's error shows at the column.
        const key = standby.getByRole('textbox', { name: new RegExp(t[l].key) })
        await key.fill(s.f.width.key)
        await p.getByRole('button', { name: t[l].save }).click()
        await expect(standby.locator('[aria-invalid="true"]').first()).toBeVisible()
      },
    },
    {
      name: 'import-change-known',
      path: `/catalog/imports/${s.import.asking.id}?profile=${s.import.profile.id}`,
      act: async (p, l) => {
        // The profile's mapping is previewed at once and asks.
        await p.getByRole('button', { name: new RegExp(`^${t[l].change} Colour`) }).click()
        await expect(column('Colour', l)).toBeVisible()
      },
    },
    { name: 'import-preview', path: `/catalog/imports/${s.import.previewed.id}` },
  ]

  // CAP3A_ONLY=<regexp> limits the steps, e.g. while fixing one page.
  const only = process.env.CAP3A_ONLY ? new RegExp(process.env.CAP3A_ONLY) : undefined
  for (const lang of ['en', 'de'] as const) {
    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const step of steps.filter((x) => !only || only.test(`${x.name}-${viewport.name}-${colorScheme}-${lang}`))) {
          await page.goto(step.path)
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          await page.waitForLoadState('networkidle')
          await expect(page.getByRole('status').filter({ hasText: /^(Loading…|Wird geladen…)$/ })).toHaveCount(0)
          if (step.act) await step.act(page, lang)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/cap3a-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.full !== false, animations: 'disabled' })
        }
      }
    }
  }
})
