import { type Locator, type Page } from '@playwright/test'

import { admin } from '../env'
import { chooseLanguage, chooseOption, expect, navigate, optionTexts, row, test, type Attribute, unique, uniqueKey } from '../fixtures'

// Categories and their attribute schemas (step 1b): the list, the schema
// editor and who may do what. Categories are global and other specs run in
// parallel, so every spec finds its own rows by unique keys and names.

const listPath = '/catalog/categories'

const basics = (page: Page) => page.getByRole('region', { name: 'Basics' })
const attributes = (page: Page) => page.getByRole('region', { name: 'Attributes', exact: true })
const instanceAttributes = (page: Page) => page.getByRole('region', { name: 'Instance attributes' })
/** Attribute card n (1-based) of a schema section. */
const card = (section: Locator, n: number) => section.getByRole('group', { name: `Attribute ${n}`, exact: true })
const option = (attribute: Locator, n: number) => attribute.getByRole('group', { name: `Option ${n}`, exact: true })
/** The attribute's own Key field (its options have one too). */
const keyOf = (attribute: Locator) => attribute.getByLabel('Key', { exact: true }).first()

/** Adds an attribute at the end of a section; the new card opens with its key focused. */
async function addAttribute(section: Locator, n: number, fields: { key: string; en: string; de?: string; type?: string }) {
  await section.getByRole('button', { name: 'Add attribute', exact: true }).click()
  const attribute = card(section, n)
  await expect(keyOf(attribute)).toBeFocused()
  await keyOf(attribute).fill(fields.key)
  await attribute.getByLabel('Label (English)').fill(fields.en)
  if (fields.de) await attribute.getByLabel('Label (German)').fill(fields.de)
  if (fields.type) await chooseOption(attribute.getByLabel('Type', { exact: true }), fields.type)
  return attribute
}

async function addOption(attribute: Locator, n: number, key: string, en: string, de?: string) {
  await attribute.getByRole('button', { name: 'Add option' }).click()
  const o = option(attribute, n)
  await expect(o.getByLabel('Key')).toBeFocused()
  await o.getByLabel('Key').fill(key)
  await o.getByLabel('Label (English)').fill(en)
  if (de) await o.getByLabel('Label (German)').fill(de)
}

/** A simple text attribute for seeding. */
const textAttribute = (key: string, en: string): Attribute => ({ key, label: { en }, type: 'text', scope: 'product' })

