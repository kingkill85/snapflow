import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type Page } from '@playwright/test'

import { type Api, expect, test, unique, uniqueKey } from '../fixtures'

// Every step and state of the import at phone and desktop width, light and
// dark, English and German: nothing overflows the viewport. Screenshots land
// in e2e/screenshots/import-*.png for a look by eye. The runs are seeded
// through the API (the flows themselves are tested in imports.spec.ts).
// Tagged @visual: it runs with `make e2e-visual`, not in the default run (D107).

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'desktop', size: { width: 1280, height: 800 } },
]

type Run = { id: string; state: string }

async function upload(api: Api, name: string, mimeType: string, buffer: Buffer): Promise<Run> {
  const res = await api.ctx.post('/api/imports', { multipart: { file: { name, mimeType, buffer } } })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()) as Run
}

const uploadCsv = (api: Api, name: string, csv: string) => upload(api, name, 'text/csv', Buffer.from(csv))

/** frontend/e2e/assets/import-v1.xlsx (sheets "Items"; pictures). */
const workbook = readFileSync(fileURLToPath(new URL('../assets/import-v1.xlsx', import.meta.url)))

async function post(api: Api, path: string, data: object, status = 200): Promise<Run> {
  const res = await api.ctx.post(path, { data })
  expect(res.status(), await res.text()).toBe(status)
  return (await res.json()) as Run
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

test('every import step fits the screen in both themes and languages', { tag: '@visual' }, async ({ page, api }) => {
  test.setTimeout(480_000)
  const { ids } = await api.createKind(
    { name: { en: unique('Visual dimmers'), de: unique('Visuelle Dimmer') }, attributes: [{ key: 'width_te', label: { en: 'Width', de: 'Breite' }, type: 'integer', unit: 'TE', scope: 'product' }] },
    { name: { en: unique('Visual system') }, abbreviation: 'VIS', color: '#0f766e' },
  )
  const m = uniqueKey('VIS').toUpperCase()
  const header = 'Model Number;Item Name;Style;SKU;Price (USD);Width;Optional Addon;Notes'
  const rows = [
    `${m}-1;Universal dimmer actuator 4-fold with manual operation;White;${m}-1-W;27,50;4;;first`,
    `${m}-1;Universal dimmer actuator 4-fold with manual operation;Black;${m}-1-B;28;4;${m}-1-W;`,
    `${m}-2;Switch actuator 8-fold;;${m}-2;120;eight;UNKNOWN-ADDON;`,
    `${m}-3;Blind actuator;Grey;${m}-1-W;99;2;;duplicate sku`,
  ]
  const csv = [header, ...rows].join('\n') + '\n'
  const mapping = {
    sourceKind: 'csv',
    headerRow: 1,
    dataStartRow: 2,
    ...ids,
    allOrNothing: false,
    fields: [
      { target: 'product.modelNumber', column: 'Model Number' },
      { target: 'product.name.en', column: 'Item Name' },
      { target: 'variant.name.en', column: 'Style' },
      { target: 'variant.sku', column: 'SKU' },
      { target: 'variant.price', column: 'Price (USD)' },
      { target: 'attribute.width_te', column: 'Width' },
      { target: 'addon.optional', column: 'Optional Addon' },
    ],
  }
  const goodMapping = { ...mapping, fields: mapping.fields.filter((f) => f.target !== 'attribute.width_te') }

  const uploaded = await uploadCsv(api, 'supplier-uploaded.csv', csv)
  const previewed = await uploadCsv(api, 'supplier-preview.csv', csv)
  await post(api, `/api/imports/${previewed.id}/preview`, { mapping })
  const applied = await uploadCsv(api, 'supplier-applied.csv', csv)
  await post(api, `/api/imports/${applied.id}/preview`, { mapping: goodMapping })
  await post(api, `/api/imports/${applied.id}/apply`, { allOrNothing: false })
  // Changed since the import: its undo conflicts.
  const products = (await (await api.ctx.get('/api/products', { params: { search: `${m}-1` } })).json()) as { items: { id: string; modelNumber: string }[] }
  const touched = products.items.find((p) => p.modelNumber === `${m}-1`)!
  await api.updateProduct(touched.id, { name: { en: 'Edited after the import' } })
  // A second, undone run of another file.
  const other = uniqueKey('VISU').toUpperCase()
  const undone = await uploadCsv(api, 'supplier-undone.csv', `${header}\n${other};Presence detector;;${other};45;1;;\n`)
  await post(api, `/api/imports/${undone.id}/preview`, { mapping: goodMapping })
  await post(api, `/api/imports/${undone.id}/apply`, {})
  await post(api, `/api/imports/${undone.id}/undo`, {})
  // A profile the next run was previewed with: its mapping step says when the form differs from it.
  const profile = await post(api, '/api/import-profiles', { name: unique('Visual supplier'), mapping: goodMapping }, 201)
  const profiled = await uploadCsv(api, 'supplier-profile.csv', csv)
  await post(api, `/api/imports/${profiled.id}/preview`, { profileId: profile.id })
  // A profile for a sheet the workbook lacks.
  const otherSheet = await post(
    api,
    '/api/import-profiles',
    { name: unique('Visual other sheet'), mapping: { ...goodMapping, sourceKind: 'xlsx', sheet: 'Price list 2025' } },
    201,
  )
  const xlsx = await upload(api, 'supplier-workbook.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', workbook)

  const steps: { name: string; path: string; act?: (page: Page) => Promise<void> }[] = [
    { name: 'list', path: '/catalog/imports' },
    { name: 'new', path: '/catalog/imports/new' },
    { name: 'mapping-empty', path: `/catalog/imports/${uploaded.id}` },
    {
      name: 'mapping-errors',
      path: `/catalog/imports/${uploaded.id}`,
      act: async (p) => {
        await p.getByRole('button', { name: /^(Preview|Vorschau)$/ }).click()
        await expect(p.locator('[aria-invalid="true"]').first()).toBeVisible()
      },
    },
    { name: 'mapping-filled', path: `/catalog/imports/${previewed.id}?view=mapping` },
    {
      name: 'mapping-busy',
      path: `/catalog/imports/${uploaded.id}`,
      act: async (p) => {
        // The preview never answers: the step shows that it runs.
        await p.route('**/api/imports/*/preview', () => {})
        await p.getByRole('button', { name: /^(Preview|Vorschau)$/ }).click()
        await expect(p.getByText(/^(Reading the file…|Datei wird gelesen …)$/).first()).toBeVisible()
      },
    },
    { name: 'mapping-sheet-missing', path: `/catalog/imports/${xlsx.id}?profile=${otherSheet.id}` },
    {
      name: 'mapping-profile-differs',
      path: `/catalog/imports/${profiled.id}?view=mapping`,
      act: async (p) => {
        await p.getByLabel(/^(Create missing categories|Fehlende Kategorien anlegen)$/).check()
        await expect(p.getByText(/(differs from the profile|weicht vom Profil)/)).toBeVisible()
      },
    },
    { name: 'preview', path: `/catalog/imports/${previewed.id}` },
    { name: 'result', path: `/catalog/imports/${applied.id}` },
    {
      name: 'undo-conflict',
      path: `/catalog/imports/${applied.id}`,
      act: async (p) => {
        await p.getByRole('button', { name: /^(Undo import|Import rückgängig machen)$/ }).click()
        await p.getByRole('dialog').getByRole('button', { name: /^(Undo|Rückgängig)$/ }).click()
        await expect(p.getByRole('dialog').getByRole('list')).toBeVisible()
      },
    },
    { name: 'undone', path: `/catalog/imports/${undone.id}` },
    {
      name: 'delete',
      path: `/catalog/imports/${uploaded.id}`,
      act: async (p) => {
        await p.getByRole('button', { name: /^(Delete|Löschen)$/ }).click()
        await expect(p.getByRole('dialog')).toBeVisible()
      },
    },
  ]

  for (const lang of ['en', 'de'] as const) {
    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const step of steps) {
          await page.unrouteAll({ behavior: 'ignoreErrors' })
          await page.goto(step.path)
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          await page.waitForLoadState('networkidle')
          await expect(page.getByRole('status').filter({ hasText: /^(Loading…|Wird geladen…)$/ })).toHaveCount(0)
          if (step.act) await step.act(page)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/import-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.name !== 'undo-conflict' && step.name !== 'delete' })
        }
      }
    }
  }
})
