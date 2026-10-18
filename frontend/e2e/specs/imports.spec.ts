import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Locator, type Page } from '@playwright/test'

import { type Api, chooseOption, expect, navigate, test, unique, uniqueKey } from '../fixtures'
import { rewriteZip } from '../zip'

// The catalog import (step 1d) through the UI: a SnapFlow 1 workbook with
// the starter profile (pictures, add-ons, categories created), importing it
// again changes nothing, undo; and a CSV mapped by hand and saved as a
// profile. Every run imports its own model numbers and categories (the
// workbook's "E2E" made unique), so reruns against the same server work.

/** frontend/e2e/assets/import-v1.xlsx, made by importsrctest.TestE2EFixture (backend). */
const workbookAsset = fileURLToPath(new URL('../assets/import-v1.xlsx', import.meta.url))

/**
 * A copy of the workbook whose model numbers, SKUs, names and categories
 * start with a prefix of its own ("E2E" + a unique tag): its path and prefix.
 */
function uniqueWorkbook() {
  const prefix = `E2E${uniqueKey('').replace(/_/g, '').toUpperCase()}`
  const path = join(mkdtempSync(join(tmpdir(), 'snapflow-import-')), `import-${prefix.toLowerCase()}.xlsx`)
  rewriteZip(workbookAsset, path, (name, data) => (name === 'xl/sharedStrings.xml' ? Buffer.from(data.toString('utf8').replaceAll('E2E', prefix)) : data))
  return { path, prefix, fileName: basename(path) }
}

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
/** A counter card's value, e.g. counter(page, 'Products', 'New'). */
const counter = (page: Page, card: string, line: string) =>
  page
    .getByRole('heading', { name: card, exact: true })
    .locator('xpath=..')
    .locator('dl > div')
    .filter({ has: page.locator('dt').getByText(line, { exact: true }) })
    .locator('dd')

type Product = { id: string; modelNumber: string; isActive: boolean; variants: { name: { en: string }; price: string; imageFileId?: string; addons: unknown[] }[] }

async function productByModel(api: Api, model: string): Promise<Product | undefined> {
  const res = await api.ctx.get('/api/products', { params: { search: model, includeInactive: true } })
  const list = ((await res.json()) as { items: { id: string; modelNumber: string }[] }).items
  const hit = list.find((p) => p.modelNumber === model)
  return hit ? ((await (await api.ctx.get(`/api/products/${hit.id}`)).json()) as Product) : undefined
}

/** The product type the starter profile puts every row on (it must exist; the import never creates one). */
async function ensureZigbee(api: Api) {
  const res = await api.ctx.post('/api/product-types', { data: { key: 'zigbee', name: { en: 'Zigbee' }, abbreviation: 'ZB', color: '#1f6feb', isActive: true } })
  expect([201, 409]).toContain(res.status())
}

/**
 * Applies the previewed run with one click: the preview is stale only if
 * the part of the catalog it read changed (D147), which specs running
 * alongside never touch.
 */
async function applyImport(page: Page) {
  await page.getByRole('button', { name: 'Apply import' }).click()
  await expect(page.getByText(/The import was applied on/)).toBeVisible()
}

/** Uploads a file on the new-import page, with a profile or without. */
async function upload(page: Page, file: string, profile?: string) {
  await page.goto('/catalog/imports/new')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(file)
  if (profile) {
    await chooseOption(page.getByRole('combobox', { name: 'Profile' }), profile)
    await page.getByRole('button', { name: 'Upload and preview' }).click()
  } else {
    await page.getByRole('button', { name: 'Upload and map columns' }).click()
  }
}

const target = (page: Page, column: string): Locator => page.getByRole('combobox', { name: `Imported as: ${column}`, exact: true })

test.describe.configure({ mode: 'serial' })

