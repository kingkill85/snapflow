import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Page } from '@playwright/test'

import { chooseOption, expect, row, test, unique, uniqueKey } from '../fixtures'

// Catalog capabilities (step 3a) through the UI: a CSV with capability
// columns the catalog does not know yet is imported with a profile; the
// import asks what the new columns mean, the answers create catalog fields,
// and the product page shows what SnapFlow knows about the product. Then the
// capability settings of a category and a product type survive edits of
// their other fields (D294). Every run uses keys of its own.

/** Uploads a file on the new-import page with a profile. */
async function uploadWithProfile(page: Page, file: string, profile: string) {
  await page.goto('/catalog/imports/new')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(file)
  await chooseOption(page.getByRole('combobox', { name: 'Profile' }), profile)
  await page.getByRole('button', { name: 'Upload and preview' }).click()
}

test('an import asks what new capability columns mean; the product then shows its capabilities', async ({ page, api }) => {
  const tag = uniqueKey('').replace(/^_+/, '')
  const type = await api.createProductType({ name: { en: unique('Capability system') } })
  const kindName = unique('Dimmer output')
  const loadName = unique('LED lamps')
  const kind = await (await api.ctx.post('/api/output-kinds', { data: { key: `dim_${tag}`, name: { en: kindName }, isActive: true } })).json()
  const load = await (await api.ctx.post('/api/load-types', { data: { key: `led_${tag}`, name: { en: loadName }, isActive: true } })).json()
  expect(kind.id).toBeTruthy()
  expect(load.id).toBeTruthy()

  const model = `CAP-${tag}`.toUpperCase()
  const category = unique('Capability dimmers')
  const columns = { dimmers: `Dimmers ${tag}`, led: `LED max ${tag}`, width: `Width ${tag}`, notes: `Notes ${tag}` }
  const file = join(mkdtempSync(join(tmpdir(), 'snapflow-capabilities-')), 'capabilities.csv')
  writeFileSync(
    file,
    `Model;Name;Category;Variant;Price;${columns.dimmers};${columns.led};${columns.width};${columns.notes}\n` +
      `${model};Dimmer 6ch;${category};Standard;99.00;6;200;6;made in EU\n`,
  )
  const profileName = unique('Capabilities')
  // Listing first creates the starter profile while there is none (D121), as the imports spec running alongside expects.
  expect((await api.ctx.get('/api/import-profiles')).ok()).toBe(true)
  const attr = (column: string, key: string) => ({ target: `attribute.${key}`, column })
  const profile = await api.ctx.post('/api/import-profiles', {
    data: {
      name: profileName,
      mapping: {
        sourceKind: 'csv',
        headerRow: 1,
        dataStartRow: 2,
        productTypeId: type.id,
        createMissingCategories: true,
        fields: [
          { target: 'product.modelNumber', column: 'Model' },
          { target: 'product.name.en', column: 'Name' },
          { target: 'product.category', column: 'Category' },
          { target: 'variant.name.en', column: 'Variant' },
          { target: 'variant.price', column: 'Price' },
          attr(columns.dimmers, `dimmers_${tag}`),
          attr(columns.led, `led_w_${tag}`),
          attr(columns.width, `width_${tag}`),
          attr(columns.notes, `notes_${tag}`),
        ],
      },
    },
  })
  expect(profile.status()).toBe(201)

  await uploadWithProfile(page, file, profileName)
  await expect(page.getByRole('heading', { name: 'New columns – what do they mean?' })).toBeVisible()
  const column = (name: string) => page.getByRole('listitem', { name: new RegExp(`^Column "${name}"`) })

  // Dimmer outputs: channels supplied of the new output kind.
  const dimmers = column(columns.dimmers)
  await chooseOption(dimmers.getByRole('combobox', { name: 'Meaning for the checks' }), 'Number of channels')
  await chooseOption(dimmers.getByRole('combobox', { name: /Output kind/ }), kindName)
  // LED limit: watts per channel for the output kind and load type.
  const led = column(columns.led)
  await chooseOption(led.getByRole('combobox', { name: 'Meaning for the checks' }), 'Max. load per channel (W)')
  await chooseOption(led.getByRole('combobox', { name: /Output kind/ }), kindName)
  await chooseOption(led.getByRole('combobox', { name: /Load type/ }), loadName)
  await led.getByRole('textbox', { name: /Unit/ }).fill('W')
  // Width: rail width in TE.
  const width = column(columns.width)
  await chooseOption(width.getByRole('combobox', { name: 'Meaning for the checks' }), 'Width on the rail (TE)')
  await width.getByRole('textbox', { name: /Unit/ }).fill('TE')
  // Notes: just information.
  await chooseOption(column(columns.notes).getByRole('combobox', { name: 'This column is' }), 'Just information')

  await page.getByRole('button', { name: 'Save answers and preview' }).click()
  await expect(page.getByText('The file has no errors or warnings.')).toBeVisible()
  await page.getByRole('button', { name: 'Apply import' }).click()
  await expect(page.getByText(/The import was applied on/)).toBeVisible()

  // The fields exist now, and the next import knows the columns.
  const fields = (await (await api.ctx.get('/api/catalog-fields')).json()) as { items: { key: string; meaning?: string }[] }
  expect(fields.items.find((f) => f.key === `dimmers_${tag}`)?.meaning).toBe('channels_supplied')

  const products = (await (await api.ctx.get('/api/products', { params: { search: model, includeInactive: true } })).json()) as {
    items: { id: string; modelNumber: string }[]
  }
  const product = products.items.find((p) => p.modelNumber === model)
  expect(product).toBeTruthy()
  await page.goto(`/catalog/products/${product?.id}`)
  const block = page.getByTestId('capabilities')
  await expect(block).toContainText(`6 × ${kindName}, max 200 W ${loadName} · 6 TE · mounting: Floorplan`)
})

test('a category keeps its mounting and a product type its reserve when other fields are edited', async ({ page, api }) => {
  const { type, category } = await api.createKind({ name: { en: unique('Mounting kind') } }, { name: { en: unique('Reserve system') } })

  // Category: mounting set, then only the name changed.
  await page.goto(`/catalog/categories/${category.id}`)
  await chooseOption(page.getByRole('combobox', { name: 'Mounting' }), 'Distribution board')
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  const nameEn = page.getByRole('region', { name: 'Basics' }).getByRole('textbox', { name: /^Name/ }).first()
  await nameEn.fill(`${category.name.en} 2`)
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Mounting' })).toHaveText('Distribution board')
  expect((await api.category(category.id)) as unknown as { mounting: string }).toMatchObject({ mounting: 'board' })

  // Product type: reserve set, then only the abbreviation changed.
  await page.goto('/catalog/product-types')
  await row(page, type.name.en).getByRole('button', { name: 'Edit' }).click()
  let dialog = page.getByRole('dialog', { name: 'Edit product type' })
  await dialog.getByLabel(/^Reserve/).fill('30')
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()
  await row(page, type.name.en).getByRole('button', { name: 'Edit' }).click()
  dialog = page.getByRole('dialog', { name: 'Edit product type' })
  await expect(dialog.getByLabel(/^Reserve/)).toHaveValue('30')
  await dialog.getByLabel('Abbreviation').fill('RS')
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()
  expect((await api.productType(type.id)) as unknown as { reservePercent: number; abbreviation: string }).toMatchObject({
    reservePercent: 30,
    abbreviation: 'RS',
  })
})
