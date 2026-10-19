import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Page, type Route } from '@playwright/test'

import { Api, expect, test, unique, uniqueKey } from '../fixtures'

// Every page, dialog and state of plans and the floorplan editor (step 2b) at
// phone, tablet and desktop width, light and dark, English and German: nothing
// overflows the viewport. Screenshots land in e2e/screenshots/plan-*.png for a
// look by eye. The data is seeded through the API (the flows themselves are
// tested in plans.spec.ts). Tagged @visual: it runs with `make e2e-visual`.

const assets = join(import.meta.dirname, '../assets')
const file = (name: string) => readFileSync(join(assets, name))
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: file('floorplan.png') })
const floorplan = { width: 1200, height: 800 }

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 }, wide: false },
  { name: 'tablet', size: { width: 768, height: 1024 }, wide: true },
  { name: 'desktop', size: { width: 1280, height: 800 }, wide: true },
]

const labels = {
  en: {
    add: 'Add plan',
    edit: (n: string) => `Edit ${n}`,
    del: (n: string) => `Delete ${n}`,
    products: 'Products',
    zones: 'Zones',
    inspector: 'Inspector',
    layers: 'Layers',
    calibrate: 'Calibrate scale',
    saved: 'Saved',
    saving: 'Saving…',
    failed: 'Save failed',
    plan: { main: 'Ground floor', upper: 'Upper floor', cellar: 'Cellar with boiler room and storage' },
    zone: { living: 'Living room', kitchen: 'Kitchen', bath: 'Bathroom' },
  },
  de: {
    add: 'Plan hinzufügen',
    edit: (n: string) => `${n} bearbeiten`,
    del: (n: string) => `${n} löschen`,
    products: 'Produkte',
    zones: 'Zonen',
    inspector: 'Eigenschaften',
    layers: 'Ebenen',
    calibrate: 'Maßstab kalibrieren',
    saved: 'Gespeichert',
    saving: 'Speichert…',
    failed: 'Speichern fehlgeschlagen',
    plan: { main: 'Erdgeschoss', upper: 'Obergeschoss', cellar: 'Keller mit Heizungsraum und Abstellraum' },
    zone: { living: 'Wohnzimmer', kitchen: 'Küche', bath: 'Badezimmer' },
  },
}

type Lang = keyof typeof labels

