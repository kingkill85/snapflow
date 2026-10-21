import { writeFileSync } from 'node:fs'

import type { Page } from '@playwright/test'

import { type Api, expect, test } from '../fixtures'
import { autoConnect, catalog, json, villa } from '../villa-seed'

// Step 3e: the Documents tab (proposals, installation documents, programming
// exports with disabled reasons and an export error), the Networks tab's
// address column (automatic and by hand, an edit with an error, a device
// without gateway with an address, default and duplicate line prefixes), the
// Checks tab's address findings, the inspectors' address line, the zone
// inspector's short name and the catalog dialogs (KNX objects, addressing)
// at phone, tablet and desktop width, light and dark, English and German:
// nothing overflows the viewport (D107). Seed: the villa of the 3d visual spec
// with KNX actuators on a third row (D417, D434). Screenshots land in
// e2e/screenshots/installation-*.png; the generated manual, labels and exports
// of the seed next to them (installation-files-*). Tagged @visual.

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 }, wide: false },
  { name: 'tablet', size: { width: 768, height: 1024 }, wide: true },
  { name: 'desktop', size: { width: 1280, height: 800 }, wide: true },
]

const floorplan = { width: 1200, height: 800 }

const labels = {
  en: {
    inspector: 'Inspector',
    zones: 'Zones',
    saved: 'Saved',
    edit: 'Edit',
    editAddress: /^Edit address of .*touch panel/,
    addressOf: /^Address of .*touch panel/,
    exports: 'Programming exports',
    csv: /KNX group addresses \(CSV\)/,
  },
  de: {
    inspector: 'Details',
    zones: 'Zonen',
    saved: 'Gespeichert',
    edit: 'Bearbeiten',
    editAddress: /^Adresse von .*Touchpanel.* bearbeiten$/,
    addressOf: /^Adresse von .*Touchpanel/,
    exports: 'Programmierdaten',
    csv: /KNX-Gruppenadressen \(CSV\)/,
  },
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

async function imageToPage(page: Page) {
  const box = (await page.getByTestId('plan-canvas').boundingBox())!
  const scale = Math.min((box.width - 32) / floorplan.width, (box.height - 32) / floorplan.height)
  const ox = box.x + (box.width - floorplan.width * scale) / 2
  const oy = box.y + (box.height - floorplan.height * scale) / 2
  return { at: (x: number, y: number) => ({ x: ox + x * scale, y: oy + y * scale }) }
}

async function save(api: Api, path: string, file: string) {
  const res = await api.ctx.get(path)
  expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBe(true)
  writeFileSync(`e2e/screenshots/installation-files-${file}`, await res.body())
}

type Placement = { id: string; variantId: string; x: number; y: number; label?: string }

for (const lang of ['en', 'de'] as const) {
  test(`installation documents, addresses and exports fit the screen: ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
    test.setTimeout(900_000)
    const l = labels[lang]
    const cat = await catalog(api, lang)
    const s = await villa(api, cat, lang, 'Villa Gulberg, Lahore', { knx: true })
    const v = s.version
    await autoConnect(api, v)
    const [ground, first] = s.plans
    const groundDevices = ground.content.placements as Placement[]
    const firstDevices = first.content.placements as Placement[]
    const byVariant = (list: Placement[], key: string) => list.filter((p) => p.variantId === cat.products[key].variantId)
    const [, knxType, zigbeeType] = await Promise.all(cat.types.map((id) => api.productType(id)))

    // Zone short name for the labels (D433).
    const zones = ground.content.zones ?? []
    // A door sensor on the ground floor, which has no Zigbee gateway: a device without gateway.
    const lone = { id: crypto.randomUUID(), variantId: cat.products.sensor.variantId, x: 300, y: 600, label: 'S1' }
    await api.savePlanContent(ground.id, {
      ...ground.content,
      placements: [...groundDevices, lone],
      zones: zones.map((z, i) => (i === 0 ? { ...z, shortName: lang === 'en' ? 'Drawing' : 'Salon' } : z)) as typeof zones,
    })

    // The first floor's second gateway goes away while the door sensor is pinned to it: the sensor is without gateway.
    const [, gw2] = byVariant(firstDevices, 'gateway')
    const sensor = byVariant(firstDevices, 'sensor')[0]
    await json(await api.ctx.put(`/api/versions/${v}/network-assignments`, { data: { assignments: [{ planId: first.id, itemId: sensor.id, gatewayPlanId: first.id, gatewayItemId: gw2.id }] } }))
    const firstContent = { ...first.content, placements: firstDevices.filter((p) => p.id !== gw2.id) }
    await api.savePlanContent(first.id, firstContent)

    // A second KNX line with the same prefix as the first (bus_line_address_duplicate); HDL keeps its default prefix.
    const lines = await json<{ id: string; name: string; productTypeId: string }[] | { items: { id: string; name: string; productTypeId: string }[] }>(await api.ctx.get(`/api/versions/${v}/bus-lines`))
    const lineList = Array.isArray(lines) ? lines : lines.items
    const knxLine = lineList.find((x) => x.productTypeId === cat.types[1])!
    await json(await api.ctx.put(`/api/versions/${v}/bus-lines/${knxLine.id}`, { data: { name: knxLine.name, address: '1.1' } }))
    await json(await api.ctx.post(`/api/versions/${v}/bus-lines`, { data: { productTypeId: cat.types[1], name: 'KNX 2', address: '1.1' } }))

    // Automatic addresses, then some by hand: the touch panel (pinned), a presence detector outside its line, the
    // gateway, a bulb and the sensor without gateway (IEEE).
    await json(await api.ctx.post(`/api/versions/${v}/addresses/assign`, { data: {} }))
    const touch = byVariant(groundDevices, 'touch')[0]
    const presence = byVariant(groundDevices, 'presence')[1]
    const [gw1] = byVariant(firstDevices, 'gateway')
    const bulb = byVariant(firstDevices, 'bulb')[0]
    await json(
      await api.ctx.put(`/api/versions/${v}/addresses`, {
        data: {
          addresses: [
            { planId: ground.id, itemId: touch.id, knx: '1.1.20', note: lang === 'en' ? 'Entrance' : 'Eingang' },
            { planId: ground.id, itemId: presence.id, knx: '1.3.7' },
            { planId: first.id, itemId: gw1.id, ieee: '00:12:4B:00:1C:A1:B2:C3' },
            { planId: first.id, itemId: bulb.id, ieee: '00158D0004A1B2C4' },
            { planId: first.id, itemId: sensor.id, ieee: '00-15-8D-00-04-A1-B2-C5' },
            { planId: ground.id, itemId: lone.id, ieee: '00 15 8d 00 04 a1 b2 c6' },
          ],
        },
      }),
    )
    // A presence detector added afterwards has no address yet (address_missing).
    await api.savePlanContent(first.id, { ...firstContent, placements: [...(firstContent.placements as Placement[]), { id: crypto.randomUUID(), variantId: cat.products.presence.variantId, x: 380, y: 600, label: '' }] })

    // Group addresses stored; the manual and the labels generated; files of the seed for the review.
    await json(await api.ctx.post(`/api/versions/${v}/group-addresses/assign`, { data: {} }))
    for (const kind of ['installation_manual', 'channel_labels'] as const) {
      const doc = await json<{ downloadUrl: string }>(await api.ctx.post(`/api/versions/${v}/documents`, { data: { kind } }))
      await save(api, doc.downloadUrl, `${kind}-${lang}.docx`)
    }
    await save(api, `/api/versions/${v}/exports/knx-group-addresses.csv`, `ga-1-1-${lang}.csv`)
    await save(api, `/api/versions/${v}/exports/knx-group-addresses.csv?format=3-1`, `ga-3-1-${lang}.csv`)
    for (const x of ['knx-devices', 'hdl-commissioning', 'wireless-devices']) await save(api, `/api/versions/${v}/exports/${x}.xlsx`, `${x}-${lang}.xlsx`)

    const tab = (name: string) => `/projects/${s.project.id}/versions/${v}?tab=${name}`
    const boardPath = `/projects/${s.project.id}/versions/${v}/boards/${s.board.id}`
    const floorPath = `/projects/${s.project.id}/versions/${v}/plans/${ground.id}`
    const inspector = (p: Page) => p.getByRole('tab', { name: l.inspector, exact: true }).click()

    type Step = { name: string; path: () => string; wide?: boolean; editor?: boolean; fullPage?: boolean; act?: (p: Page) => Promise<void>; after?: (p: Page) => Promise<void> }
    const steps: Step[] = [
      { name: 'documents', path: () => tab('documents'), fullPage: true },
      {
        name: 'documents-export-error',
        path: () => tab('documents'),
        act: async (p) => {
          await p.route('**/exports/knx-group-addresses.csv*', (route) =>
            route.fulfill({ status: 422, contentType: 'application/problem+json', body: JSON.stringify({ status: 422, code: 'export.too_many_group_addresses', detail: 'too many', params: { max: 31 } }) }),
          )
          const exports = p.getByRole('region', { name: l.exports })
          await exports.getByRole('button', { name: l.csv }).click()
          await expect(exports.getByRole('alert')).toBeVisible()
          await exports.getByRole('alert').scrollIntoViewIfNeeded()
        },
        after: (p) => p.unrouteAll(),
      },
      { name: 'networks', path: () => tab('networks'), fullPage: true },
      {
        name: 'networks-edit-error',
        path: () => tab('networks'),
        act: async (p) => {
          await p.getByRole('button', { name: l.editAddress }).click()
          const field = p.getByRole('textbox', { name: l.addressOf })
          await field.fill('1.1.300')
          await field.press('Enter')
          await expect(p.getByRole('alert').or(p.locator('[id$="-error"]')).first()).toBeVisible()
        },
      },
      { name: 'checks', path: () => tab('checks'), fullPage: true },
      {
        name: 'board-inspector',
        path: () => boardPath,
        editor: true,
        wide: true,
        act: async (p) => {
          await p.getByRole('button', { name: /^.*, Q2, / }).click()
          await expect(p.getByRole('tab', { name: l.inspector, exact: true })).toHaveAttribute('aria-selected', 'true')
        },
      },
      {
        name: 'floorplan-inspector',
        path: () => floorPath,
        editor: true,
        wide: true,
        act: async (p) => {
          const at = (await imageToPage(p)).at(touch.x, touch.y)
          await p.mouse.click(at.x, at.y)
          await inspector(p)
        },
      },
      {
        name: 'zone-inspector',
        path: () => floorPath,
        editor: true,
        wide: true,
        act: async (p) => {
          await p.getByRole('tab', { name: l.zones, exact: true }).click()
          await p.getByRole('tabpanel', { name: l.zones }).getByRole('button', { name: cat.names.drawing[lang], exact: true }).click()
        },
      },
      {
        name: 'function-type-dialog',
        path: () => '/catalog/function-types',
        act: async (p) => {
          await p.getByRole('row').filter({ hasText: cat.fns.dimmable.key }).getByRole('button', { name: l.edit }).click()
          // The KNX objects repeater (D436), scrolled into view.
          await p.getByRole('dialog').getByRole('group').last().scrollIntoViewIfNeeded()
        },
      },
      {
        name: 'product-type-dialog',
        path: () => '/catalog/product-types',
        act: async (p) => {
          await p.getByRole('row').filter({ hasText: knxType.key }).getByRole('button', { name: l.edit }).click()
          await expect(p.getByRole('dialog')).toBeVisible()
        },
      },
      {
        name: 'product-type-dialog-wireless',
        path: () => '/catalog/product-types',
        act: async (p) => {
          await p.getByRole('row').filter({ hasText: zigbeeType.key }).getByRole('button', { name: l.edit }).click()
          await expect(p.getByRole('dialog')).toBeVisible()
        },
      },
    ]

    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const step of steps) {
          if (step.wide && !viewport.wide) continue
          await page.goto(step.path())
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          if (step.editor) await expect(page.getByText(l.saved, { exact: true })).toBeVisible()
          await page.waitForLoadState('networkidle')
          if (step.act) await step.act(page)
          await page.waitForTimeout(300)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/installation-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          await page.keyboard.press('Escape')
          if (step.after) await step.after(page)
        }
      }
    }
  })
}
