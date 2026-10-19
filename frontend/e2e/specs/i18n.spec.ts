import { accountButton, chooseLanguage, expect, navEntries, test, userMenu } from '../fixtures'

test('switching to Deutsch translates the UI and survives a reload', async ({ page }) => {
  await page.goto('/admin/tenants')
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible()
  await chooseLanguage(page, 'Deutsch')

  await expect(page.getByRole('heading', { name: 'Mandanten' })).toBeVisible()
  expect(await navEntries(page)).toEqual({
    Projekte: ['Projekte'],
    Katalog: ['Produkte', 'Kategorien', 'Produkttypen', 'Funktionstypen', 'Import'],
    Verwaltung: ['Benutzer', 'Mandanten', 'Rollen', 'Firmenprofil'],
  })
  await expect(page.getByRole('button', { name: 'Neuer Mandant' })).toBeVisible()
  await expect(accountButton(page)).toHaveAccessibleName(/^Konto: /)
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Mandanten' })).toBeVisible()
  await expect((await userMenu(page)).getByRole('menuitemradio', { name: 'Deutsch' })).toBeChecked()
  await page.keyboard.press('Escape')

  await chooseLanguage(page, 'English')
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible()
})

test('the theme choice applies at once and survives a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/admin/tenants')
  const html = page.locator('html')
  await expect(html).not.toHaveAttribute('data-theme')
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const light = await background()

  let menu = await userMenu(page)
  await expect(menu.getByRole('menuitemradio', { name: 'System' })).toBeChecked()
  await menu.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  expect(await background()).not.toBe(light)
  await page.keyboard.press('Escape')

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  menu = await userMenu(page)
  await expect(menu.getByRole('menuitemradio', { name: 'Dark' })).toBeChecked()

  // System follows the operating system again.
  await menu.getByRole('menuitemradio', { name: 'System' }).click()
  await expect(html).not.toHaveAttribute('data-theme')
  expect(await background()).toBe(light)
  await page.reload()
  await expect(html).not.toHaveAttribute('data-theme')
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
