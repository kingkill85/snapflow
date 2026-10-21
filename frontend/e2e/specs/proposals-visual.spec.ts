import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { type Api, expect, test, unique } from '../fixtures'

// Step 2d: every state of the proposals UI (tab, dialog, notice, company
// profile, tenant letterhead, pricing texts) at phone, tablet and desktop
// width, light and dark, English and German; screenshots land in
// e2e/screenshots/proposals2d-*.png. A realistic customer job (floorplan,
// zones, catalog images, add-ons, an existing device, manual and free-text
// lines, discount, services, texts, letterhead with logo) is generated as
// combined and split proposals in German/EUR and English/USD into
// e2e/screenshots/proposal-docs/ to be converted with LibreOffice and checked
// by eye. Tagged @visual: it runs with `make e2e-visual`.

const assets = join(import.meta.dirname, '../assets/proposal')
const file = (name: string) => readFileSync(join(assets, name))
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: file(name) })
const docsDir = join(import.meta.dirname, '../screenshots/proposal-docs')

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'tablet', size: { width: 768, height: 1024 } },
  { name: 'desktop', size: { width: 1280, height: 800 } },
]

const labels = {
  en: {
    createProposal: 'Create proposal',
    create: 'Create',
    documents: 'Documents',
    split: 'One document per system',
    edit: 'Edit',
    letterhead: 'Letterhead',
  },
  de: {
    createProposal: 'Angebot erstellen',
    create: 'Erstellen',
    documents: 'Dokumente',
    split: 'Ein Dokument je System',
    edit: 'Bearbeiten',
    letterhead: 'Briefkopf',
  },
}
type Lang = keyof typeof labels

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

const t = (en: string, de: string) => ({ en, de })

/** A letterhead with logo on a new tenant (an installer company). */
async function letterheadTenant(api: Api) {
  const tenant = await api.createTenant(unique('Elektro Becker'))
  const logo = await api.ctx.post(`/api/tenants/${tenant.id}/logo`, { multipart: { image: png('logo.png') } })
  expect(logo.ok(), await logo.text()).toBe(true)
  const { id: logoFileId } = (await logo.json()) as { id: string }
  const put = await api.ctx.put(`/api/tenants/${tenant.id}/letterhead`, {
    data: {
      companyName: 'Elektro Becker GmbH',
      address: 'Lindenstraße 42\n50674 Köln',
      phone: '+49 221 987654-0',
      email: 'angebote@elektro-becker.de',
      website: 'www.elektro-becker.de',
      logoFileId,
    },
  })
  expect(put.ok(), await put.text()).toBe(true)
  return tenant
}

/**
 * A realistic catalog: Zigbee devices in six categories with images and
 * add-ons, KNX actuators and a door station. `suffix` keeps model numbers unique.
 */
