import { chooseLanguage, chooseOption, expect, navigate, row, test, unique, uniqueKey, translation } from '../fixtures'

// Product types (the remodel replacing D14): the systems and product lines
// (Zigbee, KNX, …) with a badge, edited in a dialog. Product types are
// global and other specs run in parallel, so every spec finds its own rows
// by unique keys and names.

const listPath = '/catalog/product-types'

test('an admin creates a product type with a badge in a dialog, edits and deactivates it', async ({ page, api }) => {
  const key = uniqueKey('zigbee')
  const name = unique('Zigbee')
  await page.goto(listPath)
  await page.getByRole('button', { name: 'New system' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New system' })
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
  const edit = page.getByRole('dialog', { name: 'Edit system' })
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
  await page.getByRole('button', { name: 'New system' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New system' })
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
  const dialog = page.getByRole('dialog', { name: 'Edit system' })
  await expect(dialog.getByLabel('Abbreviation')).toHaveValue('OLD')
  const renamed = unique('Renamed')
  await api.updateProductType(type.id, { name: { en: renamed } })

  await dialog.getByLabel('Abbreviation').fill('NEW')
  await dialog.getByRole('button', { name: 'Update' }).click()
  const stale = dialog.getByRole('alert').filter({ hasText: 'Someone else changed this system in the meantime.' })
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
  const confirm = page.getByRole('dialog', { name: 'Delete system' })
  await expect(confirm).toContainText(`Delete "${a.name.en}"?`)
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm.getByRole('alert')).toHaveText('This system is still used by products or projects. Deactivate it instead.')
  await confirm.getByRole('button', { name: 'Cancel' }).click()

  await row(page, c.key).getByRole('button', { name: 'Delete' }).click()
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toBeHidden()
  await expect(row(page, c.key)).toHaveCount(0)
  expect((await api.productTypes()).map((t) => t.id)).not.toContain(c.id)
})

// D443: only the chosen topology's settings; voltage and reserve under Advanced.
test('the editor follows the topology and keeps voltage and reserve under Advanced', async ({ page, api }) => {
  const type = await api.createProductType({ topology: 'bus', addressing: 'knx_individual', defaultBusCurrentMa: 10, busDevicesMax: 64 })
  await page.goto(listPath)
  await expect(row(page, type.key)).toContainText('Bus')
  await expect(row(page, type.key)).toContainText('KNX individual address')
  await row(page, type.key).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit system' })
  await expect(dialog.getByLabel('Default bus current')).toHaveValue('10')
  await expect(dialog.getByLabel('Devices per line')).toHaveValue('64')
  await expect(dialog.getByLabel('Default wireless places')).toHaveCount(0)
  // At their defaults, voltage and reserve are tucked away.
  const advanced = dialog.getByRole('button', { name: /^Advanced/ })
  await expect(advanced).toHaveAttribute('aria-expanded', 'false')
  await expect(dialog.getByLabel(/^Reserve/)).toBeHidden()

  // Wireless: the bus settings go and are cleared, addressing offers EUI-64.
  await chooseOption(dialog.getByLabel('Topology'), 'Wireless')
  await expect(dialog.getByLabel('Default bus current')).toHaveCount(0)
  await dialog.getByLabel('Default wireless places').fill('2')
  await chooseOption(dialog.getByLabel('Addressing'), 'EUI-64 (Zigbee IEEE)')
  await advanced.click()
  await dialog.getByLabel(/^Reserve/).fill('30')
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()
  expect(await api.productType(type.id)).toMatchObject({ topology: 'wireless', addressing: 'eui64', defaultWirelessPlacesUsed: 2, reservePercent: 30, nominalVoltage: 230 })
  const stored = await api.productType(type.id)
  expect(stored.defaultBusCurrentMa ?? 0).toBe(0)
  expect(stored.busDevicesMax ?? 0).toBe(0)

  // A non-default reserve opens Advanced; None shows no topology settings and no addressing.
  await row(page, type.key).getByRole('button', { name: 'Edit' }).click()
  await expect(advanced).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.getByLabel(/^Reserve/)).toHaveValue('30')
  await chooseOption(dialog.getByLabel('Topology'), 'None')
  await expect(dialog.getByLabel('Addressing')).toHaveCount(0)
  await expect(dialog.getByLabel('Default wireless places')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()
  expect(await api.productType(type.id)).toMatchObject({ topology: 'none', addressing: 'none' })
  await expect(row(page, type.key).getByRole('cell').nth(4)).toHaveText('–')
})

for (const role of ['user', 'tenant_admin'] as const) {
  test(`a ${role} sees product types read-only`, async ({ api, sessionFor }) => {
    const type = await api.createProductType({ abbreviation: 'RO', color: '#d1242f' })
    const tenant = role === 'tenant_admin' ? await api.createTenant() : undefined
    const account = await api.createUser({ role, tenantId: tenant?.id })
    const page = await sessionFor(account)

    await page.goto('/')
    await navigate(page, 'Setup', 'Systems')
    await expect(page.getByRole('heading', { name: 'Systems', level: 1 })).toBeVisible()
    await expect(row(page, type.key)).toContainText(`RO${type.name.en}`)
    await expect(page.getByRole('button', { name: /New system|Edit|Delete|^Move / })).toHaveCount(0)
  })
}

test('the list in German', async ({ page, api }) => {
  const type = await api.createProductType({ name: { en: unique('KNX'), de: unique('KNX DE') }, abbreviation: 'KNX' })
  await page.goto(listPath)
  await chooseLanguage(page, 'Deutsch')
  await expect(page.getByRole('heading', { name: 'Systeme', level: 1 })).toBeVisible()
  await expect(row(page, type.key)).toContainText(`KNX${type.name.de!}`)
  await expect(page.getByRole('columnheader')).toContainText(['Position', 'Name', 'Schlüssel', 'Status'])
  await row(page, type.key).getByRole('button', { name: 'Bearbeiten' }).click()
  const dialog = page.getByRole('dialog', { name: 'System bearbeiten' })
  await expect(dialog.getByLabel('Kürzel')).toHaveValue('KNX')
  await expect(dialog.getByText('Vorschau des Abzeichens')).toBeVisible()
  await dialog.getByRole('button', { name: 'Abbrechen' }).click()
})

// D446, D447: a system's readiness card names a board product without a
// width; the product page says what is missing; filling the width there
// turns the card green.
test('a readiness card shows a missing width, fixed on the product the card goes green', async ({ page, api }) => {
  const tag = uniqueKey('').replace(/^_+/, '').slice(-6)
  const post = async <T,>(path: string, data: unknown): Promise<T> => {
    const res = await api.ctx.post(path, { data })
    expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const systemName = `Bus ${tag}`
  const system = await post<{ id: string }>('/api/product-types', {
    key: `bus_${tag}`, name: { en: systemName }, isActive: true, topology: 'bus', defaultBusCurrentMa: 10,
  })
  const fields = { width: `width_${tag}`, supply: `supply_${tag}`, rows: `rows_${tag}` }
  await post('/api/catalog-fields', { key: fields.width, label: { en: 'Width' }, type: 'number', unit: 'TE', meaning: 'rail_width_te' })
  await post('/api/catalog-fields', { key: fields.supply, label: { en: 'Supply' }, type: 'number', meaning: 'bus_current_supplied_ma' })
  await post('/api/catalog-fields', { key: fields.rows, label: { en: 'Rows' }, type: 'integer', meaning: 'enclosure_rows' })
  const attr = (key: string, type: string, fieldKey: string) => ({ key, label: { en: key[0].toUpperCase() + key.slice(1) }, type, fieldKey })
  const category = await post<{ id: string }>('/api/categories', {
    key: `board_${tag}`, name: { en: `Board ${tag}` }, isActive: true, mounting: 'board', instanceAttributes: [],
    attributes: [attr('width', 'number', fields.width), attr('supply', 'number', fields.supply), attr('rows', 'integer', fields.rows)],
  })
  const ids = { productTypeId: system.id, categoryId: category.id }
  await api.createProduct({ ...ids, modelNumber: `PS-${tag}`, attributes: { supply: 640, width: 4 } })
  await api.createProduct({ ...ids, modelNumber: `ENC-${tag}`, attributes: { rows: 3 } })
  const actuator = await api.createProduct({ ...ids, modelNumber: `ACT-${tag}`, name: { en: `Actuator ${tag}` } })

  await page.goto('/catalog/product-types')
  await expect(page.getByText('What SnapFlow still needs before this system works in a project.')).toBeVisible()
  const card = page.getByRole('listitem', { name: systemName })
  await expect(card).toContainText('Products on the board without a width (TE)')
  await card.getByRole('link', { name: `ACT-${tag}` }).click()

  await expect(page.getByRole('heading', { name: 'Edit product' })).toBeVisible()
  await expect(page.getByTestId('still-missing')).toContainText('Width on the DIN rail (TE): the board cannot place it without one')
  await page.getByRole('textbox', { name: /^Width/ }).fill('2')
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(page.getByTestId('still-missing')).toHaveCount(0)
  expect((await api.product(actuator.id)).attributes).toMatchObject({ width: 2 })

  await page.goto('/catalog/product-types')
  await expect(page.getByRole('listitem', { name: systemName })).toContainText('Ready: nothing missing')
})
