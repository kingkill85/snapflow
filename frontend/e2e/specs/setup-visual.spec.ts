import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type Page } from '@playwright/test'

import { chooseLanguage, expect, navEntries, navigate, test, uniqueKey } from '../fixtures'

// Step 4a-1 (D441, D442): the six Setup pages with their one-line explanation,
// the Catalog menu and the Import's saved mapping, at phone, tablet and desktop
// width, light and dark, English and German; screenshots in
// e2e/screenshots/setup-*.png. Plus a click-through of both menus as admin, in
// German, and as a tenant admin. Tagged @visual: runs with `make e2e-visual`.

type Lang = 'en' | 'de'
const locale = (feature: string, lang: Lang) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../src/features/${feature}/locales/${lang}.json`, import.meta.url)), 'utf8')) as Record<string, unknown>
const text = (feature: string, lang: Lang, group?: string) => {
  const l = locale(feature, lang)
  const g = (group ? l[group] : l) as { title: string; description: string }
  return { title: g.title, description: g.description }
}

const setupPages = [
  { name: 'systems', path: '/catalog/product-types', text: (l: Lang) => text('product-types', l) },
  { name: 'functions', path: '/catalog/function-types', text: (l: Lang) => text('function-types', l) },
  { name: 'fields', path: '/catalog/fields', text: (l: Lang) => text('capabilities', l, 'fields') },
  { name: 'room-templates', path: '/catalog/room-templates', text: (l: Lang) => text('room-templates', l) },
  { name: 'channel-kinds', path: '/catalog/output-kinds', text: (l: Lang) => text('capabilities', l, 'outputKinds') },
  { name: 'load-types', path: '/catalog/load-types', text: (l: Lang) => text('capabilities', l, 'loadTypes') },
]

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'tablet', size: { width: 820, height: 1180 } },
  { name: 'desktop', size: { width: 1440, height: 900 } },
]

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('status').filter({ hasText: /^(Loading…|Wird geladen…)$/ })).toHaveCount(0)
}

const csv = 'Model;Name;Price\nSA4;Switch actuator 4-fold;180.00\n'

test('the setup pages, the catalog menu and the saved mapping fit the screen', { tag: '@visual' }, async ({ page, api }) => {
  test.setTimeout(600_000)
  const tag = uniqueKey('').replace(/^_+/, '').slice(-5)
  const { ids } = await api.createKind()
  await api.createFunctionType(`dimmer_${tag}`, 'Dimmable light')
  const mapping = {
    sourceKind: 'csv',
    headerRow: 1,
    dataStartRow: 2,
    ...ids,
    fields: [
      { target: 'product.modelNumber', column: 'Model' },
      { target: 'product.name.en', column: 'Name' },
      { target: 'variant.name.en', column: 'Model' },
      { target: 'variant.price', column: 'Price' },
    ],
  }
  expect((await api.ctx.post('/api/import-profiles', { data: { name: `Supplier ${tag}`, mapping } })).ok()).toBe(true)
  const upload = await api.ctx.post('/api/imports', { multipart: { file: { name: `supplier-${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) } } })
  expect(upload.ok(), await upload.text()).toBe(true)
  const imported = (await upload.json()) as { id: string }

  for (const lang of ['en', 'de'] as const) {
    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const p of setupPages) {
          const { title, description } = p.text(lang)
          await page.goto(p.path)
          await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
          await expect(page.getByRole('main').getByText(description, { exact: true })).toBeVisible()
          await settle(page)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/setup-${p.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: false, animations: 'disabled' })
        }
        if (viewport.name === 'phone') {
          // The side sheet with its four groups.
          await page.getByRole('button', { name: lang === 'de' ? 'Menü' : 'Menu' }).click()
          await expect(page.getByRole('dialog').getByRole('region', { name: lang === 'de' ? 'Einrichtung' : 'Setup' }).getByRole('link')).toHaveCount(6)
          await page.screenshot({ path: `e2e/screenshots/setup-nav-sheet-${viewport.name}-${colorScheme}-${lang}.png`, animations: 'disabled' })
          await page.keyboard.press('Escape')
        }
        if (viewport.name !== 'desktop') continue
        // The Catalog menu, open.
        await page.goto('/catalog/products')
        await settle(page)
        await page.getByRole('banner').getByRole('button', { name: lang === 'de' ? 'Katalog' : 'Catalog' }).click()
        await expect(page.getByRole('menuitem')).toHaveCount(3)
        await page.screenshot({ path: `e2e/screenshots/setup-catalog-menu-${viewport.name}-${colorScheme}-${lang}.png`, animations: 'disabled' })
        await page.keyboard.press('Escape')
        if (colorScheme === 'dark') continue
        // The import's saved mapping: on the upload page and in the mapping step.
        await page.goto('/catalog/imports/new')
        await settle(page)
        await page.screenshot({ path: `e2e/screenshots/setup-import-new-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: true, animations: 'disabled' })
        await page.goto(`/catalog/imports/${imported.id}`)
        await settle(page)
        const section = page.getByText(lang === 'de' ? 'Gespeicherte Zuordnung' : 'Saved mapping', { exact: true }).first()
        await expect(section).toBeVisible()
        await section.scrollIntoViewIfNeeded()
        await page.screenshot({ path: `e2e/screenshots/setup-import-mapping-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: true, animations: 'disabled' })
      }
    }
  }
})

