import { distributorName } from '../env'
import { expect, row, signIn, test, unique } from '../fixtures'

// Admin: tenant management.
test.beforeEach(async ({ page }) => {
  await page.goto('/admin/tenants')
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible()
})

test('create, rename, deactivate and reactivate a partner tenant', async ({ page }) => {
  const name = unique('Partner')
  await page.getByRole('button', { name: 'New tenant' }).click()
  const dialog = page.getByRole('dialog', { name: 'New tenant' })
  await dialog.getByLabel('Name').fill(name)
  await expect(dialog.getByLabel('Active')).toBeChecked()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, name)).toContainText('Partner')
  await expect(row(page, name)).toContainText('Active')

  const renamed = unique('Renamed')
  await row(page, name).getByRole('button', { name: 'Edit' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit tenant' })
  await expect(edit.getByLabel('Name')).toHaveValue(name)
  await edit.getByLabel('Name').fill(renamed)
  await edit.getByRole('button', { name: 'Update' }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, renamed)).toBeVisible()
  await expect(row(page, name)).toHaveCount(0)

  await row(page, renamed).getByRole('button', { name: 'Edit' }).click()
  await edit.getByLabel('Active').uncheck()
  await edit.getByRole('button', { name: 'Update' }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, renamed)).toContainText('Inactive')

  await row(page, renamed).getByRole('button', { name: 'Edit' }).click()
  await expect(edit.getByLabel('Active')).not.toBeChecked()
  await edit.getByLabel('Active').check()
  await edit.getByRole('button', { name: 'Update' }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, renamed)).not.toContainText('Inactive')
  await expect(row(page, renamed)).toContainText('Active')
})

test('a duplicate tenant name is refused', async ({ page, api }) => {
  const existing = await api.createTenant()
  await page.reload()
  await page.getByRole('button', { name: 'New tenant' }).click()
  const dialog = page.getByRole('dialog', { name: 'New tenant' })
  await dialog.getByLabel('Name').fill(existing.name)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(`A tenant named "${existing.name}" already exists.`)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})

test('the distributor cannot be deleted and always stays active', async ({ page }) => {
  const distributor = row(page, distributorName)
  await expect(distributor).toContainText('Distributor')
  await expect(distributor.getByRole('button', { name: 'Delete' })).toHaveCount(0)
  await distributor.getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit tenant' })
  await expect(dialog.getByText('The distributor tenant always stays active.')).toBeVisible()
  await expect(dialog.getByLabel('Active')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
})

test('users of an inactive tenant cannot sign in', async ({ api, anonymous }) => {
  const tenant = await api.createTenant(unique('Inactive'), false)
  const user = await api.createUser({ tenantId: tenant.id })
  const page = await anonymous()
  await page.goto('/login')
  await signIn(page, user.email, user.password)
  await expect(page.getByRole('alert')).toHaveText('Your account is disabled. Please contact your administrator.')
})

test('deleting a partner tenant deletes its users', async ({ page, api }) => {
  const tenant = await api.createTenant()
  const users = [await api.createUser({ tenantId: tenant.id, role: 'tenant_admin' }), await api.createUser({ tenantId: tenant.id })]
  await page.reload()

  await row(page, tenant.name).getByRole('button', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete tenant' })
  await expect(dialog).toContainText(`Delete "${tenant.name}" and all its users? This cannot be undone.`)
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, tenant.name)).toHaveCount(0)

  await page.getByRole('navigation').getByRole('link', { name: 'Users' }).click()
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
  await expect(page.getByRole('row').nth(1)).toBeVisible()
  for (const user of users) await expect(row(page, user.email)).toHaveCount(0)
  await expect(page.getByLabel('Tenant')).not.toContainText(tenant.name)
})