async function catalog(api: Api, suffix: string) {
  const zigbee = await api.createKind(
    { name: t('Switches', 'Schalter') },
    { name: t('Zigbee', 'Zigbee'), abbreviation: 'ZB', color: '#1f6feb' },
  )
  const knx = await api.createKind({ name: t('Actuators', 'Aktoren') }, { name: t('KNX', 'KNX'), abbreviation: 'KNX', color: '#d9480f' })
  const category = async (name: { en: string; de: string }) => (await api.createCategory({ name })).id
  const sensors = await category(t('Sensors', 'Sensoren'))
  const climate = await category(t('Climate', 'Klima'))
  const lighting = await category(t('Lighting', 'Beleuchtung'))
  const safety = await category(t('Safety', 'Sicherheit'))
  const gateways = await category(t('Gateways', 'Gateways'))
  const accessories = await category(t('Accessories', 'Zubehör'))
  const door = await category(t('Door communication', 'Türkommunikation'))

  const images = new Map<string, string>()
  const image = async (name: string) => {
    if (!images.has(name)) images.set(name, (await api.uploadFile(name, 'image/png', file(name))).id)
    return images.get(name)!
  }
  const product = async (
    ids: { productTypeId: string; categoryId: string },
    name: { en: string; de: string },
    model: string,
    price: string,
    img?: string,
    variant = t('White', 'Weiß'),
  ) => {
    const modelNumber = suffix ? `${model}-${suffix}` : model
    const p = await api.createProduct({ ...ids, modelNumber, name })
    const v = await api.createVariant(p.id, { name: variant, sku: `${modelNumber}-01`, imageFileId: img ? await image(img) : undefined, price })
    return { product: p, variant: v, id: v.id }
  }
  const zb = (categoryId: string) => ({ productTypeId: zigbee.type.id, categoryId })
  const kx = (categoryId: string) => ({ productTypeId: knx.type.id, categoryId })
  const c = {
    switch2: await product(zigbee.ids, t('Wall switch 2-gang with status LED', 'Wandschalter 2-fach mit Status-LED'), 'ZB-SW2', '49.90', 'switch.png'),
    switch1: await product(zigbee.ids, t('Wall switch 1-gang', 'Wandschalter 1-fach'), 'ZB-SW1', '39.90', 'switch1.png'),
    dimmer: await product(zigbee.ids, t('Rotary dimmer', 'Drehdimmer'), 'ZB-DIM', '64.00', 'dimmer.png'),
    motion: await product(zb(sensors), t('Motion sensor', 'Bewegungsmelder'), 'ZB-PIR', '39.90', 'motion.png'),
    contact: await product(zb(sensors), t('Window and door contact', 'Fenster-/Türkontakt'), 'ZB-WDC', '24.90', 'contact.png'),
    thermostat: await product(zb(climate), t('Room thermostat with display', 'Raumthermostat mit Display'), 'ZB-THM', '89.00', 'thermostat.png'),
    led: await product(zb(lighting), t('LED strip controller RGBW', 'LED-Stripe-Controller RGBW'), 'ZB-LED', '54.90', 'led.png'),
    smoke: await product(zb(safety), t('Smoke alarm', 'Rauchwarnmelder'), 'ZB-SMK', '59.00', 'smoke.png'),
    gateway: await product(zb(gateways), t('Zigbee gateway', 'Zigbee-Gateway'), 'ZB-GW', '129.00', 'gateway.png'),
    frame: await product(zb(accessories), t('Design frame anthracite', 'Designrahmen anthrazit'), 'ACC-FRM', '12.50', 'frame.png'),
    battery: await product(zb(accessories), t('Battery pack CR2032', 'Batteriepack CR2032'), 'ACC-BAT', '4.90'),
    actuator: await product(knx.ids, t('Switch actuator 8-fold, 16 A', 'Schaltaktor 8-fach, 16 A'), 'KNX-SA8', '389.00', 'actuator.png', t('DIN rail', 'REG')),
    blinds: await product(kx(knx.category.id), t('Blind actuator 4-fold', 'Jalousieaktor 4-fach'), 'KNX-JA4', '329.00', 'actuator.png', t('DIN rail', 'REG')),
    station: await product(kx(door), t('Video door station', 'Video-Türstation'), 'KNX-VDS', '449.00', 'camera.png', t('Stainless steel', 'Edelstahl')),
  }
  await api.replaceAddons(c.switch2.product.id, c.switch2.id, [{ addonVariantId: c.frame.id }])
  await api.replaceAddons(c.switch1.product.id, c.switch1.id, [{ addonVariantId: c.frame.id }])
  await api.replaceAddons(c.motion.product.id, c.motion.id, [{ addonVariantId: c.battery.id, required: true }])
  return { types: [zigbee.type.id, knx.type.id], c }
}

type Catalog = Awaited<ReturnType<typeof catalog>>

const rooms = {
  ground: [
    { name: t('Living room', 'Wohnzimmer'), color: '#4f7cff', box: [72, 72, 1094, 794] },
    { name: t('Kitchen', 'Küche'), color: '#f59f00', box: [1106, 72, 1928, 634] },
    { name: t('Bathroom', 'Bad'), color: '#15aabf', box: [1106, 646, 1494, 1328] },
    { name: t('Office', 'Arbeitszimmer'), color: '#7950f2', box: [1506, 646, 1928, 1328] },
    { name: t('Dining room', 'Esszimmer'), color: '#e64980', box: [72, 806, 694, 1328] },
    { name: t('Hallway', 'Flur'), color: '#82c91e', box: [706, 806, 1094, 1328] },
  ],
  upper: [
    { name: t('Bedroom', 'Schlafzimmer'), color: '#4f7cff', box: [72, 72, 1094, 794] },
    { name: t("Children's room", 'Kinderzimmer'), color: '#f59f00', box: [1106, 72, 1928, 634] },
    { name: t('Bathroom', 'Bad'), color: '#15aabf', box: [1106, 646, 1494, 1328] },
    { name: t('Dressing room', 'Ankleide'), color: '#7950f2', box: [1506, 646, 1928, 1328] },
  ],
}

