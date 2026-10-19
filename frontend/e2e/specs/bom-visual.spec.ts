import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { type Api, expect, test, unique } from '../fixtures'

// Every state of the bill of materials and pricing (step 2c) at phone, tablet
// and desktop width, light and dark, English and German: nothing overflows the
// viewport. Screenshots land in e2e/screenshots/bom2c-*.png for a look by eye.
// The data is seeded through the API (the flows are tested in bom.spec.ts).
// Tagged @visual: it runs with `make e2e-visual`.

const assets = join(import.meta.dirname, '../assets')
const file = (name: string) => readFileSync(join(assets, name))
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: file('floorplan.png') })

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'tablet', size: { width: 768, height: 1024 } },
  { name: 'desktop', size: { width: 1280, height: 800 } },
]

const labels = {
  en: {
    bom: 'Bill of materials',
    pricing: 'Pricing',
    plan: 'Plan',
    zone: 'Zone',
    addCatalog: 'Add product',
    addFreeText: 'Add free-text line',
    search: 'Search',
    create: 'Create',
    delete: 'Delete',
    update: 'Update from catalog',
    discountValue: 'Discount value',
    save: 'Save',
    plans: { ground: 'Ground floor', upper: 'Upper floor', cellar: 'Cellar with boiler room and storage' },
    zones: { living: 'Living room', kitchen: 'Kitchen' },
    cabling: 'Cabling and small material',
    travel: 'Travel costs',
    unitPrice: 'Unit price (USD)',
  },
  de: {
    bom: 'Stückliste',
    pricing: 'Preise',
    plan: 'Plan',
    zone: 'Zone',
    addCatalog: 'Produkt hinzufügen',
    addFreeText: 'Freitext-Position hinzufügen',
    search: 'Suche',
    create: 'Erstellen',
    delete: 'Löschen',
    update: 'Aus dem Katalog aktualisieren',
    discountValue: 'Rabattwert',
    save: 'Speichern',
    plans: { ground: 'Erdgeschoss', upper: 'Obergeschoss', cellar: 'Keller mit Heizungsraum und Abstellraum' },
    zones: { living: 'Wohnzimmer', kitchen: 'Küche' },
    cabling: 'Verkabelung und Kleinmaterial',
    travel: 'Anfahrtskosten',
    unitPrice: 'Einzelpreis (USD)',
  },
}
type Lang = keyof typeof labels

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

/**
 * Two systems with three categories, add-ons and images; a project with three
 * plans, manual lines and pricing whose catalog changed since (outdated,
 * inactive, deleted, required add-on); a EUR project, an empty one and a
 * completed one.
 */
