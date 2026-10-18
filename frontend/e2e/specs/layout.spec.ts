import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type Page, type TestInfo } from '@playwright/test'

import { expect, test, unique, uniqueKey } from '../fixtures'

// Key pages at phone, tablet and desktop width, in light and dark mode: nothing
// may overflow the viewport horizontally (tables scroll inside their own box).
//
// The default run checks a slim smoke: phone (390) and desktop (1280) in light
// mode, and the list pages at 1280 px in English and German. Every other
// combination is tagged @visual and runs with `make e2e-visual` (the "visual"
// project), which also saves screenshots to e2e/screenshots/ for a look by eye.
const pages = [
  { name: 'projects', path: '/projects', heading: 'Projects' },
  { name: 'function-types', path: '/catalog/function-types', heading: 'Function types' },
  { name: 'product-types', path: '/catalog/product-types', heading: 'Product types' },
  { name: 'categories', path: '/catalog/categories', heading: 'Categories' },
  { name: 'category-new', path: '/catalog/categories/new', heading: 'New category' },
  { name: 'users', path: '/admin/users', heading: 'Users' },
  { name: 'tenants', path: '/admin/tenants', heading: 'Tenants' },
  { name: 'roles', path: '/admin/roles', heading: 'Roles' },
  { name: 'profile', path: '/profile', heading: 'Profile' },
]

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 }, smoke: true },
  { name: 'tablet', size: { width: 768, height: 1024 }, smoke: false },
  { name: 'desktop', size: { width: 1280, height: 800 }, smoke: true },
]

/** Tags a combination that is not part of the smoke as @visual (left out of the default run). */
function tags(smoke: boolean) {
  return smoke ? {} : { tag: '@visual' }
}

/** Screenshots are for the visual review only; the smoke just checks the layout. */
async function screenshot(page: Page, testInfo: TestInfo, file: string, fullPage = false) {
  if (testInfo.project.name !== 'visual') return
  await page.screenshot({ path: `e2e/screenshots/${file}.png`, fullPage })
}

// Every list page on a desktop screen (1280 px and wider), in English and the
// longer German: all columns incl. the row actions fit, the table box does not
// scroll (D95).
const listPages = [
  { name: 'projects', path: '/projects', heading: { en: 'Projects', de: 'Projekte' } },
  { name: 'products', path: '/catalog/products', heading: { en: 'Products', de: 'Produkte' } },
  { name: 'categories', path: '/catalog/categories', heading: { en: 'Categories', de: 'Kategorien' } },
  { name: 'product-types', path: '/catalog/product-types', heading: { en: 'Product types', de: 'Produkttypen' } },
  { name: 'function-types', path: '/catalog/function-types', heading: { en: 'Function types', de: 'Funktionstypen' } },
  { name: 'users', path: '/admin/users', heading: { en: 'Users', de: 'Benutzer' } },
  { name: 'tenants', path: '/admin/tenants', heading: { en: 'Tenants', de: 'Mandanten' } },
  { name: 'roles', path: '/admin/roles', heading: { en: 'Roles', de: 'Rollen' } },
]

/**
 * How much room each table box has left over its table's narrowest layout
 * (every wrapping column at its minimum): the margin for fonts that render a
 * little wider elsewhere, e.g. on the CI runner.
 */
async function tableSlack(page: Page): Promise<number[]> {
  return page.locator('div:has(> table)').evaluateAll((boxes) =>
    boxes.map((box) => {
      const table = box.querySelector('table')!
      table.style.width = '1px'
      const narrowest = table.scrollWidth
      table.style.width = ''
      return box.clientWidth - narrowest
    }),
  )
}

/** How far each table box on the page scrolls horizontally (0 = everything fits). */
async function tableOverflows(page: Page): Promise<number[]> {
  return page.locator('div:has(> table)').evaluateAll((boxes) => boxes.map((box) => box.scrollWidth - box.clientWidth))
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
  // The header keeps everything on one line without spilling over (D97).
  const header = await page.getByRole('banner').evaluateAll((els) => els.map((el) => [el.scrollWidth - el.clientWidth, el.getBoundingClientRect().height]))
  for (const [spill, height] of header) {
    expect(spill, 'header content is wider than the header').toBeLessThanOrEqual(0)
    expect(height, 'header wraps onto a second line').toBeLessThanOrEqual(57)
  }
}

