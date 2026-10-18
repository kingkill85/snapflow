import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Page } from '@playwright/test'

import { type Api, chooseLanguage, chooseOption, expect, test } from '../fixtures'

// The real SnapFlow 1 workbook (9.3 MB, 205 rows, 76 pictures; not in the
// repository) through the UI: set SNAPFLOW_V1_WORKBOOK to its path to run
// this spec, e.g.
//   SNAPFLOW_V1_WORKBOOK=~/snap-flow/2026-02-14\ ZIGBEE\ Website\ Item\ List\ -\ v2.0.xlsx make e2e args=imports-v1-workbook
// Imported with the starter profile, imported again (nothing changes), and
// undone, refused first while a product it created was edited since. It
// leaves the catalog as it found it, so it can run again on the same server.
// The committed specs use the small synthetic workbook (imports.spec.ts).

const workbook = process.env.SNAPFLOW_V1_WORKBOOK

test.skip(!workbook, 'SNAPFLOW_V1_WORKBOOK is not set')

const counter = (page: Page, card: string, line: string) =>
  page
    .getByRole('heading', { name: card, exact: true })
    .locator('xpath=..')
    .locator('dl > div')
    .filter({ has: page.locator('dt').getByText(line, { exact: true }) })
    .locator('dd')

async function uploadWithStarterProfile(page: Page, file: string) {
  await page.goto('/catalog/imports/new')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(file)
  await chooseOption(page.getByRole('combobox', { name: 'Profile' }), 'SnapFlow 1 workbook')
  await page.getByRole('button', { name: 'Upload and preview' }).click()
  await expect(page.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible({ timeout: 60_000 })
}

async function productId(api: Api, model: string): Promise<string | undefined> {
  const res = await api.ctx.get('/api/products', { params: { search: model, includeInactive: true } })
  return ((await res.json()) as { items: { id: string; modelNumber: string }[] }).items.find((p) => p.modelNumber === model)?.id
}

test('the real SnapFlow 1 workbook imports, imports again unchanged, and is undone', async ({ page, api }) => {
  test.setTimeout(240_000)
  const res = await api.ctx.post('/api/product-types', { data: { key: 'zigbee', name: { en: 'Zigbee' }, abbreviation: 'ZB', color: '#1f6feb', isActive: true } })
  expect([201, 409]).toContain(res.status())
  const file = join(mkdtempSync(join(tmpdir(), 'snapflow-v1-')), 'zigbee-item-list.xlsx')
  copyFileSync(workbook!, file)

  await uploadWithStarterProfile(page, file)
  for (const [card, line, value] of [
    ['Products', 'New', '79'],
    ['Variants', 'New', '205'],
    ['Add-on links', 'To add', '380'],
    ['Add-on links', 'Not found', '0'],
    ['Images', 'New', '201'],
    ['Images', 'Distinct pictures', '76'],
    ['Rows', 'Data rows', '205'],
    ['Rows', 'New categories', '10'],
  ]) {
    await expect(counter(page, card, line), `${card}: ${line}`).toHaveText(value)
  }
  await expect(page.getByText('The file has no errors or warnings.')).toBeVisible()
  // Two columns stay unmapped: the row number and the photo column (pictures come from any column, D145).
  await expect(page.getByText('2 columns are not imported:')).toBeVisible()
  const firstRun = page.url().replace(/[?#].*$/, '')

  await page.getByRole('button', { name: 'Apply import' }).click()
  await expect(page.getByText(/The import was applied on/)).toBeVisible({ timeout: 60_000 })
  await expect(counter(page, 'Products', 'Created')).toHaveText('79')

  // The catalog: a touchscreen with three variants, its category, image, price and add-ons.
  const id = await productId(api, 'MGWSIPD-LK.18')
  expect(id).toBeDefined()
  const product = await api.product(id!)
  expect(product.variants.map((v) => v.name.en)).toEqual(['Ink Black', 'Pine Green', 'Mountain Blue'])
  expect(product.variants.every((v) => v.imageFileId && v.price === '815.00' && v.addons.length === 3)).toBe(true)
  await page.goto('/catalog/products?search=MGWSIPD-LK.18')
  const listed = page.getByRole('row').filter({ hasText: 'MGWSIPD-LK.18' })
  await expect(listed).toContainText('Touchscreens')
  await expect(listed).toContainText('$815.00')
  await chooseLanguage(page, 'Deutsch')
  await expect(listed).toContainText('815,00 $')
  await chooseLanguage(page, 'English')

  // The same file again: nothing changes.
  await uploadWithStarterProfile(page, file)
  await expect(counter(page, 'Products', 'Unchanged')).toHaveText('79')
  await expect(counter(page, 'Variants', 'Unchanged')).toHaveText('205')
  await expect(counter(page, 'Add-on links', 'Unchanged')).toHaveText('380')
  await expect(counter(page, 'Products', 'Changed')).toHaveText('0')
  await expect(counter(page, 'Variants', 'Changed')).toHaveText('0')

  // Edited since: the first run's undo names the product and changes nothing.
  await api.updateProduct(id!, { name: { en: 'Source 7 (edited)' } })
  await page.goto(firstRun)
  await page.getByRole('button', { name: 'Undo import' }).click()
  const dialog = page.getByRole('dialog', { name: 'Undo import' })
  await dialog.getByRole('button', { name: 'Undo' }).click()
  await expect(dialog.getByRole('listitem')).toHaveCount(1)
  await expect(dialog.getByRole('link', { name: 'MGWSIPD-LK.18' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(await productId(api, 'MGWSIPD-LK.18')).toBe(id)

  // The edit reverted, the undo goes through and removes everything the run created.
  await api.updateProduct(id!, { name: product.name })
  await page.getByRole('button', { name: 'Undo import' }).click()
  await dialog.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText(/The import was undone on/)).toBeVisible({ timeout: 60_000 })
  expect(await productId(api, 'MGWSIPD-LK.18')).toBeUndefined()
  expect((await api.categories()).filter((c) => c.key === 'touchscreens')).toHaveLength(0)
})
