import { expect, row, test, unique, uniqueKey, translation } from '../fixtures'

test('an unknown URL shows the not-found page', async ({ page }) => {
  await page.goto('/projects/123/does-not-exist')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await page.getByRole('link', { name: 'Go to start page' }).click()
  await expect(page).toHaveURL(/\/projects$/)
})

test('function types: create, duplicate key, edit, delete', async ({ page }) => {
  const key = `e2e_${Date.now().toString(36)}`
  const name = unique('Dimmer')
  await page.goto('/catalog/function-types')
  await expect(page.getByRole('heading', { name: 'Functions' })).toBeVisible()

  await page.getByRole('button', { name: 'New function' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New function' })
  await dialog.getByLabel('Key').fill('Not A Key')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByLabel('Key')).toHaveAccessibleDescription('Use lower case letters, digits and underscores, starting with a letter.')
  await expect(await translation(dialog, 'Name', 'en')).toHaveAccessibleDescription('This field is required.')

  await dialog.getByLabel('Key').fill(key)
  await (await translation(dialog, 'Name', 'en')).fill(name)
  await (await translation(dialog, 'Name', 'de')).fill(`${name} DE`)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, key)).toContainText(name)

  await page.getByRole('button', { name: 'New function' }).first().click()
  await dialog.getByLabel('Key').fill(key)
  await (await translation(dialog, 'Name', 'en')).fill('Duplicate')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(`The key "${key}" is already used.`)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  const renamed = unique('Switch')
  await row(page, key).getByRole('button', { name: 'Edit' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit function' })
  await expect(edit.getByLabel('Key')).toHaveValue(key)
  await (await translation(edit, 'Name', 'en')).fill(renamed)
  await edit.getByRole('button', { name: 'Update' }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, key)).toContainText(renamed)

  await row(page, key).getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete function' })
  await expect(confirm).toContainText(`Delete "${renamed}"?`)
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toBeHidden()
  await expect(row(page, key)).toHaveCount(0)
})

// D444: a function is made connectable from its own editor.
test('function types: served by channel kinds, from the function editor and in the list', async ({ page, api }) => {
  const [kindAName, kindBName] = [unique('Kind A'), unique('Kind B')]
  const kindA = await api.createOutputKind(uniqueKey('e2e_kind_a'), kindAName)
  const kindB = await api.createOutputKind(uniqueKey('e2e_kind_b'), kindBName)
  const key = uniqueKey('e2e_served')
  await page.goto('/catalog/function-types')

  await page.getByRole('button', { name: 'New function' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New function' })
  await dialog.getByLabel('Key').fill(key)
  await (await translation(dialog, 'Name', 'en')).fill(unique('Served'))
  const servedBy = dialog.getByRole('group', { name: 'Served by channel kinds' })
  await expect(servedBy).toContainText('No channel kind serves this function yet: needs of it cannot be connected.')
  await servedBy.getByRole('checkbox', { name: kindAName }).check()
  await servedBy.getByRole('checkbox', { name: kindBName }).check()
  await expect(servedBy).not.toContainText('No channel kind serves this function yet')
  // Details (load types, KNX objects) start collapsed for a new function.
  await expect(dialog.getByRole('button', { name: /^Details/ })).toHaveAttribute('aria-expanded', 'false')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, key)).toContainText(`${kindAName}, ${kindBName}`)
  const created = (await api.ctx.get('/api/function-types').then((r) => r.json())).items.find((f: { key: string }) => f.key === key) as { id: string }
  expect((await api.functionType(created.id)).outputKindIds).toEqual([kindA.id, kindB.id])
  // The channel kind side sees it too.
  expect((await api.ctx.get(`/api/output-kinds/${kindA.id}`).then((r) => r.json())).functionTypeIds).toContain(created.id)

  // Unticking both: the list warns that nothing serves it.
  await row(page, key).getByRole('button', { name: 'Edit' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit function' })
  await edit.getByRole('checkbox', { name: kindAName }).uncheck()
  await edit.getByRole('checkbox', { name: kindBName }).uncheck()
  await edit.getByRole('button', { name: 'Update' }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, key)).toContainText('Not served')
  expect((await api.functionType(created.id)).outputKindIds).toEqual([])
})