// Step 4a-2 (D443, D444): the Systems editor (bus, Advanced open) and the
// Functions editor (served by, Details open) in every layout; screenshots in
// e2e/screenshots/setup-editor-*.png.
test('the Systems and Functions editors fit the screen', { tag: '@visual' }, async ({ page, api }) => {
  test.setTimeout(300_000)
  const system = await api.createProductType({ topology: 'bus', addressing: 'knx_individual', defaultBusCurrentMa: 10, busDevicesMax: 64, reservePercent: 25 })
  const kind = await api.createOutputKind(uniqueKey('visual_kind'), 'Visual dimmer output')
  const fn = uniqueKey('visual_fn')
  const created = await api.ctx.post('/api/function-types', {
    data: { key: fn, name: { en: 'Visual dimmer', de: 'Visueller Dimmer' }, allowsCircuit: true, outputKindIds: [kind.id], knxObjects: [{ key: 'switch', name: { en: 'Switch', de: 'Schalten' }, dpst: 'DPST-1-1' }] },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const editors = [
    { name: 'system', path: '/catalog/product-types', key: system.key, dialog: { en: 'Edit system', de: 'System bearbeiten' } },
    { name: 'function', path: '/catalog/function-types', key: fn, dialog: { en: 'Edit function', de: 'Funktion bearbeiten' } },
  ]
  for (const lang of ['en', 'de'] as const) {
    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const e of editors) {
          await page.goto(e.path)
          await settle(page)
          await page.getByRole('row').filter({ hasText: e.key }).getByRole('button', { name: lang === 'de' ? 'Bearbeiten' : 'Edit' }).click()
          const dialog = page.getByRole('dialog', { name: e.dialog[lang] })
          await expect(dialog).toBeVisible()
          await settle(page)
          // Advanced (reserve 25) and Details (objects) open by themselves.
          await expect(dialog.getByRole('button', { expanded: true })).toHaveCount(1)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/setup-editor-${e.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: true, animations: 'disabled' })
          await page.keyboard.press('Escape')
          await expect(dialog).toBeHidden()
        }
      }
    }
  }
})

