import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type Page, type TestInfo } from '@playwright/test'

import { expect, test, unique, uniqueKey } from '../fixtures'
import { wiringSeed } from '../wiring-seed'

// Key pages at phone, tablet and desktop width, in light and dark mode: nothing
// may overflow the viewport horizontally (tables scroll inside their own box).
//
// The default run checks a slim smoke: phone (390) and desktop (1280) in light
// mode, and the list pages at 1280 px in English and German. Every other
// combination is tagged @visual and runs with `make e2e-visual` (the "visual"
// project), which also saves screenshots to e2e/screenshots/ for a look by eye.
const pages = [
  { name: 'projects', path: '/projects', heading: 'Projects' },
  { name: 'function-types', path: '/catalog/function-types', heading: 'Functions' },
  { name: 'product-types', path: '/catalog/product-types', heading: 'Systems' },
  { name: 'catalog-fields', path: '/catalog/fields', heading: 'Fields' },
  { name: 'output-kinds', path: '/catalog/output-kinds', heading: 'Channel kinds' },
  { name: 'load-types', path: '/catalog/load-types', heading: 'Load types' },
  { name: 'room-templates', path: '/catalog/room-templates', heading: 'Room templates' },
  { name: 'categories', path: '/catalog/categories', heading: 'Categories' },
  { name: 'category-new', path: '/catalog/categories/new', heading: 'New category' },
  { name: 'users', path: '/admin/users', heading: 'Users' },
  { name: 'tenants', path: '/admin/tenants', heading: 'Tenants' },
  { name: 'roles', path: '/admin/roles', heading: 'Roles' },
  { name: 'profile', path: '/profile', heading: 'Profile' },
  { name: 'company-profile', path: '/admin/company', heading: 'Company profile' },
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
  { name: 'product-types', path: '/catalog/product-types', heading: { en: 'Systems', de: 'Systeme' } },
  { name: 'function-types', path: '/catalog/function-types', heading: { en: 'Functions', de: 'Funktionen' } },
  { name: 'catalog-fields', path: '/catalog/fields', heading: { en: 'Fields', de: 'Felder' } },
  { name: 'output-kinds', path: '/catalog/output-kinds', heading: { en: 'Channel kinds', de: 'Kanalarten' } },
  { name: 'load-types', path: '/catalog/load-types', heading: { en: 'Load types', de: 'Lastarten' } },
  { name: 'room-templates', path: '/catalog/room-templates', heading: { en: 'Room templates', de: 'Raumvorlagen' } },
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
        // A catalog field with a meaning and both parameters: the widest Fields row (output kinds and load types are seeded).
        const [kinds, loads] = await Promise.all(
          ['/api/output-kinds', '/api/load-types'].map(async (path) => ((await (await api.ctx.get(path)).json()) as { items: { id: string }[] }).items),
        )
        const field = await api.ctx.post('/api/catalog-fields', {
          data: {
            key: uniqueKey('dimmer_led_w'),
            label: { en: unique('Max. LED load per dimmer channel'), de: unique('Max. LED-Last je Dimmkanal') },
            type: 'number',
            unit: 'W',
            meaning: 'channel_limit_w',
            outputKindId: kinds[0].id,
            loadTypeId: loads[0].id,
          },
        })
        expect(field.status()).toBe(201)
        // A room template with a long name and level: the widest Room templates row.
        const lighting = await api.createFunctionType(uniqueKey('room_light'), unique('Dimmable light'))
        const roomTemplate = await api.ctx.post('/api/room-templates', {
          data: {
            key: uniqueKey('living_comfort'),
            name: { en: unique('Living room with open kitchen and dining area'), de: unique('Wohnzimmer mit offener Küche und Essbereich') },
            equipmentLevel: { en: 'Comfort plus', de: 'Komfort plus' },
            isActive: true,
            lines: [{ functionTypeId: lighting.id, quantity: 4, powerW: '7.5', loadTypeId: null, label: 'Ceiling' }],
          },
        })
        expect(roomTemplate.status()).toBe(201)
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
          const sheet = page.getByRole('dialog', { name: 'Menu' })
          await expect(sheet.getByRole('link', { name: 'Products' })).toBeVisible()
          // Four sections (D442): the setup pages under their own heading.
          await expect(sheet.getByRole('region')).toHaveText([/^Projects/, /^Catalog/, /^Setup/, /^Administration/, /^Account/])
          await expect(sheet.getByRole('region', { name: 'Setup' }).getByRole('link')).toHaveText(['Systems', 'Functions', 'Fields', 'Room templates', 'Channel kinds', 'Load types'])
          await expectNoHorizontalOverflow(page)
          await screenshot(page, testInfo, `nav-sheet-${viewport.name}-${colorScheme}`)
          await page.keyboard.press('Escape')
        } else {
          await page.getByRole('banner').getByRole('button', { name: 'Catalog' }).click()
          await expect(page.getByRole('menuitem', { name: 'Products' })).toBeVisible()
          await screenshot(page, testInfo, `nav-menu-${viewport.name}-${colorScheme}`)
          await page.keyboard.press('Escape')
          // Four sections in one line (D442); Setup holds the pages the catalog builds on.
          await expect(page.getByRole('navigation', { name: 'Main navigation' }).locator(':scope > *')).toHaveText(['Projects', 'Catalog', 'Setup', 'Administration'])
          await page.getByRole('banner').getByRole('button', { name: 'Setup' }).click()
          await expect(page.getByRole('menuitem')).toHaveText(['Systems', 'Functions', 'Fields', 'Room templates', 'Channel kinds', 'Load types'])
          await screenshot(page, testInfo, `nav-setup-${viewport.name}-${colorScheme}`)
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
        const dialog = page.getByRole('dialog', { name: 'Edit system' })
        await expect(dialog.getByTestId('type-abbreviation')).toHaveText('ZB3PRO')
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `product-type-dialog-${viewport.name}-${colorScheme}`)
      })

      test('the room template dialog fits the screen', async ({ page, api }, testInfo) => {
        const lighting = await api.createFunctionType(uniqueKey('room_light'), unique('Dimmable light with a rather long name'))
        const name = unique('Living room with open kitchen and dining area')
        const created = await api.ctx.post('/api/room-templates', {
          data: {
            key: uniqueKey('living_comfort'),
            name: { en: name },
            equipmentLevel: { en: 'Comfort' },
            isActive: true,
            lines: [
              { functionTypeId: lighting.id, quantity: 4, powerW: '7.5', loadTypeId: null, label: 'Ceiling' },
              { functionTypeId: lighting.id, quantity: 2, powerW: null, loadTypeId: null, label: 'Wall' },
            ],
          },
        })
        expect(created.status()).toBe(201)
        const key = ((await created.json()) as { key: string }).key
        await page.goto('/catalog/room-templates')
        const row = page.getByRole('row').filter({ hasText: name })
        await expect(row).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await row.getByRole('button', { name: 'Edit' }).click()
        const dialog = page.getByRole('dialog', { name: 'Edit room template' })
        await expect(dialog.getByLabel('Key')).toHaveValue(key)
        await expect(dialog.getByRole('group', { name: 'Line 2' })).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `room-template-dialog-${viewport.name}-${colorScheme}`)
      })

      test('the plans section and the plan editor fit the screen', async ({ page, api }, testInfo) => {
        const kind = await api.createKind({ name: { en: 'Switches with a rather long category name' } }, { abbreviation: 'ZB', color: '#1f6feb' })
        await api.createVariant((await api.createProduct({ ...kind.ids, name: { en: 'Wall switch with a long product name' } })).id, { name: { en: 'White' } })
        const project = await api.createProject({ name: unique('Villa Mustermann-Schmidt') })
        const version = project.versions[0].id
        const image = { name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(fileURLToPath(new URL('../assets/floorplan.png', import.meta.url))) }
        const plan = await api.createPlan(version, 'Ground floor with a long plan name', image)
        await api.createPlan(version, 'Attic', image)
        await page.goto(`/projects/${project.id}`)
        await expect(page.getByRole('link', { name: 'Attic' })).toBeVisible()
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `plans-section-${viewport.name}-${colorScheme}`, true)

        await page.goto(`/projects/${project.id}/versions/${version}/plans/${plan.id}`)
        await expect(page.getByTestId('plan-canvas')).toBeVisible()
        await expect(page.getByText('Loading…')).toHaveCount(0)
        await expectNoHorizontalOverflow(page)
        await screenshot(page, testInfo, `plan-editor-${viewport.name}-${colorScheme}`)
        if (viewport.size.width >= 768) {
          for (const tab of ['Zones', 'Layers', 'Inspector', 'Products']) {
            await page.getByRole('tab', { name: tab }).click()
            await expectNoHorizontalOverflow(page)
            await screenshot(page, testInfo, `plan-editor-${tab.toLowerCase()}-${viewport.name}-${colorScheme}`)
          }
          // The longer German tab names fit the panel too (no tab scrolls out of view).
          await page.evaluate(() => window.localStorage.setItem('i18nextLng', 'de'))
          await page.reload()
          const tabs = page.getByRole('tablist', { name: 'Planbereich' })
          await expect(tabs.getByRole('tab', { name: 'Produkte' })).toBeVisible()
          expect(await tabs.evaluate((el) => el.scrollWidth - el.clientWidth), 'the panel tabs overflow').toBeLessThanOrEqual(0)
          for (const tab of await tabs.getByRole('tab').all()) {
            const [box, list] = [(await tab.boundingBox())!, (await tabs.boundingBox())!]
            expect(box.x + box.width, 'a tab ends outside the panel').toBeLessThanOrEqual(list.x + list.width + 0.5)
          }
          await expectNoHorizontalOverflow(page)
          await screenshot(page, testInfo, `plan-editor-${viewport.name}-${colorScheme}-de`)
          await page.evaluate(() => window.localStorage.setItem('i18nextLng', 'en'))
        }
      })

      test('every version tab fits the screen', async ({ page, api }, testInfo) => {
        await api.createProductType()
        const project = await api.createProject({ name: unique('Villa Mustermann-Schmidt') })
        for (const lang of ['en', 'de'] as const) {
          await page.goto('/profile')
          await page.evaluate((l) => window.localStorage.setItem('i18nextLng', l), lang)
          for (const tab of ['plans', 'needs', 'networks', 'checks', 'bom', 'pricing', 'documents']) {
            await page.goto(`/projects/${project.id}?tab=${tab}`)
            const tabs = page.getByRole('tablist').first()
            const selected = tabs.getByRole('tab', { selected: true })
            await expect(selected).toBeVisible()
            await expect(page.getByText(lang === 'en' ? 'Loading…' : 'Wird geladen…')).toHaveCount(0)
            await expectNoHorizontalOverflow(page)
            // The tab list scrolls inside its own box; the selected tab is scrolled into view.
            const [box, list] = [(await selected.boundingBox())!, (await tabs.boundingBox())!]
            expect(box.x, `${tab}: selected tab left of the list`).toBeGreaterThanOrEqual(list.x - 1)
            expect(box.x + box.width, `${tab}: selected tab right of the list`).toBeLessThanOrEqual(list.x + list.width + 1)
            await screenshot(page, testInfo, `version-tab-${tab}-${viewport.name}-${colorScheme}-${lang}`)
          }
        }
        await page.evaluate(() => window.localStorage.setItem('i18nextLng', 'en'))
      })

      test('the bill of materials and pricing fit the screen', async ({ page, api }, testInfo) => {
        const kind = await api.createKind({ name: { en: 'Switches with a rather long category name' } }, { abbreviation: 'ZB', color: '#1f6feb' })
        const product = await api.createProduct({ ...kind.ids, name: { en: 'Wall switch with a long product name' } })
        const variant = await api.createVariant(product.id, { name: { en: 'White' }, price: '1234.50' })
        const project = await api.createProject({ name: unique('Villa Mustermann-Schmidt') })
        const version = project.versions[0].id
        const image = { name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(fileURLToPath(new URL('../assets/floorplan.png', import.meta.url))) }
        // Several plans: one quantity column each, so the table scrolls inside its box on narrow screens.
        for (const name of ['Ground floor with a long plan name', 'Upper floor', 'Attic', 'Basement']) {
          const plan = await api.createPlan(version, name, image)
          await api.savePlanContent(plan.id, { placements: [{ variantId: variant.id, x: 100, y: 100 }] })
        }
        for (const lang of ['en', 'de'] as const) {
          await page.goto('/profile')
          await page.evaluate((l) => window.localStorage.setItem('i18nextLng', l), lang)
          for (const tab of ['bom', 'pricing']) {
            await page.goto(`/projects/${project.id}?tab=${tab}`)
            await expect(page.getByTestId('total-grandTotal')).toBeVisible()
            await expectNoHorizontalOverflow(page)
            await screenshot(page, testInfo, `${tab}-${viewport.name}-${colorScheme}-${lang}`, true)
          }
        }
        await page.evaluate(() => window.localStorage.setItem('i18nextLng', 'en'))
      })

      test('the documents tab and the networks addresses fit the screen', async ({ page, api }, testInfo) => {
        // Step 3e (D425–D427): addresses assigned, one by hand, a manual and labels generated.
        const s = await wiringSeed(api)
        const assign = await api.ctx.post(`/api/versions/${s.versionId}/addresses/assign`, { data: {} })
        expect(assign.ok(), await assign.text()).toBe(true)
        for (const kind of ['installation_manual', 'channel_labels']) {
          const res = await api.ctx.post(`/api/versions/${s.versionId}/documents`, { data: { kind } })
          expect(res.ok(), await res.text()).toBe(true)
        }
        for (const lang of ['en', 'de'] as const) {
          await page.goto('/profile')
          await page.evaluate((l) => window.localStorage.setItem('i18nextLng', l), lang)
          await page.goto(`/projects/${s.project.id}/versions/${s.versionId}?tab=networks`)
          // The automatic first line (D451): named in the project's language (en), whatever the UI language.
          await expect(page.getByRole('heading', { name: 'Line 1', exact: true })).toBeVisible()
          await expect(page.getByRole('row').filter({ hasText: s.dimmer.name })).toContainText('1.1.1')
          await expectNoHorizontalOverflow(page)
          await screenshot(page, testInfo, `networks-addresses-${viewport.name}-${colorScheme}-${lang}`, true)
          await page.goto(`/projects/${s.project.id}/versions/${s.versionId}?tab=documents`)
          await expect(page.getByRole('table', { name: lang === 'en' ? 'Installation documents' : 'Installationsunterlagen' }).getByRole('row')).toHaveCount(3)
          await expect(page.getByText(lang === 'en' ? 'Loading…' : 'Wird geladen…')).toHaveCount(0)
          await expectNoHorizontalOverflow(page)
          await screenshot(page, testInfo, `documents-${viewport.name}-${colorScheme}-${lang}`, true)
        }
        await page.evaluate(() => window.localStorage.setItem('i18nextLng', 'en'))
      })

      test('the needs by room fit the screen', async ({ page, api }, testInfo) => {
        const dimmer = await api.createFunctionType(uniqueKey('dimmer'), 'Dimmable light with a rather long name')
        const blind = await api.createFunctionType(uniqueKey('blind'), 'Blind')
        const project = await api.createProject({ name: unique('Villa Mustermann-Schmidt'), productTypeIds: [(await api.createProductType()).id] })
        const version = project.versions[0].id
        const image = { name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(fileURLToPath(new URL('../assets/floorplan.png', import.meta.url))) }
        const plan = await api.createPlan(version, 'Ground floor with a long plan name', image)
        const living = crypto.randomUUID()
        await api.savePlanContent(plan.id, {
          zones: [{ id: living, name: 'Living room with a long zone name', color: '#22aa55', opacity: 0.3, points: [[0, 0], [600, 0], [600, 800], [0, 800]] }],
          placements: [],
          needs: [
            { zoneId: living, functionTypeId: dimmer.id, quantity: 12, powerW: '7.5', label: 'Ceiling, along the window front', note: 'Warm white, dimmable to 1 %' },
            { functionTypeId: blind.id, quantity: 2, x: 100, y: 100, label: 'Terrace door' },
            { functionTypeId: blind.id, quantity: 1, x: 900, y: 700 },
          ],
        })
        for (const lang of ['en', 'de'] as const) {
          await page.goto('/profile')
          await page.evaluate((l) => window.localStorage.setItem('i18nextLng', l), lang)
          await page.goto(`/projects/${project.id}?tab=needs`)
          await expect(page.getByRole('heading', { name: lang === 'en' ? 'Needs by room' : 'Bedarf nach Raum' })).toBeVisible()
          await expectNoHorizontalOverflow(page)
          await screenshot(page, testInfo, `needs-${viewport.name}-${colorScheme}-${lang}`, true)
        }
        await page.evaluate(() => window.localStorage.setItem('i18nextLng', 'en'))
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
