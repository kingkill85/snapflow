import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type Locator, type Page } from '@playwright/test'

import { admin } from '../env'
import {
  type Api,
  type Attribute,
  type CategoryInput,
  chooseLanguage,
  chooseOption,
  expect,
  navigate,
  optionTexts,
  type ProductType,
  row,
  type StoredFile,
  test,
  translation,
  unique,
  uniqueKey,
} from '../fixtures'

// Products, variants, add-ons and images (step 1c). Products, product types
// and categories are global and other specs run in parallel, so every spec
// seeds its own product types and categories and finds its rows by unique
// model numbers, or filters the list by its own type.

const listPath = '/catalog/products'

/**
 * Test images (frontend/e2e/assets): blue.png and red.png (160×100),
 * portrait-exif6.jpg (stored 160×80 with EXIF orientation 6, i.e. 80×160
 * upright) and animation.gif (not accepted).
 */
const asset = (name: string) => fileURLToPath(new URL(`../assets/${name}`, import.meta.url))

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const basics = (page: Page) => region(page, 'Basics')
const attributes = (page: Page) => region(page, 'Attributes')
const variants = (page: Page) => region(page, 'Variants')
/** A product with one variant shows it in this section instead of the list (D449). */
const single = (page: Page) => region(page, 'Price and variant')
/** The product form's Update (first on the page; the one-variant section has its own). */
const updateProduct = (page: Page) => page.getByRole('button', { name: 'Update' }).first()
const addons = (page: Page) => region(page, 'Add-ons')
const linked = (page: Page) => page.getByRole('list', { name: 'Linked add-ons' })
const results = (page: Page) => page.getByRole('region', { name: 'Search results' })
const variantRows = (page: Page) => variants(page).locator('tbody tr')

/** A model number no other spec uses. */
const modelNumber = (prefix = 'M') => unique(prefix).replace(/\s+/g, '-')

const option = (key: string, en: string, de?: string) => ({ key, label: de ? { en, de } : { en } })

/** Every kind of attribute, product scope, plus one per variant. */
const everyKind: Attribute[] = [
  { key: 'model_name', label: { en: 'Model name', de: 'Modellname' }, type: 'text', scope: 'product', required: true },
  { key: 'power', label: { en: 'Power', de: 'Leistung' }, type: 'number', unit: 'W', scope: 'product' },
  { key: 'width_te', label: { en: 'Width', de: 'Breite' }, type: 'integer', unit: 'TE', scope: 'product' },
  { key: 'dimmable', label: { en: 'Dimmable', de: 'Dimmbar' }, type: 'boolean', scope: 'product' },
  { key: 'colour', label: { en: 'Colour', de: 'Farbe' }, type: 'enum', scope: 'product', options: [option('white', 'White', 'Weiß'), option('black', 'Black', 'Schwarz')] },
  { key: 'protocols', label: { en: 'Protocols', de: 'Protokolle' }, type: 'list', itemType: 'enum', scope: 'product', options: [option('knx', 'KNX'), option('zigbee', 'Zigbee'), option('matter', 'Matter')] },
  { key: 'tags', label: { en: 'Tags', de: 'Schlagwörter' }, type: 'list', itemType: 'text', scope: 'product' },
  { key: 'finish', label: { en: 'Finish', de: 'Oberfläche' }, type: 'text', scope: 'variant' },
]

/** Width and height of a JPEG from its SOF segment. */
function jpegSize(data: Buffer): { width: number; height: number } {
  let i = 2
  while (i + 9 < data.length) {
    const marker = data[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) }
    }
    i += 2 + data.readUInt16BE(i + 2)
  }
  throw new Error('no SOF segment')
}

/** Waits for the next image upload and returns the stored file. */
const nextUpload = (page: Page) =>
  page
    .waitForResponse((r) => r.url().endsWith('/api/files') && r.request().method() === 'POST')
    .then(async (r) => {
      expect(r.status()).toBe(201)
      return (await r.json()) as StoredFile
    })

/** Chooses a file through the visible Choose file / Replace button. */
async function chooseImage(page: Page, button: string, file: string) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: button, exact: true }).click()
  await (await chooser).setFiles(file)
}

/** An image element that shows `fileId` and has loaded. */
async function expectImage(image: Locator, fileId: string) {
  await expect(image).toHaveAttribute('src', `/api/files/${fileId}`)
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0)
}

/** Opens the list filtered by a product type (through the filter, as a user would). */
async function openListOfType(page: Page, type: ProductType) {
  await page.goto(listPath)
  await chooseOption(page.getByLabel('System', { exact: true }), type.name.en)
  await expect(page).toHaveURL(new RegExp(`type=${type.id}`))
}

/** A product of a new type and a new category (`categoryInput`) with variants named after `names`. */
async function seedProduct(api: Api, names: string[], categoryInput: Partial<CategoryInput> = {}, values: Record<string, unknown> = {}) {
  const kind = await api.createKind(categoryInput)
  const product = await api.createProduct({ ...kind.ids, attributes: values })
  for (const [i, name] of names.entries()) {
    await api.createVariant(product.id, { name: { en: name }, sku: modelNumber(`SKU${i}`), price: `${10 + i}.00` })
  }
  return { ...kind, product: await api.product(product.id) }
}