test('both menus lead to their pages, in German too, and a tenant admin gets theirs', { tag: '@visual' }, async ({ page, api, sessionFor }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  expect(await navEntries(page)).toEqual({
    Projects: ['Projects'],
    Catalog: ['Products', 'Categories', 'Import'],
    Setup: ['Systems', 'Functions', 'Fields', 'Room templates', 'Channel kinds', 'Load types'],
    Administration: expect.any(Array),
  })
  for (const p of setupPages) {
    const { title, description } = p.text('en')
    await navigate(page, 'Setup', title)
    await expect(page).toHaveURL(new RegExp(`${p.path}$`))
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.getByRole('main').getByText(description, { exact: true })).toBeVisible()
    await settle(page)
    await expect(page.getByRole('alert')).toHaveCount(0)
    // The list loaded: rows, cards or an empty state (seeded kinds always have rows).
    if (p.name === 'channel-kinds' || p.name === 'load-types') await expect(page.getByRole('row').nth(1)).toBeVisible()
  }
  for (const [item, path, heading] of [
    ['Products', '/catalog/products', 'Products'],
    ['Categories', '/catalog/categories', 'Categories'],
    ['Import', '/catalog/imports', 'Import'],
  ]) {
    await navigate(page, 'Catalog', item)
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    await expect(page.getByRole('heading', { level: 1 })).toContainText(heading)
    await settle(page)
    await expect(page.getByRole('alert')).toHaveCount(0)
  }

  await chooseLanguage(page, 'Deutsch')
  const de = await navEntries(page)
  expect(de.Katalog).toEqual(['Produkte', 'Kategorien', 'Import'])
  expect(de.Einrichtung).toEqual(['Systeme', 'Funktionen', 'Felder', 'Raumvorlagen', 'Kanalarten', 'Lastarten'])
  expect(Object.keys(de)).toEqual(['Projekte', 'Katalog', 'Einrichtung', 'Verwaltung'])

  const tenant = await api.createTenant()
  const tenantAdmin = await api.createUser({ role: 'tenant_admin', tenantId: tenant.id })
  const other = await sessionFor(tenantAdmin)
  await other.setViewportSize({ width: 1440, height: 900 })
  await other.goto('/')
  expect(await navEntries(other)).toEqual({
    Projects: ['Projects'],
    Catalog: ['Products', 'Categories'],
    Setup: ['Systems', 'Functions', 'Fields', 'Room templates', 'Channel kinds', 'Load types'],
    Administration: ['Users', 'Roles', 'Company profile'],
  })
})