test('a SnapFlow 1 workbook imports with the starter profile; importing it again changes nothing; undo removes it', async ({ page, api }) => {
  await ensureZigbee(api)
  const { path: workbook, prefix: p, fileName } = uniqueWorkbook()
  await page.goto('/')
  await navigate(page, 'Catalog', 'Import')
  await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toBeVisible()

  await upload(page, workbook, 'SnapFlow 1 workbook')
  await expect(page.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible()
  await expect(counter(page, 'Products', 'New')).toHaveText('2')
  await expect(counter(page, 'Variants', 'New')).toHaveText('3')
  await expect(counter(page, 'Rows', 'New categories')).toHaveText('2')
  await expect(counter(page, 'Images', 'Distinct pictures')).toHaveText('2')
  // The unknown add-on is a warning, not an error.
  await expect(
    page.getByRole('table', { name: 'Errors and warnings' }).getByRole('row').filter({ hasText: `The add-on "${p}-PSU-9" was found neither in the file nor in the catalog.` }),
  ).toContainText('Warning')
  const changes = region(page, 'Changes')
  await expect(changes.getByText(`${p}-GW-1 · White · SKU ${p}-GW-1 White`)).toBeVisible()
  await expect(changes.getByRole('img', { name: 'Image' }).first()).toBeVisible()

  await applyImport(page)
  const firstRun = page.url()
  await expect(region(page, 'Change log').getByRole('link', { name: `${p}-DIM-2` }).first()).toBeVisible()

  const gw = await productByModel(api, `${p}-GW-1`)
  expect(gw?.variants.map((v) => v.name.en).sort()).toEqual(['Black', 'White'])
  expect(gw?.variants.every((v) => v.imageFileId)).toBe(true)
  const dim = await productByModel(api, `${p}-DIM-2`)
  expect(dim?.variants[0].addons).toHaveLength(1)

  // The same file again: everything unchanged.
  await upload(page, workbook, 'SnapFlow 1 workbook')
  await expect(page.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible()
  await expect(counter(page, 'Products', 'Unchanged')).toHaveText('2')
  await expect(counter(page, 'Variants', 'Unchanged')).toHaveText('3')
  await expect(counter(page, 'Products', 'New')).toHaveText('0')
  await expect(counter(page, 'Products', 'Changed')).toHaveText('0')

  // The list shows both runs, newest first.
  await page.goto('/catalog/imports')
  const rows = page.getByRole('row').filter({ hasText: fileName })
  await expect(rows.first()).toContainText('Previewed')
  await expect(rows.nth(1)).toContainText('Applied')

  // Undo the first run: the products are gone again.
  await page.goto(firstRun)
  await page.getByRole('button', { name: 'Undo import' }).click()
  const dialog = page.getByRole('dialog', { name: 'Undo import' })
  await dialog.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText(/The import was undone on/)).toBeVisible()
  expect(await productByModel(api, `${p}-GW-1`)).toBeUndefined()
  expect(await productByModel(api, `${p}-DIM-2`)).toBeUndefined()
})

test('a CSV with a title line is mapped by hand, saved as a profile and imported into a fixed product type and category', async ({ page, api }) => {
  const { type, category } = await api.createKind(
    { name: { en: unique('CSV dimmers') }, attributes: [{ key: 'width_te', label: { en: 'Width' }, type: 'integer', scope: 'product' }] },
    { name: { en: unique('CSV system') } },
  )
  const model = uniqueKey('CSV').toUpperCase()
  const dir = mkdtempSync(join(tmpdir(), 'snapflow-import-'))
  const file = join(dir, 'supplier.csv')
  // A title line above the header, decimal commas and a thousands separator, as a German spreadsheet saves it.
  writeFileSync(file, `Price list 2026\nModel;Name;Style;SKU;Price;Width\n${model};Dimmer 4ch;White;${model}-W;27,50;4\n${model};Dimmer 4ch;Black;${model}-B;1.028,00;4\n`)
  const profileName = unique('Supplier')

  await upload(page, file)
  await expect(page.getByRole('heading', { name: 'Columns' })).toBeVisible()
  await expect(page.getByText('3 data rows, 6 columns, 0 pictures')).toBeVisible()
  await page.getByLabel('Header row').fill('2')
  await expect(page.getByLabel('First data row')).toHaveValue('3')
  await expect(page.getByText('2 data rows, 6 columns, 0 pictures')).toBeVisible()
  await chooseOption(page.getByRole('combobox', { name: 'Product type', exact: true }), type.name.en)
  await chooseOption(page.getByRole('combobox', { name: 'Category', exact: true }), category.name.en)
  await chooseOption(target(page, 'Model'), 'Model number (required)')
  await chooseOption(target(page, 'Name'), 'Product name (English)')
  await chooseOption(target(page, 'Style'), 'Variant name (English)')
  await chooseOption(target(page, 'SKU'), 'SKU')
  await chooseOption(target(page, 'Price'), 'Price (USD)')
  await chooseOption(target(page, 'Width'), 'Width (width_te)')

  await page.getByRole('button', { name: 'Save as new profile' }).click()
  const dialog = page.getByRole('dialog', { name: 'Save as profile' })
  await dialog.getByLabel('Profile name').fill(profileName)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText(`Profile "${profileName}" created.`)).toBeVisible()

  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.getByText('The file has no errors or warnings.')).toBeVisible()
  await expect(counter(page, 'Products', 'New')).toHaveText('1')
  await expect(counter(page, 'Variants', 'New')).toHaveText('2')
  await applyImport(page)

  const product = await productByModel(api, model)
  expect(product?.variants.map((v) => `${v.name.en} ${v.price}`).sort()).toEqual(['Black 1028.00', 'White 27.50'])

  // The saved profile maps the next file at once.
  await upload(page, file, profileName)
  await expect(counter(page, 'Variants', 'Unchanged')).toHaveText('2')
})
