import { chooseLanguage, expect, navigate, row, test, unique, uniqueKey, translation } from '../fixtures'

// Product types (the remodel replacing D14): the systems and product lines
// (Zigbee, KNX, …) with a badge, edited in a dialog. Product types are
// global and other specs run in parallel, so every spec finds its own rows
// by unique keys and names.

const listPath = '/catalog/product-types'

test('an admin creates a product type with a badge in a dialog, edits and deactivates it', async ({ page, api }) => {
  const key = uniqueKey('zigbee')
  const name = unique('Zigbee')
  await page.goto(listPath)
  await page.getByRole('button', { name: 'New product type' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New product type' })
  const preview = dialog.getByTestId('badge-preview')
  await expect(preview.getByTestId('type-color')).toBeVisible()

  await dialog.getByLabel('Key').fill(key)
  await (await translation(dialog, 'Name', 'en')).fill(name)
  await (await translation(dialog, 'Name', 'de')).fill(`${name} DE`)
  await dialog.getByLabel('Abbreviation').fill(' zb ')
  await dialog.getByLabel('Colour', { exact: true }).fill('#1F6FEB')
  // The preview: the abbreviation upper case on the colour, white text for contrast.
  const badge = preview.getByTestId('type-abbreviation')
  await expect(badge).toHaveText('ZB')
  await expect(badge).toHaveCSS('background-color', 'rgb(31, 111, 235)')
  await expect(badge).toHaveCSS('color', 'rgb(255, 255, 255)')
  await expect(preview).toContainText(name)

  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  const listed = row(page, key)
  await expect(listed).toContainText(`ZB${name}`)
  await expect(listed.getByTestId('type-abbreviation')).toHaveCSS('background-color', 'rgb(31, 111, 235)')
  await expect(listed).toContainText('Active')
  const stored = (await api.productTypes()).find((t) => t.key === key)!
  expect(stored).toMatchObject({ key, name: { en: name, de: `${name} DE` }, abbreviation: 'ZB', color: '#1f6feb', isActive: true })

  // Edit: a light colour gets black text; deactivated, it is hidden unless inactive ones are shown.
  await listed.getByRole('button', { name: 'Edit' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit product type' })
  await expect(edit.getByLabel('Abbreviation')).toHaveValue('ZB')
  await edit.getByLabel('Colour', { exact: true }).fill('#ffd33d')
  await expect(edit.getByTestId('type-abbreviation')).toHaveCSS('color', 'rgb(0, 0, 0)')
  await edit.getByLabel('Active', { exact: true }).uncheck()
  await edit.getByRole('button', { name: 'Update' }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, key)).toHaveCount(0)
  await page.getByLabel('Show inactive').check()
  await expect(row(page, key)).toContainText('Inactive')
  expect(await api.productType(stored.id)).toMatchObject({ color: '#ffd33d', isActive: false })
})

test('the dialog reports mistakes at their fields, a taken key from the server', async ({ page, api }) => {
  const taken = await api.createProductType()
  await page.goto(listPath)
  await page.getByRole('button', { name: 'New product type' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New product type' })
  await dialog.getByLabel('Key').fill('Bad Key')
  await dialog.getByLabel('Abbreviation').fill('TOOLONG')
  await dialog.getByLabel('Colour', { exact: true }).fill('blue')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByLabel('Key')).toHaveAccessibleDescription('Use lower case letters, digits and underscores, starting with a letter.')
  await expect(await translation(dialog, 'Name', 'en')).toHaveAccessibleDescription('This field is required.')
  await expect(dialog.getByLabel('Abbreviation')).toHaveAccessibleDescription('This value is too long (at most 6 characters).')
  await expect(dialog.getByLabel('Colour', { exact: true })).toHaveAccessibleDescription('Enter a colour as #rrggbb, e.g. #1f6feb.')

  await dialog.getByLabel('Key').fill(taken.key)
  await (await translation(dialog, 'Name', 'en')).fill(unique('Taken'))
  await dialog.getByLabel('Abbreviation').fill('TK')
  await dialog.getByLabel('Colour', { exact: true }).fill('')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByLabel('Key')).toHaveAccessibleDescription(`The key "${taken.key}" is already used.`)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})

test('a save over a newer version is refused, and Reload shows that version', async ({ page, api }) => {
  const type = await api.createProductType({ abbreviation: 'OLD' })
  await page.goto(listPath)
  await row(page, type.key).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit product type' })
  await expect(dialog.getByLabel('Abbreviation')).toHaveValue('OLD')
  const renamed = unique('Renamed')
  await api.updateProductType(type.id, { name: { en: renamed } })

  await dialog.getByLabel('Abbreviation').fill('NEW')
  await dialog.getByRole('button', { name: 'Update' }).click()
  const stale = dialog.getByRole('alert').filter({ hasText: 'Someone else changed this product type in the meantime.' })
  await expect(stale).toBeVisible()
  await stale.getByRole('button', { name: 'Reload' }).click()
  await expect(await translation(dialog, 'Name', 'en')).toHaveValue(renamed)
  await expect(dialog.getByLabel('Abbreviation')).toHaveValue('OLD')
  await dialog.getByLabel('Abbreviation').fill('NEW')
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()
  expect(await api.productType(type.id)).toMatchObject({ name: { en: renamed }, abbreviation: 'NEW' })
})

test('reorder and delete on the list; a type in use cannot be deleted', async ({ page, api }) => {
  const a = await api.createProductType({ name: { en: unique('Alpha') } })
  const b = await api.createProductType({ name: { en: unique('Bravo') }, isActive: false })
  const c = await api.createProductType({ name: { en: unique('Charlie') } })
  await api.moveProductTypesToTop([a.id, b.id, c.id])
  const category = await api.createCategory()
  await api.createProduct({ productTypeId: a.id, categoryId: category.id })
  const position = (key: string) => row(page, key).getByRole('cell').first()

  await page.goto(listPath)
  await expect(row(page, b.key)).toHaveCount(0)
  await expect(position(a.key)).toHaveText('1')
  await expect(position(c.key)).toHaveText('2')
  // Charlie passes Alpha, its visible neighbour; the hidden Bravo stays after Alpha.
  await page.getByRole('button', { name: `Move ${c.name.en} up` }).click()
  await expect(position(c.key)).toHaveText('1')
  expect((await api.productTypes()).slice(0, 3).map((t) => t.key)).toEqual([c.key, a.key, b.key])

  await row(page, a.key).getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete product type' })
  await expect(confirm).toContainText(`Delete "${a.name.en}"?`)
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm.getByRole('alert')).toHaveText('This product type is still used by products. Deactivate it instead.')
  await confirm.getByRole('button', { name: 'Cancel' }).click()

  await row(page, c.key).getByRole('button', { name: 'Delete' }).click()
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toBeHidden()
  await expect(row(page, c.key)).toHaveCount(0)
  expect((await api.productTypes()).map((t) => t.id)).not.toContain(c.id)
})

for (const role of ['user', 'tenant_admin'] as const) {
  test(`a ${role} sees product types read-only`, async ({ api, sessionFor }) => {
    const type = await api.createProductType({ abbreviation: 'RO', color: '#d1242f' })
    const tenant = role === 'tenant_admin' ? await api.createTenant() : undefined
    const account = await api.createUser({ role, tenantId: tenant?.id })
    const page = await sessionFor(account)

    await page.goto('/')
    await navigate(page, 'Catalog', 'Product types')
    await expect(page.getByRole('heading', { name: 'Product types', level: 1 })).toBeVisible()
    await expect(row(page, type.key)).toContainText(`RO${type.name.en}`)
    await expect(page.getByRole('button', { name: /New product type|Edit|Delete|^Move / })).toHaveCount(0)
  })
}

test('the list in German', async ({ page, api }) => {
  const type = await api.createProductType({ name: { en: unique('KNX'), de: unique('KNX DE') }, abbreviation: 'KNX' })
  await page.goto(listPath)
  await chooseLanguage(page, 'Deutsch')
  await expect(page.getByRole('heading', { name: 'Produkttypen', level: 1 })).toBeVisible()
  await expect(row(page, type.key)).toContainText(`KNX${type.name.de!}`)
  await expect(page.getByRole('columnheader')).toContainText(['Position', 'Name', 'Schlüssel', 'Status'])
  await row(page, type.key).getByRole('button', { name: 'Bearbeiten' }).click()
  const dialog = page.getByRole('dialog', { name: 'Produkttyp bearbeiten' })
  await expect(dialog.getByLabel('Kürzel')).toHaveValue('KNX')
  await expect(dialog.getByText('Vorschau des Abzeichens')).toBeVisible()
  await dialog.getByRole('button', { name: 'Abbrechen' }).click()
})