// Step 4a-2 review: every state of both editors and both lists, the whole
// dialog too (a second shot of the dialog alone in a tall viewport, `-full`), in every layout;
// screenshots in e2e/screenshots/editor-states/<state>-<width>-<theme>-<lang>.png.
test('every state of the Systems and Functions editors and their lists', { tag: '@visual' }, async ({ page, api }) => {
  test.setTimeout(900_000)
  page.on('dialog', (d) => void d.accept())
  const tag = uniqueKey('').replace(/^_+/, '').slice(-5)
  const sys = {
    bus: await api.createProductType({ name: { en: `KNX ${tag}`, de: `KNX ${tag}` }, topology: 'bus', addressing: 'knx_individual', defaultBusCurrentMa: 10, busDevicesMax: 64 }),
    wireless: await api.createProductType({ name: { en: `Zigbee ${tag}`, de: `Zigbee ${tag}` }, topology: 'wireless', addressing: 'eui64', defaultWirelessPlacesUsed: 1 }),
    none: await api.createProductType({ name: { en: `Plain ${tag}`, de: `Einfach ${tag}` }, topology: 'none' }),
    advanced: await api.createProductType({ name: { en: `HDL ${tag}`, de: `HDL ${tag}` }, topology: 'bus', addressing: 'hdl', nominalVoltage: 110 }),
  }
  const kinds = ((await api.ctx.get('/api/output-kinds').then((r) => r.json())) as { items: { id: string; isActive: boolean }[] }).items.filter((k) => k.isActive)
  const loads = ((await api.ctx.get('/api/load-types').then((r) => r.json())) as { items: { id: string }[] }).items
  const fnKey = (k: string) => `${k}_${tag}`
  for (const [key, data] of [
    [fnKey('lonely'), { name: { en: 'Unserved light', de: 'Unbediente Leuchte' } }],
    [
      fnKey('served'),
      {
        name: { en: 'Served light', de: 'Bediente Leuchte' },
        allowsCircuit: true,
        outputKindIds: kinds.slice(0, 2).map((k) => k.id),
        loadTypeIds: loads.slice(0, 2).map((l) => l.id),
        knxObjects: [{ key: 'switch', name: { en: 'Switch', de: 'Schalten' }, dpst: 'DPST-1-1' }],
      },
    ],
  ] as const) {
    const res = await api.ctx.post('/api/function-types', { data: { key, ...data } })
    expect(res.ok(), await res.text()).toBe(true)
  }
  const noKnx = async () =>
    page.route(/\/api\/product-types(\?|$)/, async (route) => {
      const response = await route.fetch()
      const body = (await response.json()) as { items: { addressing: string }[] }
      await route.fulfill({ response, json: { ...body, items: body.items.map((p) => ({ ...p, addressing: p.addressing === 'knx_individual' ? 'none' : p.addressing })) } })
    })

  type Lang = 'en' | 'de'
  const tr = (en: string, de: string) => (lang: Lang) => (lang === 'de' ? de : en)
  const editSystem = tr('Edit system', 'System bearbeiten')
  const editFunction = tr('Edit function', 'Funktion bearbeiten')
  const advanced = tr('Advanced', 'Erweitert')
  const states: { name: string; path: string; key?: string; dialog?: (l: Lang) => string; prepare?: () => Promise<unknown>; act?: (dialog: ReturnType<Page['getByRole']>, lang: Lang) => Promise<void>; expanded?: boolean }[] = [
    { name: 'list-systems', path: '/catalog/product-types' },
    { name: 'list-functions', path: '/catalog/function-types' },
    { name: 'sys-bus', path: '/catalog/product-types', key: sys.bus.key, dialog: editSystem, expanded: false },
    { name: 'sys-wireless', path: '/catalog/product-types', key: sys.wireless.key, dialog: editSystem, expanded: false },
    { name: 'sys-none', path: '/catalog/product-types', key: sys.none.key, dialog: editSystem, expanded: false },
    { name: 'sys-advanced-auto', path: '/catalog/product-types', key: sys.advanced.key, dialog: editSystem, expanded: true },
    {
      name: 'sys-advanced-error',
      path: '/catalog/product-types',
      key: sys.bus.key,
      dialog: editSystem,
      expanded: true,
      act: async (dialog, lang) => {
        const toggle = dialog.getByRole('button', { name: new RegExp(`^${advanced(lang)}`) })
        await toggle.click()
        await dialog.getByRole('group', { name: advanced(lang) }).getByRole('textbox').nth(1).fill('95')
        await toggle.click()
        await dialog.getByRole('button', { name: lang === 'de' ? 'Aktualisieren' : 'Update' }).click()
        await expect(dialog.getByRole('group', { name: advanced(lang) })).toBeVisible()
      },
    },
    { name: 'fn-unserved', path: '/catalog/function-types', key: fnKey('lonely'), dialog: editFunction, expanded: false },
    {
      name: 'fn-new-details-open',
      path: '/catalog/function-types',
      dialog: tr('New function', 'Neue Funktion'),
      act: async (dialog, lang) => {
        await dialog.getByRole('button', { name: new RegExp(`^${lang === 'de' ? 'Details' : 'Details'}`) }).click()
      },
    },
    { name: 'fn-served-knx', path: '/catalog/function-types', key: fnKey('served'), dialog: editFunction, expanded: true },
    { name: 'fn-served-no-knx', path: '/catalog/function-types', key: fnKey('served'), dialog: editFunction, expanded: true, prepare: noKnx },
  ]

  for (const lang of ['en', 'de'] as const) {
    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const s of states) {
          const suffix = `${viewport.name}-${colorScheme}-${lang}`
          if (s.prepare) await s.prepare()
          await page.goto(s.path)
          await settle(page)
          if (!s.dialog) {
            await expectNoHorizontalOverflow(page)
            await page.screenshot({ path: `e2e/screenshots/editor-states/${s.name}-${suffix}.png`, fullPage: true, animations: 'disabled' })
            continue
          }
          if (s.key) await page.getByRole('row').filter({ hasText: s.key }).getByRole('button', { name: lang === 'de' ? 'Bearbeiten' : 'Edit' }).click()
          else await page.getByRole('button', { name: s.dialog(lang) }).first().click()
          const dialog = page.getByRole('dialog', { name: s.dialog(lang) })
          await expect(dialog).toBeVisible()
          await settle(page)
          if (s.expanded !== undefined && !s.act) await expect(dialog.getByRole('button', { expanded: s.expanded })).toHaveCount(1)
          if (s.act) await s.act(dialog, lang)
          await expectNoHorizontalOverflow(page)
          // The footer stays reachable without scrolling the page.
          await expect(dialog.getByRole('button', { name: lang === 'de' ? 'Abbrechen' : 'Cancel' })).toBeInViewport()
          await page.screenshot({ path: `e2e/screenshots/editor-states/${s.name}-${suffix}.png`, animations: 'disabled' })
          await page.setViewportSize({ width: viewport.size.width, height: 2600 })
          await dialog.screenshot({ path: `e2e/screenshots/editor-states/${s.name}-full-${suffix}.png`, animations: 'disabled' })
          await page.setViewportSize(viewport.size)
          if (s.prepare) await page.unrouteAll({ behavior: 'wait' })
        }
      }
    }
  }
})

