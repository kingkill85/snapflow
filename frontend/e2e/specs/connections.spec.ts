import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures'
import { wiringSeed } from '../wiring-seed'

// Step 3d: needs in zones and a board with dimmer, relay (blind mode), blind
// actuator and power supply; the Checks tab, auto-connect preview/apply, a
// connection moved by hand in the board editor, a bus line near its limit,
// and undoing the auto-connect batch.

/** An overview card of the Checks tab by its heading. */
const card = (page: Page, heading: RegExp) => page.getByRole('heading', { name: heading }).locator('xpath=../..')

test('connections: checks, auto-connect, a hand move, a bus line near its limit, undo', async ({ page, api }) => {
  const s = await wiringSeed(api)
  const checksUrl = `/projects/${s.project.id}/versions/${s.versionId}?tab=checks`
  await page.setViewportSize({ width: 1400, height: 900 })

  // Checks: nothing connected yet.
  await page.goto(`/projects/${s.project.id}`)
  await page.getByRole('tab', { name: 'Checks' }).click()
  await expect(page).toHaveURL(/\?tab=checks/)
  const zones = card(page, /^Zones covered$/)
  await expect(zones).toContainText('0 / 2')
  await expect(zones).toContainText('Not all covered')
  const unconnected = page.getByRole('region', { name: 'Unconnected needs' })
  await expect(unconnected.getByRole('list', { name: 'Ground floor · Kitchen' })).toContainText(`3 × ${s.lightName} · Spots — 0 of 3 connected`)
  await expect(unconnected.getByRole('list', { name: 'Ground floor · Living room' })).toContainText(`1 × ${s.blindName} · Door`)
  await expect(card(page, /^Bus line /)).toContainText('80 of 160 mA (reserve 20 %)')

  // Auto-connect: preview, apply.
  await page.getByRole('button', { name: 'Auto-connect…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Auto-connect' })
  await dialog.getByRole('button', { name: 'Preview' }).click()
  await expect(dialog.getByText('7 units will be connected.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Auto-connect made 5 connections.')).toBeVisible()
  await expect(zones).toContainText('2 / 2')
  await expect(zones).toContainText('All covered')
  await expect(unconnected.getByText('Every need is connected.')).toBeVisible()

  // A hand move in the board editor (a second tab, so the undo notice stays here). Auto-connect gave the
  // kitchen's windows the native blind outputs of J1 and the living room's door a relay pair of Q1 (D409); the
  // door moves from Q1's blind output 1 (relays 1–2) to blind output 2 (relays 3–4).
  const editor = await page.context().newPage()
  await editor.setViewportSize({ width: 1400, height: 900 })
  await editor.goto(`/projects/${s.project.id}/versions/${s.versionId}/boards/${s.board.id}`)
  await expect(editor.getByRole('button', { name: new RegExp(`^${s.blindAct.name}, J1, 4 TE, 2 of 2 channels used`) })).toBeVisible()
  await editor.getByRole('button', { name: new RegExp(`^${s.relay.name}, Q1, 4 TE`) }).click()
  // The module badge counts used physical channels: the two relays of the pair's blind output.
  const q1 = new RegExp(`^${s.relay.name}, Q1, 4 TE, 2 of 4 channels used`)
  await expect(editor.getByRole('button', { name: q1 })).toBeVisible()
  const channels = editor.getByRole('region', { name: 'Channels' })
  const door = `1 × ${s.blindName} · Door`
  const disconnect = channels.getByRole('button', { name: `Disconnect ${door}` })
  await expect(disconnect).toBeVisible()
  await disconnect.click()
  await expect(disconnect).toHaveCount(0)
  const second = channels.getByRole('button', { name: /^Connect a need to Blind output .* 2$/ })
  await second.click()
  const picker = editor.getByRole('dialog', { name: /^Connect a need to / })
  await picker.getByRole('button', { name: `Connect to ${door} — Ground floor · Living room` }).click()
  await expect(picker).toBeHidden()
  await expect(disconnect).toHaveCount(1)
  await expect(editor.getByRole('button', { name: q1 })).toBeVisible()

  // The catalog raises the dimmer's bus current: the line is near its limit (130 of 160 mA > 80 %).
  const product = (await (await api.ctx.get(`/api/products/${s.dimmer.id}`)).json()) as { attributes: Record<string, unknown> }
  const updated = await api.updateProduct(s.dimmer.id, { attributes: { ...product.attributes, [s.f.busMa.key]: 80 } })
  expect(updated.id).toBe(s.dimmer.id)
  await editor.goto(`/projects/${s.project.id}/versions/${s.versionId}?tab=checks`)
  const line = card(editor, /^Bus line /)
  await expect(line).toContainText('130 of 160 mA (reserve 20 %)')
  await expect(line.getByText('Near limit').first()).toBeVisible()
  await editor.close()

  // Undo the batch: everything auto-connected goes, the hand-made connection stays.
  await page.bringToFront()
  await page.getByRole('button', { name: 'Undo auto-connect' }).click()
  await expect(page.getByText('Auto-connect undone: 4 connections removed.')).toBeVisible()
  await expect(zones).toContainText('0 / 2')
  await expect(unconnected.getByRole('list', { name: 'Ground floor · Kitchen' })).toContainText(`3 × ${s.lightName} · Spots — 0 of 3 connected`)
  const livingList = unconnected.getByRole('list', { name: 'Ground floor · Living room' })
  await expect(livingList).toContainText(`1 × ${s.lightName} · Ceiling`)
  await expect(livingList).not.toContainText('Door')
  await page.goto(checksUrl)
  await expect(card(page, /^Bus line /)).toContainText('Near limit')

  // One problem list (D453, D454): the dimmer's product goes inactive; the Checks tab lists it under the
  // board with a link that opens the board editor on D1, and the editor's Problems tab lists it too.
  await api.updateProduct(s.dimmer.id, { isActive: false })
  await page.goto(checksUrl)
  const findings = page.getByRole('region', { name: 'Findings' })
  const boardGroup = findings.getByRole('region', { name: 'Main board' })
  const inactive = /^D1\b.*: the product is inactive in the catalog\.$/
  await expect(boardGroup.getByText(inactive)).toBeVisible()
  await expect(findings.getByRole('region', { name: 'Version (networks)' })).toContainText('Line 1: 130 of 160 mA used')
  await boardGroup.getByRole('link', { name: /^Open: D1\b.*the product is inactive/ }).click()
  await expect(page.getByRole('tabpanel', { name: 'Inspector' }).getByText(inactive)).toBeVisible()
  await page.getByRole('tab', { name: /^Problems \(\d+\)$/ }).click()
  const problems = page.getByRole('tabpanel', { name: /^Problems/ })
  await problems.getByRole('button', { name: /^Show: D1\b.*the product is inactive/ }).click()
  await expect(page.getByRole('tabpanel', { name: 'Inspector' }).getByText(inactive)).toBeVisible()
})
