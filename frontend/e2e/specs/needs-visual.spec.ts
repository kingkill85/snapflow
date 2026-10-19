import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type Page } from '@playwright/test'

import { Api, expect, test, unique, uniqueKey } from '../fixtures'

// Step 3b at phone, tablet and desktop width, light and dark, English and
// German: zone needs in the inspector, room templates, load symbols on the
// canvas and in the export, the version's needs tab and the plan cards.
// Screenshots land in e2e/screenshots/needs-*.png. Seeded through the API (the
// flows are tested in needs.spec.ts). Tagged @visual: runs with `make e2e-visual`.

const assets = join(import.meta.dirname, '../assets')
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })
const floorplan = { width: 1200, height: 800 }

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 }, wide: false },
  { name: 'tablet', size: { width: 768, height: 1024 }, wide: true },
  { name: 'desktop', size: { width: 1280, height: 800 }, wide: true },
]

const labels = {
  en: {
    zones: 'Zones',
    inspector: 'Inspector',
    layers: 'Layers',
    saved: 'Saved',
    needs: 'Needs',
    edit: 'Edit',
    applyTemplate: 'Apply template',
    placeNeed: 'Place need',
    placeFunction: 'Function type of the next symbol',
    exportPng: 'Export PNG',
    plan: 'Ground floor',
    zone: { living: 'Living room', kitchen: 'Kitchen', bedroom: 'Bedroom', hall: 'Hallway', bath: 'Bathroom' },
  },
  de: {
    zones: 'Zonen',
    inspector: 'Eigenschaften',
    layers: 'Ebenen',
    saved: 'Gespeichert',
    needs: 'Bedarf',
    edit: 'Bearbeiten',
    applyTemplate: 'Vorlage anwenden',
    placeNeed: 'Bedarf platzieren',
    placeFunction: 'Funktionstyp des nächsten Symbols',
    exportPng: 'Als PNG exportieren',
    plan: 'Erdgeschoss',
    zone: { living: 'Wohnzimmer', kitchen: 'Küche', bedroom: 'Schlafzimmer', hall: 'Flur', bath: 'Badezimmer' },
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

async function putContent(api: Api, planId: string, content: object) {
  await json(await api.ctx.post(`/api/plans/${planId}/lock`))
  const current = (await api.planContent(planId)) as unknown as { contentUpdatedAt: string }
  await json(await api.ctx.put(`/api/plans/${planId}/content`, { data: { expectedContentUpdatedAt: current.contentUpdatedAt, ...content } }))
  await api.ctx.delete(`/api/plans/${planId}/lock`)
}

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

/** Function and load types, three room templates, a project with a plan of five zones, their needs and load symbols. */
async function seed(api: Api, lang: Lang) {
  const l = labels[lang]
  await api.createKind()
  // Both languages run at once on one catalog: the German run's names are German in English too, so each run finds its own rows.
  const tn = (name: { en: string; de: string }) => (lang === 'de' ? { en: name.de, de: name.de } : name)
  const loadType = async (key: string, en: string, de: string) => json<{ id: string }>(await api.ctx.post('/api/load-types', { data: { key: uniqueKey(key), name: tn({ en, de }), isActive: true } }))
  const led = await loadType('led', 'LED', 'LED')
  const halogen = await loadType('halogen', 'Halogen', 'Halogen')
  const motor = await loadType('motor', 'Motor', 'Motor')
  const heater = await loadType('resistive', 'Resistive heating', 'Ohmsche Heizung')
  const fn = async (key: string, en: string, de: string, allowsCircuit: boolean, loadTypeIds: string[]) => {
    const body = { key: uniqueKey(key), name: tn({ en, de }), allowsCircuit, loadTypeIds }
    return { ...(await json<{ id: string }>(await api.ctx.post('/api/function-types', { data: body }))), body }
  }
  const dimmable = await fn('dimmable_light', 'Dimmable light', 'Dimmbares Licht', true, [led.id, halogen.id])
  const switched = await fn('switched_light', 'Switched light', 'Geschaltetes Licht', true, [led.id, halogen.id])
  const blind = await fn('blind', 'Blind', 'Jalousie', false, [motor.id])
  const socket = await fn('socket', 'Socket', 'Steckdose', true, [])
  const button = await fn('pushbutton', 'Pushbutton', 'Taster', false, [])
  const towel = await fn('towel_heater', 'Towel heater', 'Handtuchheizkörper', true, [heater.id])

  const template = async (key: string, name: { en: string; de: string }, level: { en: string; de: string } | object, lines: object[]) =>
    json<{ id: string }>(await api.ctx.post('/api/room-templates', { data: { key: uniqueKey(key), name: tn(name), equipmentLevel: level, isActive: true, lines } }))
  const line = (functionTypeId: string, quantity: number, powerW: string | null, loadTypeId: string | null, label = '') => ({ functionTypeId, quantity, powerW, loadTypeId, label })
  const lbl = (en: string, de: string) => (lang === 'de' ? de : en)
  const living = { en: 'Living room – comfort', de: 'Wohnzimmer – Komfort' }
  await template('living_comfort', living, { en: 'Comfort', de: 'Komfort' }, [
    line(dimmable.id, 6, '5.5', led.id, lbl('Ceiling spots', 'Deckenspots')),
    line(blind.id, 2, '120', motor.id, lbl('Window', 'Fenster')),
    line(socket.id, 4, null, null),
    line(button.id, 1, null, null, lbl('Entrance', 'Eingang')),
  ])
  await template('bedroom_basic', { en: 'Bedroom – basic', de: 'Schlafzimmer – Basis' }, { en: 'Basic', de: 'Basis' }, [
    line(switched.id, 1, '9.5', led.id, lbl('Ceiling', 'Decke')),
    line(blind.id, 1, '120', motor.id),
    line(socket.id, 2, null, null),
  ])
  const bathName = { en: 'Bathroom', de: 'Badezimmer' }
  await template('bathroom', bathName, {}, [
    line(dimmable.id, 4, '3.5', led.id, lbl('Spots', 'Spots')),
    line(towel.id, 1, '450', heater.id, lbl('Towel rail', 'Handtuchhalter')),
    line(switched.id, 1, '12.25', led.id, lbl('Mirror', 'Spiegel')),
  ])

  const project = await api.createProject({ name: unique('Villa Mustermann-Schmidt') })
  const version = project.versions[0].id
  const plan = await api.createPlan(version, l.plan, planImage())
  const id = () => crypto.randomUUID()
  const zones = [
    { id: id(), name: l.zone.living, color: '#4f7cff', opacity: 0.2, points: rect(12, 12, 594, 500) },
    { id: id(), name: l.zone.kitchen, color: '#f59f00', opacity: 0.25, points: rect(606, 12, 1188, 394) },
    { id: id(), name: l.zone.bedroom, color: '#be4bdb', opacity: 0.2, points: rect(12, 512, 400, 700) },
    { id: id(), name: l.zone.hall, color: '#868e96', opacity: 0.2, points: rect(412, 512, 594, 700) },
    { id: id(), name: l.zone.bath, color: '#12b886', opacity: 0.25, points: rect(606, 406, 1188, 700) },
  ]
  const [zLiving, zKitchen, zBedroom, zHall, zBath] = zones.map((z) => z.id)
  const need = (zoneId: string | null, functionTypeId: string, quantity: number, powerW: string | null, loadTypeId: string | null, label = '', extra: object = {}) => ({
    id: id(),
    zoneId,
    functionTypeId,
    quantity,
    powerW,
    loadTypeId,
    label,
    note: '',
    x: null,
    y: null,
    ...extra,
  })
  const needs = [
    // Living room – comfort, with 8 instead of 6 spots and a longer label.
    need(zLiving, dimmable.id, 8, '5.50', led.id, lbl('Ceiling spots along the window front', 'Deckenspots entlang der Fensterfront')),
    need(zLiving, blind.id, 2, '120.00', motor.id, lbl('Window', 'Fenster')),
    need(zLiving, socket.id, 4, null, null),
    need(zLiving, button.id, 1, null, null, lbl('Entrance', 'Eingang')),
    // Kitchen, by hand.
    need(zKitchen, switched.id, 3, '7.25', led.id, lbl('Under-cabinet lights', 'Unterbauleuchten'), { note: lbl('Warm white', 'Warmweiß') }),
    need(zKitchen, socket.id, 6, null, null, lbl('Worktop', 'Arbeitsplatte')),
    // Bedroom – basic plus a second blind.
    need(zBedroom, switched.id, 1, '9.50', led.id, lbl('Ceiling', 'Decke')),
    need(zBedroom, blind.id, 2, '120.00', motor.id),
    need(zBedroom, socket.id, 2, null, null),
    // Hallway.
    need(zHall, switched.id, 2, '4.80', led.id),
    need(zHall, button.id, 2, null, null),
    // Bathroom template (towel heater added while active).
    need(zBath, dimmable.id, 4, '3.50', led.id, lbl('Spots', 'Spots')),
    need(zBath, towel.id, 1, '450.00', heater.id, lbl('Towel rail', 'Handtuchhalter')),
    need(zBath, switched.id, 1, '12.25', led.id, lbl('Mirror', 'Spiegel')),
    // Load symbols (zone computed by the backend).
    need(null, dimmable.id, 2, '25.00', halogen.id, lbl('Pendant', 'Pendel'), { x: 300, y: 240 }),
    need(null, blind.id, 1, '120.00', motor.id, '', { x: 900, y: 60 }),
    need(null, socket.id, 1, null, null, lbl('Coffee machine', 'Kaffeemaschine'), { x: 760, y: 220 }),
    need(null, button.id, 1, null, null, '', { x: 500, y: 600 }),
    need(null, switched.id, 1, null, null, lbl('Bedside', 'Nachttisch'), { x: 200, y: 600 }),
    need(null, towel.id, 1, '300.00', heater.id, '', { x: 1100, y: 600 }),
    need(null, socket.id, 2, null, null, lbl('Garden', 'Garten'), { x: 1000, y: 750 }),
  ]
  await putContent(api, plan.id, { scale: 0.01, zones, placements: [], needs })
  // The towel heater leaves the catalog after it was used: a skipped template line and a warning marker.
  await json(await api.ctx.put(`/api/function-types/${towel.id}`, { data: { ...towel.body, isActive: false } }))

  return { project, version, plan, names: { living, bath: bathName, towel: towel.body.name } }
}

async function imageToPage(page: Page) {
  const box = (await page.getByTestId('plan-canvas').boundingBox())!
  const scale = Math.min((box.width - 32) / floorplan.width, (box.height - 32) / floorplan.height)
  const ox = box.x + (box.width - floorplan.width * scale) / 2
  const oy = box.y + (box.height - floorplan.height * scale) / 2
  return (x: number, y: number) => ({ x: ox + x * scale, y: oy + y * scale })
}

for (const lang of ['en', 'de'] as const) {
  test(`needs, room templates and load symbols fit the screen: ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
    test.setTimeout(900_000)
    const l = labels[lang]
    const s = await seed(api, lang)
    const editor = `/projects/${s.project.id}/versions/${s.version}/plans/${s.plan.id}`
    const tab = (p: Page, name: string) => p.getByRole('tab', { name, exact: true }).click()
    const ready = async (p: Page) => {
      await expect(p.getByTestId('plan-canvas')).toBeVisible()
      await expect(p.getByText(l.saved, { exact: true })).toBeVisible()
      await p.waitForLoadState('networkidle')
      await p.waitForTimeout(300)
    }
    const zoneInspector = async (p: Page, zone: string) => {
      await tab(p, l.zones)
      await p.getByRole('tabpanel', { name: l.zones }).getByRole('button', { name: zone, exact: true }).click()
      await tab(p, l.inspector)
      const region = p.getByRole('tabpanel', { name: l.inspector }).getByRole('region', { name: l.needs, exact: true })
      await region.scrollIntoViewIfNeeded()
      return region
    }
    let cleanup: ((p: Page) => Promise<void>) | undefined
    let colorScheme: 'light' | 'dark' = 'light'
    let viewportName = ''

    type Step = { name: string; path: () => string; wide?: boolean; editor?: boolean; fullPage?: boolean; act?: (p: Page) => Promise<void> }
    const steps: Step[] = [
      { name: 'plan-cards', path: () => `/projects/${s.project.id}`, fullPage: true },
      { name: 'needs-tab', path: () => `/projects/${s.project.id}?tab=needs`, fullPage: true },
      { name: 'room-templates', path: () => '/catalog/room-templates', fullPage: true },
      {
        name: 'room-template-dialog',
        path: () => '/catalog/room-templates',
        act: async (p) => {
          await p.getByRole('row').filter({ hasText: s.names.bath[lang] }).last().getByRole('button', { name: l.edit }).click()
          await expect(p.getByRole('dialog')).toBeVisible()
          await p.getByRole('dialog').getByText(lang === 'de' ? /Inaktiver Funktionstyp/ : /Inactive function type/).scrollIntoViewIfNeeded()
        },
      },
      {
        name: 'function-type-dialog',
        path: () => '/catalog/function-types',
        act: async (p) => {
          await p.getByRole('row').filter({ hasText: s.names.towel[lang] }).last().getByRole('button', { name: l.edit }).click()
          await expect(p.getByRole('dialog')).toBeVisible()
        },
      },
      { name: 'editor', path: () => editor, editor: true, wide: true },
      { name: 'editor-zones', path: () => editor, editor: true, wide: true, act: (p) => tab(p, l.zones) },
      { name: 'editor-layers', path: () => editor, editor: true, wide: true, act: (p) => tab(p, l.layers) },
      { name: 'editor-zone-needs', path: () => editor, editor: true, wide: true, act: async (p) => void (await zoneInspector(p, l.zone.living)) },
      {
        name: 'editor-need-edit',
        path: () => editor,
        editor: true,
        wide: true,
        act: async (p) => {
          const needs = await zoneInspector(p, l.zone.kitchen)
          await needs.getByRole('button', { name: lang === 'de' ? /bearbeiten$/ : /^Edit / }).first().click()
          await needs.getByRole('button', { name: lang === 'de' ? 'Fertig' : 'Done' }).scrollIntoViewIfNeeded()
        },
      },
      {
        name: 'editor-apply-template',
        path: () => editor,
        editor: true,
        wide: true,
        act: async (p) => {
          const needs = await zoneInspector(p, l.zone.bath)
          await needs.getByRole('combobox', { name: l.applyTemplate }).click()
          await p.getByRole('option', { name: s.names.bath[lang] }).last().click()
          await expect(needs.getByText(lang === 'de' ? /übersprungen/ : /skipped/)).toBeVisible()
          await needs.getByText(lang === 'de' ? /übersprungen/ : /skipped/).scrollIntoViewIfNeeded()
          cleanup = async (q) => {
            await q.keyboard.press('Escape')
            await q.getByTestId('plan-canvas').click({ position: { x: 4, y: 4 } })
            await q.keyboard.press('Control+z')
            await expect(q.getByText(l.saved, { exact: true })).toBeVisible()
          }
        },
      },
      {
        name: 'editor-place-need',
        path: () => editor,
        editor: true,
        wide: true,
        act: async (p) => {
          await p.getByRole('button', { name: l.placeNeed }).click()
          await expect(p.getByRole('combobox', { name: l.placeFunction })).toBeVisible()
          await expect(p.getByRole('button', { name: l.placeNeed })).toHaveAttribute('aria-pressed', 'true')
          await expect(p.getByRole('button', { name: lang === 'de' ? 'Auswählen' : 'Select', exact: true })).toHaveAttribute('aria-pressed', 'false')
          // The buttons' colours fade (transition-colors): a screenshot right after the click shows the old tool highlighted.
          await p.waitForTimeout(300)
        },
      },
      {
        name: 'editor-symbol',
        path: () => editor,
        editor: true,
        wide: true,
        act: async (p) => {
          const at = (await imageToPage(p))(1100, 600)
          await p.mouse.click(at.x, at.y)
          await tab(p, l.inspector)
        },
      },
      {
        name: 'editor-symbol-outside',
        path: () => editor,
        editor: true,
        wide: true,
        act: async (p) => {
          const at = (await imageToPage(p))(1000, 750)
          await p.mouse.click(at.x, at.y)
          await tab(p, l.inspector)
        },
      },
      {
        name: 'editor-export',
        path: () => editor,
        editor: true,
        wide: true,
        act: async (p) => {
          const download = p.waitForEvent('download')
          await p.getByRole('button', { name: l.exportPng }).click()
          await (await download).saveAs(`e2e/screenshots/needs-exported-${viewportName}-${colorScheme}-${lang}.png`)
        },
      },
    ]

    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      viewportName = viewport.name
      await page.setViewportSize(viewport.size)
      for (const scheme of ['light', 'dark'] as const) {
        colorScheme = scheme
        await page.emulateMedia({ colorScheme })
        for (const step of steps) {
          if (step.wide && !viewport.wide) continue
          await page.goto(step.path())
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          if (step.editor) await ready(page)
          else await page.waitForLoadState('networkidle')
          if (step.act) await step.act(page)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/needs-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          if (cleanup) {
            await cleanup(page)
            cleanup = undefined
          }
          await page.keyboard.press('Escape')
        }
      }
    }
  })
}