// Step 4a-3 (D446, D447): the Readiness section of the Systems page (a
// system with gaps, the General card) and the product page's "Still missing"
// lines in every layout; screenshots in e2e/screenshots/setup-readiness-*.png
// and setup-product-missing-*.png.
test('the Readiness section and the product missing lines fit the screen', { tag: '@visual' }, async ({ page, api }) => {
  test.setTimeout(300_000)
  const tag = uniqueKey('').replace(/^_+/, '').slice(-6)
  const post = async <T,>(path: string, data: unknown): Promise<T> => {
    const res = await api.ctx.post(path, { data })
    expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const system = await post<{ id: string }>('/api/product-types', {
    key: `ready_${tag}`, name: { en: `KNX ${tag}`, de: `KNX ${tag}` }, abbreviation: 'KNX', color: '#2f855a', isActive: true, topology: 'bus',
  })
  const width = `ready_width_${tag}`
  await post('/api/catalog-fields', { key: width, label: { en: 'Width' }, type: 'number', unit: 'TE', meaning: 'rail_width_te' })
  const category = await post<{ id: string }>('/api/categories', {
    key: `ready_${tag}`, name: { en: `Actuators ${tag}` }, isActive: true, mounting: 'board', instanceAttributes: [],
    attributes: [{ key: 'width', label: { en: 'Width' }, type: 'number', fieldKey: width }],
  })
  const product = await api.createProduct({ productTypeId: system.id, categoryId: category.id, modelNumber: `RDY-${tag}` })
  // Its card first.
  await api.moveProductTypesToTop([system.id])

  for (const lang of ['en', 'de'] as const) {
    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await page.goto('/catalog/product-types')
        const card = page.getByRole('listitem', { name: `KNX ${tag}` })
        await expect(card.getByRole('link', { name: `RDY-${tag}` }).first()).toBeVisible()
        await settle(page)
        await expectNoHorizontalOverflow(page)
        await card.scrollIntoViewIfNeeded()
        await page.screenshot({ path: `e2e/screenshots/setup-readiness-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: false, animations: 'disabled' })
        await page.goto(`/catalog/products/${product.id}`)
        const missing = page.getByTestId('still-missing')
        await expect(missing).toBeVisible()
        await settle(page)
        await expectNoHorizontalOverflow(page)
        await missing.scrollIntoViewIfNeeded()
        await page.screenshot({ path: `e2e/screenshots/setup-product-missing-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: false, animations: 'disabled' })
      }
    }
  }
})