async function seed(api: Api, lang: Lang) {
  const l = labels[lang]
  const zigbee = await api.createKind(
    { name: { en: unique('Switches and sensors'), de: unique('Schalter und Sensoren') } },
    { name: { en: unique('Zigbee'), de: unique('Zigbee') }, abbreviation: 'ZB', color: '#1f6feb' },
  )
  const accessories = await api.createCategory({ name: { en: unique('Accessories'), de: unique('Zubehör') } })
  const gateways = await api.createCategory({ name: { en: unique('Gateways'), de: unique('Gateways') } })
  const knx = await api.createKind(
    { name: { en: unique('Actuators'), de: unique('Aktoren') } },
    { name: { en: unique('KNX'), de: unique('KNX') }, abbreviation: 'KNX', color: '#d9480f' },
  )
  const blue = await api.uploadFile('blue.png', 'image/png', file('blue.png'))
  const red = await api.uploadFile('red.png', 'image/png', file('red.png'))

  const product = async (ids: { productTypeId: string; categoryId: string }, en: string, de: string, price: string, model: string, image?: string) => {
    const p = await api.createProduct({ ...ids, modelNumber: unique(model).replace(/\s+/g, '-'), name: { en, de } })
    const v = await api.createVariant(p.id, { name: { en: 'White', de: 'Weiß' }, imageFileId: image, price })
    return { product: p, variant: v }
  }
  const zb = (categoryId: string) => ({ productTypeId: zigbee.type.id, categoryId })
  const sw = await product(zigbee.ids, 'Wall switch 2-gang with status LED', 'Wandschalter 2-fach mit Status-LED', '49.90', 'ZB-SW2', blue.id)
  const sensor = await product(zigbee.ids, 'Motion sensor', 'Bewegungsmelder', '39.90', 'ZB-PIR', red.id)
  const dimmer = await product(zigbee.ids, 'Rotary dimmer', 'Drehdimmer', '64.00', 'ZB-DIM', blue.id)
  const relay = await product(zigbee.ids, 'Relay insert', 'Relais-Einsatz', '29.90', 'ZB-REL')
  const battery = await product(zb(accessories.id), 'Battery pack CR2032', 'Batteriepack CR2032', '4.90', 'ACC-BAT')
  const frame = await product(zb(accessories.id), 'Design frame anthracite', 'Designrahmen anthrazit', '12.50', 'ACC-FRM')
  const cover = await product(zb(accessories.id), 'Cover plate', 'Abdeckplatte', '3.20', 'ACC-CVR')
  const gateway = await product(zb(gateways.id), 'Zigbee gateway', 'Zigbee-Gateway', '129.00', 'ZB-GW', red.id)
  const actuator = await product(knx.ids, 'Switch actuator 8-fold', 'Schaltaktor 8-fach', '389.00', 'KNX-SA8')
  await api.replaceAddons(sw.product.id, sw.variant.id, [{ addonVariantId: battery.variant.id, required: true }, { addonVariantId: frame.variant.id }])
  const types = [zigbee.type.id, knx.type.id]

  const id = () => crypto.randomUUID()
  const zones = [
    { id: id(), name: l.zones.living, color: '#4f7cff', opacity: 0.2, points: [[0, 0], [600, 0], [600, 800], [0, 800]] },
    { id: id(), name: l.zones.kitchen, color: '#f59f00', opacity: 0.25, points: [[600, 0], [1200, 0], [1200, 400], [600, 400]] },
  ]
  const at = (variantId: string, x: number, y: number, extra: object = {}) => ({ variantId, x, y, ...extra })
  const fill = async (versionId: string) => {
    const ground = await api.createPlan(versionId, l.plans.ground, planImage())
    const upper = await api.createPlan(versionId, l.plans.upper, planImage())
    const cellar = await api.createPlan(versionId, l.plans.cellar, planImage())
    await api.savePlanContent(ground.id, {
      zones,
      placements: [
        at(sw.variant.id, 100, 100, { addonVariantIds: [frame.variant.id] }),
        at(sw.variant.id, 300, 100),
        at(sw.variant.id, 800, 100),
        at(sensor.variant.id, 200, 500),
        at(sensor.variant.id, 900, 200),
        at(dimmer.variant.id, 700, 600),
        at(actuator.variant.id, 1000, 700),
        at(actuator.variant.id, 1000, 300, { existing: true }),
      ],
    })
    await api.savePlanContent(upper.id, { placements: [at(sensor.variant.id, 300, 300), at(sw.variant.id, 500, 300), at(relay.variant.id, 600, 300)] })
    await api.savePlanContent(cellar.id, { placements: [at(actuator.variant.id, 300, 300), at(relay.variant.id, 400, 300)] })
    await api.addManualLine(versionId, { variantId: gateway.variant.id, quantity: 1 })
    await api.addManualLine(versionId, { variantId: relay.variant.id, quantity: 2, note: lang === 'de' ? 'Reserve' : 'Spare' })
    await api.addManualLine(versionId, { name: l.cabling, unitPrice: '350', quantity: 1, note: lang === 'de' ? 'Pauschal' : 'Flat rate' })
    await api.addManualLine(versionId, { name: l.travel, unitPrice: '85.50', quantity: 2 })
    return { ground, upper, cellar }
  }

  const main = await api.createProject({ name: unique('Villa Mustermann-Schmidt'), productTypeIds: types, customer: { name: 'Erika Musterfrau' } })
  const plans = await fill(main.versions[0].id)
  await api.savePricing(main.versions[0].id, { discountKind: 'percent', discountValue: '5', servicesKind: 'amount', servicesValue: '1500' })
  const eur = await api.createProject({ name: unique('Haus am See'), productTypeIds: types, currency: 'EUR', exchangeRate: '0.92' })
  await fill(eur.versions[0].id)
  await api.savePricing(eur.versions[0].id, { discountKind: 'amount', discountValue: '200', servicesKind: 'percent', servicesValue: '12.5' })
  const empty = await api.createProject({ name: unique('Neubau Schulze'), productTypeIds: types })
  const done = await api.createProject({ name: unique('Abgeschlossen Meier'), productTypeIds: types })
  await fill(done.versions[0].id)
  await api.savePricing(done.versions[0].id, {
    discountKind: 'amount',
    discountValue: '150',
    servicesKind: 'percent',
    servicesValue: '10',
    servicesLabel: { en: 'Programming and commissioning', de: 'Programmierung und Inbetriebnahme' },
  })

  // The catalog changes after the quote: a price, a name, a required add-on,
  // a deactivated product and a deleted variant.
  await api.setVariantPrice(sensor.product.id, sensor.variant, '44.90')
  await api.updateProduct(actuator.product.id, { name: { en: 'Switch actuator 8-fold, 16 A', de: 'Schaltaktor 8-fach, 16 A' } })
  await api.replaceAddons(sw.product.id, sw.variant.id, [
    { addonVariantId: battery.variant.id, required: true },
    { addonVariantId: cover.variant.id, required: true },
    { addonVariantId: frame.variant.id },
  ])
  await api.updateProduct(dimmer.product.id, { isActive: false })
  await api.ctx.delete(`/api/products/${relay.product.id}/variants/${relay.variant.id}`)

  return { main, eur, empty, done, plans }
}

async function complete(api: Api, projectId: string) {
  const res = await api.ctx.get(`/api/projects/${projectId}`)
  const p = (await res.json()) as { name: string; updatedAt: string }
  const put = await api.ctx.put(`/api/projects/${projectId}`, { data: { name: p.name, status: 'completed', expectedUpdatedAt: p.updatedAt } })
  expect(put.ok(), await put.text()).toBe(true)
}