async function json<T>(res: Awaited<ReturnType<Api['ctx']['get']>>): Promise<T> {
  expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

/** Replaces a plan's content (takes and releases the lock as `api`'s user). */
async function putContent(api: Api, planId: string, content: object) {
  await json(await api.ctx.post(`/api/plans/${planId}/lock`))
  const current = await api.planContent(planId)
  await json(
    await api.ctx.put(`/api/plans/${planId}/content`, {
      data: { expectedContentUpdatedAt: (current as unknown as { contentUpdatedAt: string }).contentUpdatedAt, ...content },
    }),
  )
  await api.ctx.delete(`/api/plans/${planId}/lock`)
}

/** A catalog of two systems with images, add-ons and an instance attribute; a project with three plans. */
async function seed(api: Api, lang: Lang) {
  const l = labels[lang]
  const zigbee = await api.createKind(
    {
      name: { en: unique('Switches and sensors'), de: unique('Schalter und Sensoren') },
      instanceAttributes: [
        { key: 'circuit', label: { en: 'Circuit', de: 'Stromkreis' }, type: 'text' },
        { key: 'height', label: { en: 'Mounting height', de: 'Montagehöhe' }, type: 'number', unit: 'cm' },
      ],
    },
    { name: { en: unique('Zigbee'), de: unique('Zigbee') }, abbreviation: 'ZB', color: '#1f6feb' },
  )
  const knx = await api.createKind(
    { name: { en: unique('Actuators'), de: unique('Aktoren') } },
    { name: { en: unique('KNX'), de: unique('KNX') }, abbreviation: 'KNX', color: '#d9480f' },
  )
  const blue = await api.uploadFile('blue.png', 'image/png', file('blue.png'))
  const red = await api.uploadFile('red.png', 'image/png', file('red.png'))

  const product = async (kind: typeof zigbee, en: string, de: string, image?: string) => {
    const p = await api.createProduct({ ...kind.ids, name: { en, de } })
    const v = await api.createVariant(p.id, { name: { en: 'White', de: 'Weiß' }, imageFileId: image, price: '49.90' })
    return { product: p, variant: v }
  }
  const sw = await product(zigbee, 'Wall switch 2-gang with status LED', 'Wandschalter 2-fach mit Status-LED', blue.id)
  const sensor = await product(zigbee, 'Motion sensor', 'Bewegungsmelder', red.id)
  const dimmer = await product(zigbee, 'Rotary dimmer (discontinued)', 'Drehdimmer (ausgelaufen)', blue.id)
  const actuator = await product(knx, 'Switch actuator 8-fold', 'Schaltaktor 8-fach')
  const accessories = await api.createProduct({ ...zigbee.ids, name: { en: 'Accessories', de: 'Zubehör' } })
  const battery = await api.createVariant(accessories.id, { name: { en: 'Battery pack CR2032', de: 'Batteriepack CR2032' }, price: '4.90' })
  const frame = await api.createVariant(accessories.id, { name: { en: 'Design frame anthracite', de: 'Designrahmen anthrazit' }, price: '12.50' })
  await api.replaceAddons(sw.product.id, sw.variant.id, [{ addonVariantId: battery.id, required: true }, { addonVariantId: frame.id }])

  const project = await json<{ id: string; number: string; name: string; versions: { id: string }[] }>(
    await api.ctx.post('/api/projects', {
      data: { name: unique('Villa Mustermann-Schmidt'), productTypeIds: [zigbee.type.id, knx.type.id], customer: { name: 'Erika Musterfrau' } },
    }),
  )
  const version = project.versions[0].id
  const main = await api.createPlan(version, l.plan.main, planImage())
  const upper = await api.createPlan(version, l.plan.upper, planImage())
  await api.createPlan(version, l.plan.cellar, planImage())

  const id = () => crypto.randomUUID()
  const placement = (variantId: string, x: number, y: number, extra: object = {}) => ({
    id: id(),
    variantId,
    x,
    y,
    width: 64,
    height: 40,
    rotation: 0,
    label: '',
    existing: false,
    addonVariantIds: [],
    instanceValues: {},
    ...extra,
  })
  // Needs (3b): function types with and without a pictogram, a load type, a room template.
  const fn = async (key: string, en: string, de: string, loadTypeIds: string[] = []) =>
    json<{ id: string }>(await api.ctx.post('/api/function-types', { data: { key: uniqueKey(key), name: { en, de }, allowsCircuit: false, loadTypeIds } }))
  const led = await json<{ id: string }>(await api.ctx.post('/api/load-types', { data: { key: uniqueKey('led'), name: { en: 'LED', de: 'LED' }, isActive: true } }))
  const dimmable = await fn('dimmable_light', 'Dimmable light', 'Dimmbares Licht', [led.id])
  const blindFn = await fn('roller_blind', 'Roller blind', 'Rollladen')
  const socketFn = await fn('socket', 'Switched socket', 'Schaltbare Steckdose')
  const heating = await fn('heating_valve', 'Heating valve', 'Heizungsventil')
  await api.ctx.post('/api/room-templates', {
    data: {
      key: uniqueKey('living'),
      name: { en: 'Living room', de: 'Wohnzimmer' },
      equipmentLevel: { en: 'Comfort', de: 'Komfort' },
      isActive: true,
      lines: [
        { functionTypeId: dimmable.id, quantity: 4, powerW: 7.5, loadTypeId: led.id, label: 'Ceiling' },
        { functionTypeId: blindFn.id, quantity: 2, powerW: null, loadTypeId: null, label: '' },
      ],
    },
  })
  const need = (functionTypeId: string, extra: object = {}) => ({ id: id(), zoneId: null, functionTypeId, quantity: 1, powerW: null, loadTypeId: null, label: '', note: '', x: null, y: null, ...extra })
  const switchPlacement = placement(sw.variant.id, 160, 140, { label: 'S1', addonVariantIds: [frame.id], instanceValues: { circuit: 'F3', height: 105 } })
  const content = {
    scale: 0.01,
    zones: [
      { id: id(), name: l.zone.living, color: '#4f7cff', opacity: 0.2, points: [[12, 12], [594, 12], [594, 788], [12, 788]] },
      { id: id(), name: l.zone.kitchen, color: '#f59f00', opacity: 0.25, points: [[606, 12], [1188, 12], [1188, 394], [606, 394]] },
      { id: id(), name: l.zone.bath, color: '#12b886', opacity: 0.25, points: [[606, 406], [1188, 406], [1188, 788], [800, 788], [800, 600], [606, 600]] },
    ],
    placements: [
      switchPlacement,
      placement(sw.variant.id, 540, 140, { label: 'S2' }),
      placement(sensor.variant.id, 300, 420, { width: 48, height: 30 }),
      placement(sensor.variant.id, 900, 200, { width: 48, height: 30, rotation: 45 }),
      placement(actuator.variant.id, 1050, 300, { existing: true, label: 'A1' }),
      placement(dimmer.variant.id, 700, 520),
      placement(sw.variant.id, 1000, 700),
    ],
    needs: [] as object[],
  }
  const bath = content.zones[2].id
  content.needs = [
    need(dimmable.id, { zoneId: bath, quantity: 3, powerW: 7.5, loadTypeId: led.id, label: 'Ceiling spots over the bathtub and the double washbasin', note: 'Warm white, IP44' }),
    need(blindFn.id, { zoneId: bath, quantity: 1, label: 'Window' }),
    need(heating.id, { zoneId: bath, quantity: 1 }),
    need(dimmable.id, { x: 300, y: 250, quantity: 2, label: 'Pendant' }),
    need(blindFn.id, { x: 1100, y: 100 }),
    need(socketFn.id, { x: 700, y: 300, label: 'Coffee' }),
    need(heating.id, { x: 900, y: 700 }),
  ]
  await putContent(api, main.id, content)
  await putContent(api, upper.id, { scale: null, zones: [content.zones[0]], placements: [placement(sensor.variant.id, 300, 300)] })
  // Discontinued after it was placed: a warning marker.
  await api.updateProduct(dimmer.product.id, { isActive: false })

  // A project without plans; a completed project with a plan.
  const empty = await json<{ id: string }>(await api.ctx.post('/api/projects', { data: { name: unique('Neubau Schulze'), productTypeIds: [zigbee.type.id] } }))
  const done = await json<{ id: string; name: string; versions: { id: string }[] }>(
    await api.ctx.post('/api/projects', { data: { name: unique('Abgeschlossen Meier'), productTypeIds: [zigbee.type.id, knx.type.id] } }),
  )
  const donePlan = await api.createPlan(done.versions[0].id, l.plan.main, planImage())
  await putContent(api, donePlan.id, content)
  const current = await json<{ updatedAt: string }>(await api.ctx.get(`/api/projects/${done.id}`))
  await json(await api.ctx.put(`/api/projects/${done.id}`, { data: { name: done.name, status: 'completed', expectedUpdatedAt: current.updatedAt } }))

  return { project, version, main, upper, empty, done, donePlan, switchPlacement }
}

/** Maps image pixels to page coordinates (the editor fits the image with 16 px padding). */
async function imageToPage(page: Page) {
  const box = (await page.getByTestId('plan-canvas').boundingBox())!
  const scale = Math.min((box.width - 32) / floorplan.width, (box.height - 32) / floorplan.height)
  const ox = box.x + (box.width - floorplan.width * scale) / 2
  const oy = box.y + (box.height - floorplan.height * scale) / 2
  return { box, at: (x: number, y: number) => ({ x: ox + x * scale, y: oy + y * scale }) }
}

for (const lang of ['en', 'de'] as const) {
  for (const viewport of viewports) {
    test(`plans and the editor fit the screen: ${viewport.name}, ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
      test.setTimeout(600_000)
      const l = labels[lang]
      const s = await seed(api, lang)
      const projectPath = `/projects/${s.project.id}`
      const editor = (planId: string, projectId = s.project.id, versionId = s.version) => `/projects/${projectId}/versions/${versionId}/plans/${planId}`

      // Another admin who holds the upper floor's lock.
      const other = await api.createUser({ role: 'admin', fullName: 'Bea Bauer-Lindqvist' })
      const otherApi = await Api.login(other.email, other.password)
      const holdUpper = async () => json(await otherApi.ctx.post(`/api/plans/${s.upper.id}/lock`))

      const ready = async (p: Page, editable = true) => {
        await expect(p.getByTestId('plan-canvas')).toBeVisible()
        if (editable) await expect(p.getByText(l.saved, { exact: true })).toBeVisible()
        await p.waitForLoadState('networkidle')
        await p.waitForTimeout(300)
      }
      const tab = (p: Page, name: string) => p.getByRole('tab', { name, exact: true }).click()

      type Step = { name: string; path: () => string; wide?: boolean; editor?: boolean; editable?: boolean; fullPage?: boolean; before?: () => Promise<unknown>; act?: (p: Page) => Promise<void> }
      const steps: Step[] = [
        { name: 'section', path: () => projectPath, before: holdUpper, fullPage: true },
        { name: 'section-empty', path: () => `/projects/${s.empty.id}`, fullPage: true },
        {
          name: 'add-dialog',
          path: () => projectPath,
          act: async (p) => {
            await p.getByRole('button', { name: l.add }).click()
            await expect(p.getByRole('dialog')).toBeVisible()
          },
        },
        {
          name: 'edit-dialog',
          path: () => projectPath,
          act: async (p) => {
            await p.getByRole('button', { name: l.edit(l.plan.main) }).click()
            await expect(p.getByRole('dialog')).toBeVisible()
          },
        },
        {
          name: 'delete-confirm',
          path: () => projectPath,
          act: async (p) => {
            await p.getByRole('button', { name: l.del(l.plan.cellar) }).click()
            await expect(p.getByRole('dialog')).toBeVisible()
          },
        },
        { name: 'editor', path: () => editor(s.main.id), editor: true, editable: viewport.wide },
        { name: 'editor-zones', path: () => editor(s.main.id), editor: true, wide: true, act: (p) => tab(p, l.zones) },
        { name: 'editor-layers', path: () => editor(s.main.id), editor: true, wide: true, act: (p) => tab(p, l.layers) },
        {
          name: 'editor-inspector-placement',
          path: () => editor(s.main.id),
          editor: true,
          wide: true,
          act: async (p) => {
            const map = await imageToPage(p)
            const at = map.at(s.switchPlacement.x, s.switchPlacement.y)
            await p.mouse.click(at.x, at.y)
            await tab(p, l.inspector)
            await expect(p.getByRole('tabpanel', { name: l.inspector }).getByLabel(lang === 'de' ? 'Stromkreis' : 'Circuit')).toHaveValue('F3')
          },
        },
        {
          name: 'editor-inspector-zone',
          path: () => editor(s.main.id),
          editor: true,
          wide: true,
          act: async (p) => {
            await tab(p, l.zones)
            await p.getByRole('tabpanel', { name: l.zones }).getByRole('button', { name: l.zone.bath, exact: true }).click()
            await tab(p, l.inspector)
          },
        },
        {
          name: 'editor-need-edit',
          path: () => editor(s.main.id),
          editor: true,
          wide: true,
          act: async (p) => {
            await tab(p, l.zones)
            await p.getByRole('tabpanel', { name: l.zones }).getByRole('button', { name: l.zone.bath, exact: true }).click()
            await tab(p, l.inspector)
            const needs = p.getByRole('tabpanel', { name: l.inspector }).getByRole('region', { name: lang === 'de' ? 'Bedarf' : 'Needs', exact: true })
            await needs.getByRole('button', { name: lang === 'de' ? /bearbeiten$/ : /^Edit / }).first().click()
            await needs.scrollIntoViewIfNeeded()
          },
        },
        {
          name: 'editor-place-need',
          path: () => editor(s.main.id),
          editor: true,
          wide: true,
          act: async (p) => {
            await p.getByRole('button', { name: lang === 'de' ? 'Bedarf platzieren' : 'Place need' }).click()
          },
        },
        {
          name: 'editor-inspector-symbol',
          path: () => editor(s.main.id),
          editor: true,
          wide: true,
          act: async (p) => {
            const map = await imageToPage(p)
            const at = map.at(700, 300)
            await p.mouse.click(at.x, at.y)
            await tab(p, l.inspector)
            await expect(p.getByRole('tabpanel', { name: l.inspector }).getByText(lang === 'de' ? 'Bedarfssymbol' : 'Need symbol')).toBeVisible()
          },
        },
        {
          name: 'editor-multi',
          path: () => editor(s.main.id),
          editor: true,
          wide: true,
          act: async (p) => {
            const map = await imageToPage(p)
            await p.mouse.click(map.box.x + 4, map.box.y + 4)
            await p.keyboard.press('Control+a')
            await tab(p, l.inspector)
          },
        },
        {
          name: 'editor-calibrate',
          path: () => editor(s.main.id),
          editor: true,
          wide: true,
          act: async (p) => {
            await p.getByRole('button', { name: l.calibrate }).click()
            const map = await imageToPage(p)
            for (const [x, y] of [
              [12, 795],
              [594, 795],
            ]) {
              const at = map.at(x, y)
              await p.mouse.click(at.x, at.y)
            }
            await expect(p.getByRole('dialog')).toBeVisible()
          },
        },
        {
          name: 'editor-saving',
          path: () => editor(s.main.id),
          editor: true,
          wide: true,
          act: async (p) => {
            let held: Route | undefined
            await p.route('**/api/plans/*/content', async (route) => {
              if (route.request().method() !== 'PUT') return route.fallback()
              held = route
            })
            await tab(p, l.zones)
            await p.getByRole('tabpanel', { name: l.zones }).getByRole('button', { name: l.zone.kitchen, exact: true }).click()
            await tab(p, l.inspector)
            await p.getByRole('tabpanel', { name: l.inspector }).getByLabel('Name', { exact: true }).fill(`${l.zone.kitchen} 2`)
            await expect(p.getByText(l.saving, { exact: true })).toBeVisible()
            cleanup = async () => {
              await p.unroute('**/api/plans/*/content')
              await held?.fallback()
              await p.getByRole('tabpanel', { name: l.inspector }).getByLabel('Name', { exact: true }).fill(l.zone.kitchen)
              await expect(p.getByText(l.saved, { exact: true })).toBeVisible()
            }
          },
        },
        {
          name: 'editor-save-failed',
          path: () => editor(s.main.id),
          editor: true,
          wide: true,
          act: async (p) => {
            await p.route('**/api/plans/*/content', async (route) => {
              if (route.request().method() !== 'PUT') return route.fallback()
              await route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ status: 500, title: 'Internal Server Error', code: 'internal' }) })
            })
            await tab(p, l.zones)
            await p.getByRole('tabpanel', { name: l.zones }).getByRole('button', { name: l.zone.kitchen, exact: true }).click()
            await tab(p, l.inspector)
            await p.getByRole('tabpanel', { name: l.inspector }).getByLabel('Name', { exact: true }).fill(`${l.zone.kitchen} 2`)
            await expect(p.getByText(l.failed, { exact: true })).toBeVisible()
            cleanup = async () => {
              await p.unroute('**/api/plans/*/content')
              await p.getByRole('tabpanel', { name: l.inspector }).getByLabel('Name', { exact: true }).fill(l.zone.kitchen)
              await expect(p.getByText(l.saved, { exact: true })).toBeVisible()
            }
          },
        },
        {
          // Zoomed in first: the export's strokes and labels do not depend on the zoom.
          name: 'editor-export',
          path: () => editor(s.main.id),
          editor: true,
          wide: true,
          act: async (p) => {
            for (let i = 0; i < 3; i++) await p.getByRole('button', { name: lang === 'de' ? 'Vergrößern' : 'Zoom in' }).click()
            const download = p.waitForEvent('download')
            await p.getByRole('button', { name: lang === 'de' ? 'Als PNG exportieren' : 'Export PNG' }).click()
            await (await download).saveAs(`e2e/screenshots/plan-exported-${viewport.name}-${await p.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))}-${lang}.png`)
          },
        },
        { name: 'editor-locked', path: () => editor(s.upper.id), before: holdUpper, editor: true, editable: false },
        { name: 'editor-read-only', path: () => editor(s.donePlan.id, s.done.id, s.done.versions[0].id), editor: true, editable: false },
      ]
      let cleanup: (() => Promise<void>) | undefined

      await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const step of steps) {
          if (step.wide && !viewport.wide) continue
          await step.before?.()
          await page.goto(step.path())
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          if (step.editor) await ready(page, step.editable ?? true)
          else await page.waitForLoadState('networkidle')
          if (step.act) await step.act(page)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/plan-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          if (cleanup) {
            await cleanup()
            cleanup = undefined
          }
          await page.keyboard.press('Escape')
        }
      }
      await otherApi.dispose()
    })
  }
}
