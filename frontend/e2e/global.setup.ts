import { expect, test as setup } from '@playwright/test'

import { admin, adminStorageState } from './env'

// Signs the e2e admin in once through the UI; specs reuse the session.
setup('sign in as admin', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('Email').fill(admin.email)
  await page.getByLabel('Password').fill(admin.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
  await page.context().storageState({ path: adminStorageState })
})