/**
 * A customer job: two plans with zones, placements with add-ons and labels, an
 * existing actuator, manual and free-text lines, discount, services and texts.
 */
async function realisticProject(api: Api, { types, c }: Catalog, opts: { lang: Lang; currency?: string; rate?: string; tenantId?: string; name?: string }) {
  const { lang } = opts
  const res = await api.ctx.post('/api/projects', {
    data: {
      name: opts.name ?? (lang === 'de' ? 'Einfamilienhaus Weber' : 'Weber family home'),
      tenantId: opts.tenantId,
      language: lang,
      currency: opts.currency,
      exchangeRate: opts.rate,
      productTypeIds: types,
      customer: { name: 'Thomas und Anna Weber', email: 'weber@example.com', phone: '+49 221 555123', address: 'Am Stadtgarten 7\n50674 Köln' },
    },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const project = (await res.json()) as { id: string; number: string; name: string; versions: { id: string }[] }
  const versionId = project.versions[0].id
  const zones = (list: (typeof rooms)['ground']) =>
    list.map((r) => {
      const [x0, y0, x1, y1] = r.box
      return { id: crypto.randomUUID(), name: r.name[lang], color: r.color, opacity: 0.18, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }
    })
  const at = (v: { id: string }, x: number, y: number, extra: object = {}) => ({ variantId: v.id, x, y, width: 64, height: 64, ...extra })
  const ground = await api.createPlan(versionId, lang === 'de' ? 'Erdgeschoss' : 'Ground floor', png('floorplan.png'))
  const upper = await api.createPlan(versionId, lang === 'de' ? 'Obergeschoss' : 'Upper floor', png('floorplan.png'))
  const frame = { addonVariantIds: [c.frame.id] }
  await api.savePlanContent(ground.id, {
    zones: zones(rooms.ground),
    placements: [
      at(c.switch2, 1040, 470, { ...frame, label: lang === 'de' ? 'Licht/Rollo' : 'Light/blind' }),
      at(c.dimmer, 1040, 580),
      at(c.motion, 960, 140),
      at(c.thermostat, 1040, 720),
      at(c.smoke, 640, 420),
      at(c.contact, 110, 450, { rotation: 90, width: 40, height: 64 }),
      at(c.switch1, 1160, 560, frame),
      at(c.led, 1600, 230, { label: lang === 'de' ? 'Arbeitsplatte' : 'Worktop' }),
      at(c.thermostat, 1860, 560),
      at(c.switch1, 1160, 900),
      at(c.thermostat, 1440, 900),
      at(c.switch2, 1560, 1250, frame),
      at(c.dimmer, 640, 1200),
      at(c.station, 920, 1270, { label: lang === 'de' ? 'Haustür' : 'Front door' }),
      at(c.motion, 1030, 870),
      at(c.actuator, 780, 1090, { label: 'UV1' }),
      at(c.actuator, 860, 1090, { existing: true, label: 'UV1' }),
      at(c.blinds, 940, 1090, { label: 'UV1' }),
    ],
  })
  await api.savePlanContent(upper.id, {
    zones: zones(rooms.upper),
    placements: [
      at(c.switch2, 1040, 470, frame),
      at(c.thermostat, 1040, 700),
      at(c.smoke, 580, 420),
      at(c.switch1, 1160, 560),
      at(c.smoke, 1500, 350),
      at(c.thermostat, 1440, 900),
      at(c.led, 1700, 900),
    ],
  })
  await api.addManualLine(versionId, { variantId: c.gateway.id, quantity: 1 })
  await api.addManualLine(versionId, { variantId: c.contact.id, quantity: 4, note: lang === 'de' ? 'Fenster Obergeschoss' : 'Upper floor windows' })
  await api.addManualLine(versionId, {
    name: lang === 'de' ? 'Verkabelung, Unterverteilung und Kleinmaterial' : 'Cabling, sub-distribution board and small material',
    unitPrice: '480',
    quantity: 1,
    note: lang === 'de' ? 'Pauschal' : 'Flat rate',
  })
  await api.addManualLine(versionId, { name: lang === 'de' ? 'Anfahrt' : 'Travel', unitPrice: '65', quantity: 3 })
  await api.savePricing(versionId, {
    discountKind: 'percent',
    discountValue: '5',
    servicesKind: 'amount',
    servicesValue: '1450',
    servicesLabel: t('Programming and commissioning', 'Programmierung und Inbetriebnahme'),
    introText: t(
      'Dear Mr and Mrs Weber,\n\nthank you for your enquiry. We are pleased to offer you the smart home installation for your house as discussed on site.',
      'Sehr geehrte Frau Weber, sehr geehrter Herr Weber,\n\nvielen Dank für Ihre Anfrage. Gerne bieten wir Ihnen die Smart-Home-Ausstattung Ihres Hauses wie vor Ort besprochen an.',
    ),
    closingText: t(
      'This offer is valid for 30 days. Payment: 30 % on order, the rest after commissioning.\n\nKind regards\nElektro Becker GmbH',
      'Dieses Angebot ist 30 Tage gültig. Zahlung: 30 % bei Auftrag, Rest nach Inbetriebnahme.\n\nMit freundlichen Grüßen\nElektro Becker GmbH',
    ),
  })
  return { project, versionId }
}

async function generate(api: Api, versionId: string, body: object) {
  const res = await api.ctx.post(`/api/versions/${versionId}/proposals`, { data: { exporter: 'docx', ...body } })
  expect(res.ok(), await res.text()).toBe(true)
  return (await res.json()) as { number: string; fileName: string; downloadUrl: string }[]
}

test('realistic proposal documents for a look by eye', { tag: '@visual' }, async ({ api }) => {
  test.setTimeout(300_000)
  const cat = await catalog(api, '')
  const tenant = await letterheadTenant(api)
  mkdirSync(docsDir, { recursive: true })
  const save = async (proposals: { fileName: string; downloadUrl: string }[], prefix: string) => {
    for (const p of proposals) {
      const res = await api.ctx.get(p.downloadUrl)
      expect(res.ok()).toBe(true)
      writeFileSync(join(docsDir, `${prefix} ${p.fileName}`), await res.body())
    }
  }
  const de = await realisticProject(api, cat, { lang: 'de', currency: 'EUR', rate: '0.92', tenantId: tenant.id })
  await save(await generate(api, de.versionId, {}), 'de-combined')
  await save(await generate(api, de.versionId, { split: true, productTypeIds: cat.types }), 'de-split')
  const en = await realisticProject(api, cat, { lang: 'en', tenantId: tenant.id })
  await save(await generate(api, en.versionId, {}), 'en-combined')
})

for (const lang of ['en', 'de'] as const) {
  for (const viewport of viewports) {
    test(`proposals fit the screen: ${viewport.name}, ${lang}`, { tag: '@visual' }, async ({ page, api, sessionFor }) => {
      test.setTimeout(600_000)
      const l = labels[lang]
      const cat = await catalog(api, `${viewport.name}-${lang}`.toUpperCase())
      const tenant = await letterheadTenant(api)
      const tenantAdmin = await api.createUser({ role: 'tenant_admin', tenantId: tenant.id })
      const main = await realisticProject(api, cat, { lang, currency: 'EUR', rate: '0.92', name: unique(lang === 'de' ? 'Haus Weber' : 'Weber home') })
      await generate(api, main.versionId, {})
      await generate(api, main.versionId, { split: true, productTypeIds: cat.types })
      const fresh = await realisticProject(api, cat, { lang, name: unique(lang === 'de' ? 'Neubau Schulze' : 'New build Schulze') })
      const empty = await api.createProject({ name: unique(lang === 'de' ? 'Altbau Meier' : 'Old building Meier'), productTypeIds: cat.types })
      const done = await realisticProject(api, cat, { lang, name: unique(lang === 'de' ? 'Abgeschlossen Krüger' : 'Completed Krüger') })
      await generate(api, done.versionId, {})
      const p = (await (await api.ctx.get(`/api/projects/${done.project.id}`)).json()) as { name: string; updatedAt: string }
      const put = await api.ctx.put(`/api/projects/${done.project.id}`, { data: { name: p.name, status: 'completed', expectedUpdatedAt: p.updatedAt } })
      expect(put.ok(), await put.text()).toBe(true)

      const path = (projectId: string, tab: 'pricing' | 'proposals') => `/projects/${projectId}?tab=${tab}`
      const dialog = (pg: Page) => pg.getByRole('dialog')
      const openCreate = async (pg: Page) => {
        await pg.getByRole('button', { name: l.createProposal }).click()
        await expect(dialog(pg).getByTestId('preview-total')).toHaveCount(1)
      }
      const chooseSplit = async (pg: Page) => {
        await dialog(pg).getByRole('combobox', { name: l.documents, exact: true }).click()
        await pg.getByRole('option', { name: l.split, exact: true }).click()
      }
      const editTenant = async (pg: Page) => {
        await pg.getByRole('row').filter({ hasText: tenant.name }).getByRole('button', { name: l.edit }).click()
      }

      type Step = { name: string; path: string; fullPage?: boolean; tenantAdmin?: boolean; act?: (pg: Page) => Promise<void>; route?: (pg: Page) => Promise<unknown> }
      const steps: Step[] = [
        { name: 'list', path: path(main.project.id, 'proposals'), fullPage: true },
        { name: 'empty', path: path(empty.id, 'proposals'), fullPage: true },
        { name: 'read-only', path: path(done.project.id, 'proposals'), fullPage: true },
        { name: 'dialog', path: path(main.project.id, 'proposals'), act: openCreate },
        {
          name: 'dialog-split',
          path: path(main.project.id, 'proposals'),
          act: async (pg) => {
            await openCreate(pg)
            await chooseSplit(pg)
            await expect(dialog(pg).getByTestId('preview-total')).toHaveCount(2)
            await expect(dialog(pg).getByTestId('preview-free-text')).toBeVisible()
          },
        },
        {
          name: 'dialog-error',
          path: path(main.project.id, 'proposals'),
          act: async (pg) => {
            await openCreate(pg)
            await chooseSplit(pg)
            for (const box of await dialog(pg).getByRole('checkbox').all()) await box.uncheck()
            await dialog(pg).getByRole('button', { name: l.create, exact: true }).click()
            await expect(dialog(pg).getByRole('checkbox').first()).toHaveAttribute('aria-invalid', 'true')
          },
        },
        {
          name: 'created',
          path: path(fresh.project.id, 'proposals'),
          fullPage: true,
          act: async (pg) => {
            await openCreate(pg)
            await chooseSplit(pg)
            await expect(dialog(pg).getByTestId('preview-total')).toHaveCount(2)
            await dialog(pg).getByRole('button', { name: l.create, exact: true }).click()
            await expect(dialog(pg)).toBeHidden()
            await expect(pg.getByRole('status').first()).toBeVisible()
          },
        },
        { name: 'pricing-texts', path: path(main.project.id, 'pricing'), fullPage: true },
        { name: 'company-profile', path: '/admin/company', fullPage: true, tenantAdmin: true },
        {
          name: 'tenant-letterhead',
          path: '/admin/tenants',
          act: async (pg) => {
            await editTenant(pg)
            await expect(dialog(pg).getByRole('img', { name: 'Logo' })).toBeVisible()
          },
        },
        {
          name: 'tenant-letterhead-loading',
          path: '/admin/tenants',
          route: (pg) => pg.route('**/api/tenants/*/letterhead', () => {}),
          act: async (pg) => {
            await editTenant(pg)
            await expect(dialog(pg).getByRole('heading', { name: l.letterhead })).toBeVisible()
          },
        },
        {
          name: 'tenant-letterhead-failed',
          path: '/admin/tenants',
          route: (pg) => pg.route('**/api/tenants/*/letterhead', (r) => r.fulfill({ status: 500, json: { code: 'server.error', title: 'Internal Server Error', status: 500 } })),
          act: async (pg) => {
            await editTenant(pg)
            await expect(dialog(pg).getByRole('alert').first()).toBeVisible()
          },
        },
      ]

      const adminPage = page
      const tenantPage = await sessionFor(tenantAdmin)
      for (const pg of [adminPage, tenantPage]) {
        await pg.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
        await pg.setViewportSize(viewport.size)
      }
      for (const colorScheme of ['light', 'dark'] as const) {
        for (const step of steps) {
          const pg = step.tenantAdmin ? tenantPage : adminPage
          await pg.emulateMedia({ colorScheme })
          if (step.route) await step.route(pg)
          await pg.goto(step.path)
          await expect(pg.getByRole('heading', { level: 1 })).toBeVisible()
          await pg.waitForLoadState('networkidle').catch(() => {})
          if (step.act) await step.act(pg)
          await pg.waitForTimeout(250)
          await expectNoHorizontalOverflow(pg)
          await pg.screenshot({ path: `e2e/screenshots/proposals2d-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          await pg.keyboard.press('Escape')
          if (step.route) await pg.unrouteAll({ behavior: 'ignoreErrors' })
        }
      }
    })
  }
}
