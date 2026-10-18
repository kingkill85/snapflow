import { admin } from '../env'
import { expect, row, signIn, test, unique, uniqueEmail } from '../fixtures'

// Admin: user management.
test.beforeEach(async ({ page }) => {
  await page.goto('/admin/users')
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
})

test('create a tenant admin in a partner tenant and filter by tenant', async ({ page, api }) => {
  const tenant = await api.createTenant()
  const other = await api.createUser()
  await page.reload()

  const email = uniqueEmail('partner-admin')
  const name = unique('Partner Admin')
  await page.getByRole('button', { name: 'New user' }).click()
  const dialog = page.getByRole('dialog', { name: 'New user' })
  await dialog.getByLabel('Email').fill(email)
  await dialog.getByLabel('Full name').fill(name)
  await expect(dialog.getByLabel('Role').locator('option')).toHaveText(['Admin', 'Tenant admin', 'User'])
  await dialog.getByLabel('Role').selectOption({ label: 'Tenant admin' })
  await dialog.getByLabel('Tenant').selectOption({ label: tenant.name })
  await dialog.getByLabel('Password').fill('partner-password')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const created = row(page, email)
  await expect(created).toContainText(name)
  await expect(created).toContainText(tenant.name)
  await expect(created).toContainText('Tenant admin')
  await expect(created).toContainText('Active')

  await page.getByLabel('Tenant').selectOption({ label: tenant.name })
  await expect(page.getByRole('row')).toHaveCount(2) // header + the new user
  await expect(created).toBeVisible()
  await expect(row(page, other.email)).toHaveCount(0)

  // New users are preselected in the filtered tenant.
  await page.getByRole('button', { name: 'New user' }).click()
  await expect(dialog.getByLabel('Tenant')).toHaveValue(tenant.id)
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await page.getByLabel('Tenant').selectOption({ label: 'All tenants' })
  await expect(row(page, other.email)).toBeVisible()

  // The new tenant admin can sign in.
  await page.context().clearCookies()
  await page.goto('/login')
  await signIn(page, email, 'partner-password')
  await expect(page.getByRole('link', { name: new RegExp(name) })).toContainText(tenant.name)
})

test('form validation: missing password, short password, taken email', async ({ page, api }) => {
  const existing = await api.createUser()
  await page.getByRole('button', { name: 'New user' }).click()
  const dialog = page.getByRole('dialog', { name: 'New user' })
  await dialog.getByLabel('Email').fill(uniqueEmail())
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByLabel('Password')).toHaveAccessibleDescription('This field is required.')
  await dialog.getByLabel('Password').fill('short')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByLabel('Password')).toHaveAccessibleDescription('The password needs at least 8 characters.')

  await dialog.getByLabel('Email').fill(existing.email)
  await dialog.getByLabel('Password').fill('long-enough-password')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(`The email address ${existing.email} is already used.`)
  await expect(dialog).toBeVisible()
})

test('edit a user: role and name', async ({ page, api }) => {
  const user = await api.createUser({ role: 'user' })
  await page.reload()
  await row(page, user.email).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit user' })
  await expect(dialog.getByLabel('Email')).toHaveValue(user.email)
  await expect(dialog.getByLabel('Role')).toHaveValue('user')
  const name = unique('Edited')
  await dialog.getByLabel('Full name').fill(name)
  await dialog.getByLabel('Role').selectOption({ label: 'Tenant admin' })
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, user.email)).toContainText(name)
  await expect(row(page, user.email)).toContainText('Tenant admin')
})

test('resetting a password ends that user’s sessions', async ({ page, api, sessionFor }) => {
  const user = await api.createUser()
  const theirPage = await sessionFor(user)
  await theirPage.goto('/profile')
  await expect(theirPage.getByRole('heading', { name: 'Profile' })).toBeVisible()

  await page.reload()
  await row(page, user.email).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit user' })
  await expect(dialog.getByLabel('Password')).toHaveAccessibleDescription(
    'Leave empty to keep the current password. Setting one signs the user out.',
  )
  await dialog.getByLabel('Password').fill('a-brand-new-password')
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()

  await theirPage.reload()
  await expect(theirPage).toHaveURL(/\/login\?returnTo=%2Fprofile$/)
  await signIn(theirPage, user.email, user.password)
  await expect(theirPage.getByRole('alert')).toHaveText('Email or password is wrong.')
  await signIn(theirPage, user.email, 'a-brand-new-password')
  await expect(theirPage).toHaveURL(/\/profile$/)
})

test('a deactivated user cannot sign in', async ({ page, api, anonymous }) => {
  const user = await api.createUser()
  await page.reload()
  await row(page, user.email).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit user' })
  await dialog.getByLabel('Active').uncheck()
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, user.email)).toContainText('Inactive')

  const theirPage = await anonymous()
  await theirPage.goto('/login')
  await signIn(theirPage, user.email, user.password)
  await expect(theirPage.getByRole('alert')).toHaveText('Your account is disabled. Please contact your administrator.')
  // A wrong password does not reveal the flag.
  await signIn(theirPage, user.email, 'wrong-password')
  await expect(theirPage.getByRole('alert')).toHaveText('Email or password is wrong.')
})

test('deactivating a signed-in user ends their access at once', async ({ page, api, sessionFor }) => {
  const user = await api.createUser()
  const theirPage = await sessionFor(user)
  await theirPage.goto('/admin/roles')
  await expect(theirPage.getByRole('heading', { name: 'Roles' })).toBeVisible()

  await page.reload()
  await row(page, user.email).getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit user' })
  await dialog.getByLabel('Active').uncheck()
  await dialog.getByRole('button', { name: 'Update' }).click()
  await expect(dialog).toBeHidden()

  await theirPage.reload()
  await expect(theirPage).toHaveURL(/\/login/)
})

test('delete a user', async ({ page, api }) => {
  const user = await api.createUser()
  await page.reload()
  await row(page, user.email).getByRole('button', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete user' })
  await expect(dialog).toContainText(`Delete ${user.fullName}? This cannot be undone.`)
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(dialog).toBeHidden()
  await expect(row(page, user.email)).toHaveCount(0)
})

test('editing yourself hides role, tenant, active and password', async ({ page }) => {
  const self = row(page, admin.email)
  await expect(self.getByRole('button', { name: 'Delete' })).toHaveCount(0)
  await self.getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit user' })
  await expect(dialog.getByLabel('Email')).toHaveValue(admin.email)
  await expect(dialog.getByLabel('Full name')).toBeVisible()
  await expect(dialog.getByLabel('Role')).toHaveCount(0)
  await expect(dialog.getByLabel('Tenant')).toHaveCount(0)
  await expect(dialog.getByLabel('Active')).toHaveCount(0)
  await expect(dialog.getByLabel('Password')).toHaveCount(0)
  await expect(dialog.getByText('You change your own password on your profile.')).toBeVisible()
  await dialog.getByRole('link', { name: 'Open profile' }).click()
  await expect(page).toHaveURL(/\/profile$/)
  await expect(dialog).toBeHidden()
})