test('an admin creates a category with every kind of attribute, reopens and edits it', async ({ page, api }) => {
  const key = uniqueKey('actuator')
  const name = unique('Dimmer actuator')
  await page.goto(listPath)
  await page.getByRole('link', { name: 'New category' }).first().click()
  await expect(page.getByRole('heading', { name: 'New category', level: 1 })).toBeVisible()

  await basics(page).getByLabel('Key').fill(key)
  await basics(page).getByLabel('Name (English)').fill(name)
  await basics(page).getByLabel('Name (German)').fill(`${name} DE`)
  await basics(page).getByLabel('Description (English)').fill('Switches and dims lights.')

  const attrs = attributes(page)
  await expect(attrs.getByText('No attributes yet.')).toBeVisible()
  // Text with length bounds, required.
  let a = await addAttribute(attrs, 1, { key: 'model_name', en: 'Model name', de: 'Modellname' })
  await a.getByLabel('Minimum length').fill('1')
  await a.getByLabel('Maximum length').fill('40')
  await a.getByLabel('Required', { exact: true }).check()
  // Number with range and unit, per variant.
  a = await addAttribute(attrs, 2, { key: 'power', en: 'Power', type: 'Number' })
  await a.getByLabel('Minimum', { exact: true }).fill('0')
  await a.getByLabel('Maximum', { exact: true }).fill('12.5')
  await a.getByLabel('Unit').fill('W')
  await chooseOption(a.getByLabel('Set per'), 'Variant')
  // Whole number.
  a = await addAttribute(attrs, 3, { key: 'width_te', en: 'Width', type: 'Whole number' })
  await a.getByLabel('Minimum', { exact: true }).fill('1')
  await a.getByLabel('Maximum', { exact: true }).fill('12')
  await a.getByLabel('Unit').fill('TE')
  // Yes/no.
  await addAttribute(attrs, 4, { key: 'dimmable', en: 'Dimmable', type: 'Yes/no' })
  await expect(card(attrs, 4).getByLabel('Minimum', { exact: true })).toHaveCount(0)
  // Choice with options, per variant.
  a = await addAttribute(attrs, 5, { key: 'colour', en: 'Colour', type: 'Choice' })
  await chooseOption(a.getByLabel('Set per'), 'Variant')
  await addOption(a, 1, 'white', 'White', 'Weiß')
  await addOption(a, 2, 'black', 'Black')
  // List of choices.
  a = await addAttribute(attrs, 6, { key: 'protocols', en: 'Protocols', type: 'List' })
  await chooseOption(a.getByLabel('Item type'), 'Choice')
  await addOption(a, 1, 'knx', 'KNX')
  await addOption(a, 2, 'zigbee', 'Zigbee')
  // List of texts.
  a = await addAttribute(attrs, 7, { key: 'tags', en: 'Tags', type: 'List' })
  await expect(a.getByLabel('Item type')).toHaveText('Text')
  await a.getByLabel('Maximum items').fill('5')
  await expect(a.getByRole('group', { name: 'Options' })).toHaveCount(0)

  const inst = instanceAttributes(page)
  a = await addAttribute(inst, 1, { key: 'bus_address', en: 'Bus address' })
  await a.getByLabel('Required', { exact: true }).check()
  // Instance attributes have no scope.
  await expect(a.getByLabel('Set per')).toHaveCount(0)
  a = await addAttribute(inst, 2, { key: 'mac', en: 'MAC address' })
  await a.getByLabel('Maximum length').fill('17')

  await page.getByRole('button', { name: 'Create' }).click()
  // A new category continues on its edit page (D84); the list is one click away.
  await expect(page).toHaveURL(/\/catalog\/categories\/[0-9a-f-]{36}$/)
  await expect(page.getByText('Category created.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to list' }).click()
  await expect(page).toHaveURL(/\/catalog\/categories$/)
  const listed = row(page, key)
  await expect(listed).toContainText(name)
  await expect(listed.getByRole('cell').nth(3)).toHaveText('7')
  // Categories have no badge colour (product types do).
  await expect(listed.getByTestId('type-color')).toHaveCount(0)

  // Stored exactly as entered, only what applies to each attribute type.
  const id = (await api.categories()).find((t) => t.key === key)!.id
  const stored = await api.category(id)
  expect(stored).toMatchObject({
    key,
    name: { en: name, de: `${name} DE` },
    description: { en: 'Switches and dims lights.' },
    isActive: true,
    attributes: [
      { key: 'model_name', label: { en: 'Model name', de: 'Modellname' }, type: 'text', required: true, scope: 'product', min: 1, max: 40 },
      { key: 'power', type: 'number', unit: 'W', scope: 'variant', min: 0, max: 12.5 },
      { key: 'width_te', type: 'integer', unit: 'TE', scope: 'product', min: 1, max: 12 },
      { key: 'dimmable', type: 'boolean', scope: 'product' },
      {
        key: 'colour',
        type: 'enum',
        scope: 'variant',
        options: [
          { key: 'white', label: { en: 'White', de: 'Weiß' } },
          { key: 'black', label: { en: 'Black' } },
        ],
      },
      { key: 'protocols', type: 'list', itemType: 'enum', options: [{ key: 'knx' }, { key: 'zigbee' }] },
      { key: 'tags', type: 'list', itemType: 'text', max: 5 },
    ],
    instanceAttributes: [
      { key: 'bus_address', type: 'text', required: true },
      { key: 'mac', type: 'text', max: 17 },
    ],
  })
  expect(stored.attributes[1].required ?? false).toBe(false)
  expect(stored.attributes[3]).not.toHaveProperty('min')
  expect(stored.attributes[6]).not.toHaveProperty('options')

  // Reopened, the cards are collapsed and say what they define.
  await listed.getByRole('link', { name }).click()
  await expect(page.getByRole('heading', { name: 'Edit category', level: 1 })).toBeVisible()
  await expect(basics(page).getByLabel('Key')).toHaveValue(key)
  const summaries = [
    'Model name · Text · Required · Product',
    'Power · Number · W · Variant',
    'Width · Whole number · TE · Product',
    'Dimmable · Yes/no · Product',
    'Colour · Choice · Variant',
    'Protocols · List · Product',
    'Tags · List · Product',
  ]
  for (const [i, summary] of summaries.entries()) {
    await expect(card(attrs, i + 1)).toContainText(summary)
    await expect(card(attrs, i + 1).getByRole('button', { name: `Expand attribute ${i + 1}` })).toHaveAttribute('aria-expanded', 'false')
  }
  await expect(attrs.getByLabel('Key', { exact: true })).toHaveCount(0)
  await expect(card(inst, 1)).toContainText('Bus address · Text · Required')
  await expect(card(inst, 2)).toContainText('MAC address · Text')

  // Edit: open one card, change a bound and the name.
  await card(attrs, 2).getByRole('button', { name: 'Expand attribute 2' }).click()
  await expect(card(attrs, 2).getByLabel('Maximum', { exact: true })).toHaveValue('12.5')
  await card(attrs, 2).getByLabel('Maximum', { exact: true }).fill('15')
  await card(attrs, 2).getByRole('button', { name: 'Collapse attribute 2' }).click()
  const renamed = unique('Switch actuator')
  await basics(page).getByLabel('Name (English)').fill(renamed)
  await expect(page.getByRole('link', { name: 'Cancel' })).toBeVisible()
  await page.getByRole('button', { name: 'Update' }).click()
  // An update stays in the editor, restarted from the saved version.
  await expect(page.getByText('Saved.')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/catalog/categories/${id}$`))
  await expect(basics(page).getByLabel('Name (English)')).toHaveValue(renamed)
  await page.getByRole('link', { name: 'Back to list' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(row(page, key)).toContainText(renamed)
  const updated = await api.category(id)
  expect(updated.attributes[1]).toMatchObject({ key: 'power', min: 0, max: 15 })
  expect(updated.attributes).toHaveLength(7)
})

test('the editor shows each mistake at its field and opens the cards with errors', async ({ page, api }) => {
  const taken = await api.createCategory()
  await page.goto(`${listPath}/new`)
  const attrs = attributes(page)

  await basics(page).getByLabel('Key').fill('Bad Key')
  let a = await addAttribute(attrs, 1, { key: 'label_missing', en: '' })
  await a.getByLabel('Minimum length').fill('5')
  await a.getByLabel('Maximum length').fill('2')
  a = await addAttribute(attrs, 2, { key: 'power', en: 'Power', type: 'Number' })
  // A decimal comma is fine (D71), an exponent is not.
  await a.getByLabel('Minimum', { exact: true }).fill('1e3')
  await addAttribute(attrs, 3, { key: 'colour', en: 'Colour', type: 'Choice' })
  // A duplicate keeps "_copy" in its key until it is changed.
  await card(attrs, 2).getByRole('button', { name: 'Duplicate attribute 2' }).click()
  await expect(keyOf(card(attrs, 3))).toBeFocused()
  await expect(keyOf(card(attrs, 3))).toHaveValue('power_copy')
  await expect(card(attrs, 4)).toContainText('colour')
  await addAttribute(attrs, 5, { key: 'fine', en: 'Fine', type: 'Yes/no' })

  // Collapsed cards with errors open on save; the valid one stays closed.
  await attrs.getByRole('button', { name: 'Collapse all' }).click()
  await expect(attrs.getByLabel('Key', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Create' }).click()

  await expect(basics(page).getByLabel('Key')).toHaveAccessibleDescription('Use lower case letters, digits and underscores, starting with a letter.')
  await expect(basics(page).getByLabel('Key')).toBeFocused()
  await expect(basics(page).getByLabel('Name (English)')).toHaveAccessibleDescription('This field is required.')
  await expect(card(attrs, 1).getByLabel('Label (English)')).toHaveAccessibleDescription('An English label is required.')
  await expect(card(attrs, 1).getByLabel('Maximum length')).toHaveAccessibleDescription('The maximum must not be below the minimum (5).')
  await expect(card(attrs, 2).getByLabel('Minimum', { exact: true })).toHaveAccessibleDescription('Enter a number.')
  await expect(keyOf(card(attrs, 3))).toHaveAccessibleDescription('Change the key of the copied attribute.')
  await expect(card(attrs, 3).getByLabel('Minimum', { exact: true })).toHaveAccessibleDescription('Enter a number.')
  await expect(card(attrs, 4).getByRole('group', { name: 'Options' })).toHaveAccessibleDescription('Add at least one option.')
  for (const n of [1, 2, 3, 4]) {
    await expect(card(attrs, n)).toContainText('Contains errors')
    await expect(card(attrs, n).getByRole('button', { name: `Collapse attribute ${n}` })).toBeVisible()
  }
  await expect(card(attrs, 5).getByRole('button', { name: 'Expand attribute 5' })).toBeVisible()
  await expect(card(attrs, 5)).not.toContainText('Contains errors')
  await expect(page).toHaveURL(/\/new$/)

  // Fixed, except for a key the server knows is taken.
  await basics(page).getByLabel('Key').fill(taken.key)
  await basics(page).getByLabel('Name (English)').fill(unique('Taken'))
  await card(attrs, 1).getByLabel('Label (English)').fill('Label')
  await card(attrs, 1).getByLabel('Maximum length').fill('20')
  await card(attrs, 2).getByLabel('Minimum', { exact: true }).fill('12,5')
  await keyOf(card(attrs, 3)).fill('power_max')
  await card(attrs, 3).getByLabel('Minimum', { exact: true }).fill('')
  await addOption(card(attrs, 4), 1, 'white', 'White')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(basics(page).getByLabel('Key')).toHaveAccessibleDescription(`The key "${taken.key}" is already used.`)
  await expect(page.getByRole('alert').filter({ hasText: `The key "${taken.key}" is already used.` }).first()).toBeVisible()
  await expect(card(attrs, 1)).not.toContainText('Contains errors')

  // A new key: saved.
  const key = uniqueKey('fixed')
  await basics(page).getByLabel('Key').fill(key)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('Category created.')).toBeVisible()
  const created = await api.category((await api.categories()).find((t) => t.key === key)!.id)
  expect(created.attributes).toHaveLength(5)
  expect(created.attributes[1]).toMatchObject({ key: 'power', min: 12.5 })
  await page.getByRole('link', { name: 'Back to list' }).click()
  await expect(row(page, key).getByRole('cell').nth(3)).toHaveText('5')
})

test('long schemas: collapse, expand, move, insert, duplicate and remove with sensible focus', async ({ page, api }) => {
  const category = await api.createCategory({
    attributes: ['a1', 'a2', 'a3', 'a4', 'a5'].map((k) => textAttribute(k, k.toUpperCase())),
  })
  await page.goto(`${listPath}/${category.id}`)
  const attrs = attributes(page)
  const subtitles = async (texts: string[]) => {
    for (const [i, text] of texts.entries()) await expect(card(attrs, i + 1)).toContainText(`${text} · Text`)
  }
  await subtitles(['A1', 'A2', 'A3', 'A4', 'A5'])

  await attrs.getByRole('button', { name: 'Expand all' }).click()
  await expect(attrs.getByRole('button', { name: /^Collapse attribute \d$/ })).toHaveCount(5)
  await expect(attrs.getByLabel('Key', { exact: true })).toHaveCount(5)
  await attrs.getByRole('button', { name: 'Collapse all' }).click()
  await expect(attrs.getByRole('button', { name: /^Expand attribute \d$/ })).toHaveCount(5)

  // To the top: focus stays on the card's controls (its "to the top" is disabled now).
  await card(attrs, 4).getByRole('button', { name: 'Move attribute 4 to the top' }).click()
  await subtitles(['A4', 'A1', 'A2', 'A3', 'A5'])
  await expect(card(attrs, 1).getByRole('button', { name: 'Move attribute 1 down' })).toBeFocused()
  await page.keyboard.press('Enter')
  await subtitles(['A1', 'A4', 'A2', 'A3', 'A5'])
  await expect(card(attrs, 2).getByRole('button', { name: 'Move attribute 2 down' })).toBeFocused()
  await card(attrs, 2).getByRole('button', { name: 'Move attribute 2 to the bottom' }).click()
  await subtitles(['A1', 'A2', 'A3', 'A5', 'A4'])
  await expect(card(attrs, 5).getByRole('button', { name: 'Move attribute 5 up' })).toBeFocused()

  // Insert below: a new open card, its key focused.
  await card(attrs, 1).getByRole('button', { name: 'Insert below attribute 1' }).click()
  await expect(keyOf(card(attrs, 2))).toBeFocused()
  await expect(keyOf(card(attrs, 2))).toHaveValue('')
  await subtitles(['A1'])
  await expect(card(attrs, 3)).toContainText('A2 · Text')

  // Duplicate: a copy right below, "_copy" in its key.
  await card(attrs, 3).getByRole('button', { name: 'Duplicate attribute 3' }).click()
  await expect(keyOf(card(attrs, 4))).toBeFocused()
  await expect(keyOf(card(attrs, 4))).toHaveValue('a2_copy')
  await expect(card(attrs, 4).getByLabel('Label (English)')).toHaveValue('A2')

  // Remove: focus moves to the next card, after the last one to "Add attribute".
  await card(attrs, 4).getByRole('button', { name: 'Remove attribute 4' }).click()
  await expect(attrs.getByRole('group', { name: /^Attribute \d$/ })).toHaveCount(6)
  await expect(card(attrs, 4).getByRole('button', { name: 'Expand attribute 4' })).toBeFocused()
  await expect(card(attrs, 4)).toContainText('A3 · Text')
  await card(attrs, 6).getByRole('button', { name: 'Remove attribute 6' }).click()
  await expect(attrs.getByRole('button', { name: 'Add attribute', exact: true })).toBeFocused()

  // "Add attribute" above the list adds at the top.
  await attrs.getByRole('button', { name: 'Add attribute at the top' }).click()
  await expect(keyOf(card(attrs, 1))).toBeFocused()
  await keyOf(card(attrs, 1)).fill('a0')
  await card(attrs, 1).getByLabel('Label (English)').fill('A0')
  await card(attrs, 3).getByRole('button', { name: 'Remove attribute 3' }).click() // the empty inserted one

  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  expect((await api.category(category.id)).attributes.map((x) => x.key)).toEqual(['a0', 'a1', 'a2', 'a3', 'a5'])
})

test('leaving the editor with unsaved changes asks first', async ({ page, api }) => {
  const category = await api.createCategory()

  // Nothing changed: no question.
  await page.goto(`${listPath}/${category.id}`)
  await expect(basics(page).getByLabel('Key')).toHaveValue(category.key)
  await navigate(page, 'Catalog', 'Function types')
  await expect(page.getByRole('heading', { name: 'Function types', level: 1 })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.goto(`${listPath}/${category.id}`)
  await basics(page).getByLabel('Name (English)').fill('Unsaved name')
  await navigate(page, 'Catalog', 'Function types')
  const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Stay' }).click()
  await expect(confirm).toBeHidden()
  await expect(page).toHaveURL(new RegExp(`/catalog/categories/${category.id}$`))
  await expect(basics(page).getByLabel('Name (English)')).toHaveValue('Unsaved name')

  await page.getByRole('link', { name: 'Cancel' }).click()
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Leave page' }).click()
  await expect(page).toHaveURL(/\/catalog\/categories$/)
  await expect(row(page, category.key)).toContainText(category.name.en)
  expect((await api.category(category.id)).name.en).toBe(category.name.en)

  // Back in the editor: the stored version, and leaving it asks nothing.
  await row(page, category.key).getByRole('link', { name: category.name.en }).click()
  await expect(basics(page).getByLabel('Name (English)')).toHaveValue(category.name.en)
  await expect(page.getByRole('link', { name: 'Cancel' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Back to list' }).click()
  await expect(page).toHaveURL(/\/catalog\/categories$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('a save over a newer version is refused, and Reload shows that version', async ({ page, api, sessionFor }) => {
  const category = await api.createCategory({ attributes: [textAttribute('a1', 'A1')] })
  const other = await sessionFor(admin)
  for (const p of [page, other]) {
    await p.goto(`${listPath}/${category.id}`)
    await expect(basics(p).getByLabel('Key')).toHaveValue(category.key)
  }

  const first = unique('First')
  await basics(page).getByLabel('Name (English)').fill(first)
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()

  await basics(other).getByLabel('Name (English)').fill(unique('Second'))
  await other.getByRole('button', { name: 'Update' }).click()
  const stale = other.getByRole('alert').filter({ hasText: 'Someone else changed this category in the meantime.' })
  await expect(stale).toBeVisible()
  await expect(other).toHaveURL(new RegExp(`/catalog/categories/${category.id}$`))
  await stale.getByRole('button', { name: 'Reload' }).click()
  await expect(basics(other).getByLabel('Name (English)')).toHaveValue(first)
  await expect(stale).toHaveCount(0)
  expect((await api.category(category.id)).name.en).toBe(first)

  // The reloaded version saves.
  await basics(other).getByLabel('Description (English)').fill('Second try')
  await other.getByRole('button', { name: 'Update' }).click()
  await expect(other.getByText('Saved.')).toBeVisible()
  expect(await api.category(category.id)).toMatchObject({ name: { en: first }, description: { en: 'Second try' } })
})

test('reorder, deactivate and delete on the list', async ({ page, api }) => {
  const a = await api.createCategory({ name: { en: unique('Alpha') } })
  const b = await api.createCategory({ name: { en: unique('Bravo') }, isActive: false })
  const c = await api.createCategory({ name: { en: unique('Charlie') } })
  await api.moveCategoriesToTop([a.id, b.id, c.id])
  const position = (key: string) => row(page, key).getByRole('cell').first()

  await page.goto(listPath)
  await expect(page.getByLabel('Show inactive')).not.toBeChecked()
  await expect(row(page, b.key)).toHaveCount(0)
  await expect(position(a.key)).toHaveText('1')
  await expect(position(c.key)).toHaveText('2')
  await expect(page.getByRole('button', { name: `Move ${a.name.en} up` })).toBeDisabled()

  // Charlie passes Alpha, its visible neighbour; the hidden Bravo stays after Alpha.
  await page.getByRole('button', { name: `Move ${c.name.en} up` }).click()
  await expect(position(c.key)).toHaveText('1')
  await expect(position(a.key)).toHaveText('2')
  expect((await api.categories()).slice(0, 3).map((t) => t.key)).toEqual([c.key, a.key, b.key])

  await page.getByLabel('Show inactive').check()
  await expect(row(page, b.key)).toContainText('Inactive')
  await expect(position(b.key)).toHaveText('3')
  await page.getByRole('button', { name: `Move ${b.name.en} up` }).click()
  await expect(position(b.key)).toHaveText('2')
  await expect(position(a.key)).toHaveText('3')
  await page.getByRole('button', { name: `Move ${a.name.en} down` }).click()
  await expect(position(a.key)).toHaveText('4')
  expect((await api.categories()).slice(0, 2).map((t) => t.key)).toEqual([c.key, b.key])
  await page.getByLabel('Show inactive').uncheck()

  // Deactivate in the editor: hidden unless inactive categories are shown.
  await row(page, c.key).getByRole('link', { name: 'Edit' }).click()
  await page.getByLabel('Active', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to list' }).click()
  await expect(page).toHaveURL(/\/catalog\/categories$/)
  await expect(row(page, a.key)).toBeVisible()
  await expect(row(page, c.key)).toHaveCount(0)
  await page.getByLabel('Show inactive').check()
  await expect(row(page, c.key)).toContainText('Inactive')

  await row(page, c.key).getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete category' })
  await expect(confirm).toContainText(`Delete "${c.name.en}"?`)
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toBeHidden()
  await expect(row(page, c.key)).toHaveCount(0)
  await expect(row(page, b.key)).toBeVisible()
  expect((await api.categories()).map((t) => t.id)).not.toContain(c.id)
})

for (const role of ['user', 'tenant_admin'] as const) {
  test(`a ${role} sees categories read-only`, async ({ api, sessionFor }) => {
    const category = await api.createCategory({
      attributes: [
        textAttribute('model', 'Model'),
        { key: 'colour', label: { en: 'Colour' }, type: 'enum', scope: 'variant', options: [{ key: 'white', label: { en: 'White' } }] },
      ],
      instanceAttributes: [{ key: 'address', label: { en: 'Address' }, type: 'text' }],
    })
    const tenant = role === 'tenant_admin' ? await api.createTenant() : undefined
    const account = await api.createUser({ role, tenantId: tenant?.id })
    const page = await sessionFor(account)

    await page.goto('/')
    await navigate(page, 'Catalog', 'Categories')
    await expect(page.getByRole('heading', { name: 'Categories', level: 1 })).toBeVisible()
    await expect(row(page, category.key)).toContainText(category.name.en)
    await expect(page.getByRole('link', { name: 'New category' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Edit' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Move .* up$/ })).toHaveCount(0)

    await row(page, category.key).getByRole('link', { name: category.name.en }).click()
    await expect(page.getByRole('heading', { name: category.name.en, level: 1 })).toBeVisible()
    await expect(page.getByText('You can view this category but not change it.')).toBeVisible()
    await expect(basics(page).getByLabel('Key')).toHaveValue(category.key)
    await expect(basics(page).getByLabel('Key')).toBeDisabled()
    // Every card open, nothing to change.
    const attrs = attributes(page)
    await expect(keyOf(card(attrs, 2))).toHaveValue('colour')
    await expect(keyOf(card(attrs, 2))).toBeDisabled()
    await expect(option(card(attrs, 2), 1).getByLabel('Key')).toHaveValue('white')
    await expect(keyOf(card(instanceAttributes(page), 1))).toHaveValue('address')
    await expect(page.getByRole('button', { name: /Expand|Collapse|Add attribute|Add option|Remove|Update|Create/ })).toHaveCount(0)
    await page.getByRole('link', { name: 'Back to list' }).click()
    await expect(page).toHaveURL(/\/catalog\/categories$/)

    await page.goto(`${listPath}/new`)
    await expect(page.getByRole('heading', { name: 'No access' })).toBeVisible()
  })
}

test('signed out, the editor asks for a login', async ({ api, anonymous }) => {
  const category = await api.createCategory()
  const page = await anonymous()
  await page.goto(`${listPath}/${category.id}`)
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('an unknown or invalid id shows the not-found state', async ({ page }) => {
  for (const id of ['00000000-0000-0000-0000-000000000000', 'not-an-id']) {
    await page.goto(`${listPath}/${id}`)
    await expect(page.getByRole('heading', { name: 'Category not found' })).toBeVisible()
    await expect(page.getByText('This category does not exist (anymore).')).toBeVisible()
    await page.getByRole('link', { name: 'Back to list' }).click()
    await expect(page.getByRole('heading', { name: 'Categories', level: 1 })).toBeVisible()
  }
})

test('the editor in German', async ({ page, api }) => {
  const category = await api.createCategory({
    name: { en: unique('Sensor'), de: unique('Sensor DE') },
    attributes: [{ key: 'range', label: { en: 'Range', de: 'Reichweite' }, type: 'integer', unit: 'm', scope: 'variant', required: true }],
  })
  await page.goto(`${listPath}/${category.id}`)
  await expect(basics(page).getByLabel('Key')).toHaveValue(category.key)
  await chooseLanguage(page, 'Deutsch')

  await expect(page.getByRole('heading', { name: 'Kategorie bearbeiten', level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Grunddaten' }).getByLabel('Schlüssel')).toHaveValue(category.key)
  const attrs = page.getByRole('region', { name: 'Attribute', exact: true })
  const first = attrs.getByRole('group', { name: 'Attribut 1', exact: true })
  await expect(first).toContainText('Reichweite · Ganzzahl · m · Pflichtfeld · Variante')
  await expect(attrs.getByRole('button', { name: 'Alle aufklappen' })).toBeVisible()
  await first.getByRole('button', { name: 'Attribut 1 aufklappen' }).click()
  expect(await optionTexts(first.getByLabel('Typ', { exact: true }))).toEqual(['Text', 'Zahl', 'Ganzzahl', 'Ja/Nein', 'Auswahl', 'Liste'])
  await expect(first.getByRole('button', { name: 'Attribut 1 ganz nach unten verschieben' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Aktualisieren' })).toBeVisible()
  // Nothing changed: the way out is "Back to list" (D84).
  await expect(page.getByRole('link', { name: 'Zurück zur Liste' })).toBeVisible()

  await page.getByRole('link', { name: 'Zurück zur Liste' }).click()
  await expect(page.getByRole('heading', { name: 'Kategorien', level: 1 })).toBeVisible()
  await expect(row(page, category.key)).toContainText(category.name.de!)
  await expect(page.getByRole('columnheader')).toContainText(['Position', 'Name', 'Schlüssel', 'Attribute', 'Status'])
})