for (const lang of ['en', 'de'] as const) {
  for (const viewport of viewports) {
    test(`bom and pricing fit the screen: ${viewport.name}, ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
      test.setTimeout(600_000)
      const l = labels[lang]
      const s = await seed(api, lang)
      await complete(api, s.done.id)
      const path = (projectId: string, tab: 'bom' | 'pricing') => `/projects/${projectId}?tab=${tab}`
      const choose = async (p: Page, label: string, option: string) => {
        await p.getByRole('combobox', { name: label, exact: true }).click()
        await p.getByRole('option', { name: option, exact: true }).click()
      }
      const dialog = (p: Page) => p.getByRole('dialog')

      type Step = { name: string; path: string; fullPage?: boolean; warning?: boolean; act?: (p: Page) => Promise<void> }
      const steps: Step[] = [
        // A placement without a price snapshot cannot be made through the API: the warning is added to the response.
        { name: 'bom', path: path(s.main.id, 'bom'), fullPage: true, warning: true },
        { name: 'bom-plan-filter', path: path(s.main.id, 'bom'), fullPage: true, act: (p) => choose(p, l.plan, l.plans.ground) },
        {
          name: 'bom-zone-filter',
          path: path(s.main.id, 'bom'),
          fullPage: true,
          act: async (p) => {
            await choose(p, l.plan, l.plans.ground)
            await choose(p, l.zone, l.zones.kitchen)
          },
        },
        { name: 'bom-eur', path: path(s.eur.id, 'bom'), fullPage: true },
        { name: 'bom-empty', path: path(s.empty.id, 'bom'), fullPage: true },
        { name: 'bom-read-only', path: path(s.done.id, 'bom'), fullPage: true },
        {
          name: 'manual-catalog',
          path: path(s.main.id, 'bom'),
          act: async (p) => {
            await p.getByRole('button', { name: l.addCatalog }).click()
            await dialog(p).getByRole('searchbox', { name: l.search }).fill(lang === 'de' ? 'Wandschalter' : 'Wall switch')
            await dialog(p).getByRole('button', { name: /2-/ }).first().click()
          },
        },
        {
          name: 'manual-free-text-errors',
          path: path(s.main.id, 'bom'),
          act: async (p) => {
            await p.getByRole('button', { name: l.addFreeText }).click()
            const d = dialog(p)
            await d.getByLabel(l.unitPrice).fill('abc')
            await d.getByRole('button', { name: l.create }).click()
            await expect(d.getByLabel(l.unitPrice)).toHaveAttribute('aria-invalid', 'true')
          },
        },
        {
          name: 'manual-delete',
          path: path(s.main.id, 'bom'),
          act: async (p) => {
            await p.getByRole('button', { name: `${l.delete} ${l.travel}` }).click()
            await expect(dialog(p)).toBeVisible()
          },
        },
        {
          name: 'changes',
          path: path(s.main.id, 'bom'),
          act: async (p) => {
            await p.getByRole('button', { name: l.update, exact: true }).click()
            await expect(dialog(p).getByRole('checkbox').first()).toBeVisible()
          },
        },
        { name: 'pricing', path: path(s.main.id, 'pricing'), fullPage: true },
        { name: 'pricing-amount-eur', path: path(s.eur.id, 'pricing'), fullPage: true },
        { name: 'pricing-none', path: path(s.empty.id, 'pricing'), fullPage: true },
        {
          name: 'pricing-error',
          path: path(s.main.id, 'pricing'),
          fullPage: true,
          act: async (p) => {
            await p.getByLabel(l.discountValue).fill('150')
            await p.getByRole('button', { name: l.save }).click()
            await expect(p.getByRole('alert').first()).toBeVisible()
            await p.waitForTimeout(600)
          },
        },
        {
          name: 'pricing-stale',
          path: path(s.main.id, 'pricing'),
          fullPage: true,
          act: async (p) => {
            await api.savePricing(s.main.versions[0].id, { discountKind: 'percent', discountValue: '5', servicesKind: 'amount', servicesValue: '1500' })
            await p.getByRole('button', { name: l.save }).click()
            await expect(p.getByRole('alert').first()).toBeVisible()
            await p.waitForTimeout(600)
          },
        },
        { name: 'pricing-read-only', path: path(s.done.id, 'pricing'), fullPage: true },
      ]

      await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const step of steps) {
          if (step.warning) {
            await page.route('**/api/versions/*/bom', async (route) => {
              const response = await route.fetch()
              const body = (await response.json()) as { warnings: object[] }
              body.warnings = [{ code: 'placement_without_snapshot', planId: s.plans.cellar.id, placementId: crypto.randomUUID() }]
              await route.fulfill({ response, json: body })
            })
          }
          await page.goto(step.path)
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          await page.waitForLoadState('networkidle')
          if (step.act) await step.act(page)
          await page.waitForTimeout(200)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/bom2c-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          await page.keyboard.press('Escape')
          if (step.warning) await page.unroute('**/api/versions/*/bom')
        }
      }
    })
  }
}
