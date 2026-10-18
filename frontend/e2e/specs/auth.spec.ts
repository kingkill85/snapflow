import { admin } from '../env'
import { accountButton, expect, nav, signIn, signOut, test, uniqueEmail } from '../fixtures'

// Login, redirects, sign out and the login rate limit.
test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('a wrong password shows the error and keeps the user on the login page', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await signIn(page, admin.email, 'not-the-password')
    await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.')
    await expect(page).toHaveURL(/\/login$/)
  })

  test('empty fields are required', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByLabel('Email')).toHaveAccessibleDescription('This field is required.')
    await expect(page.getByLabel('Password')).toHaveAccessibleDescription('This field is required.')
  })

  test('a correct login lands on the first page the user may see', async ({ page, api }) => {
    const user = await api.createUser({ role: 'user' })
    await page.goto('/')
    await expect(page).toHaveURL(/\/login\?returnTo=%2F$/)
    await signIn(page, user.email, user.password)
    await expect(page).toHaveURL(/\/catalog\/function-types$/)
    await expect(page.getByRole('heading', { name: 'Function types' })).toBeVisible()
    await expect(accountButton(page)).toHaveAccessibleName(`Account: ${user.fullName}`)
  })

  test('emails are case-insensitive', async ({ page, api }) => {
    const user = await api.createUser()
    await page.goto('/login')
    await signIn(page, user.email.toUpperCase(), user.password)
    await expect(accountButton(page)).toBeVisible()
  })

  test('a deep link opened while signed out is honoured after login', async ({ page }) => {
    await page.goto('/admin/tenants')
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fadmin%2Ftenants$/)
    await signIn(page, admin.email, admin.password)
    await expect(page).toHaveURL(/\/admin\/tenants$/)
    await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible()
  })

  test('a returnTo pointing to another site is ignored', async ({ page, api }) => {
    const user = await api.createUser()
    await page.goto('/login?returnTo=//evil.example')
    await signIn(page, user.email, user.password)
    await expect(page).toHaveURL(/\/catalog\/function-types$/)
  })

  test('ten failed logins for one email lead to "Too many attempts"', async ({ page }) => {
    const email = uniqueEmail('limited')
    await page.goto('/login')
    for (let i = 0; i < 10; i++) {
      await signIn(page, email, `wrong-password-${i}`)
      await expect(page.getByRole('alert')).toHaveText('Email or password is wrong.')
    }
    await signIn(page, email, 'wrong-password-again')
    await expect(page.getByRole('alert')).toHaveText(/^Too many attempts\. Try again in \d+ seconds\.$/)
  })
})

test('a signed-in user visiting /login is sent on', async ({ page }) => {
  await page.goto('/login')
  await expect(page).toHaveURL(/\/catalog\/function-types$/)
})

test('a signed-in user visiting /login?returnTo goes there', async ({ page }) => {
  await page.goto('/login?returnTo=%2Fadmin%2Froles')
  await expect(page).toHaveURL(/\/admin\/roles$/)
})

test('sign out returns to the login page and protected pages need a login again', async ({ sessionFor, api }) => {
  const user = await api.createUser({ role: 'tenant_admin' })
  const page = await sessionFor(user)
  await page.goto('/admin/users')
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
  await signOut(page)
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  await page.goto('/admin/users')
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fadmin%2Fusers$/)
  await expect(nav(page)).toBeHidden()
})
