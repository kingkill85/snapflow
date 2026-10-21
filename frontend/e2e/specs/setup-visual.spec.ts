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
