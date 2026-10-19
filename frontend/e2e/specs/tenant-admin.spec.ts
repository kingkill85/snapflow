import { admin } from '../env'
import { expect, navEntries, navigate, optionTexts, row, test, uniqueEmail } from '../fixtures'

// What a tenant admin sees and may do.
test('a partner tenant admin manages only their own tenant', async ({ api, sessionFor }) => {
  const tenant = await api.createTenant()
  const tenantAdmin = await api.createUser({ role: 'tenant_admin', tenantId: tenant.id })
  const colleague = await api.createUser({ role: 'user', tenantId: tenant.id })
  const outsider = await api.createUser({ role: 'user' })

  const page = await sessionFor(tenantAdmin)
  await page.goto('/')
  expect(await navEntries(page)).toEqual({ Projects: ['Projects'], Catalog: ['Products', 'Categories', 'Product types', 'Function types', 'Fields', 'Output kinds', 'Load types', 'Room templates'], Administration: ['Users', 'Roles', 'Company profile'] })

  await navigate(page, 'Administration', 'Users')
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
  await expect(page.getByRole('row')).toHaveCount(3) // header, the tenant admin, the colleague
  await expect(row(page, tenantAdmin.email)).toBeVisible()
  await expect(row(page, colleague.email)).toBeVisible()
  await expect(row(page, outsider.email)).toHaveCount(0)
  // One tenant only: no tenant filter or column.
  await expect(page.getByLabel('Tenant')).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Tenant' })).toHaveCount(0)

  // Creating a user: only roles up to their own, always in their tenant.
  await page.getByRole('button', { name: 'New user' }).click()
  const dialog = page.getByRole('dialog', { name: 'New user' })
  expect(await optionTexts(dialog.getByLabel('Role'))).toEqual(['Tenant admin', 'User'])
  await expect(dialog.getByLabel('Tenant')).toHaveCount(0)
  const email = uniqueEmail('colleague')
  await dialog.getByLabel('Email').fill(email)
  await dialog.getByLabel('Password').fill('colleague-password')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, email)).toContainText('User')
  const created = (await api.users(tenant.id)).find((u) => u.email === email)
  expect(created?.tenantId).toBe(tenant.id)

  // Rows of the same or a lower role can be changed.
  await expect(row(page, colleague.email).getByRole('button', { name: 'Edit' })).toBeVisible()
  await expect(row(page, colleague.email).getByRole('button', { name: 'Delete' })).toBeVisible()
  await expect(row(page, tenantAdmin.email).getByRole('button', { name: 'Delete' })).toHaveCount(0)
})

test('a tenant admin in the distributor tenant cannot change admins', async ({ api, sessionFor }) => {
  const tenantAdmin = await api.createUser({ role: 'tenant_admin' })
  const page = await sessionFor(tenantAdmin)
  await page.goto('/admin/users')
  const adminRow = row(page, admin.email)
  await expect(adminRow).toContainText('Admin')
  await expect(adminRow.getByRole('button', { name: 'Edit' })).toHaveCount(0)
  await expect(adminRow.getByRole('button', { name: 'Delete' })).toHaveCount(0)
})

test('a tenant admin has no access to tenants', async ({ api, sessionFor }) => {
  const tenantAdmin = await api.createUser({ role: 'tenant_admin' })
  const page = await sessionFor(tenantAdmin)
  await page.goto('/admin/tenants')
  await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible()
  await expect(page.getByText('You do not have permission to see this page.')).toBeVisible()
  expect(await navEntries(page)).toEqual({ Projects: ['Projects'], Catalog: ['Products', 'Categories', 'Product types', 'Function types', 'Fields', 'Output kinds', 'Load types', 'Room templates'], Administration: ['Users', 'Roles', 'Company profile'] })
})
