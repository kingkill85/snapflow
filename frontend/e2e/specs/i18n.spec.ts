import { expect, nav, test } from '../fixtures'

test('switching to Deutsch translates the UI and survives a reload', async ({ page }) => {
  await page.goto('/admin/tenants')
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible()
  await page.getByLabel('Language').selectOption({ label: 'Deutsch' })

  await expect(page.getByRole('heading', { name: 'Mandanten' })).toBeVisible()
  await expect(nav(page).getByRole('link')).toHaveText(['Funktionstypen', 'Produkttypen', 'Produkte', 'Benutzer', 'Mandanten', 'Rollen'])
  await expect(page.getByRole('button', { name: 'Neuer Mandant' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Mandanten' })).toBeVisible()
  await expect(page.getByLabel('Sprache')).toHaveValue('de')

  await page.getByLabel('Sprache').selectOption({ label: 'English' })
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible()
})

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] }, locale: 'de-DE' })

  test('the login page follows the browser language', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible()
    await page.getByRole('button', { name: 'Anmelden' }).click()
    await expect(page.getByLabel('E-Mail')).toHaveAccessibleDescription('Dieses Feld ist erforderlich.')
  })
})
