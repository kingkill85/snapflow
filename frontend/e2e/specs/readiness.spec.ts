import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chooseOption, expect, test, translation, unique, uniqueKey } from '../fixtures'

// Step 4a-3 (D445-D447) end to end as admin: a KNX system's readiness card
// names a product with gaps, the product page says what is still missing,
// filling it clears the card; an unserved function shows in the General card
// until a channel kind serves it; a category attribute creates its field in
// place; the import's New columns step explains meanings in plain words.

test('readiness of a KNX system, the product and the functions', async ({ page, api }) => {
  test.setTimeout(90_000)
  const tag = uniqueKey('').replace(/^_+/, '').slice(-6)
  const post = async <T,>(path: string, data: unknown): Promise<T> => {
    const res = await api.ctx.post(path, { data })
    expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const systemName = `KNX ${tag}`
  const system = await post<{ id: string }>('/api/product-types', {
    key: `knx_${tag}`, name: { en: systemName }, abbreviation: 'KNX', color: '#2f855a', isActive: true, topology: 'bus', addressing: 'knx_individual',
  })
  const relayName = unique('Relay')
  const relay = await post<{ id: string }>('/api/output-kinds', { key: `relay_${tag}`, name: { en: relayName }, isActive: true })
  const f = { relay: `relay_ch_${tag}`, width: `width_${tag}`, bus: `bus_ma_${tag}` }
  await post('/api/catalog-fields', { key: f.relay, label: { en: 'Relay channels' }, type: 'integer', meaning: 'channels_supplied', outputKindId: relay.id })
  await post('/api/catalog-fields', { key: f.width, label: { en: 'Width' }, type: 'number', unit: 'TE', meaning: 'rail_width_te' })
  await post('/api/catalog-fields', { key: f.bus, label: { en: 'Bus current' }, type: 'number', unit: 'mA', meaning: 'bus_current_used_ma' })
  const category = await post<{ id: string }>('/api/categories', {
    key: `act_${tag}`, name: { en: `Actuators ${tag}` }, isActive: true, mounting: 'board', instanceAttributes: [],
    attributes: [
      { key: 'relay', label: { en: 'Relay channels' }, type: 'integer', fieldKey: f.relay },
      { key: 'width', label: { en: 'Width' }, type: 'number', fieldKey: f.width },
      { key: 'bus', label: { en: 'Bus current' }, type: 'number', fieldKey: f.bus },
    ],
  })
  const model = `ACT-${tag}`
  const product = await api.createProduct({ productTypeId: system.id, categoryId: category.id, modelNumber: model, name: { en: `Actuator ${tag}` } })
  await api.moveProductTypesToTop([system.id])

  // The KNX card names the product under errors and warnings.
  await page.goto('/catalog/product-types')
  const card = page.getByRole('listitem', { name: systemName })
  for (const code of ['product_board_without_width', 'product_bus_current_missing', 'product_channels_missing'])
    await expect(card.locator(`[data-code="${code}"]`).getByRole('link', { name: model })).toBeVisible()
  await expect(card).toContainText('Error')
  await expect(card).toContainText('Warning')
  await card.locator('[data-code="product_board_without_width"]').getByRole('link', { name: model }).click()

  // The product says what is missing; filling it in clears it.
  await expect(page.getByRole('heading', { name: 'Edit product' })).toBeVisible()
  const missing = page.getByTestId('still-missing')
  await expect(missing).toContainText('Width on the rail (TE)')
  await expect(missing).toContainText('Bus current the device draws (mA)')
  await expect(missing).toContainText('Number of channels')
  await page.getByRole('textbox', { name: /^Width/ }).fill('4')
  await page.getByRole('textbox', { name: /^Bus current/ }).fill('10')
  await page.getByRole('textbox', { name: /^Relay channels/ }).fill('8')
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(missing).toHaveCount(0)
  expect((await api.product(product.id)).attributes).toMatchObject({ width: 4, bus: 10, relay: 8 })

  await page.goto('/catalog/product-types')
  await expect(card.locator('[data-code="product_channels_missing"], [data-code="product_board_without_width"], [data-code="product_bus_current_missing"]')).toHaveCount(0)
  await expect(card.getByRole('link', { name: model })).toHaveCount(0)

  // A function nobody serves shows in the General card until a channel kind serves it.
  const functionName = unique('Garden pump')
  await api.createFunctionType(`pump_${tag}`, functionName)
  await page.reload()
  const general = page.getByRole('listitem', { name: 'General' })
  await expect(general.locator('[data-code="function_not_served"]')).toContainText(functionName)
  await page.goto('/catalog/function-types')
  await page.getByRole('row').filter({ hasText: functionName }).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit function' })
  await dialog.getByRole('checkbox', { name: relayName }).check()
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()
  await page.goto('/catalog/product-types')
  await expect(general).toBeVisible()
  // Not unserved any more (it still lacks load types and KNX objects, listed apart).
  await expect(general.locator('[data-code="function_not_served"]').getByText(functionName)).toHaveCount(0)
  await expect(general.locator('[data-code="function_no_knx_objects"]')).toContainText(functionName)
})

test('a category attribute creates its field in place, and the import explains meanings', async ({ page, api }) => {
  test.setTimeout(90_000)
  const tag = uniqueKey('').replace(/^_+/, '').slice(-6)
  const category = await api.createCategory({ name: { en: `Gateways ${tag}` } })
  await page.goto(`/catalog/categories/${category.id}`)
  const section = page.getByRole('region', { name: 'Attributes', exact: true })
  await section.getByRole('button', { name: 'Add attribute', exact: true }).click()
  const attribute = section.getByRole('group', { name: /^Attribute 1(: |$)/ })
  const key = `max_devices_${tag}`
  await attribute.getByLabel('Key', { exact: true }).first().fill(key)
  await (await translation(attribute, 'Label', 'en')).fill('Max devices')
  await chooseOption(attribute.getByLabel('Type', { exact: true }), 'Whole number')
  await chooseOption(attribute.getByRole('combobox', { name: /^Catalog field/ }), 'Create a new field…')
  const dialog = page.getByRole('dialog', { name: 'New field' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Key', { exact: true })).toHaveValue(key)
  await expect(await translation(dialog, 'Label', 'en')).toHaveValue('Max devices')
  await expect(dialog.getByRole('combobox', { name: /^Value type/ })).toHaveText('Whole number')
  await chooseOption(dialog.getByRole('combobox', { name: /^Meaning/ }), 'Wireless places supplied')
  await expect(dialog).toContainText('How many wireless devices a gateway or coordinator can take')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const linked = attribute.getByTestId('linked-meaning')
  await expect(linked).toContainText('Wireless places supplied')
  await expect(linked).toContainText('How many wireless devices a gateway or coordinator can take')
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  expect((await api.category(category.id)).attributes.find((a) => a.key === key)).toMatchObject({ fieldKey: key })

  // The import: a sheet with a column nobody knows.
  const type = await api.createProductType({ name: { en: unique('Import system') } })
  const column = `Standby ${tag}`
  const file = join(mkdtempSync(join(tmpdir(), 'snapflow-readiness-')), 'sheet.csv')
  writeFileSync(file, `Model;Name;Category;Variant;Price;${column}\nRD-${tag};Gateway;Gateways ${tag} new;Standard;99.00;0.4\n`)
  expect((await api.ctx.get('/api/import-profiles')).ok()).toBe(true)
  const profileName = unique('Readiness')
  const profile = await api.ctx.post('/api/import-profiles', {
    data: {
      name: profileName,
      mapping: {
        sourceKind: 'csv', headerRow: 1, dataStartRow: 2, productTypeId: type.id, createMissingCategories: true,
        fields: [
          { target: 'product.modelNumber', column: 'Model' },
          { target: 'product.name.en', column: 'Name' },
          { target: 'product.category', column: 'Category' },
          { target: 'variant.name.en', column: 'Variant' },
          { target: 'variant.price', column: 'Price' },
          { target: `attribute.standby_${tag}`, column },
        ],
      },
    },
  })
  expect(profile.status()).toBe(201)
  await page.goto('/catalog/imports/new')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(file)
  await chooseOption(page.getByRole('combobox', { name: 'Saved mapping' }), profileName)
  await page.getByRole('button', { name: 'Upload and preview' }).click()
  await expect(page.getByRole('heading', { name: 'New columns – what do they mean?' })).toBeVisible()
  const item = page.getByRole('listitem', { name: new RegExp(`^Column "${column}"`) })
  await item.getByRole('combobox', { name: 'Meaning for the checks' }).click()
  const listbox = page.getByRole('listbox')
  await expect(listbox.getByRole('option', { name: /Width on the rail \(TE\)/ })).toContainText("In TE (17.5 mm); used for the board's capacity")
  await expect(listbox.getByRole('option', { name: /Bus current used \(mA\)/ })).toContainText("mA taken from the bus line")
  await listbox.getByRole('option', { name: /Bus current used \(mA\)/ }).click()
  await expect(item).toContainText('Example: 10 mA')
})