for (const width of [1280, 1440, 1920]) {
  for (const lang of ['en', 'de'] as const) {
    test.describe(`list pages at ${width} px, ${lang}`, tags(width === 1280), () => {
      test.use({ viewport: { width, height: 900 } })

      test('every column fits without scrolling the table', async ({ page, api }, testInfo) => {
        // Long names, a product with problems, an unavailable product: the widest rows.
        await api.createUser({ fullName: 'Maximilian Alexander Mustermann-Schmidt' })
        await api.createFunctionType(uniqueKey('lighting'), unique('Lighting control with presence detection'))
        await api.createTenant(unique('Elektrotechnik Mustermann-Schmidt GmbH & Co. KG'))
        const attribute = { key: 'nominal_power', label: { en: 'Nominal power' }, type: 'number', unit: 'W', scope: 'product' } as const
        const { type, category, ids } = await api.createKind(
          { name: { en: unique('Universal dimmer actuators'), de: unique('Universal-Dimmaktoren') }, attributes: [attribute] },
          { name: { en: unique('HDL Buspro professional'), de: unique('HDL Buspro Profi') }, abbreviation: 'HDLPRO', color: '#1f6feb' },
        )
        await api.createProduct({
          ...ids,
          modelNumber: unique('M485/GW-ZB.10').replace(/\s+/g, '-'),
          name: { en: 'Universal dimmer actuator, 4-fold, with manual operation and status LEDs', de: 'Universal-Dimmaktor, 4-fach, mit Handbedienung und Status-LEDs' },
        })
        await api.createProject({
          name: unique('Villa Mustermann-Schmidt, Erweiterung Nebengebäude'),
          tenantId: (await api.createTenant(unique('Elektrotechnik Mustermann-Schmidt GmbH & Co. KG'))).id,
          customer: { name: 'Maximilian Alexander Mustermann-Schmidt', company: 'Mustermann-Schmidt Immobilienverwaltung GmbH' },
        })
        // Required afterwards: the product misses the value, a problem badge in the status cell.
        await api.updateCategory(category.id, { attributes: [{ ...attribute, required: true }] })
        await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)

        for (const p of listPages) {
          await page.goto(p.path === '/catalog/products' ? `${p.path}?type=${type.id}` : p.path)
          await expect(page.getByRole('heading', { name: p.heading[lang], level: 1 })).toBeVisible()
          await expect(page.getByRole('table')).toBeVisible()
          await expectNoHorizontalOverflow(page)
          if (testInfo.project.name === 'visual') {
            for (const colorScheme of ['light', 'dark'] as const) {
              // Reloaded, so everything is painted in the scheme from the start.
              await page.emulateMedia({ colorScheme })
              await page.reload()
              await expect(page.getByRole('table')).toBeVisible()
              await screenshot(page, testInfo, `list-${p.name}-${width}-${lang}-${colorScheme}`, true)
            }
          }
          expect(await tableOverflows(page), `${p.name}: the table scrolls`).toEqual([0])
          for (const slack of await tableSlack(page)) expect(slack, `${p.name}: less than 40 px to spare`).toBeGreaterThanOrEqual(40)
        }
      })
    })
  }
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const viewport of viewports) {
    test.describe(`${viewport.name}, ${colorScheme}`, tags(viewport.smoke && colorScheme === 'light'), () => {
      test.use({ colorScheme, viewport: viewport.size })

      test('app pages fit the screen', async ({ page, api }, testInfo) => {
        // Something to delete, and a long name in the table.
        await api.createUser({ fullName: 'Maximilian Alexander Mustermann-Schmidt' })
        await api.createProductType()
        const project = await api.createProject({
          name: unique('Villa Mustermann-Schmidt, Erweiterung Nebengebäude'),
          customer: { name: 'Maximilian Alexander Mustermann-Schmidt', company: 'Mustermann-Schmidt Immobilienverwaltung GmbH' },
        })
        for (const p of [...pages, { name: 'project', path: `/projects/${project.id}`, heading: `${project.number} ${project.name}` }]) {
          await page.goto(p.path)
          await expect(page.getByRole('heading', { name: p.heading, level: 1 })).toBeVisible()
          await expect(page.getByText('Loading…')).toHaveCount(0)
          await expectNoHorizontalOverflow(page)
          await screenshot(page, testInfo, `${p.name}-${viewport.name}-${colorScheme}`, true)
        }

        // The navigation: section menus and the user menu from 768 px, a side sheet on phones.
        await page.goto('/admin/users')
        if (viewport.size.width < 768) {
          await page.getByRole('button', { name: 'Menu' }).click()
          await expect(page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Products' })).toBeVisible()
          await screenshot(page, testInfo, `nav-sheet-${viewport.name}-${colorScheme}`)
          await page.keyboard.press('Escape')
        } else {
          await page.getByRole('banner').getByRole('button', { name: 'Catalog' }).click()
          await expect(page.getByRole('menuitem', { name: 'Products' })).toBeVisible()
          await screenshot(page, testInfo, `nav-menu-${viewport.name}-${colorScheme}`)
          await page.keyboard.press('Escape')
          await page.getByRole('banner').getByRole('button', { name: /^Account: / }).click()
          await expect(page.getByRole('menuitemradio', { name: 'Dark' })).toBeVisible()
          await screenshot(page, testInfo, `user-menu-${viewport.name}-${colorScheme}`)
          await page.keyboard.press('Escape')
        }

        await page.getByRole('button', { name: 'New user' }).click()
        const dialog = page.getByRole('dialog', { name: 'New user' })
        await dialog.getByRole('button', { name: 'Create' }).click()
        await expect(dialog.getByLabel('Email')).toHaveAccessibleDescription('Enter a valid email address.')
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `user-dialog-${viewport.name}-${colorScheme}`)
        await dialog.getByRole('button', { name: 'Cancel' }).click()

        await page.getByRole('button', { name: 'Delete' }).first().click()
        await expect(page.getByRole('dialog', { name: 'Delete user' })).toBeVisible()
        await screenshot(page, testInfo, `delete-dialog-${viewport.name}-${colorScheme}`)
        await page.keyboard.press('Escape')

        // The project dialogs.
        await page.goto(`/projects/${project.id}`)
        await page.getByRole('button', { name: 'Edit project' }).click()
        await expect(page.getByRole('dialog', { name: 'Edit project' })).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `project-dialog-${viewport.name}-${colorScheme}`)
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: 'New version' }).click()
        await expect(page.getByRole('dialog', { name: 'New version' })).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `version-dialog-${viewport.name}-${colorScheme}`)
      })

      test('the category editor and the product type dialog fit the screen', async ({ page, api }, testInfo) => {
        const category = await api.createCategory({
          name: { en: 'Universal dimmer actuators with a rather long name for narrow screens' },
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
        await page.goto(`/catalog/categories/${category.id}`)
        await expect(page.getByRole('heading', { name: 'Edit category', level: 1 })).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `category-collapsed-${viewport.name}-${colorScheme}`, true)

        const attrs = page.getByRole('region', { name: 'Attributes', exact: true })
        await attrs.getByRole('button', { name: 'Expand all' }).click()
        // Errors at the fields, the cards marked.
        // An exponent is not a number here (a decimal comma is, D71).
        await attrs.getByLabel('Minimum', { exact: true }).fill('1e3')
        await page.getByRole('button', { name: 'Update' }).click()
        await expect(attrs.getByLabel('Minimum', { exact: true })).toHaveAccessibleDescription('Enter a number.')
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `category-expanded-${viewport.name}-${colorScheme}`, true)

        // The list with a long name.
        await page.goto('/catalog/categories')
        await expect(page.getByRole('row').filter({ hasText: category.key })).toBeVisible()
        await expectNoHorizontalOverflow(page)

        // Product types: the list with a badge and a long name, and the dialog with its preview.
        const type = await api.createProductType({ name: { en: 'Zigbee 3.0 professional line with a rather long name' }, abbreviation: 'ZB3PRO', color: '#1f6feb' })
        await page.goto('/catalog/product-types')
        const typeRow = page.getByRole('row').filter({ hasText: type.key })
        await expect(typeRow).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await typeRow.getByRole('button', { name: 'Edit' }).click()
        const dialog = page.getByRole('dialog', { name: 'Edit product type' })
        await expect(dialog.getByTestId('type-abbreviation')).toHaveText('ZB3PRO')
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `product-type-dialog-${viewport.name}-${colorScheme}`)
      })

      test('the product pages fit the screen', async ({ page, api }, testInfo) => {
        const image = await api.uploadFile('blue.png', 'image/png', readFileSync(fileURLToPath(new URL('../assets/blue.png', import.meta.url))))
        const { type, ids } = await api.createKind({
          name: { en: unique('Universal dimmer actuators with a rather long name') },
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
        }, { name: { en: unique('Zigbee professional line') }, abbreviation: 'ZB', color: '#1f6feb' })
        const product = await api.createProduct({
          ...ids,
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
        await screenshot(page, testInfo, `products-${viewport.name}-${colorScheme}`, true)

        await page.goto(`/catalog/products/${product.id}`)
        await expect(page.getByRole('heading', { name: 'Edit product', level: 1 })).toBeVisible()
        await expect(page.getByRole('row').filter({ hasText: 'Ivory white glossy' })).toContainText(sku)
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `product-${viewport.name}-${colorScheme}`, true)

        await page.goto(`/catalog/products/${product.id}/variants/${variant.id}`)
        await expect(page.getByRole('heading', { name: 'Edit variant', level: 1 })).toBeVisible()
        await expect(page.getByRole('region', { name: 'Search results' }).getByRole('listitem').first()).toBeVisible()
        await expect(page.getByRole('img', { name: 'Image' })).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `variant-${viewport.name}-${colorScheme}`, true)
      })

      test.describe('signed out', () => {
        test.use({ storageState: { cookies: [], origins: [] } })

        test('login page fits the screen', async ({ page }, testInfo) => {
          await page.goto('/login')
          await page.getByRole('button', { name: 'Sign in' }).click()
          await expect(page.getByLabel('Email')).toHaveAccessibleDescription('This field is required.')
          await expectNoHorizontalOverflow(page)
          await screenshot(page, testInfo, `login-${viewport.name}-${colorScheme}`, true)
        })
      })
    })
  }
}
