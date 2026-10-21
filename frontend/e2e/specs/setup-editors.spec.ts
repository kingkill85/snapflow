import { chooseOption, expect, row, test, translation, unique, uniqueKey } from '../fixtures'

// Step 4a-2 click-through (D443, D444): a KNX system through the topology-driven
// editor, and a function's channel kinds edited from both sides.

test('a KNX system: bus settings, Advanced tucked away, switching to wireless', async ({ page, api }) => {
  const key = uniqueKey('knx_test')
  const name = unique('KNX test')
  await page.goto('/catalog/product-types')
  await page.getByRole('button', { name: 'New system' }).first().click()
  const create = page.getByRole('dialog', { name: 'New system' })
  await create.getByLabel('Key').fill(key)
  await (await translation(create, 'Name', 'en')).fill(name)
  await chooseOption(create.getByLabel('Topology'), 'Bus')
  await chooseOption(create.getByLabel('Addressing'), 'KNX individual address')
  await create.getByLabel('Default bus current').fill('10')
  await create.getByLabel('Devices per line').fill('64')
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(create).toBeHidden()

  await row(page, key).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit system' })
  await expect(dialog.getByLabel('Topology')).toContainText('Bus')
  await expect(dialog.getByLabel('Addressing')).toContainText('KNX individual address')
  await expect(dialog.getByLabel('Default bus current')).toHaveValue('10')
  await expect(dialog.getByLabel('Devices per line')).toHaveValue('64')
  await expect(dialog.getByRole('button', { name: /^Advanced/ })).toHaveAttribute('aria-expanded', 'false')

  await chooseOption(dialog.getByLabel('Topology'), 'Wireless')
  await expect(dialog.getByLabel('Default bus current')).toHaveCount(0)
  await expect(dialog.getByLabel('Devices per line')).toHaveCount(0)
  await expect(dialog.getByLabel('Addressing')).toContainText('None')
  await dialog.getByLabel('Addressing').click()
  await expect(page.getByRole('option')).toHaveText(['None', 'EUI-64 (Zigbee IEEE)'])
  await page.getByRole('option', { name: 'EUI-64 (Zigbee IEEE)' }).click()
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, key)).toContainText('Wireless')
  await expect(row(page, key)).toContainText('EUI-64 (Zigbee IEEE)')
  const stored = (await api.productTypes()).find((t) => t.key === key)
  expect(stored).toMatchObject({ topology: 'wireless', addressing: 'eui64' })
  expect(stored?.defaultBusCurrentMa ?? 0).toBe(0)
  expect(stored?.busDevicesMax ?? 0).toBe(0)
})

test('a function and its channel kinds agree from both sides; a rename keeps the links', async ({ page, api }) => {
  const [aName, bName] = [unique('Click kind A'), unique('Click kind B')]
  const a = await api.createOutputKind(uniqueKey('click_a'), aName)
  const b = await api.createOutputKind(uniqueKey('click_b'), bName)
  const key = uniqueKey('light_test')
  await page.goto('/catalog/function-types')
  await page.getByRole('button', { name: 'New function' }).first().click()
  const create = page.getByRole('dialog', { name: 'New function' })
  await create.getByLabel('Key').fill(key)
  await (await translation(create, 'Name', 'en')).fill('Light test')
  await create.getByRole('checkbox', { name: aName }).check()
  await create.getByRole('checkbox', { name: bName }).check()
  await create.getByRole('button', { name: 'Create' }).click()
  await expect(create).toBeHidden()
  await expect(row(page, key)).toContainText(`${aName}, ${bName}`)

  // The channel kind side: ticked there; untick it.
  await page.goto('/catalog/output-kinds')
  await row(page, aName).getByRole('button', { name: 'Edit' }).click()
  const kind = page.getByRole('dialog', { name: 'Edit channel kind' })
  const serves = kind.getByRole('checkbox', { name: 'Light test' })
  await expect(serves).toBeChecked()
  await serves.uncheck()
  await kind.getByRole('button', { name: 'Update' }).click()
  await expect(kind).toBeHidden()

  // The function side agrees.
  await page.goto('/catalog/function-types')
  await expect(row(page, key)).not.toContainText(aName)
  await expect(row(page, key)).toContainText(bName)
  await row(page, key).getByRole('button', { name: 'Edit' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit function' })
  await expect(edit.getByRole('checkbox', { name: aName })).not.toBeChecked()
  await expect(edit.getByRole('checkbox', { name: bName })).toBeChecked()

  // Only the name changes: the links stay.
  await (await translation(edit, 'Name', 'en')).fill('Light test renamed')
  await edit.getByRole('button', { name: 'Update' }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, key)).toContainText('Light test renamed')
  await expect(row(page, key)).toContainText(bName)
  const created = ((await api.ctx.get('/api/function-types').then((r) => r.json())) as { items: { id: string; key: string }[] }).items.find((f) => f.key === key)!
  expect((await api.functionType(created.id)).outputKindIds).toEqual([b.id])
  expect((await api.ctx.get(`/api/output-kinds/${a.id}`).then((r) => r.json())).functionTypeIds).not.toContain(created.id)
})
