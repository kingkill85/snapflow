import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Download, Page } from '@playwright/test'

import { type Api, expect, navigate, test, unique } from '../fixtures'
import { readZip } from '../zip'

// Step 2d: proposals generated from a version, downloaded and opened as DOCX
// (a ZIP with word/document.xml), and the letterhead a tenant admin edits.

const assets = join(import.meta.dirname, '../assets')
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })

/** The XML parts of a downloaded DOCX by name. */
async function docxParts(download: Download): Promise<Map<string, string>> {
  const path = await download.path()
  const entries = readZip(readFileSync(path))
  return new Map(entries.filter((e) => e.name.endsWith('.xml')).map((e) => [e.name, e.data.toString('utf8')]))
}

/** Two systems on one plan: Zigbee 3 × 10.00, KNX 1 × 1,200.00 = 1,230.00 USD. */
async function seed(api: Api, tenantId?: string) {
  const zigbee = await api.createKind({}, { name: { en: unique('Zigbee') }, abbreviation: 'ZB', color: '#1f6feb' })
  const knx = await api.createKind({}, { name: { en: unique('KNX') }, abbreviation: 'KX', color: '#d9480f' })
  const sensor = await api.createProduct({ ...zigbee.ids, name: { en: unique('Motion sensor') } })
  const sensorVariant = await api.createVariant(sensor.id, { name: { en: 'White' }, price: '10.00' })
  const actuator = await api.createProduct({ ...knx.ids, name: { en: unique('Switch actuator') } })
  const actuatorVariant = await api.createVariant(actuator.id, { name: { en: '8-fold' }, price: '1200.00' })
  const project = await api.createProject({ name: unique('Villa'), tenantId, productTypeIds: [zigbee.type.id, knx.type.id] })
  const plan = await api.createPlan(project.versions[0].id, 'Ground floor', planImage())
  await api.savePlanContent(plan.id, {
    placements: [
      { variantId: sensorVariant.id, x: 100, y: 100 },
      { variantId: sensorVariant.id, x: 300, y: 300 },
      { variantId: sensorVariant.id, x: 500, y: 300 },
      { variantId: actuatorVariant.id, x: 900, y: 400 },
    ],
  })
  return { project, zigbee, knx }
}

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Create proposal' })
const proposalsTable = (page: Page) => page.getByRole('table', { name: 'Proposals' })

