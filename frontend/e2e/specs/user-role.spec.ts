import { expect, navEntries, navigate, row, test, unique } from '../fixtures'

// What a plain user sees.
test('a user sees the catalog read-only and the roles, nothing to manage', async ({ api, sessionFor }) => {
  const key = `ro_${Date.now().toString(36)}`
  const name = unique('Read only')
  await api.createFunctionType(key, name)
  const user = await api.createUser({ role: 'user' })

  const page = await sessionFor(user)
  await page.goto('/')
  await expect(page).toHaveURL(/\/catalog\/function-types$/)
  // A section with one page is a plain link.
  expect(await navEntries(page)).toEqual({ Catalog: ['Products', 'Product types', 'Function types'], Roles: ['Roles'] })

  await expect(row(page, key)).toContainText(name)
  await expect(page.getByRole('button', { name: 'New function type' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0)

  await navigate(page, 'Administration', 'Roles')
  await expect(page.getByRole('heading', { name: 'Roles' })).toBeVisible()
  await expect(page.getByRole('columnheader')).toHaveText(['Permission', 'Admin', 'Tenant admin', 'User'])
  const manageUsers = row(page, 'Manage users')
  await expect(manageUsers.getByRole('img', { name: 'Allowed', exact: true })).toHaveCount(2)
  await expect(manageUsers.getByRole('img', { name: 'Not allowed' })).toHaveCount(1)

  await page.goto('/admin/users')
  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible()
  await page.goto('/admin/tenants')
  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible()
})
