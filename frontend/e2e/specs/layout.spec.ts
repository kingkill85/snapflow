import { type Page } from '@playwright/test'

import { expect, test } from '../fixtures'

// Key pages at phone and desktop width, in light and dark mode: nothing may
// overflow the viewport horizontally (tables scroll inside their own box).
// Screenshots land in e2e/screenshots/ for a look by eye.
const pages = [
  { name: 'function-types', path: '/catalog/function-types', heading: 'Function types' },
  { name: 'users', path: '/admin/users', heading: 'Users' },
  { name: 'tenants', path: '/admin/tenants', heading: 'Tenants' },
  { name: 'roles', path: '/admin/roles', heading: 'Roles' },
  { name: 'profile', path: '/profile', heading: 'Profile' },
]

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'tablet', size: { width: 768, height: 1024 } },
  { name: 'desktop', size: { width: 1280, height: 800 } },
]

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const viewport of viewports) {
    test.describe(`${viewport.name}, ${colorScheme}`, () => {
      test.use({ colorScheme, viewport: viewport.size })

      test('app pages fit the screen', async ({ page, api }) => {
        // Something to delete, and a long name in the table.
        await api.createUser({ fullName: 'Maximilian Alexander Mustermann-Schmidt' })
        for (const p of pages) {
          await page.goto(p.path)
          await expect(page.getByRole('heading', { name: p.heading, level: 1 })).toBeVisible()
          await expect(page.getByText('Loading…')).toHaveCount(0)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/${p.name}-${viewport.name}-${colorScheme}.png`, fullPage: true })
        }

        await page.goto('/admin/users')
        await page.getByRole('button', { name: 'New user' }).click()
        const dialog = page.getByRole('dialog', { name: 'New user' })
        await dialog.getByRole('button', { name: 'Create' }).click()
        await expect(dialog.getByLabel('Email')).toHaveAccessibleDescription('Enter a valid email address.')
        await expectNoHorizontalOverflow(page)
        await page.screenshot({ path: `e2e/screenshots/user-dialog-${viewport.name}-${colorScheme}.png` })
        await dialog.getByRole('button', { name: 'Cancel' }).click()

        await page.getByRole('button', { name: 'Delete' }).first().click()
        await expect(page.getByRole('dialog', { name: 'Delete user' })).toBeVisible()
        await page.screenshot({ path: `e2e/screenshots/delete-dialog-${viewport.name}-${colorScheme}.png` })
      })

      test.describe('signed out', () => {
        test.use({ storageState: { cookies: [], origins: [] } })

        test('login page fits the screen', async ({ page }) => {
          await page.goto('/login')
          await page.getByRole('button', { name: 'Sign in' }).click()
          await expect(page.getByLabel('Email')).toHaveAccessibleDescription('This field is required.')
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/login-${viewport.name}-${colorScheme}.png`, fullPage: true })
        })
      })
    })
  }
}