// Step 4a-3 review: every readiness and meaning state at phone, tablet and
// desktop width, light and dark, English and German; screenshots in
// e2e/screenshots/4a-3/<state>-<width>-<theme>-<lang>.png.
test('4a-3 states: readiness, still missing, meanings', { tag: '@visual' }, async ({ page, api }) => {
  test.setTimeout(900_000)
  const tag = uniqueKey('').replace(/^_+/, '').slice(-6)
  const post = async <T,>(path: string, data: unknown): Promise<T> => {
    const res = await api.ctx.post(path, { data })
    expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  // A KNX system with errors, warnings and notes, and 25 products without a width.
  const knxName = `KNX Haus ${tag}`
  const knx = await post<{ id: string }>('/api/product-types', {
    key: `vknx_${tag}`, name: { en: knxName }, abbreviation: 'KNX', color: '#2f855a', isActive: true, topology: 'bus', addressing: 'knx_individual',
  })
  const relay = await post<{ id: string }>('/api/output-kinds', { key: `vrelay_${tag}`, name: { en: `Relay ${tag}`, de: `Relais ${tag}` }, isActive: true })
  const f = { relay: `vrelay_ch_${tag}`, width: `vwidth_${tag}`, bus: `vbus_${tag}` }
  await post('/api/catalog-fields', { key: f.relay, label: { en: 'Relay channels', de: 'Relaiskanäle' }, type: 'integer', meaning: 'channels_supplied', outputKindId: relay.id })
  await post('/api/catalog-fields', { key: f.width, label: { en: 'Width', de: 'Breite' }, type: 'number', unit: 'TE', meaning: 'rail_width_te' })
  await post('/api/catalog-fields', { key: f.bus, label: { en: 'Bus current', de: 'Busstrom' }, type: 'number', unit: 'mA', meaning: 'bus_current_used_ma' })
  const actuators = await post<{ id: string }>('/api/categories', {
    key: `vact_${tag}`, name: { en: `Actuators ${tag}`, de: `Aktoren ${tag}` }, isActive: true, mounting: 'board', instanceAttributes: [],
    attributes: [
      { key: 'relay', label: { en: 'Relay channels', de: 'Relaiskanäle' }, type: 'integer', fieldKey: f.relay },
      { key: 'width', label: { en: 'Width', de: 'Breite' }, type: 'number', fieldKey: f.width },
      { key: 'bus', label: { en: 'Bus current', de: 'Busstrom' }, type: 'number', fieldKey: f.bus },
      { key: 'max_devices', label: { en: 'Max devices', de: 'Max. Geräte' }, type: 'integer' },
    ],
  })
  const kids = { productTypeId: knx.id, categoryId: actuators.id }
  for (let i = 1; i <= 24; i++) await api.createProduct({ ...kids, modelNumber: `SA-${String(i).padStart(2, '0')}-${tag}` })
  const missing = await api.createProduct({ ...kids, modelNumber: `SAM-${tag}`, name: { en: `Switch actuator ${tag}`, de: `Schaltaktor ${tag}` }, attributes: { relay: 4 } })
  const fixed = await api.createProduct({ ...kids, modelNumber: `SAF-${tag}`, name: { en: `Switch actuator ${tag}`, de: `Schaltaktor ${tag}` }, attributes: { relay: 4, width: 4, bus: 10 } })
  // A system with nothing missing.
  const readyName = `Ready ${tag}`
  const ready = await post<{ id: string }>('/api/product-types', { key: `vready_${tag}`, name: { en: readyName }, isActive: true, topology: 'bus', defaultBusCurrentMa: 10 })
  const g = { width: `vrw_${tag}`, supply: `vrs_${tag}`, rows: `vrr_${tag}` }
  await post('/api/catalog-fields', { key: g.width, label: { en: 'Width' }, type: 'number', unit: 'TE', meaning: 'rail_width_te' })
  await post('/api/catalog-fields', { key: g.supply, label: { en: 'Supply' }, type: 'number', meaning: 'bus_current_supplied_ma' })
  await post('/api/catalog-fields', { key: g.rows, label: { en: 'Rows' }, type: 'integer', meaning: 'enclosure_rows' })
  const board = await post<{ id: string }>('/api/categories', {
    key: `vboard_${tag}`, name: { en: `Board ${tag}` }, isActive: true, mounting: 'board', instanceAttributes: [],
    attributes: [
      { key: 'width', label: { en: 'Width' }, type: 'number', fieldKey: g.width },
      { key: 'supply', label: { en: 'Supply' }, type: 'number', fieldKey: g.supply },
      { key: 'rows', label: { en: 'Rows' }, type: 'integer', fieldKey: g.rows },
    ],
  })
  await api.createProduct({ productTypeId: ready.id, categoryId: board.id, modelNumber: `PS-${tag}`, attributes: { supply: 640, width: 4 } })
  await api.createProduct({ productTypeId: ready.id, categoryId: board.id, modelNumber: `ENC-${tag}`, attributes: { rows: 3 } })
  await api.moveProductTypesToTop([knx.id, ready.id])
  // A function nobody serves.
  await api.createFunctionType(`vpump_${tag}`, `Garden pump ${tag}`)

  // An import run waiting at its New columns step.
  const column = `Standby power ${tag}`
  const sheet = `Model;Name;Category;Variant;Price;${column}\nIM-${tag};Gateway;Gateways ${tag};Standard;99.00;0.4\n`
  expect((await api.ctx.get('/api/import-profiles')).ok()).toBe(true)
  const profileName = `Visual ${tag}`
  await post('/api/import-profiles', {
    name: profileName,
    mapping: {
      sourceKind: 'csv', headerRow: 1, dataStartRow: 2, productTypeId: knx.id, createMissingCategories: true,
      fields: [
        { target: 'product.modelNumber', column: 'Model' },
        { target: 'product.name.en', column: 'Name' },
        { target: 'product.category', column: 'Category' },
        { target: 'variant.name.en', column: 'Variant' },
        { target: 'variant.price', column: 'Price' },
        { target: `attribute.standby_${tag}`, column },
      ],
    },
  })
  await page.goto('/catalog/imports/new')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles({ name: `sheet-${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(sheet) })
  await page.getByRole('combobox', { name: 'Saved mapping' }).click()
  await page.getByRole('option', { name: profileName, exact: true }).click()
  await page.getByRole('button', { name: 'Upload and preview' }).click()
  await expect(page.getByRole('heading', { name: 'New columns – what do they mean?' })).toBeVisible()
  const importURL = page.url()

  const widths = { phone: 390, tablet: 820, desktop: 1440 } as const
  const dir = 'e2e/screenshots/4a-3'
  for (const lang of ['en', 'de'] as const) {
    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        const shot = (state: string) => `${dir}/${state}-${widths[viewport.name as keyof typeof widths]}-${colorScheme}-${lang}.png`

        // Systems: the header, the KNX card, the green card, the General card.
        await page.goto('/catalog/product-types')
        const knxCard = page.getByRole('listitem', { name: knxName })
        await expect(knxCard.getByRole('link', { name: `SA-01-${tag}` }).first()).toBeVisible()
        await settle(page)
        await expectNoHorizontalOverflow(page)
        await page.screenshot({ path: shot('systems-top'), animations: 'disabled' })
        await knxCard.screenshot({ path: shot('readiness-errors'), animations: 'disabled' })
        const readyCard = page.getByRole('listitem', { name: readyName })
        await expect(readyCard).toContainText(lang === 'de' ? 'Bereit' : 'Ready')
        await readyCard.screenshot({ path: shot('readiness-ready'), animations: 'disabled' })
        const general = page.getByRole('listitem', { name: lang === 'de' ? 'Allgemein' : 'General' })
        await expect(general).toContainText(`Garden pump ${tag}`)
        await general.screenshot({ path: shot('readiness-general'), animations: 'disabled' })

        // The product with gaps, and one without.
        for (const [state, p] of [['product-missing', missing], ['product-fixed', fixed]] as const) {
          await page.goto(`/catalog/products/${p.id}`)
          const block = page.getByTestId('capabilities')
          await expect(block).toBeVisible()
          if (state === 'product-missing') await expect(page.getByTestId('still-missing')).toBeVisible()
          else await expect(page.getByTestId('still-missing')).toHaveCount(0)
          await settle(page)
          await expectNoHorizontalOverflow(page)
          await block.scrollIntoViewIfNeeded()
          await page.screenshot({ path: shot(state), animations: 'disabled' })
        }

        // The category editor: a linked attribute, then "Create a new field…" from another.
        await page.goto(`/catalog/categories/${actuators.id}`)
        const attrs = page.getByRole('region', { name: lang === 'de' ? 'Attribute' : 'Attributes', exact: true })
        const card = (n: number) => attrs.getByRole('group', { name: new RegExp(`^(Attribute|Attribut) ${n}(: |$)`) })
        await card(3).getByRole('button', { name: lang === 'de' ? 'Attribut 3 aufklappen' : 'Expand attribute 3' }).click()
        await expect(card(3).getByTestId('linked-meaning')).toBeVisible()
        await settle(page)
        await card(3).scrollIntoViewIfNeeded()
        await expectNoHorizontalOverflow(page)
        await page.screenshot({ path: shot('category-linked'), animations: 'disabled' })
        await card(4).getByRole('button', { name: lang === 'de' ? 'Attribut 4 aufklappen' : 'Expand attribute 4' }).click()
        await card(4).getByRole('combobox', { name: lang === 'de' ? /^Katalogfeld/ : /^Catalog field/ }).click()
        await page.getByRole('option', { name: lang === 'de' ? 'Neues Feld anlegen…' : 'Create a new field…', exact: true }).click()
        const fieldDialog = page.getByRole('dialog', { name: lang === 'de' ? 'Neues Feld' : 'New field' })
        await expect(fieldDialog).toBeVisible()
        await expect(fieldDialog.getByLabel(lang === 'de' ? 'Schlüssel' : 'Key', { exact: true })).toHaveValue('max_devices')
        await page.waitForTimeout(300)
        await page.screenshot({ path: shot('category-create-field'), animations: 'disabled' })
        await fieldDialog.getByRole('button', { name: lang === 'de' ? 'Abbrechen' : 'Cancel' }).click()

        // The import's New columns step with the meaning select open.
        // Back on the run, the mapping step: the saved mapping again, then Preview.
        await page.goto(importURL)
        const de = lang === 'de'
        await page.getByRole('combobox', { name: de ? 'Gespeicherte Zuordnung' : 'Saved mapping', exact: true }).click()
        await page.getByRole('option', { name: profileName, exact: true }).click()
        await page.getByRole('button', { name: de ? 'Vorschau' : 'Preview', exact: true }).last().click()
        await expect(page.getByRole('heading', { name: de ? 'Neue Spalten – was bedeuten sie?' : 'New columns – what do they mean?' })).toBeVisible()
        const meaning = page.getByRole('combobox', { name: lang === 'de' ? /^Bedeutung für die Prüfungen/ : /^Meaning for the checks/ }).first()
        await expect(meaning).toBeVisible()
        await settle(page)
        await meaning.scrollIntoViewIfNeeded()
        await page.screenshot({ path: shot('import-new-columns'), animations: 'disabled' })
        await meaning.click()
        await expect(page.getByRole('listbox')).toBeVisible()
        await page.waitForTimeout(300)
        await page.screenshot({ path: shot('import-meaning-open'), animations: 'disabled' })
        await page.keyboard.press('Escape')

        // The Fields page with the meaning in plain words.
        await page.goto('/catalog/fields')
        await expect(page.getByRole('row').filter({ hasText: f.bus })).toBeVisible()
        await settle(page)
        await expectNoHorizontalOverflow(page)
        await page.screenshot({ path: shot('fields-list'), animations: 'disabled' })
      }
    }
  }
})
