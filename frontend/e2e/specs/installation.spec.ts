import { readFileSync } from 'node:fs'

import type { Download, Page } from '@playwright/test'

import { expect, test } from '../fixtures'
import { wiringSeed } from '../wiring-seed'
import { readZip } from '../zip'

// Step 3e: a KNX project with a board and auto-connected needs; addresses
// assigned in the Networks tab, one set by hand, the installation manual and
// the channel labels generated and downloaded (DOCX), the KNX group address
// CSV and the commissioning lists downloaded from the Documents tab.

/** The parts of a downloaded ZIP (DOCX, XLSX) by name. */
async function zipParts(download: Download): Promise<Map<string, string>> {
  const entries = readZip(readFileSync(await download.path()))
  return new Map(entries.filter((e) => e.name.endsWith('.xml')).map((e) => [e.name, e.data.toString('utf8')]))
}

async function downloadOf(page: Page, click: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent('download'), click()])
  return download
}

test('installation: assign addresses, generate manual and labels, download the exports', async ({ page, api }) => {
  const s = await wiringSeed(api)
  // Auto-connect every need (preview, apply): the manual's channel table has rows.
  const preview = await api.ctx.post(`/api/versions/${s.versionId}/auto-connect/preview`, { data: { scope: 'all' } })
  expect(preview.ok(), await preview.text()).toBe(true)
  const { checksum } = (await preview.json()) as { checksum: string }
  const apply = await api.ctx.post(`/api/versions/${s.versionId}/auto-connect/apply`, { data: { scope: 'all', expectedChecksum: checksum } })
  expect(apply.ok(), await apply.text()).toBe(true)
  await page.setViewportSize({ width: 1400, height: 900 })

  // Networks: no addresses yet; assign every line, then set one by hand.
  await page.goto(`/projects/${s.project.id}/versions/${s.versionId}?tab=networks`)
  const dimmerRow = page.getByRole('row').filter({ hasText: s.dimmer.name })
  await expect(dimmerRow).toBeVisible()
  await page.getByRole('button', { name: 'Assign addresses', exact: true }).first().click()
  await expect(page.getByRole('status').filter({ hasText: /3 devices got an automatic address/ })).toBeVisible()
  await expect(dimmerRow).toContainText('1.1.1')
  await expect(page.getByRole('row').filter({ hasText: s.blindAct.name })).toContainText('1.1.3')
  // By hand: the relay gets 1.1.10 (pinned).
  const relayRow = page.getByRole('row').filter({ hasText: s.relay.name })
  await relayRow.getByRole('button', { name: /^Edit address of / }).click()
  const field = relayRow.getByRole('textbox', { name: /^Address of / })
  await field.fill('1.1.10')
  await field.press('Enter')
  await expect(relayRow).toContainText('1.1.10')
  await expect(relayRow).toContainText('By hand')
  await expect(dimmerRow).toContainText('Automatic')

  // The checks have no address findings now.
  await page.getByRole('tab', { name: 'Checks' }).click()
  await expect(page.getByText(/devices without address/)).toHaveCount(0)

  // Documents: the manual and the labels.
  await page.getByRole('tab', { name: 'Documents' }).click()
  await expect(page).toHaveURL(/\?tab=documents/)
  const docs = page.getByRole('region', { name: 'Installation documents' })
  await expect(docs.getByText('No installation documents yet. Generate the installation manual or the channel labels above.')).toBeVisible()

  const manual = await downloadOf(page, () => docs.getByRole('button', { name: 'Installation manual (DOCX)' }).click())
  const manualNumber = `${s.project.number}-V1-IM01`
  expect(manual.suggestedFilename()).toMatch(new RegExp(`^${manualNumber}.*\\.docx$`))
  const manualXml = (await zipParts(manual)).get('word/document.xml')
  expect(manualXml).toBeDefined()
  expect(manualXml).toContain(s.project.number)
  expect(manualXml).toContain('Free channels')
  expect(manualXml).toContain('Spots')
  expect(manualXml).toContain('1.1.1')
  expect(manualXml).toContain('1.1.10')
  await expect(docs.getByRole('status')).toContainText(`${manualNumber} created`)

  const labels = await downloadOf(page, () => docs.getByRole('button', { name: 'Channel labels (DOCX)' }).click())
  const labelsNumber = `${s.project.number}-V1-LB01`
  expect(labels.suggestedFilename()).toMatch(new RegExp(`^${labelsNumber}.*\\.docx$`))
  const labelsXml = (await zipParts(labels)).get('word/document.xml')
  expect(labelsXml).toBeDefined()
  expect(labelsXml).toContain('Spots')

  const table = docs.getByRole('table', { name: 'Installation documents' })
  await expect(table.getByRole('row')).toHaveCount(3)
  await expect(table.getByRole('row').filter({ hasText: manualNumber })).toContainText('Installation manual')
  await expect(table.getByRole('row').filter({ hasText: labelsNumber })).toContainText('Channel labels')

  // Download from the list again.
  const again = await downloadOf(page, () => table.getByRole('row').filter({ hasText: manualNumber }).getByRole('link', { name: 'Download' }).click())
  expect(again.suggestedFilename()).toBe(manual.suggestedFilename())

  // Exports: KNX group addresses (CSV) and the KNX device list; HDL and Zigbee are disabled with the reason.
  const exports = page.getByRole('region', { name: 'Programming exports' })
  const csv = await downloadOf(page, () => exports.getByRole('link', { name: 'Download: KNX group addresses (CSV)' }).click())
  expect(csv.suggestedFilename()).toMatch(/\.csv$/)
  const text = readFileSync(await csv.path(), 'utf8').replace(/^﻿/, '')
  const lines = text.split('\r\n')
  expect(lines[0]).toBe('"Main","Middle","Sub","Address","Central","Unfiltered","Description","DatapointType","Security"')
  expect(lines.some((l) => l.startsWith('"Ground floor","","","1/-/-"'))).toBe(true)
  expect(lines.some((l) => l.includes('Kitchen Spots Switch') && l.includes('"DPST-1-1"'))).toBe(true)

  const knxList = await downloadOf(page, () => exports.getByRole('link', { name: 'Download: KNX device list (XLSX)' }).click())
  expect((await zipParts(knxList)).get('xl/workbook.xml')).toBeDefined()
  await expect(exports.getByRole('button', { name: 'Download: HDL commissioning list (XLSX)' })).toBeDisabled()
  await expect(exports.getByText('This version has no HDL devices.')).toBeVisible()
  await expect(exports.getByRole('button', { name: 'Download: Zigbee device list (XLSX)' })).toBeDisabled()

  // The old tab name still opens the tab.
  await page.goto(`/projects/${s.project.id}/versions/${s.versionId}?tab=proposals`)
  await expect(page.getByRole('tab', { name: 'Documents', selected: true })).toBeVisible()

  // Delete the labels.
  await table.getByRole('row').filter({ hasText: labelsNumber }).getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete document' })
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toBeHidden()
  await expect(table.getByRole('row')).toHaveCount(2)
})

test('installation: an HDL line with a hand-set address and the HDL commissioning list', async ({ page, api }) => {
  // HDL: the scheme comes from the product type key (hdl…, D419).
  const s = await wiringSeed(api, { systemKey: 'hdl' })
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/projects/${s.project.id}/versions/${s.versionId}?tab=networks`)
  await page.getByRole('button', { name: 'Assign addresses', exact: true }).first().click()
  await expect(page.getByRole('row').filter({ hasText: s.dimmer.name })).toContainText('1.1')

  await page.getByRole('tab', { name: 'Documents' }).click()
  const exports = page.getByRole('region', { name: 'Programming exports' })
  const hdl = await downloadOf(page, () => exports.getByRole('link', { name: 'Download: HDL commissioning list (XLSX)' }).click())
  expect(hdl.suggestedFilename()).toMatch(/\.xlsx$/)
  const parts = await zipParts(hdl)
  expect(parts.get('xl/workbook.xml')).toBeDefined()
  await expect(exports.getByRole('button', { name: 'Download: KNX group addresses (CSV)' })).toBeDisabled()
})