test('an admin creates a product with every kind of attribute; the values persist', async ({ page, api }) => {
  const { type, category } = await api.createKind({ name: { en: unique('Actuator') }, attributes: everyKind }, { abbreviation: 'ZB', color: '#1f6feb' })
  const model = modelNumber()
  const name = unique('Dimmer')

  await page.goto(listPath)
  await page.getByRole('link', { name: 'New product' }).first().click()
  await expect(page.getByRole('heading', { name: 'New product', level: 1 })).toBeVisible()
  await expect(attributes(page)).toContainText('Choose a category to fill in its attributes.')
  await chooseOption(basics(page).getByLabel('System', { exact: true }), type.name.en)
  // The attributes come from the category, not the product type.
  await expect(attributes(page)).toContainText('Choose a category to fill in its attributes.')
  await chooseOption(basics(page).getByLabel('Category'), category.name.en)
  await basics(page).getByLabel('Model number').fill(model)
  await (await translation(basics(page), 'Name', 'en')).fill(name)
  await (await translation(basics(page), 'Name', 'de')).fill(`${name} DE`)
  await (await translation(basics(page), 'Description', 'en')).fill('Dims two channels.')

  const attrs = attributes(page)
  // Only the product attributes; "Finish" is set per variant.
  await expect(attrs.getByLabel('Finish')).toHaveCount(0)
  await attrs.getByLabel('Model name').fill('DA-2')
  await attrs.getByLabel('Power').fill('2.5')
  await attrs.getByLabel('Width').fill('4')
  await attrs.getByLabel('Dimmable').check()
  await chooseOption(attrs.getByLabel('Colour'), 'White')
  const protocols = attrs.getByRole('group', { name: 'Protocols' })
  await protocols.getByLabel('KNX').check()
  await protocols.getByLabel('Matter').check()
  await attrs.getByLabel('Tags', { exact: true }).fill('smart')
  await attrs.getByLabel('Tags', { exact: true }).press('Enter')
  await attrs.getByLabel('Tags', { exact: true }).fill('flush mounted')
  await attrs.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(attrs.getByRole('button', { name: 'Remove flush mounted' })).toBeVisible()
  // The first variant's price and SKU come with the product (D449).
  const sku = modelNumber('SKU')
  await basics(page).getByLabel('Price').fill('27.50')
  await basics(page).getByLabel('SKU').fill(sku)

  await page.getByRole('button', { name: 'Create' }).click()
  // Create continues on the product's page (D84), with its one variant in place of the list.
  await expect(page).toHaveURL(/\/catalog\/products\/[0-9a-f-]{36}$/)
  await expect(page.getByText('Product created with its first variant.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Edit product', level: 1 })).toBeVisible()
  await expect(single(page).getByLabel('Price')).toHaveValue('27.50')
  await expect(single(page).getByLabel('SKU')).toHaveValue(sku)
  await expect(variants(page)).toHaveCount(0)
  const id = page.url().split('/').pop()!

  const stored = await api.product(id)
  expect(stored).toMatchObject({
    productTypeId: type.id,
    categoryId: category.id,
    modelNumber: model,
    name: { en: name, de: `${name} DE` },
    description: { en: 'Dims two channels.' },
    isActive: true,
    attributes: { model_name: 'DA-2', power: 2.5, width_te: 4, dimmable: true, colour: 'white', protocols: ['knx', 'matter'], tags: ['smart', 'flush mounted'] },
  })
  expect(stored.variants).toMatchObject([{ name: { en: 'Standard', de: 'Standard' }, sku, price: '27.50', isActive: true }])

  // The one variant is edited right here; a second one turns the section into the list.
  await single(page).getByLabel('Price').fill('29')
  await single(page).getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  expect((await api.product(id)).variants[0].price).toBe('29.00')

  // A reload shows the stored version.
  await page.reload()
  await expect(page.getByText('Product created.')).toHaveCount(0)
  await expect(basics(page).getByLabel('Model number')).toHaveValue(model)
  await expect(attrs.getByLabel('Power')).toHaveValue('2.5')
  await expect(attrs.getByLabel('Width')).toHaveValue('4')
  await expect(attrs.getByLabel('Dimmable')).toBeChecked()
  await expect(attrs.getByLabel('Colour')).toHaveText('White')
  await expect(protocols.getByLabel('KNX')).toBeChecked()
  await expect(protocols.getByLabel('Zigbee')).not.toBeChecked()
  await expect(protocols.getByLabel('Matter')).toBeChecked()
  await expect(attrs.getByRole('button', { name: 'Remove smart' })).toBeVisible()

  // An edit: back to "not set" for the colour, one tag less.
  await chooseOption(attrs.getByLabel('Colour'), 'Not set')
  await attrs.getByRole('button', { name: 'Remove smart' }).click()
  await updateProduct(page).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  const updated = await api.product(id)
  expect(updated.attributes).not.toHaveProperty('colour')
  expect(updated.attributes.tags).toEqual(['flush mounted'])

  await single(page).getByRole('link', { name: 'Add variant' }).click()
  await (await translation(basics(page), 'Name', 'en')).fill('Black')
  await basics(page).getByLabel('Price').fill('31')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('Variant created.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to product' }).click()
  await expect(single(page)).toHaveCount(0)
  await expect(variantRows(page)).toHaveCount(2)

  await page.getByRole('link', { name: 'Back to list' }).click()
  // Other specs fill the list: find it.
  await page.getByLabel('Search').fill(model)
  await expect(row(page, model)).toContainText(name)
  await expect(row(page, model)).toContainText(`ZB${type.name.en}`)
  await expect(row(page, model)).toContainText(category.name.en)
  await expect(row(page, model)).toContainText('Active')
})

test('in German, numbers and prices take a decimal comma', async ({ page, api }) => {
  const { type, category } = await api.createKind(
    { name: { en: unique('Actuator'), de: unique('Aktor') }, attributes: everyKind },
    { name: { en: unique('System'), de: unique('System DE') } },
  )
  const model = modelNumber()
  await page.goto(listPath)
  await chooseLanguage(page, 'Deutsch')
  await expect(page.getByRole('heading', { name: 'Produkte', level: 1 })).toBeVisible()

  await page.getByRole('link', { name: 'Neues Produkt' }).first().click()
  const grunddaten = region(page, 'Grunddaten')
  await chooseOption(grunddaten.getByLabel('System', { exact: true }), type.name.de!)
  await chooseOption(grunddaten.getByLabel('Kategorie'), category.name.de!)
  await grunddaten.getByLabel('Modellnummer').fill(model)
  await (await translation(grunddaten, 'Name', 'en', 'de')).fill(unique('Dimmer'))
  const attrs = region(page, 'Attribute')
  await attrs.getByLabel('Modellname').fill('DA-2')
  await attrs.getByLabel('Leistung').fill('2,5')
  expect(await optionTexts(attrs.getByLabel('Farbe'))).toEqual(['Nicht gesetzt', 'Weiß', 'Schwarz'])
  await grunddaten.getByLabel('Preis').fill('12,5')
  await page.getByRole('button', { name: 'Erstellen' }).click()
  await expect(page.getByText('Produkt mit seiner ersten Variante erstellt.')).toBeVisible()
  await expect(region(page, 'Preis und Variante').getByLabel('Preis')).toHaveValue('12,50')
  const id = page.url().split('/').pop()!
  expect((await api.product(id)).attributes).toMatchObject({ power: 2.5 })

  // A whole number does not take decimals.
  await attrs.getByLabel('Breite').fill('2,5')
  await page.getByRole('button', { name: 'Aktualisieren' }).first().click()
  await expect(attrs.getByLabel('Breite')).toHaveAccessibleDescription(/eine ganze Zahl/)
  await attrs.getByLabel('Breite').fill('')
  await page.getByRole('button', { name: 'Aktualisieren' }).first().click()
  await expect(page.getByText('Gespeichert.')).toBeVisible()

  await region(page, 'Preis und Variante').getByRole('link', { name: 'Variante hinzufügen' }).click()
  await expect(page.getByRole('heading', { name: 'Neue Variante', level: 1 })).toBeVisible()
  await (await translation(region(page, 'Grunddaten'), 'Name', 'en', 'de')).fill('Ivory White')
  await (await translation(region(page, 'Grunddaten'), 'Name', 'de', 'de')).fill('Elfenbeinweiß')
  await region(page, 'Grunddaten').getByLabel('Preis').fill('27,50')
  await region(page, 'Attribute').getByLabel('Oberfläche').fill('matt')
  await page.getByRole('button', { name: 'Erstellen' }).click()
  await expect(page.getByText('Variante erstellt. Sie können jetzt ihr Zubehör hinzufügen.')).toBeVisible()
  const [, variant] = (await api.product(id)).variants
  expect(variant).toMatchObject({ name: { en: 'Ivory White', de: 'Elfenbeinweiß' }, price: '27.50', attributes: { finish: 'matt' } })

  await page.getByRole('link', { name: 'Zurück zum Produkt' }).click()
  const listed = region(page, 'Varianten').getByRole('row').filter({ hasText: 'Elfenbeinweiß' })
  await expect(listed).toContainText(/27,50\s\$/)
  await page.getByRole('link', { name: 'Zurück zur Liste' }).click()
  await page.getByLabel('Suche').fill(model)
  await expect(row(page, model)).toContainText(/27,50\s\$/)
})

