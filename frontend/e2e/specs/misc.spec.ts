import { expect, row, test, unique } from '../fixtures'

test('an unknown URL shows the not-found page', async ({ page }) => {
  await page.goto('/projects/123/does-not-exist')
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  await page.getByRole('link', { name: 'Go to start page' }).click()
  await expect(page).toHaveURL(/\/catalog\/function-types$/)
})

test('function types: create, duplicate key, edit, delete', async ({ page }) => {
  const key = `e2e_${Date.now().toString(36)}`
  const name = unique('Dimmer')
  await page.goto('/catalog/function-types')
  await expect(page.getByRole('heading', { name: 'Function types' })).toBeVisible()

  await page.getByRole('button', { name: 'New function type' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New function type' })
  await dialog.getByLabel('Key').fill('Not A Key')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByLabel('Key')).toHaveAccessibleDescription('Use lower case letters, digits and underscores, starting with a letter.')
  await expect(dialog.getByLabel('Name (English)')).toHaveAccessibleDescription('This field is required.')

  await dialog.getByLabel('Key').fill(key)
  await dialog.getByLabel('Name (English)').fill(name)
  await dialog.getByLabel('Name (German)').fill(`${name} DE`)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, key)).toContainText(name)

  await page.getByRole('button', { name: 'New function type' }).first().click()
  await dialog.getByLabel('Key').fill(key)
  await dialog.getByLabel('Name (English)').fill('Duplicate')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(`The key "${key}" is already used.`)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  const renamed = unique('Switch')
  await row(page, key).getByRole('button', { name: 'Edit' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit function type' })
  await expect(edit.getByLabel('Key')).toHaveValue(key)
  await edit.getByLabel('Name (English)').fill(renamed)
  await edit.getByRole('button', { name: 'Update' }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, key)).toContainText(renamed)

  await row(page, key).getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete function type' })
  await expect(confirm).toContainText(`Delete "${renamed}"?`)
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toBeHidden()
  await expect(row(page, key)).toHaveCount(0)
})
