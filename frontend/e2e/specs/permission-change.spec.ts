import { chooseOption, expect, navEntries, row, test, uniqueEmail } from '../fixtures'

// Role changes apply to a signed-in user without a new login.
test('a demoted tenant admin loses user management on their next action', async ({ page, api, sessionFor }) => {
  const tenantAdmin = await api.createUser({ role: 'tenant_admin' })
  const theirPage = await sessionFor(tenantAdmin)
  await theirPage.goto('/admin/users')
  expect(await navEntries(theirPage)).toEqual({ Catalog: ['Products', 'Categories', 'Product types', 'Function types'], Administration: ['Users', 'Roles'] })
  // They start creating a user...
  await theirPage.getByRole('button', { name: 'New user' }).click()
  const theirDialog = theirPage.getByRole('dialog', { name: 'New user' })
  await theirDialog.getByLabel('Email').fill(uniqueEmail())
  await theirDialog.getByLabel('Password').fill('some-password')

  // ...while the admin demotes them.
  await page.goto('/admin/users')
  await row(page, tenantAdmin.email).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit user' })
  await chooseOption(dialog.getByLabel('Role'), 'User')
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, tenantAdmin.email)).toContainText('User')

  // Their next action is refused; the app reloads their permissions.
  await theirDialog.getByRole('button', { name: 'Create' }).click()
  await expect(theirPage.getByRole('heading', { name: 'No access' })).toBeVisible()
  expect(await navEntries(theirPage)).toEqual({ Catalog: ['Products', 'Categories', 'Product types', 'Function types'], Roles: ['Roles'] })
})

test('a promoted user gets user management after a reload', async ({ page, api, sessionFor }) => {
  const user = await api.createUser({ role: 'user' })
  const theirPage = await sessionFor(user)
  await theirPage.goto('/admin/roles')
  expect(await navEntries(theirPage)).toEqual({ Catalog: ['Products', 'Categories', 'Product types', 'Function types'], Roles: ['Roles'] })

  await page.goto('/admin/users')
  await row(page, user.email).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit user' })
  await chooseOption(dialog.getByLabel('Role'), 'Tenant admin')
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()

  await theirPage.reload()
  expect(await navEntries(theirPage)).toEqual({ Catalog: ['Products', 'Categories', 'Product types', 'Function types'], Administration: ['Users', 'Roles'] })
})