test('variants: add one with an image, replace and remove it; other files are refused', async ({ page, api }) => {
  const { type, product } = await seedProduct(api, [], { attributes: everyKind }, { model_name: 'DA-2' })
  await page.goto(`${listPath}/${product.id}`)
  await variants(page).getByRole('link', { name: 'Add variant' }).click()
  await expect(page).toHaveURL(new RegExp(`/catalog/products/${product.id}/variants/new$`))
  await expect(page.getByRole('heading', { name: 'New variant', level: 1 })).toBeVisible()
  await expect(addons(page)).toContainText('Add-ons can be added once the variant is created.')

  const sku = modelNumber('SKU')
  await (await translation(basics(page), 'Name', 'en')).fill('Ivory White')
  await (await translation(basics(page), 'Name', 'de')).fill('Elfenbeinweiß')
  await basics(page).getByLabel('SKU').fill(sku)
  await basics(page).getByLabel('Price').fill('27.50')
  await attributes(page).getByLabel('Finish').fill('glossy')

  // A GIF is refused before the upload; one named .png by the server.
  await page.locator('input[type="file"]').setInputFiles(asset('animation.gif'))
  const refused = page.getByRole('alert').filter({ hasText: 'Only JPEG, PNG and WebP images are accepted.' })
  await expect(refused).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles({ name: 'disguised.png', mimeType: 'image/png', buffer: readFileSync(asset('animation.gif')) })
  await expect(refused).toBeVisible()
  await expect(basics(page).getByRole('img', { name: 'Image' })).toHaveCount(0)

  // The upload shows its progress; Create waits for it.
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/files', async (route) => {
    await held
    await route.continue()
  })
  const blueUpload = nextUpload(page)
  await chooseImage(page, 'Choose file', asset('blue.png'))
  await expect(page.getByRole('progressbar', { name: 'Uploading…' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled()
  await expect(refused).toHaveCount(0)
  release()
  const blue = await blueUpload
  await page.unroute('**/api/files')
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await expectImage(basics(page).getByRole('img', { name: 'Image' }), blue.id)

  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('Variant created. You can now add its add-ons.')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/catalog/products/${product.id}/variants/[0-9a-f-]{36}$`))
  await expect(page.getByRole('heading', { name: 'Edit variant', level: 1 })).toBeVisible()
  const variantId = page.url().split('/').pop()!
  expect((await api.product(product.id)).variants[0]).toMatchObject({
    id: variantId,
    name: { en: 'Ivory White', de: 'Elfenbeinweiß' },
    sku,
    price: '27.50',
    imageFileId: blue.id,
    attributes: { finish: 'glossy' },
  })

  // The only variant: in the product page's "Price and variant" section (D449), and a thumbnail in the product list.
  await page.getByRole('link', { name: 'Back to product' }).click()
  await expect(single(page).getByLabel('SKU')).toHaveValue(sku)
  await expect(single(page).getByLabel(/^Price/)).toHaveValue(/^27[.,]50?$/)
  await expectImage(single(page).getByRole('img', { name: 'Image' }), blue.id)
  await openListOfType(page, type)
  await expectImage(row(page, product.modelNumber).locator('img'), blue.id)
  await expect(row(page, product.modelNumber)).toContainText('$27.50')

  // Replace: a new file; Remove: no image after the update.
  await row(page, product.modelNumber).getByRole('link', { name: product.modelNumber }).click()
  await single(page).getByRole('link', { name: 'Name and add-ons' }).click()
  await expectImage(basics(page).getByRole('img', { name: 'Image' }), blue.id)
  const redUpload = nextUpload(page)
  await chooseImage(page, 'Replace', asset('red.png'))
  const red = await redUpload
  expect(red.id).not.toBe(blue.id)
  await expectImage(basics(page).getByRole('img', { name: 'Image' }), red.id)
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  expect((await api.product(product.id)).variants[0].imageFileId).toBe(red.id)

  await page.getByRole('button', { name: 'Remove image' }).click()
  await expect(basics(page).getByRole('img', { name: 'Image' })).toHaveCount(0)
  await expect(page.getByText('Drop an image here or choose a file.')).toBeVisible()
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  expect((await api.product(product.id)).variants[0]).not.toHaveProperty('imageFileId')
  await page.getByRole('link', { name: 'Back to product' }).click()
  await expect(single(page).getByRole('img', { name: 'Image' })).toHaveCount(0)
})

test('a photo with EXIF orientation is stored upright', async ({ page, api }) => {
  const { product } = await seedProduct(api, ['Standard'])
  await page.goto(`${listPath}/${product.id}/variants/${product.variants[0].id}`)
  const upload = nextUpload(page)
  await chooseImage(page, 'Choose file', asset('portrait-exif6.jpg'))
  const stored = await upload
  // Stored 160×80 with "rotate 90°": upright it is portrait.
  expect(stored).toMatchObject({ contentType: 'image/jpeg', width: 80, height: 160 })
  const res = await page.request.get(`/api/files/${stored.id}`)
  expect(res.status()).toBe(200)
  expect(jpegSize(await res.body())).toEqual({ width: 80, height: 160 })
  await expectImage(basics(page).getByRole('img', { name: 'Image' }), stored.id)
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  expect((await api.product(product.id)).variants[0].imageFileId).toBe(stored.id)
})

test('variants are reordered and deleted on the product page', async ({ page, api }) => {
  const { type, product } = await seedProduct(api, ['Alpha', 'Bravo', 'Charlie'])
  await page.goto(`${listPath}/${product.id}`)
  await expect(variantRows(page)).toContainText(['Alpha', 'Bravo', 'Charlie'])
  await expect(variants(page).getByRole('button', { name: 'Move Alpha up' })).toBeDisabled()
  await expect(variants(page).getByRole('button', { name: 'Move Charlie down' })).toBeDisabled()

  await variants(page).getByRole('button', { name: 'Move Charlie up' }).click()
  await expect(variantRows(page)).toContainText(['Alpha', 'Charlie', 'Bravo'])
  await variants(page).getByRole('button', { name: 'Move Alpha down' }).click()
  await expect(variantRows(page)).toContainText(['Charlie', 'Alpha', 'Bravo'])
  expect((await api.product(product.id)).variants.map((v) => v.name.en)).toEqual(['Charlie', 'Alpha', 'Bravo'])

  await variantRows(page).filter({ hasText: 'Alpha' }).getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete variant' })
  await expect(confirm).toContainText('Delete the variant "Alpha" with its add-on links?')
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toBeHidden()
  await expect(variantRows(page)).toContainText(['Charlie', 'Bravo'])
  expect((await api.product(product.id)).variants.map((v) => v.name.en)).toEqual(['Charlie', 'Bravo'])

  // The list counts the variants left and their price range.
  await openListOfType(page, type)
  await expect(row(page, product.modelNumber).getByRole('cell').nth(4)).toHaveText('2')
  await expect(row(page, product.modelNumber)).toContainText('$11.00 – $12.00')
})

test('add-ons: browse, filter, search by SKU, add, mark required, reorder and save', async ({ page, api }) => {
  // 25 accessories of their own type and category, more than one page of the picker (20).
  const accessoryKind = await api.createKind({ name: { en: unique('Frames') } }, { name: { en: unique('Frame line') } })
  const accessory = await api.createProduct({ ...accessoryKind.ids, name: { en: unique('Design frame') } })
  const skuPrefix = modelNumber('FR')
  const frame = (n: number) => `Frame ${String(n).padStart(2, '0')}`
  for (let n = 1; n <= 25; n++) {
    await api.createVariant(accessory.id, { name: { en: frame(n) }, sku: `${skuPrefix}-${String(n).padStart(2, '0')}`, price: `${n}.50` })
  }
  const { product } = await seedProduct(api, ['Standard'])
  const variant = product.variants[0]
  const addonName = (n: number) => `${accessory.modelNumber} ${frame(n)}`

  await page.goto(`${listPath}/${product.id}/variants/${variant.id}`)
  await expect(linked(page)).toContainText('No add-ons yet.')
  // Before anything is typed, the picker lists variants in catalog order.
  await expect(results(page).getByRole('listitem').first()).toBeVisible()
  await expect(results(page)).toContainText(/\d+ variants? shown/)

  await chooseOption(addons(page).getByLabel('System', { exact: true }), accessoryKind.type.name.en)
  await expect(results(page).getByRole('listitem')).toHaveCount(20)
  await expect(results(page)).toContainText('20 variants shown')
  // Rows name the product with its type badge and its category.
  await expect(results(page).getByRole('listitem').first()).toContainText(`${accessory.name.en} · ${accessoryKind.category.name.en}`)
  // The category filter narrows the same way; another category shows nothing of these.
  await chooseOption(addons(page).getByLabel('Category'), accessoryKind.category.name.en)
  await expect(results(page).getByRole('listitem')).toHaveCount(20)
  await results(page).getByRole('button', { name: 'Show more' }).click()
  await expect(results(page).getByRole('listitem')).toHaveCount(25)
  await expect(results(page)).toContainText('25 variants shown')
  await expect(results(page).getByRole('button', { name: 'Show more' })).toHaveCount(0)

  // Search by SKU.
  await addons(page).getByLabel('Find a variant to add').fill(`${skuPrefix}-07`)
  await expect(results(page).getByRole('listitem')).toHaveCount(1)
  await expect(results(page).getByRole('listitem')).toContainText(`SKU ${skuPrefix}-07`)
  await results(page).getByRole('button', { name: `Add ${addonName(7)}` }).click()
  await expect(linked(page).getByRole('listitem')).toHaveCount(1)
  await expect(results(page)).toContainText('No matching variants.')

  // Back to browsing: both pages loaded before, without the linked one.
  await addons(page).getByLabel('Find a variant to add').fill('')
  await expect(results(page).getByRole('listitem')).toHaveCount(24)
  await results(page).getByRole('button', { name: `Add ${addonName(3)}` }).click()
  await expect(linked(page).getByRole('listitem')).toHaveCount(2)
  await linked(page).getByLabel(`${addonName(7)} is required`).check()
  await linked(page).getByRole('button', { name: `Move ${addonName(3)} up` }).click()
  await expect(linked(page).getByRole('listitem')).toContainText([frame(3), frame(7)])

  // Unsaved add-ons: a warning, and leaving asks first.
  await expect(addons(page).getByText('The add-ons have unsaved changes.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to product' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Cancel' }).click()
  const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' })
  await confirm.getByRole('button', { name: 'Stay' }).click()
  await expect(confirm).toBeHidden()
  await navigate(page, 'Catalog', 'Products')
  await confirm.getByRole('button', { name: 'Stay' }).click()
  await expect(page).toHaveURL(new RegExp(`/variants/${variant.id}$`))

  // Update saves the variant only; the add-ons stay unsaved (D89).
  await (await translation(basics(page), 'Name', 'de')).fill('Standard DE')
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(page.getByText('The add-ons have unsaved changes.')).toHaveCount(2)
  expect((await api.product(product.id)).variants[0].addons).toEqual([])

  await addons(page).getByRole('button', { name: 'Save add-ons' }).click()
  await expect(addons(page).getByText('Add-ons saved.')).toBeVisible()
  await expect(page.getByText('The add-ons have unsaved changes.')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Back to product' })).toBeVisible()
  const saved = (await api.product(product.id)).variants[0].addons
  const accessoryVariants = (await api.product(accessory.id)).variants
  expect(saved.map((a) => [a.addonVariantId, a.required])).toEqual([
    [accessoryVariants[2].id, false],
    [accessoryVariants[6].id, true],
  ])

  // After a reload as saved; a linked add-on links to its product.
  await page.reload()
  await expect(linked(page).getByRole('listitem')).toContainText([frame(3), frame(7)])
  await expect(linked(page).getByLabel(`${addonName(7)} is required`)).toBeChecked()
  await linked(page).getByRole('listitem').first().getByRole('link', { name: accessory.name.en }).click()
  await expect(page).toHaveURL(new RegExp(`/catalog/products/${accessory.id}$`))
  await expect(basics(page).getByLabel('Model number')).toHaveValue(accessory.modelNumber)
})

test('availability follows the product type, the category, the product and the variant', async ({ page, api }) => {
  const { type, category, product } = await seedProduct(api, ['Alpha', 'Bravo'])
  const search = async (text: string) => {
    await page.getByLabel('Search').fill(text)
    await expect(page).toHaveURL(new RegExp(`search=${encodeURIComponent(text)}`))
  }

  // A deactivated product type makes its products unavailable: hidden unless inactive ones are shown.
  await api.updateProductType(type.id, { isActive: false })
  await page.goto(listPath)
  await search(product.modelNumber)
  await expect(page.getByText('No products match these filters.')).toBeVisible()
  await page.getByLabel('Show inactive').check()
  await expect(row(page, product.modelNumber)).toContainText('Unavailable')
  await expect(row(page, product.modelNumber).getByTitle('Active, but its system or category is inactive.')).toBeVisible()

  await api.updateProductType(type.id, { isActive: true })
  // A deactivated category likewise.
  await api.updateCategory(category.id, { isActive: false })
  await page.reload()
  await expect(row(page, product.modelNumber)).toContainText('Unavailable')
  await api.updateCategory(category.id, { isActive: true })
  await page.reload()
  await expect(row(page, product.modelNumber)).toContainText('Active')
  await page.getByLabel('Show inactive').uncheck()
  await expect(row(page, product.modelNumber)).toContainText('Active')

  // A deactivated variant.
  await row(page, product.modelNumber).getByRole('link', { name: product.modelNumber }).click()
  await variantRows(page).filter({ hasText: 'Alpha' }).getByRole('link', { name: 'Edit' }).click()
  await basics(page).getByLabel('Active', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to product' }).click()
  await expect(variantRows(page).filter({ hasText: 'Alpha' })).toContainText('Inactive')
  await expect(variantRows(page).filter({ hasText: 'Bravo' })).toContainText('Active')

  // A deactivated product: its active variants are unavailable.
  await basics(page).getByLabel('Active', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(variantRows(page).filter({ hasText: 'Bravo' })).toContainText('Unavailable')
  await variantRows(page).filter({ hasText: 'Bravo' }).getByRole('link', { name: 'Bravo' }).click()
  await expect(page.getByText('This variant is not available because its product, system or category is inactive.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to product' }).click()
  await page.getByRole('link', { name: 'Back to list' }).click()
  await expect(page.getByText('No products match these filters.')).toBeVisible()
  await page.getByLabel('Show inactive').check()
  await expect(row(page, product.modelNumber)).toContainText('Inactive')
  expect(await api.product(product.id)).toMatchObject({ isActive: false, available: false })
})

test('after a schema change the product shows its stale and invalid values', async ({ page, api }) => {
  const { type, category, ids } = await api.createKind({
    attributes: [
      { key: 'colour', label: { en: 'Colour' }, type: 'enum', scope: 'product', options: [option('white', 'White'), option('black', 'Black')] },
      { key: 'protocols', label: { en: 'Protocols' }, type: 'list', itemType: 'enum', scope: 'product', options: [option('knx', 'KNX'), option('bus', 'Bus')] },
      { key: 'legacy', label: { en: 'Legacy' }, type: 'text', scope: 'product' },
    ],
  })
  const product = await api.createProduct({ ...ids, attributes: { colour: 'black', protocols: ['knx', 'bus'], legacy: 'old value' } })
  // Remove an attribute, replace an option of each choice.
  const current = await api.category(category.id)
  await api.updateCategory(category.id, {
    attributes: [
      { ...current.attributes[0], options: [option('white', 'White'), option('anthracite', 'Anthracite')] },
      { ...current.attributes[1], options: [option('knx', 'KNX'), option('zigbee', 'Zigbee')] },
    ],
  })

  await openListOfType(page, type)
  await expect(row(page, product.modelNumber).getByTitle('3 attribute values need attention')).toBeVisible()

  await row(page, product.modelNumber).getByRole('link', { name: product.modelNumber }).click()
  await expect(page.getByText("Some stored values do not match the category's current attributes.")).toBeVisible()
  const attrs = attributes(page)
  await expect(attrs.getByLabel('Colour')).toHaveText('black (not an option)')
  await expect(attrs.getByLabel('Colour')).toHaveAccessibleDescription(/not one of the allowed options/)
  const protocols = attrs.getByRole('group', { name: 'Protocols' })
  await expect(protocols.getByLabel('bus (not an option)')).toBeChecked()
  const extra = attrs.getByRole('group', { name: 'Values no longer in the schema' })
  await expect(extra).toContainText('legacy')
  await expect(extra).toContainText('old value')

  // Fixed: the stale value removed, a valid choice, the unknown list item unticked.
  await extra.getByRole('button', { name: 'Remove legacy' }).click()
  await expect(extra).toContainText('Removed on save')
  await chooseOption(attrs.getByLabel('Colour'), 'Anthracite')
  // Unticked, it is gone (it is not an option to tick again).
  await protocols.getByLabel('bus (not an option)').click()
  await expect(protocols.getByLabel('bus (not an option)')).toHaveCount(0)
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(extra).toHaveCount(0)
  const fixed = await api.product(product.id)
  expect(fixed.attributes).toEqual({ colour: 'anthracite', protocols: ['knx'] })
  expect(fixed.staleAttributes).toEqual({})

  await page.getByRole('link', { name: 'Back to list' }).click()
  await expect(row(page, product.modelNumber)).toBeVisible()
  await expect(row(page, product.modelNumber).getByTitle(/need attention/)).toHaveCount(0)
})

test("changing a product's category flags its variants", async ({ page, api }) => {
  const { ids } = await api.createKind({ attributes: [{ key: 'power', label: { en: 'Power' }, type: 'number', unit: 'W', scope: 'variant' }] })
  const to = await api.createCategory({ name: { en: unique('Sensors') }, attributes: [{ key: 'range', label: { en: 'Range' }, type: 'integer', scope: 'variant' }] })
  const product = await api.createProduct(ids)
  await api.createVariant(product.id, { name: { en: 'Flagged' }, attributes: { power: 5 } })
  await api.createVariant(product.id, { name: { en: 'Clean' } })

  await page.goto(`${listPath}/${product.id}`)
  await chooseOption(basics(page).getByLabel('Category'), to.name.en)
  await expect(page.getByText('You changed the category.')).toBeVisible()
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  const summary = variants(page).getByRole('status').filter({ hasText: '1 variant has values that no longer match the schema:' })
  await expect(summary).toBeVisible()
  await expect(summary.getByRole('link')).toHaveText(['Flagged'])
  await expect(variantRows(page).filter({ hasText: 'Flagged' }).getByTitle('1 attribute value needs attention')).toBeVisible()
  expect(await api.product(product.id)).toMatchObject({ categoryId: to.id, productTypeId: ids.productTypeId, variantsWithProblems: 1 })

  await summary.getByRole('link', { name: 'Flagged' }).click()
  await expect(page.getByRole('heading', { name: 'Edit variant', level: 1 })).toBeVisible()
  const extra = attributes(page).getByRole('group', { name: 'Values no longer in the schema' })
  await expect(extra).toContainText('power')
  await expect(attributes(page).getByLabel('Range')).toBeVisible()
  await extra.getByRole('button', { name: 'Remove power' }).click()
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to product' }).click()
  await expect(variants(page).getByText('no longer match the schema')).toHaveCount(0)
})

test('the product editor reports each mistake at its field', async ({ page, api }) => {
  const { type, category, ids } = await api.createKind({
    attributes: [{ key: 'model_name', label: { en: 'Model name' }, type: 'text', scope: 'product', required: true }],
  })
  const inactive = await api.createKind({ name: { en: unique('Retired') }, isActive: false }, { name: { en: unique('Retired line') }, isActive: false })
  const taken = await api.createProduct({ ...ids, modelNumber: modelNumber('Abc'), attributes: { model_name: 'X' } })

  await page.goto(`${listPath}/new`)
  // A new product cannot use an inactive type or category (D78).
  const typeSelect = basics(page).getByLabel('System', { exact: true })
  const categorySelect = basics(page).getByLabel('Category')
  const offered = await optionTexts(typeSelect)
  expect(offered).toContain(type.name.en)
  expect(offered.filter((o) => o.includes(inactive.type.name.en))).toEqual([])
  const offeredCategories = await optionTexts(categorySelect)
  expect(offeredCategories).toContain(category.name.en)
  expect(offeredCategories.filter((o) => o.includes(inactive.category.name.en))).toEqual([])

  await page.getByRole('button', { name: 'Create' }).click()
  await expect(typeSelect).toHaveAccessibleDescription(/This field is required\./)
  await expect(categorySelect).toHaveAccessibleDescription(/This field is required\./)
  await expect(typeSelect).toBeFocused()
  await expect(basics(page).getByLabel('Model number')).toHaveAccessibleDescription('This field is required.')
  await expect(await translation(basics(page), 'Name', 'en')).toHaveAccessibleDescription('This field is required.')
  await expect(basics(page).getByLabel('Price')).toHaveAccessibleDescription(/This field is required\./)
  await basics(page).getByLabel('Price').fill('10')

  // The server: invisible characters in the model number, a required attribute.
  await chooseOption(typeSelect, type.name.en)
  await chooseOption(categorySelect, category.name.en)
  await basics(page).getByLabel('Model number').fill(`Zero​Width-${taken.modelNumber}`)
  await (await translation(basics(page), 'Name', 'en')).fill(unique('Valid'))
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(basics(page).getByLabel('Model number')).toHaveAccessibleDescription(/Control characters .* are not allowed\./)
  await expect(attributes(page).getByLabel('Model name')).toHaveAccessibleDescription(/This value is required\./)

  // Taken, ignoring case.
  const upper = taken.modelNumber.toUpperCase()
  await basics(page).getByLabel('Model number').fill(upper)
  await attributes(page).getByLabel('Model name').fill('X')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(basics(page).getByLabel('Model number')).toHaveAccessibleDescription(`The model number "${upper}" is already used.`)
  await expect(page).toHaveURL(/\/new$/)

  await basics(page).getByLabel('Model number').fill(modelNumber())
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('Product created with its first variant.')).toBeVisible()

  // Variant: price format and a taken SKU.
  const other = await api.createVariant(taken.id, { sku: modelNumber('SKU') })
  await single(page).getByRole('link', { name: 'Add variant' }).click()
  await (await translation(basics(page), 'Name', 'en')).fill('Second')
  const price = basics(page).getByLabel('Price')
  for (const wrong of ['12.345', '1e3', '-1', '27,5,0']) {
    await price.fill(wrong)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(price).toHaveAccessibleDescription('Enter a price such as 27 or 27.50 (up to 10 digits and 2 decimals).')
  }
  await price.fill('27,5')
  await basics(page).getByLabel('SKU').fill(other.sku!.toLowerCase())
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(basics(page).getByLabel('SKU')).toHaveAccessibleDescription(`The SKU "${other.sku!.toLowerCase()}" is already used.`)
  await basics(page).getByLabel('SKU').fill('')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('Variant created.')).toBeVisible()
  const productId = page.url().split('/')[5]
  expect((await api.product(productId)).variants[1]).toMatchObject({ name: { en: 'Second' }, price: '27.50' })
  expect((await api.product(productId)).variants[1]).not.toHaveProperty('sku')
})

test('a product save over a newer version is refused, and Reload shows that version', async ({ page, api, sessionFor }) => {
  const { product } = await seedProduct(api, [])
  const other = await sessionFor(admin)
  for (const p of [page, other]) {
    await p.goto(`${listPath}/${product.id}`)
    await expect(basics(p).getByLabel('Model number')).toHaveValue(product.modelNumber)
  }
  const first = unique('First')
  await (await translation(basics(page), 'Name', 'en')).fill(first)
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()

  await (await translation(basics(other), 'Description', 'en')).fill('Second')
  await other.getByRole('button', { name: 'Update' }).click()
  const stale = other.getByRole('alert').filter({ hasText: 'Someone else changed this product in the meantime.' })
  await expect(stale).toBeVisible()
  await stale.getByRole('button', { name: 'Reload' }).click()
  await expect(await translation(basics(other), 'Name', 'en')).toHaveValue(first)
  await expect(await translation(basics(other), 'Description', 'en')).toHaveValue('')
  await expect(stale).toHaveCount(0)

  await (await translation(basics(other), 'Description', 'en')).fill('Second try')
  await other.getByRole('button', { name: 'Update' }).click()
  await expect(other.getByText('Saved.')).toBeVisible()
  expect(await api.product(product.id)).toMatchObject({ name: { en: first }, description: { en: 'Second try' } })
})

test('a variant save over a newer version is refused, and Reload shows that version', async ({ page, api, sessionFor }) => {
  const { product } = await seedProduct(api, ['Standard'])
  const path = `${listPath}/${product.id}/variants/${product.variants[0].id}`
  const other = await sessionFor(admin)
  for (const p of [page, other]) {
    await p.goto(path)
    await expect(await translation(basics(p), 'Name', 'en')).toHaveValue('Standard')
  }
  await basics(page).getByLabel('Price').fill('99.90')
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()

  await (await translation(basics(other), 'Name', 'de')).fill('Standard DE')
  await other.getByRole('button', { name: 'Update' }).click()
  const stale = other.getByRole('alert').filter({ hasText: 'Someone else changed this variant in the meantime.' })
  await expect(stale).toBeVisible()
  await stale.getByRole('button', { name: 'Reload' }).click()
  await expect(basics(other).getByLabel('Price')).toHaveValue('99.90')
  await expect(await translation(basics(other), 'Name', 'de')).toHaveValue('')
  await (await translation(basics(other), 'Name', 'de')).fill('Standard DE')
  await other.getByRole('button', { name: 'Update' }).click()
  await expect(other.getByText('Saved.')).toBeVisible()
  expect((await api.product(product.id)).variants[0]).toMatchObject({ price: '99.90', name: { en: 'Standard', de: 'Standard DE' } })
})

test('the list searches, filters by type and category and shows inactive products; the filters survive a visit', async ({ page, api }) => {
  const { type, ids } = await api.createKind({ name: { en: unique('Gateways') } }, { name: { en: unique('Gateway line') } })
  const other = await api.createCategory({ name: { en: unique('Sensors') } })
  const word = uniqueKey('needle')
  const p1 = await api.createProduct({ ...ids, description: { en: `Bridges the bus and ${word} networks.` } })
  const p2 = await api.createProduct(ids)
  const sku = modelNumber('SKU')
  await api.createVariant(p2.id, { name: { en: 'Standard' }, sku })
  const p3 = await api.createProduct({ ...ids, isActive: false })
  const p4 = await api.createProduct({ ...ids, categoryId: other.id })

  await page.goto(listPath)
  // A word of the description.
  await page.getByLabel('Search').fill(word)
  await expect(page.getByRole('row')).toHaveCount(2)
  await expect(row(page, p1.modelNumber)).toBeVisible()
  // A variant's SKU, in other case.
  await page.getByLabel('Search').fill(sku.toUpperCase())
  await expect(page.getByRole('row')).toHaveCount(2)
  await expect(row(page, p2.modelNumber)).toBeVisible()

  // The type filter; the inactive product only with Show inactive.
  await page.getByLabel('Search').fill('')
  await chooseOption(page.getByLabel('System', { exact: true }), type.name.en)
  await expect(page.getByRole('row')).toHaveCount(4)
  await expect(row(page, p3.modelNumber)).toHaveCount(0)
  await page.getByLabel('Show inactive').check()
  await expect(row(page, p3.modelNumber)).toContainText('Inactive')
  await expect(page.getByRole('row')).toHaveCount(5)
  await page.getByLabel('Show inactive').uncheck()
  // The category filter narrows further.
  await chooseOption(page.getByLabel('Category'), other.name.en)
  await expect(page.getByRole('row')).toHaveCount(2)
  await expect(row(page, p4.modelNumber)).toContainText(other.name.en)
  await expect(page).toHaveURL(new RegExp(`category=${other.id}`))
  await chooseOption(page.getByLabel('Category'), 'All categories')
  await expect(page.getByRole('row')).toHaveCount(4)

  // Opening a product and going back keeps the filters (D86).
  await page.getByLabel('Search').fill(word)
  await expect(page.getByRole('row')).toHaveCount(2)
  const filtered = page.url()
  await row(page, p1.modelNumber).getByRole('link', { name: p1.modelNumber }).click()
  await page.getByRole('link', { name: 'Back to list' }).click()
  await expect(page).toHaveURL(filtered)
  await expect(page.getByLabel('Search')).toHaveValue(word)
  await expect(page.getByLabel('System', { exact: true })).toContainText(type.name.en)

  // Cancel after a change asks first, then returns to the filtered list.
  await row(page, p1.modelNumber).getByRole('link', { name: 'Edit' }).click()
  await (await translation(basics(page), 'Name', 'en')).fill('Changed')
  await page.getByRole('link', { name: 'Cancel' }).click()
  await page.getByRole('dialog', { name: 'Discard unsaved changes?' }).getByRole('button', { name: 'Leave page' }).click()
  await expect(page).toHaveURL(filtered)
  await expect(row(page, p1.modelNumber)).toContainText(p1.name.en)

  // Through a variant and back.
  await page.getByLabel('Search').fill(sku)
  await expect(row(page, p2.modelNumber)).toBeVisible()
  const bySku = page.url()
  await row(page, p2.modelNumber).getByRole('link', { name: p2.modelNumber }).click()
  await single(page).getByRole('link', { name: 'Name and add-ons' }).click()
  await page.getByRole('link', { name: 'Back to product' }).click()
  await page.getByRole('link', { name: 'Back to list' }).click()
  await expect(page).toHaveURL(bySku)
  await expect(page.getByLabel('Search')).toHaveValue(sku)

  // The navigation link opens the bare list.
  await navigate(page, 'Catalog', 'Products')
  await expect(page).toHaveURL(new RegExp(`${listPath}$`))
  await expect(page.getByLabel('Search')).toHaveValue('')
})

test('the list pages by 50 and moves back from a page past the end', async ({ page, api }) => {
  const { type, ids } = await api.createKind({}, { name: { en: unique('Bulk') } })
  const prefix = modelNumber('BULK')
  const model = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`
  await Promise.all(Array.from({ length: 51 }, (_, i) => api.createProduct({ ...ids, modelNumber: model(i + 1) })))

  await openListOfType(page, type)
  const pages = page.getByRole('navigation', { name: 'Pages' })
  await expect(pages).toContainText('1–50 of 51')
  await expect(page.locator('tbody tr')).toHaveCount(50)
  await expect(pages.getByRole('button', { name: 'Previous' })).toBeDisabled()
  await pages.getByRole('button', { name: 'Next' }).click()
  await expect(pages).toContainText('51–51 of 51')
  await expect(page).toHaveURL(/offset=50/)
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(row(page, model(51))).toBeVisible()

  // Deleting the last row of the last page moves to the page before.
  await row(page, model(51)).getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete product' })
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toBeHidden()
  await expect(pages).toContainText('1–50 of 50')
  await expect(page).not.toHaveURL(/offset=/)
  await expect(pages.getByRole('button', { name: 'Next' })).toBeDisabled()

  // An offset past the end in the URL as well.
  await page.goto(`${listPath}?type=${type.id}&offset=500`)
  await expect(pages).toContainText('1–50 of 50')
  await expect(page).not.toHaveURL(/offset=/)
})

test('the product editor: Back to list or Cancel, the prompt, and variants locked while unsaved', async ({ page, api }) => {
  const { product } = await seedProduct(api, ['Standard', 'White'])
  await page.goto(`${listPath}/${product.id}`)
  await expect(page.getByRole('link', { name: 'Back to list' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Cancel' })).toHaveCount(0)
  await expect(variantRows(page).getByRole('link', { name: 'Standard' })).toBeVisible()

  await (await translation(basics(page), 'Name', 'en')).fill('Unsaved name')
  await expect(page.getByRole('link', { name: 'Cancel' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to list' })).toHaveCount(0)
  // Variants cannot be opened or added until the product is saved (D88).
  await expect(variants(page).getByText('Save the product first to open or add variants.').first()).toBeVisible()
  await expect(variantRows(page).getByRole('link', { name: 'Standard' })).toHaveCount(0)
  await expect(variantRows(page).getByRole('button', { name: 'Edit' }).first()).toBeDisabled()
  await expect(variants(page).getByRole('button', { name: 'Add variant' })).toBeDisabled()

  await navigate(page, 'Setup', 'Systems')
  const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' })
  await confirm.getByRole('button', { name: 'Stay' }).click()
  await expect(page).toHaveURL(new RegExp(`/catalog/products/${product.id}$`))
  await expect(await translation(basics(page), 'Name', 'en')).toHaveValue('Unsaved name')

  // Back to the stored value: nothing unsaved any more.
  await (await translation(basics(page), 'Name', 'en')).fill(product.name.en)
  await expect(page.getByRole('link', { name: 'Back to list' })).toBeVisible()
  await expect(variantRows(page).getByRole('link', { name: 'Standard' })).toBeVisible()

  await (await translation(basics(page), 'Name', 'en')).fill('Saved name')
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to list' })).toBeVisible()
  await variantRows(page).filter({ hasText: 'Standard' }).getByRole('link', { name: 'Edit' }).click()
  await expect(page.getByRole('heading', { name: 'Edit variant', level: 1 })).toBeVisible()
  await expect(page.getByText('Variant of')).toContainText('Saved name')

  // The variant page: Back to product, Cancel while unsaved.
  await expect(page.getByRole('link', { name: 'Back to product' })).toBeVisible()
  await basics(page).getByLabel('SKU').fill('changed')
  await page.getByRole('link', { name: 'Cancel' }).click()
  await confirm.getByRole('button', { name: 'Leave page' }).click()
  await expect(page).toHaveURL(new RegExp(`/catalog/products/${product.id}$`))
  expect((await api.product(product.id)).variants[0].sku).toBe(product.variants[0].sku)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const role of ['user', 'tenant_admin'] as const) {
  test(`a ${role} sees products and variants read-only, images included`, async ({ api, sessionFor }) => {
    const image = await api.uploadFile('blue.png', 'image/png', readFileSync(asset('blue.png')))
    const { ids, product } = await seedProduct(api, [], { attributes: everyKind }, { model_name: 'DA-2' })
    const accessory = await api.createProduct({ ...ids, name: { en: unique('Accessory') }, attributes: { model_name: 'F' } })
    const addon = await api.createVariant(accessory.id, { name: { en: 'Frame' } })
    const variant = await api.createVariant(product.id, { name: { en: 'Standard' }, imageFileId: image.id, price: '27.50', attributes: { finish: 'matt' } })
    await api.replaceAddons(product.id, variant.id, [{ addonVariantId: addon.id, required: true }])
    const tenant = role === 'tenant_admin' ? await api.createTenant() : undefined
    const account = await api.createUser({ role, tenantId: tenant?.id })
    const page = await sessionFor(account)

    await page.goto('/')
    await navigate(page, 'Catalog', 'Products')
    await expect(page.getByRole('heading', { name: 'Products', level: 1 })).toBeVisible()
    await page.getByLabel('Search').fill(product.modelNumber)
    await expect(row(page, product.modelNumber)).toContainText('$27.50')
    await expectImage(row(page, product.modelNumber).locator('img'), image.id)
    await expect(page.getByRole('link', { name: 'New product' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0)

    await row(page, product.modelNumber).getByRole('link', { name: product.modelNumber }).click()
    await expect(page.getByRole('heading', { name: product.name.en, level: 1 })).toBeVisible()
    await expect(page.getByText('You can view this product but not change it.')).toBeVisible()
    await expect(basics(page).getByLabel('Model number')).toBeDisabled()
    await expect(basics(page).getByLabel('System', { exact: true })).toBeDisabled()
    await expect(basics(page).getByLabel('Category')).toBeDisabled()
    await expect(attributes(page).getByLabel('Power')).toBeDisabled()
    await expect(page.getByRole('button', { name: /Update|Create|Add variant|Delete|Move/ })).toHaveCount(0)
    await expect(variants(page).getByRole('link', { name: 'Add variant' })).toHaveCount(0)

    // One variant: shown on the product page, read-only as well (D449).
    await expect(single(page).getByLabel('Price')).toBeDisabled()
    await expect(single(page).getByLabel('Price')).toHaveValue('27.50')
    await single(page).getByRole('link', { name: 'Name and add-ons' }).click()
    await expect(page.getByRole('heading', { name: 'Standard', level: 1 })).toBeVisible()
    await expect(page.getByText('You can view this variant but not change it.')).toBeVisible()
    await expect(basics(page).getByLabel('Price')).toBeDisabled()
    await expect(basics(page).getByLabel('Price')).toHaveValue('27.50')
    await expect(attributes(page).getByLabel('Finish')).toHaveValue('matt')
    await expectImage(basics(page).getByRole('img', { name: 'Image' }), image.id)
    expect((await page.request.get(`/api/files/${image.id}`)).status()).toBe(200)
    // No picker, no changes to the add-ons.
    await expect(addons(page).getByLabel('Find a variant to add')).toHaveCount(0)
    await expect(linked(page).getByRole('listitem')).toContainText('Frame')
    await expect(linked(page).getByRole('checkbox')).toBeDisabled()
    await expect(page.getByRole('button', { name: /Save add-ons|Replace|Remove|Update/ })).toHaveCount(0)
    await page.getByRole('link', { name: 'Back to product' }).click()
    // Back to the list as it was left, search included.
    await page.getByRole('link', { name: 'Back to list' }).click()
    await expect(page).toHaveURL(new RegExp(`${listPath}\\?search=${product.modelNumber}$`))
    await expect(row(page, product.modelNumber)).toBeVisible()

    for (const path of [`${listPath}/new`, `${listPath}/${product.id}/variants/new`]) {
      await page.goto(path)
      await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible()
    }
  })
}

test('signed out, product and variant pages and images ask for a login', async ({ api, anonymous }) => {
  const image = await api.uploadFile('red.png', 'image/png', readFileSync(asset('red.png')))
  const { product } = await seedProduct(api, ['Standard'])
  const page = await anonymous()
  for (const path of [`${listPath}/${product.id}`, `${listPath}/${product.id}/variants/${product.variants[0].id}`, listPath]) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  }
  expect((await page.request.get(`/api/files/${image.id}`)).status()).toBe(401)
})

test('unknown or invalid product and variant ids show the not-found state', async ({ page, api }) => {
  const { product } = await seedProduct(api, ['Standard'])
  for (const path of [`${listPath}/00000000-0000-0000-0000-000000000000`, `${listPath}/not-an-id`, `${listPath}/not-an-id/variants/also-not`]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Product not found' })).toBeVisible()
    await expect(page.getByText('This product does not exist (anymore).')).toBeVisible()
    await page.getByRole('link', { name: 'Back to list' }).click()
    await expect(page.getByRole('heading', { name: 'Products', level: 1 })).toBeVisible()
  }
  for (const id of ['00000000-0000-0000-0000-000000000000', 'not-an-id']) {
    await page.goto(`${listPath}/${product.id}/variants/${id}`)
    await expect(page.getByRole('heading', { name: 'Variant not found' })).toBeVisible()
    await expect(page.getByText('This variant does not exist (anymore).')).toBeVisible()
    await page.getByRole('link', { name: 'Back to product' }).click()
    await expect(basics(page).getByLabel('Model number')).toHaveValue(product.modelNumber)
  }
})
