import { accountButton, expect, signIn, signOut, test, unique, uniqueEmail } from '../fixtures'

// The profile page, for a user of each kind (here: a plain user).
test('change name and email', async ({ api, sessionFor }) => {
  const user = await api.createUser()
  const page = await sessionFor(user)
  await page.goto('/profile')
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible()
  await expect(page.getByText('User · E2E Distributor')).toBeVisible()
  const header = accountButton(page)
  await expect(header).toHaveAccessibleName(`Account: ${user.fullName}`)

  const name = unique('New Name')
  const email = uniqueEmail('changed')
  await page.getByLabel('Full name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status')).toHaveText('Saved.')
  await expect(header).toHaveAccessibleName(`Account: ${name}`)

  await page.reload()
  await expect(page.getByLabel('Full name')).toHaveValue(name)
  await expect(page.getByLabel('Email')).toHaveValue(email)

  // The new email signs in, the old one no longer does.
  await signOut(page)
  await signIn(page, user.email, user.password)
  await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.')
  await signIn(page, email, user.password)
  await expect(accountButton(page)).toBeVisible()
})

test('an email used by someone else is refused', async ({ api, sessionFor }) => {
  const other = await api.createUser()
  const user = await api.createUser()
  const page = await sessionFor(user)
  await page.goto('/profile')
  await page.getByLabel('Email').fill(other.email)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('alert')).toHaveText(`The email address ${other.email} is already used.`)
})

test('change password: wrong current password, then success; other sessions end', async ({ api, sessionFor }) => {
  const user = await api.createUser()
  const page = await sessionFor(user)
  const otherDevice = await sessionFor(user)
  await otherDevice.goto('/admin/roles')
  await expect(otherDevice.getByRole('heading', { name: 'Roles' })).toBeVisible()

  await page.goto('/profile')
  const current = page.getByLabel('Current password', { exact: true })
  const next = page.getByLabel('New password', { exact: true })
  const repeat = page.getByLabel('Repeat new password', { exact: true })

  await current.fill('not-my-password')
  await next.fill('my-new-password')
  await repeat.fill('my-new-password-typo')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(repeat).toHaveAccessibleDescription('The passwords do not match.')

  await repeat.fill('my-new-password')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(current).toHaveAccessibleDescription('The current password is wrong.')

  await current.fill(user.password)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('status')).toHaveText('Password changed.')
  await expect(current).toHaveValue('')

  // This session stays, the other one ends.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible()
  await otherDevice.reload()
  await expect(otherDevice).toHaveURL(/\/login\?returnTo=%2Fadmin%2Froles$/)
  await signIn(otherDevice, user.email, 'my-new-password')
  await expect(otherDevice).toHaveURL(/\/admin\/roles$/)
})

test('sign out everywhere ends every session', async ({ api, sessionFor }) => {
  const user = await api.createUser({ role: 'tenant_admin' })
  const page = await sessionFor(user)
  const otherDevice = await sessionFor(user)
  await otherDevice.goto('/admin/users')
  await expect(otherDevice.getByRole('heading', { name: 'Users' })).toBeVisible()

  await page.goto('/profile')
  await page.getByRole('button', { name: 'Sign out everywhere' }).click()
  const dialog = page.getByRole('dialog', { name: 'Sign out everywhere' })
  await expect(dialog).toContainText('Sign out on every device, including this one?')
  await dialog.getByRole('button', { name: 'Sign out everywhere' }).click()
  await expect(page).toHaveURL(/\/login$/)

  // The other device notices on its next request.
  await otherDevice.getByRole('button', { name: 'New user' }).click()
  await otherDevice.getByRole('dialog', { name: 'New user' }).getByLabel('Email').fill(uniqueEmail())
  await otherDevice.getByRole('dialog', { name: 'New user' }).getByLabel('Password').fill('some-password')
  await otherDevice.getByRole('dialog', { name: 'New user' }).getByRole('button', { name: 'Create' }).click()
  await expect(otherDevice).toHaveURL(/\/login\?returnTo=%2Fadmin%2Fusers$/)

  await page.goto('/profile')
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fprofile$/)
})
