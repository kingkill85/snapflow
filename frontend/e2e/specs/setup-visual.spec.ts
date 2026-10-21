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
