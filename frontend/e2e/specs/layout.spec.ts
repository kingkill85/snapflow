import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type Page } from '@playwright/test'

import { expect, test, unique } from '../fixtures'

// Key pages at phone and desktop width, in light and dark mode: nothing may
// overflow the viewport horizontally (tables scroll inside their own box).
// Screenshots land in e2e/screenshots/ for a look by eye.
const pages = [
  { name: 'function-types', path: '/catalog/function-types', heading: 'Function types' },
  { name: 'product-types', path: '/catalog/product-types', heading: 'Product types' },
  { name: 'product-type-new', path: '/catalog/product-types/new', heading: 'New product type' },
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

      test('the product type editor fits the screen', async ({ page, api }) => {
        const type = await api.createProductType({
          name: { en: 'Universal dimmer actuator with a rather long name for narrow screens' },
          color: '#1f6feb',
          attributes: [
            { key: 'nominal_power_per_channel', label: { en: 'Nominal power per channel at 230 V' }, type: 'number', unit: 'W', scope: 'variant', min: 0, max: 500, required: true },
            {
              key: 'colour',
              label: { en: 'Colour' },
              type: 'list',
              itemType: 'enum',
              scope: 'variant',
              options: [
                { key: 'white', label: { en: 'White', de: 'Weiß' } },
                { key: 'anthracite_grey', label: { en: 'Anthracite grey' } },
              ],
            },
          ],
          instanceAttributes: [{ key: 'bus_address', label: { en: 'Bus address' }, type: 'text', required: true }],
        })
        await page.goto(`/catalog/product-types/${type.id}`)
        await expect(page.getByRole('heading', { name: 'Edit product type', level: 1 })).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await page.screenshot({ path: `e2e/screenshots/product-type-collapsed-${viewport.name}-${colorScheme}.png`, fullPage: true })

        const attrs = page.getByRole('region', { name: 'Attributes', exact: true })
        await attrs.getByRole('button', { name: 'Expand all' }).click()
        // Errors at the fields, the cards marked.
        // An exponent is not a number here (a decimal comma is, D71).
        await attrs.getByLabel('Minimum', { exact: true }).fill('1e3')
        await page.getByRole('button', { name: 'Update' }).click()
        await expect(attrs.getByLabel('Minimum', { exact: true })).toHaveAccessibleDescription('Enter a number.')
        await expectNoHorizontalOverflow(page)
        await page.screenshot({ path: `e2e/screenshots/product-type-expanded-${viewport.name}-${colorScheme}.png`, fullPage: true })

        // The list with a coloured, long name; the read-only view of a user.
        await page.goto('/catalog/product-types')
        await expect(page.getByRole('row').filter({ hasText: type.key })).toBeVisible()
        await expectNoHorizontalOverflow(page)
      })

      test('the product pages fit the screen', async ({ page, api }) => {
        const image = await api.uploadFile('blue.png', 'image/png', readFileSync(fileURLToPath(new URL('../assets/blue.png', import.meta.url))))
        const type = await api.createProductType({
          name: { en: unique('Universal dimmer actuator with a rather long name') },
          color: '#1f6feb',
          attributes: [
            { key: 'nominal_power', label: { en: 'Nominal power per channel at 230 V' }, type: 'number', unit: 'W', scope: 'product', required: true },
            {
              key: 'protocols',
              label: { en: 'Supported protocols' },
              type: 'list',
              itemType: 'enum',
              scope: 'product',
              options: ['KNX', 'Zigbee', 'Matter', 'Thread', 'Bluetooth Low Energy', 'DALI-2'].map((en) => ({ key: en.toLowerCase().replace(/\W+/g, '_'), label: { en } })),
            },
            { key: 'tags', label: { en: 'Tags' }, type: 'list', itemType: 'text', scope: 'product' },
            { key: 'finish', label: { en: 'Surface finish' }, type: 'text', scope: 'variant' },
          ],
        })
        const product = await api.createProduct({
          productTypeId: type.id,
          modelNumber: unique('M485/GW-ZB.10-EXTRA-LONG').replace(/\s+/g, '-'),
          name: { en: 'Universal dimmer actuator, 4-fold, with manual operation and status LEDs' },
          attributes: { nominal_power: 500, protocols: ['knx', 'matter'], tags: ['flush mounted', 'professional series', 'DIN rail'] },
        })
        const sku = unique('SKU-M485-GW-ZB.10-IVORY-WHITE-GLOSSY').replace(/\s+/g, '-')
        const variant = await api.createVariant(product.id, { name: { en: 'Ivory white glossy with anthracite frame' }, sku, price: '1234567.89', imageFileId: image.id })
        const addon = await api.createVariant(product.id, { name: { en: 'Power supply 640 mA with integrated choke' }, price: '89.00' })
        await api.replaceAddons(product.id, variant.id, [{ addonVariantId: addon.id, required: true }])
        // Offered in the add-on picker.
        await api.createVariant(product.id, { name: { en: 'Design frame, 2-gang, anthracite' }, sku: `FRAME-${sku}`, price: '12.50' })

        await page.goto(`/catalog/products?type=${type.id}`)
        await expect(page.getByRole('row').filter({ hasText: product.modelNumber })).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await page.screenshot({ path: `e2e/screenshots/products-${viewport.name}-${colorScheme}.png`, fullPage: true })

        await page.goto(`/catalog/products/${product.id}`)
        await expect(page.getByRole('heading', { name: 'Edit product', level: 1 })).toBeVisible()
        await expect(page.getByRole('row').filter({ hasText: 'Ivory white glossy' })).toContainText(sku)
        await expectNoHorizontalOverflow(page)
        await page.screenshot({ path: `e2e/screenshots/product-${viewport.name}-${colorScheme}.png`, fullPage: true })

        await page.goto(`/catalog/products/${product.id}/variants/${variant.id}`)
        await expect(page.getByRole('heading', { name: 'Edit variant', level: 1 })).toBeVisible()
        await expect(page.getByRole('region', { name: 'Search results' }).getByRole('listitem').first()).toBeVisible()
        await expect(page.getByRole('img', { name: 'Image' })).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await page.screenshot({ path: `e2e/screenshots/variant-${viewport.name}-${colorScheme}.png`, fullPage: true })
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
