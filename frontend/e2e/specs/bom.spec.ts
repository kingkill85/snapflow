import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { expect, test, unique } from '../fixtures'

// Step 2c: the bill of materials and pricing of a version, clicked through in
// a real browser on top of plans saved through the API.

const assets = join(import.meta.dirname, '../assets')
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })

const bomTable = (page: Page) => page.getByRole('table', { name: 'Bill of materials' })
const bomRow = (page: Page, text: string) => bomTable(page).getByRole('row').filter({ hasText: text })
const grandTotal = (page: Page) => page.getByRole('region', { name: 'Totals', exact: true }).getByTestId('total-grandTotal')

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

test('bom: quantities per plan and zone, manual lines, pricing, update from catalog', async ({ page, api }) => {
  const kind = await api.createKind({}, { abbreviation: 'ZB', color: '#1f6feb' })
  const sensorName = unique('Motion sensor')
  const sensor = await api.createProduct({ ...kind.ids, name: { en: sensorName } })
  const sensorVariant = await api.createVariant(sensor.id, { name: { en: 'White' }, price: '10.00' })
  const hubName = unique('Hub')
  const hub = await api.createProduct({ ...kind.ids, name: { en: hubName } })
  await api.createVariant(hub.id, { name: { en: 'Std' }, price: '20.00' })
  const project = await api.createProject({ name: unique('BOM project') })
  const versionId = project.versions[0].id

  const ground = await api.createPlan(versionId, 'Ground floor', planImage())
  const upper = await api.createPlan(versionId, 'Upper floor', planImage())
  await api.savePlanContent(ground.id, {
    zones: [{ id: crypto.randomUUID(), name: 'Kitchen', color: '#22aa55', opacity: 0.3, points: [[0, 0], [600, 0], [600, 800], [0, 800]] }],
    placements: [
      { variantId: sensorVariant.id, x: 100, y: 100 },
      { variantId: sensorVariant.id, x: 300, y: 300 },
      { variantId: sensorVariant.id, x: 900, y: 400 },
      // An existing device: counted on the plan, never in the BOM (D185).
      { variantId: sensorVariant.id, x: 1000, y: 500, existing: true },
    ],
  })
  await api.savePlanContent(upper.id, { placements: [{ variantId: sensorVariant.id, x: 500, y: 500 }] })

  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/projects/${project.id}`)
  await page.getByRole('tab', { name: 'Bill of materials' }).click()
  await expect(page).toHaveURL(/\?tab=bom/)

  // Quantities per plan; the existing placement is left out.
  const sensorRow = bomRow(page, sensorName)
  await expect(sensorRow.getByRole('cell')).toHaveText(['', /White/, '3', '1', '', '4', '$10.00', '$40.00'])

  // Filter by plan, then zone.
  await choose(page, 'Plan', 'Ground floor')
  await expect(sensorRow.getByRole('cell').nth(2)).toHaveText('3')
  await choose(page, 'Zone', 'Kitchen')
  await expect(sensorRow.getByRole('cell').nth(2)).toHaveText('2')
  await choose(page, 'Zone', 'No zone')
  await expect(sensorRow.getByRole('cell').nth(2)).toHaveText('1')
  await choose(page, 'Plan', 'All plans')

  // A manual catalog line and a free-text line.
  await page.getByRole('button', { name: 'Add product' }).click()
  const add = page.getByRole('dialog', { name: 'Add product' })
  await add.getByRole('searchbox', { name: 'Search' }).fill(hubName)
  await add.getByRole('button', { name: new RegExp(hubName) }).click()
  await add.getByRole('button', { name: 'Create' }).click()
  await expect(add).toBeHidden()
  await expect(bomRow(page, hubName).getByRole('cell')).toHaveText(['', new RegExp(hubName), '', '', '1', '1', '$20.00', '$20.00'])

  await page.getByRole('button', { name: 'Add free-text line' }).click()
  const free = page.getByRole('dialog', { name: 'Add free-text line' })
  await free.getByLabel('Name').fill('Cabling')
  await free.getByLabel('Unit price (USD)').fill('12,50')
  await free.getByLabel('Quantity').fill('2')
  await free.getByRole('button', { name: 'Create' }).click()
  await expect(free).toBeHidden()
  await expect(bomRow(page, 'Cabling')).toContainText('$25.00')
  await expect(grandTotal(page)).toHaveText(/\$85\.00/)

  // Discount and services.
  await page.getByRole('tab', { name: 'Pricing' }).click()
  await expect(page).toHaveURL(/\?tab=pricing/)
  await choose(page, 'Discount', 'Percent')
  await page.getByLabel('Discount value').fill('10')
  await choose(page, 'Services', 'Amount (USD)')
  await page.getByLabel('Services value').fill('100')
  const preview = page.getByRole('region', { name: 'Totals with these values' })
  await expect(preview.getByTestId('total-grandTotal')).toHaveText(/\$176\.50/)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Pricing saved.')).toBeVisible()

  await page.getByRole('tab', { name: 'Bill of materials' }).click()
  await expect(grandTotal(page)).toHaveText(/\$176\.50/)

  // A catalog price change: outdated until updated from the catalog.
  await api.setVariantPrice(sensor.id, sensorVariant, '15.00')
  await page.reload()
  await expect(sensorRow.getByText('Outdated')).toBeVisible()
  await expect(sensorRow).toContainText('$10.00')
  await sensorRow.getByRole('button', { name: /update from catalog/i }).click()
  const changes = page.getByRole('dialog', { name: 'Update from catalog' })
  await expect(changes.getByRole('checkbox', { name: new RegExp(sensorName) })).toBeChecked()
  await expect(changes).toContainText('$15.00')
  await changes.getByRole('button', { name: 'Apply' }).click()
  await expect(changes).toBeHidden()
  await expect(sensorRow.getByText('Outdated')).toBeHidden()
  await expect(sensorRow).toContainText('$60.00')
  await expect(grandTotal(page)).toHaveText(/\$194\.50/)
})

test('bom: a project in another currency shows converted amounts', async ({ page, api }) => {
  const kind = await api.createKind({}, { abbreviation: 'KX' })
  const name = unique('Dimmer')
  const product = await api.createProduct({ ...kind.ids, name: { en: name } })
  const variant = await api.createVariant(product.id, { name: { en: '2-gang' }, price: '10.00' })
  const projects = {
    EUR: await api.createProject({ name: unique('EUR project'), currency: 'EUR', exchangeRate: '0.92' }),
    JPY: await api.createProject({ name: unique('JPY project'), currency: 'JPY', exchangeRate: '151.37' }),
  }
  for (const project of Object.values(projects)) {
    const versionId = project.versions[0].id
    const plan = await api.createPlan(versionId, 'Ground floor', planImage())
    await api.savePlanContent(plan.id, { placements: [100, 300, 500].map((x) => ({ variantId: variant.id, x, y: 100 })) })
    await api.addManualLine(versionId, { name: 'Cabling', unitPrice: '12.34', quantity: 1 })
    await api.savePricing(versionId, { discountKind: 'percent', discountValue: '10', servicesKind: 'amount', servicesValue: '100' })
  }
  await page.setViewportSize({ width: 1400, height: 900 })

  // EUR: every amount converted on its own from its USD value (D228).
  await page.goto(`/projects/${projects.EUR.id}?tab=bom`)
  await expect(bomRow(page, name).getByRole('cell')).toHaveText(['', new RegExp(name), '3', '', '3', '$10.00€9.20', '$30.00€27.60'])
  await expect(bomRow(page, 'Cabling')).toContainText('$12.34€11.35')
  const totals = page.getByRole('region', { name: 'Totals', exact: true })
  // Subtotal 42.34, discount 4.23, services 100, grand total 138.11.
  await expect(totals.getByTestId('total-subtotal')).toHaveText(/\$42\.34\s*€38\.95/)
  await expect(totals.getByTestId('total-discount')).toHaveText(/\u2212\$4\.23\s*\u2212€3\.89/)
  await expect(grandTotal(page)).toHaveText(/\$138\.11\s*€127\.06/)
  await expect(totals).toContainText('1 USD = 0.92 EUR')
  // Manual lines carry the API's converted amounts too.
  const manual = page.getByRole('table', { name: 'Manual lines' }).getByRole('row').filter({ hasText: 'Cabling' })
  await expect(manual).toContainText('$12.34€11.35')

  // JPY has no minor unit.
  await page.goto(`/projects/${projects.JPY.id}?tab=bom`)
  await expect(bomRow(page, name).getByRole('cell')).toHaveText(['', new RegExp(name), '3', '', '3', '$10.00¥1,514', '$30.00¥4,541'])
  await expect(grandTotal(page)).toHaveText(/\$138\.11\s*¥20,906/)
})
