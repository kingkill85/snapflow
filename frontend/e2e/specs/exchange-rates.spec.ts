import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test, unique } from '../fixtures'
import { readZip } from '../zip'

// Exchange rates online: the e2e backend asks the stub provider (e2e/rates-stub.ts,
// EUR 0.9237 dated yesterday) instead of open.er-api.com.

const assets = join(import.meta.dirname, '../assets')

test('exchange rates: no rate on create, fetch online, set by hand, proposal with the rate date', async ({ page, api }) => {
  const kind = await api.createKind({}, { name: { en: unique('Zigbee') }, abbreviation: 'ZB', color: '#1f6feb' })
  const product = await api.createProduct({ ...kind.ids, name: { en: unique('Motion sensor') } })
  const variant = await api.createVariant(product.id, { name: { en: 'White' }, price: '10.00' })
  const project = await api.createProject({ name: unique('Villa'), currency: 'EUR', productTypeIds: [kind.type.id] })
  expect(project.exchangeRate).toBeNull()
  const plan = await api.createPlan(project.versions[0].id, 'Ground floor', {
    name: 'floorplan.png',
    mimeType: 'image/png',
    buffer: readFileSync(join(assets, 'floorplan.png')),
  })
  await api.savePlanContent(plan.id, { placements: [{ variantId: variant.id, x: 100, y: 100 }] })

  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/projects/${project.id}?tab=bom`)
  const bar = page.getByTestId('rate-bar')
  await expect(bar).toContainText('No exchange rate yet – fetch or set one')
  // Without a rate the amounts are USD only.
  await expect(page.getByText('$10.00').first()).toBeVisible()
  await expect(page.getByText('€9.24')).toHaveCount(0)

  // Proposals wait for a rate: Create is disabled, the notice links to the Pricing tab.
  await page.getByRole('tab', { name: 'Documents' }).click()
  await expect(page.getByText(/has no exchange rate for EUR yet/).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create proposal' })).toBeDisabled()
  await page.getByRole('link', { name: 'Set the rate on the Pricing tab' }).click()
  await expect(page.getByRole('tab', { name: 'Pricing' })).toHaveAttribute('aria-selected', 'true')

  // Update rate: the online rate, converted amounts appear.
  await bar.getByRole('button', { name: 'Update rate' }).click()
  await expect(bar).toContainText('1 USD = 0.9237 EUR')
  await expect(bar).toContainText('online,')
  await page.getByRole('tab', { name: 'Bill of materials' }).click()
  await expect(page.getByText('€9.24').first()).toBeVisible()

  // Set rate by hand on the Pricing tab.
  await page.getByRole('tab', { name: 'Pricing' }).click()
  await bar.getByRole('button', { name: 'Set rate' }).click()
  const set = page.getByRole('dialog', { name: 'Set exchange rate' })
  await set.getByLabel('Exchange rate').fill('0.95')
  await set.getByRole('button', { name: 'Update' }).click()
  await expect(set).toBeHidden()
  await expect(bar).toContainText('1 USD = 0.95 EUR')
  await expect(bar).toContainText('entered manually on')
  await expect(page.getByText('€9.50').first()).toBeVisible()

  // Now a proposal works; its footnote names the rate and its date.
  await page.getByRole('tab', { name: 'Documents' }).click()
  await page.getByRole('button', { name: 'Create proposal' }).click()
  const create = page.getByRole('dialog', { name: 'Create proposal' })
  const [download] = await Promise.all([page.waitForEvent('download'), create.getByRole('button', { name: 'Create' }).click()])
  await expect(create).toBeHidden()
  const doc = readZip(readFileSync(await download.path()))
    .find((e) => e.name === 'word/document.xml')!
    .data.toString('utf8')
  expect(doc).toMatch(/1 USD = 0\.95 EUR \(rate of \d{1,2} \w+ \d{4}\)/)
})