test('proposals: generate combined and per product type, download DOCX, delete', async ({ page, api }) => {
  const { project, zigbee, knx } = await seed(api)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/projects/${project.id}`)
  await page.getByRole('tab', { name: 'Documents' }).click()
  await expect(page).toHaveURL(/\?tab=documents/)
  // By audience (D450): proposals for the customer, installation documents for the installer.
  await expect(page.getByRole('region', { name: 'For the customer' }).getByText('No proposals yet. Create one from the bill of materials of this version.')).toBeVisible()
  await expect(page.getByRole('region', { name: 'For the installer' })).toContainText('Manual, channel labels and programming data for the site.')

  // Combined: the preview shows the grand total, Create downloads the file.
  await page.getByRole('button', { name: 'Create proposal' }).click()
  await expect(dialog(page).getByRole('combobox', { name: /Format/ })).toHaveText(/Word/)
  await expect(dialog(page).getByTestId('preview-total')).toHaveText('$1,230.00')
  const [download] = await Promise.all([page.waitForEvent('download'), dialog(page).getByRole('button', { name: 'Create' }).click()])
  await expect(dialog(page)).toBeHidden()
  const number = `${project.number}-V1-01`
  expect(download.suggestedFilename()).toBe(`${number} ${project.name}.docx`)
  const parts = await docxParts(download)
  const document = parts.get('word/document.xml')
  expect(document).toBeDefined()
  expect(document).toContain(project.number)
  expect(document).toContain('1,230.00 USD')
  await expect(page.getByRole('status')).toContainText(`Proposal ${number} created`)
  const combinedRow = proposalsTable(page).getByRole('row').filter({ hasText: number })
  await expect(combinedRow).toContainText('Combined')
  await expect(combinedRow).toContainText('$1,230.00')
  await expect(combinedRow).toContainText('English')

  // Split: one document per product type, each with its own total.
  await page.getByRole('button', { name: 'Create proposal' }).click()
  await dialog(page).getByRole('combobox', { name: 'Documents' }).click()
  await page.getByRole('option', { name: 'One document per system' }).click()
  await expect(dialog(page).getByTestId('preview-total')).toHaveText(['$30.00', '$1,200.00'])
  const downloads: Download[] = []
  page.on('download', (d) => downloads.push(d))
  await dialog(page).getByRole('button', { name: 'Create' }).click()
  await expect(dialog(page)).toBeHidden()
  await expect.poll(() => downloads.length).toBe(2)
  const byName = new Map(downloads.map((d) => [d.suggestedFilename(), d]))
  const zb = byName.get(`${project.number}-V1-02-ZB ${project.name}.docx`)
  const kx = byName.get(`${project.number}-V1-02-KX ${project.name}.docx`)
  expect(zb && kx, [...byName.keys()].join(', ')).toBeTruthy()
  const zbDoc = (await docxParts(zb!)).get('word/document.xml')!
  expect(zbDoc).toContain(project.number)
  expect(zbDoc).toContain('30.00 USD')
  expect(zbDoc).not.toContain('1,230.00 USD')
  const kxDoc = (await docxParts(kx!)).get('word/document.xml')!
  expect(kxDoc).toContain('1,200.00 USD')

  await expect(proposalsTable(page).getByRole('row')).toHaveCount(4)
  await expect(proposalsTable(page).getByRole('row').filter({ hasText: '-02-ZB' })).toContainText(zigbee.type.name.en)
  await expect(proposalsTable(page).getByRole('row').filter({ hasText: '-02-KX' })).toContainText(knx.type.name.en)

  // The download link of the list serves the same file.
  const [again] = await Promise.all([page.waitForEvent('download'), combinedRow.getByRole('link', { name: 'Download' }).click()])
  expect(again.suggestedFilename()).toBe(`${number} ${project.name}.docx`)

  // Delete with confirmation.
  await combinedRow.getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete proposal' })
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toBeHidden()
  await expect(proposalsTable(page).getByRole('row')).toHaveCount(3)
})

test('proposals: introduction and closing text from the pricing tab', async ({ page, api }) => {
  const { project } = await seed(api)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/projects/${project.id}?tab=pricing`)
  const intro = unique('Thank you for your enquiry')
  const closing = unique('Valid for 30 days')
  await page.getByRole('textbox', { name: /^Introduction/ }).fill(intro)
  await page.getByRole('textbox', { name: /^Closing text/ }).fill(closing)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Pricing saved.')).toBeVisible()

  await page.getByRole('tab', { name: 'Documents' }).click()
  await page.getByRole('button', { name: 'Create proposal' }).click()
  await expect(dialog(page).getByTestId('preview-total')).toHaveText('$1,230.00')
  const [download] = await Promise.all([page.waitForEvent('download'), dialog(page).getByRole('button', { name: 'Create' }).click()])
  const document = (await docxParts(download)).get('word/document.xml')!
  expect(document).toContain(intro)
  expect(document).toContain(closing)
})

test('proposals: a tenant admin edits the letterhead, which heads their proposals', async ({ api, sessionFor }) => {
  const tenant = await api.createTenant()
  const tenantAdmin = await api.createUser({ role: 'tenant_admin', tenantId: tenant.id })
  const { project } = await seed(api, tenant.id)

  const page = await sessionFor(tenantAdmin)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/')
  await navigate(page, 'Administration', 'Company profile')
  await expect(page.getByRole('heading', { name: 'Company profile' })).toBeVisible()
  const company = unique('Acme Smart Homes')
  await page.getByRole('textbox', { name: 'Company name' }).fill(company)
  await page.getByRole('textbox', { name: 'Address' }).fill('Main Street 1\n12345 Town')
  await page.getByRole('textbox', { name: 'Phone' }).fill('+49 30 123456')
  await page.getByRole('textbox', { name: 'Email' }).fill('info@acme.example')
  await page.getByRole('textbox', { name: 'Website' }).fill('www.acme.example')
  await page.getByLabel('Logo').setInputFiles(join(assets, 'blue.png'))
  await expect(page.getByRole('img', { name: 'Logo' })).toBeVisible()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Letterhead saved.')).toBeVisible()

  // Loaded again on the next visit.
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Company name' })).toHaveValue(company)
  await expect(page.getByRole('textbox', { name: 'Address' })).toHaveValue('Main Street 1\n12345 Town')
  await expect(page.getByRole('img', { name: 'Logo' })).toBeVisible()

  // Their proposal carries it (header) and the logo.
  await page.goto(`/projects/${project.id}?tab=proposals`)
  await page.getByRole('button', { name: 'Create proposal' }).click()
  await expect(dialog(page).getByTestId('preview-total')).toHaveText('$1,230.00')
  const [download] = await Promise.all([page.waitForEvent('download'), dialog(page).getByRole('button', { name: 'Create' }).click()])
  const parts = await docxParts(download)
  expect([...parts.values()].some((xml) => xml.includes(company))).toBe(true)
  const media = readZip(readFileSync(await download.path())).filter((e) => e.name.startsWith('word/media/'))
  expect(media.length).toBeGreaterThan(0)
})
