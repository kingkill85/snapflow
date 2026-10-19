import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { getGetCategoryQueryKey } from '@/api/generated/categories/categories'
import type { CatalogField, Category, CategoryUpdate } from '@/api/generated/model'
import { routes as appRoutes } from '@/app/routes'
import { adminMe, userMe } from '@/test/fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'
import { shownTranslation, translation } from '@/test/translatable'
import { chooseOption } from '@/test/select'

import { CategoryEditorPage } from './CategoryEditorPage'

const problem = (status: number, body: object) =>
  HttpResponse.json({ status, ...body }, { status, headers: { 'Content-Type': 'application/problem+json' } })

const routes = [
  { path: '/catalog/categories', element: <p>list page</p> },
  { path: '/catalog/categories/new', element: <CategoryEditorPage /> },
  { path: '/catalog/categories/:id', element: <CategoryEditorPage /> },
]

const existing: Category = {
  id: '6f1c2b8e-0000-4000-8000-000000000001',
  key: 'dimmer_actuator',
  mounting: 'board',
  name: { en: 'Dimmer actuator', de: 'Dimmaktor' },
  description: { en: 'DIN rail dimmer' },
  sortOrder: 1,
  isActive: true,
  attributes: [
    {
      key: 'width_te',
      label: { en: 'Width', de: 'Breite' },
      type: 'integer',
      required: true,
      unit: 'TE',
      min: 1,
      max: 12,
      scope: 'product',
      fieldKey: 'width_te',
    },
    {
      key: 'colour',
      label: { en: 'Colour' },
      type: 'enum',
      scope: 'variant',
      options: [
        { key: 'white', label: { en: 'White', de: 'Weiß' } },
        { key: 'black', label: { en: 'Black' } },
      ],
    },
    { key: 'protocols', label: { en: 'Protocols' }, type: 'list', itemType: 'text', max: 4, scope: 'product' },
  ],
  instanceAttributes: [{ key: 'bus_address', label: { en: 'Bus address' }, type: 'text', required: true }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  can: { update: true, delete: true },
}
const editRoute = `/catalog/categories/${existing.id}`

const catalogField = (over: Partial<CatalogField>): CatalogField => ({
  id: '6f1c2b8e-0000-4000-8000-0000000000f1',
  key: 'width_te',
  label: { en: 'Width' },
  type: 'integer',
  unit: 'TE',
  meaning: 'rail_width_te',
  options: [],
  productTypeIds: [],
  sortOrder: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  can: { update: true, delete: true },
  inUse: 0,
  usedBy: [],
  ...over,
})
const catalogFields = [
  catalogField({}),
  catalogField({ id: '6f1c2b8e-0000-4000-8000-0000000000f2', key: 'bus_current_ma', label: { en: 'Bus current' }, type: 'number', unit: 'mA', meaning: 'bus_current_used_ma' }),
  catalogField({ id: '6f1c2b8e-0000-4000-8000-0000000000f3', key: 'notes', label: { en: 'Notes' }, type: 'text', unit: undefined, meaning: undefined }),
]
const fieldsHandler = () => http.get('/api/catalog-fields', () => HttpResponse.json({ items: catalogFields }))

/** A group by name; an attribute card is named by its position and label, e.g. "Attribute 2: Colour". */
const group = (name: string, container: HTMLElement = document.body) =>
  within(container).getByRole('group', { name: (n) => n === name || n.startsWith(`${name}: `) })
/** The attribute row's own field (option rows inside repeat the labels). */
const own = (row: HTMLElement, label: string) => within(row).getAllByLabelText(label)[0]
const region = (name: string) => screen.getByRole('region', { name })
const attributesRegion = () => region('Attributes')
const instanceRegion = () => region('Instance attributes')

type User = ReturnType<typeof userEvent.setup>
/** Chooses an entry of an attribute card's "⋯" menu (move to top or bottom, insert below, duplicate, remove). */
async function cardAction(u: User, card: HTMLElement, action: string) {
  await u.click(within(card).getByRole('button', { name: /^More actions for attribute \d+$/ }))
  await u.click(await screen.findByRole('menuitem', { name: action }))
}
/** Rows of an existing type start collapsed. */
const expandAll = (u: User, section: HTMLElement) => u.click(within(section).getByRole('button', { name: 'Expand all' }))

/** GET returns `item`, PUT records the body (and answers with `respond`, if given). */
function editHandlers(item: () => Category = () => existing, respond?: () => Response) {
  const puts: CategoryUpdate[] = []
  const gets: number[] = []
  server.use(
    fieldsHandler(),
    http.get('/api/categories/:id', () => {
      gets.push(Date.now())
      return HttpResponse.json(item())
    }),
    http.put('/api/categories/:id', async ({ request }) => {
      puts.push((await request.json()) as CategoryUpdate)
      return respond ? respond() : HttpResponse.json(item())
    }),
  )
  return { puts, gets }
}

async function openEditor(item?: () => Category, respond?: () => Response) {
  const calls = editHandlers(item, respond)
  renderRoutes(routes, { me: adminMe, route: editRoute })
  await screen.findByRole('heading', { name: 'Edit category' })
  return calls
}

describe('CategoryEditorPage', () => {
  it('creates a category with an enum attribute, sending exactly what applies', async () => {
    let posted: unknown
    const created: Category = { ...existing, id: '6f1c2b8e-0000-4000-8000-000000000099', key: 'gateway', name: { en: 'Gateway', de: 'Gateway' } }
    server.use(
      fieldsHandler(),
      http.post('/api/categories', async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json(created, { status: 201 })
      }),
      http.get('/api/categories/:id', () => HttpResponse.json(created)),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/categories/new' })

    expect(await screen.findByRole('heading', { name: 'New category' })).toBeInTheDocument()
    await u.type(screen.getByLabelText('Key'), 'gateway')
    await u.type((await translation(u, document.body, 'Name', 'en')), 'Gateway')
    await u.type((await translation(u, document.body, 'Name', 'de')), 'Gateway')

    const attributes = attributesRegion()
    await u.click(within(attributes).getByRole('button', { name: 'Add attribute' }))
    const row = group('Attribute 1', attributes)
    await u.type(own(row, 'Key'), 'bus_system')
    await u.type((await translation(u, row, 'Label', 'en')), 'Bus system')
    // Bounds of a text attribute are lengths; an enum has none.
    expect(within(row).getByLabelText('Maximum length')).toBeInTheDocument()
    await u.type(within(row).getByLabelText('Maximum length'), '20')
    await chooseOption(u, within(row).getByLabelText('Type'), 'Choice')
    expect(within(row).queryByLabelText('Maximum length')).not.toBeInTheDocument()
    await chooseOption(u, within(row).getByLabelText('Set per'), 'Variant')
    await u.click(within(row).getByLabelText('Required'))
    await u.type(within(row).getByLabelText('Unit'), ' ')

    await u.click(within(row).getByRole('button', { name: 'Add option' }))
    await u.click(within(row).getByRole('button', { name: 'Add option' }))
    await u.type(within(group('Option 1', row)).getByLabelText('Key'), 'zigbee')
    await u.type((await translation(u, group('Option 1', row), 'Label', 'en')), 'Zigbee')
    await u.type(within(group('Option 2', row)).getByLabelText('Key'), 'knx')
    await u.type((await translation(u, group('Option 2', row), 'Label', 'en')), 'KNX')
    await u.type((await translation(u, group('Option 2', row), 'Label', 'de')), 'KNX')
    // Move KNX first.
    await u.click(within(group('Option 2', row)).getByRole('button', { name: 'Move option 2 up' }))

    await u.click(screen.getByRole('button', { name: 'Create' }))

    // The new category continues on its edit page (D84).
    expect(await screen.findByText('Category created.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Edit category' })).toBeInTheDocument()
    expect(screen.getByLabelText('Key')).toHaveValue('gateway')
    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/catalog/categories')
    expect(posted).toEqual({
      key: 'gateway',
      name: { en: 'Gateway', de: 'Gateway' },
      isActive: true,
      mounting: 'floorplan',
      attributes: [
        {
          key: 'bus_system',
          label: { en: 'Bus system' },
          type: 'enum',
          required: true,
          scope: 'variant',
          options: [
            { key: 'knx', label: { en: 'KNX', de: 'KNX' } },
            { key: 'zigbee', label: { en: 'Zigbee' } },
          ],
        },
      ],
      instanceAttributes: [],
    })
  })

  it('links an attribute to a catalog field: type, unit and options follow it, its meaning is shown', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()
    expect(within(region('Basics')).getByLabelText('Mounting')).toHaveTextContent('Distribution board')
    await chooseOption(u, within(region('Basics')).getByLabelText('Mounting'), 'Floorplan and board')

    const attributes = attributesRegion()
    const adds = within(attributes).getAllByRole('button', { name: 'Add attribute' })
    await u.click(adds[adds.length - 1])
    const row = group('Attribute 4', attributes)
    await u.type(own(row, 'Key'), 'bus_ma')
    await u.type(await translation(u, row, 'Label', 'en'), 'Bus current')
    await chooseOption(u, within(row).getByLabelText('Catalog field'), 'Bus current (bus_current_ma)')
    expect(within(row).getByLabelText('Type')).toHaveTextContent('Number')
    expect(within(row).getByLabelText('Unit')).toHaveValue('mA')
    expect(within(row).getByLabelText('Unit')).toHaveAttribute('readonly')
    expect(within(row).getByTestId('linked-meaning')).toHaveTextContent('Bus current used (mA)')

    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].mounting).toBe('both')
    expect(puts[0].attributes[3]).toEqual({
      key: 'bus_ma',
      label: { en: 'Bus current' },
      type: 'number',
      unit: 'mA',
      required: false,
      scope: 'product',
      fieldKey: 'bus_current_ma',
    })
  })

  it('unlinking a catalog field keeps the values the field gave and unlocks them (D295)', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()
    const attributes = attributesRegion()
    const adds = within(attributes).getAllByRole('button', { name: 'Add attribute' })
    await u.click(adds[adds.length - 1])
    const row = group('Attribute 4', attributes)
    await u.type(own(row, 'Key'), 'bus_ma')
    await u.type(await translation(u, row, 'Label', 'en'), 'Bus current')
    await chooseOption(u, within(row).getByLabelText('Catalog field'), 'Bus current (bus_current_ma)')
    expect(within(row).getByLabelText('Unit')).toHaveAttribute('readonly')

    await chooseOption(u, within(row).getByLabelText('Catalog field'), 'No link')
    expect(within(row).queryByTestId('linked-meaning')).not.toBeInTheDocument()
    expect(within(row).getByLabelText('Type')).toHaveTextContent('Number')
    expect(within(row).getByLabelText('Unit')).toHaveValue('mA')
    expect(within(row).getByLabelText('Unit')).not.toHaveAttribute('readonly')

    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].attributes[3]).toEqual({
      key: 'bus_ma',
      label: { en: 'Bus current' },
      type: 'number',
      unit: 'mA',
      required: false,
      scope: 'product',
    })
  })

  it('loads an existing schema collapsed, and saves it unchanged with the version it was loaded from', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    const basics = region('Basics')
    expect(within(basics).getByLabelText('Key')).toHaveValue('dimmer_actuator')
    expect(await translation(u, basics, 'Name', 'de')).toHaveValue('Dimmaktor')
    expect(await translation(u, basics, 'Description', 'en')).toHaveValue('DIN rail dimmer')

    // Collapsed rows summarise what they define.
    const attributes = attributesRegion()
    const width = group('Attribute 1', attributes)
    // Titled by the label, with key, type, unit, required and scope beside it (D114).
    expect(screen.getByRole('group', { name: 'Attribute 1: Width' })).toBe(width)
    expect(width).toHaveTextContent('width_te · Whole number · TE · field width_te · Required · Product')
    expect(within(width).queryByLabelText('Key')).not.toBeInTheDocument()
    expect(group('Attribute 2', attributes)).toHaveTextContent('Colourcolour · Choice · Variant')
    expect(group('Attribute 1', instanceRegion())).toHaveTextContent('Bus addressbus_address · Text · Required')

    await expandAll(u, attributes)
    expect(own(width, 'Key')).toHaveValue('width_te')
    expect(within(width).getByLabelText('Type')).toHaveTextContent('Whole number')
    expect(within(width).getByLabelText('Minimum')).toHaveValue('1')
    expect(within(width).getByLabelText('Maximum')).toHaveValue('12')
    expect(within(width).getByLabelText('Unit')).toHaveValue('TE')
    expect(within(width).getByLabelText('Required')).toBeChecked()
    const colour = group('Attribute 2', attributes)
    expect(within(colour).getByLabelText('Set per')).toHaveTextContent('Variant')
    expect(await translation(u, group('Option 1', colour), 'Label', 'de')).toHaveValue('Weiß')
    const protocols = group('Attribute 3', attributes)
    expect(within(protocols).getByLabelText('Item type')).toHaveTextContent('Text')
    expect(within(protocols).getByLabelText('Maximum items')).toHaveValue('4')

    const instance = instanceRegion()
    await expandAll(u, instance)
    const busAddress = group('Attribute 1', instance)
    expect(own(busAddress, 'Key')).toHaveValue('bus_address')
    expect(within(busAddress).queryByLabelText('Set per')).not.toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Update' }))

    // An update stays in the editor (D84).
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(screen.queryByText('list page')).not.toBeInTheDocument()
    expect(puts).toEqual([
      {
        key: existing.key,
        name: existing.name,
        description: existing.description,
        isActive: true,
        // The stored mounting and field link are sent back (D294).
        mounting: 'board',
        attributes: [
          { ...existing.attributes[0] },
          { ...existing.attributes[1], required: false },
          { ...existing.attributes[2], required: false },
        ],
        instanceAttributes: [{ key: 'bus_address', label: { en: 'Bus address' }, type: 'text', required: true }],
        expectedUpdatedAt: existing.updatedAt,
      },
    ])
    // Instance attributes have no scope.
    expect(puts[0].instanceAttributes[0]).not.toHaveProperty('scope')
  })

  it('shows server field errors at the row and option they belong to, opens those rows and focuses the first', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () =>
      problem(422, {
        code: 'validation.failed',
        fields: [
          { location: 'body.attributes[1].options[1].key', code: 'attribute.option_key_duplicate' },
          { location: 'body.attributes[2].max', code: 'attribute.count_max', params: { max: 3 } },
          { location: 'body.instanceAttributes[0].key', code: 'attribute.key_duplicate' },
        ],
      }),
    )

    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Please check the highlighted fields.')
    const attributes = attributesRegion()
    // Rows with errors open and say so in their header; the others stay closed.
    expect(within(group('Attribute 1', attributes)).queryByLabelText('Key')).not.toBeInTheDocument()
    expect(within(group('Attribute 1', attributes)).queryByText('Contains errors')).not.toBeInTheDocument()
    expect(within(group('Attribute 2', attributes)).getAllByText('Contains errors')).toHaveLength(2) // the row and its option
    const black = group('Option 2', group('Attribute 2', attributes))
    expect(within(black).getByLabelText('Key')).toHaveAccessibleDescription('This option key is used twice.')
    expect(within(black).getByLabelText('Key')).toHaveFocus()
    expect(within(group('Option 1', group('Attribute 2', attributes))).getByLabelText('Key')).not.toHaveAccessibleDescription()
    // With its params.
    expect(within(group('Attribute 3', attributes)).getByLabelText('Maximum items')).toHaveAccessibleDescription(
      'Number of items: at most 3.',
    )
    expect(own(group('Attribute 1', instanceRegion()), 'Key')).toHaveAccessibleDescription('This key is used twice.')
    expect(screen.queryByText('list page')).not.toBeInTheDocument()
  })

  it('keeps a server error with its row when an earlier row is removed', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () =>
      problem(422, {
        code: 'validation.failed',
        fields: [{ location: 'body.attributes[2].max', code: 'attribute.range_invalid', params: { min: 5 } }],
      }),
    )
    await u.click(screen.getByRole('button', { name: 'Update' }))
    const attributes = attributesRegion()
    expect(await within(group('Attribute 3', attributes)).findByLabelText('Maximum items')).toHaveAccessibleDescription(
      'The maximum must not be below the minimum (5).',
    )

    await cardAction(u, group('Attribute 2', attributes), 'Remove')

    const protocols = group('Attribute 2', attributes)
    expect(own(protocols, 'Key')).toHaveValue('protocols')
    expect(within(protocols).getByLabelText('Maximum items')).toHaveAccessibleDescription('The maximum must not be below the minimum (5).')
    expect(within(protocols).getByText('Contains errors')).toBeInTheDocument()
  })

  it('spells out errors without a visible field instead of pointing at highlighted fields', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () =>
      problem(422, {
        code: 'validation.failed',
        // Instance attributes have no scope field, and there is no fourth attribute.
        fields: [
          { location: 'body.instanceAttributes[0].scope', code: 'validation.invalid' },
          { location: 'body.attributes[3].key', code: 'attribute.key_format' },
        ],
      }),
    )
    await u.click(screen.getByRole('button', { name: 'Update' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This value is invalid. Use lower case letters, digits and underscores, starting with a letter.')
    expect(alert).not.toHaveTextContent('highlighted')
  })

  it('shows too many attributes next to the section', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () =>
      problem(422, { code: 'validation.failed', fields: [{ location: 'body.attributes', code: 'validation.too_many', params: { max: 200 } }] }),
    )
    await u.click(screen.getByRole('button', { name: 'Update' }))

    const message = await within(attributesRegion()).findByText('There are too many entries (at most 200).')
    expect(message).toHaveRole('alert')
    expect(message).toHaveFocus()
    expect(screen.getByText('Please check the highlighted fields.')).toBeInTheDocument()
  })

  it('shows "add at least one option" under the options, linked to the options group', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () =>
      problem(422, { code: 'validation.failed', fields: [{ location: 'body.attributes[1].options', code: 'attribute.options_required' }] }),
    )
    await u.click(screen.getByRole('button', { name: 'Update' }))

    const options = await within(group('Attribute 2', attributesRegion())).findByRole('group', { name: 'Options' })
    expect(options).toHaveAccessibleDescription('Add at least one option.')
    expect(within(options).getByRole('alert')).toHaveTextContent('Add at least one option.')
  })

  it('shows a taken key at the Key field', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () => problem(409, { code: 'category.key_taken', params: { key: 'dimmer_actuator' } }))

    await u.click(screen.getByRole('button', { name: 'Update' }))

    const key = within(region('Basics')).getByLabelText('Key')
    await waitFor(() => expect(key).toHaveAccessibleDescription('The key "dimmer_actuator" is already used.'))
    expect(key).toHaveFocus()
  })

  it('checks the obvious rules before saving, with the limits in the messages', async () => {
    let called = false
    server.use(
      http.post('/api/categories', () => {
        called = true
        return HttpResponse.json(existing, { status: 201 })
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: '/catalog/categories/new' })

    await u.type(await screen.findByLabelText('Key'), 'Bad Key')
    await u.type((await translation(u, document.body, 'Name', 'de')), 'x'.repeat(101))
    const attributes = attributesRegion()
    await u.click(within(attributes).getByRole('button', { name: 'Add attribute' }))
    const row = group('Attribute 1', attributes)
    await u.type(own(row, 'Key'), 'width')
    await chooseOption(u, within(row).getByLabelText('Type'), 'Number')
    await u.type(within(row).getByLabelText('Minimum'), '10')
    await u.type(within(row).getByLabelText('Maximum'), '2')
    await u.type(within(row).getByLabelText('Unit'), 'x'.repeat(17))
    await u.click(within(attributes).getByRole('button', { name: 'Add attribute' }))
    const choice = group('Attribute 2', attributes)
    await u.type(own(choice, 'Key'), 'width')
    await chooseOption(u, within(choice).getByLabelText('Type'), 'Choice')

    await u.click(screen.getByRole('button', { name: 'Create' }))

    const key = within(region('Basics')).getByLabelText('Key')
    expect(key).toHaveAccessibleDescription('Use lower case letters, digits and underscores, starting with a letter.')
    expect(key).toHaveFocus()
    expect(await translation(u, document.body, 'Name', 'en')).toHaveAccessibleDescription('This field is required.')
    expect(await translation(u, document.body, 'Name', 'de')).toHaveAccessibleDescription('This value is too long (at most 100 characters).')
    expect(await translation(u, row, 'Label', 'en')).toHaveAccessibleDescription('An English label is required.')
    expect(within(row).getByLabelText('Maximum')).toHaveAccessibleDescription('The maximum must not be below the minimum (10).')
    expect(within(row).getByLabelText('Unit')).toHaveAccessibleDescription('This value is too long (at most 16 characters).')
    expect(own(choice, 'Key')).toHaveAccessibleDescription('This key is used twice.')
    expect(within(choice).getByRole('group', { name: 'Options' })).toHaveAccessibleDescription('Add at least one option.')
    expect(called).toBe(false)
  })

  it('checks bounds as typed: numbers, whole numbers, no negative lengths', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()
    const attributes = attributesRegion()
    await expandAll(u, attributes)

    const width = group('Attribute 1', attributes)
    await u.clear(within(width).getByLabelText('Minimum'))
    await u.type(within(width).getByLabelText('Minimum'), 'abc')
    await u.clear(within(width).getByLabelText('Maximum'))
    await u.type(within(width).getByLabelText('Maximum'), '2.5')
    const protocols = group('Attribute 3', attributes)
    await u.type(within(protocols).getByLabelText('Minimum items'), '-1')
    await u.clear(within(protocols).getByLabelText('Maximum items'))
    await u.type(within(protocols).getByLabelText('Maximum items'), '9007199254740992')

    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(within(width).getByLabelText('Minimum')).toHaveAccessibleDescription('Enter a number.')
    expect(within(width).getByLabelText('Minimum')).toHaveFocus()
    expect(within(width).getByLabelText('Maximum')).toHaveAccessibleDescription('This limit must be a whole number.')
    expect(within(protocols).getByLabelText('Minimum items')).toHaveAccessibleDescription('Lengths and item counts cannot be negative.')
    expect(within(protocols).getByLabelText('Maximum items')).toHaveAccessibleDescription(
      'This limit must be between 0 and 9,007,199,254,740,991.',
    )
    expect(puts).toHaveLength(0)
  })

  it('takes bounds with a decimal comma and refuses hex and exponent forms', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor(() => ({
      ...existing,
      attributes: [{ key: 'power', label: { en: 'Power' }, type: 'number', scope: 'product' }],
    }))
    const attributes = attributesRegion()
    await expandAll(u, attributes)
    const power = group('Attribute 1', attributes)

    await u.type(within(power).getByLabelText('Minimum'), '0x10')
    await u.type(within(power).getByLabelText('Maximum'), '1e3')
    await u.click(screen.getByRole('button', { name: 'Update' }))
    expect(within(power).getByLabelText('Minimum')).toHaveAccessibleDescription('Enter a number.')
    expect(within(power).getByLabelText('Maximum')).toHaveAccessibleDescription('Enter a number.')
    expect(puts).toHaveLength(0)

    await u.clear(within(power).getByLabelText('Minimum'))
    await u.type(within(power).getByLabelText('Minimum'), '2,5')
    await u.clear(within(power).getByLabelText('Maximum'))
    await u.type(within(power).getByLabelText('Maximum'), '10.5')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].attributes[0]).toMatchObject({ min: 2.5, max: 10.5 })
  })

  it('requires the English text when only a German description is given', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()
    await u.clear(await translation(u, region('Basics'), 'Description', 'en'))
    await u.type((await translation(u, region('Basics'), 'Description', 'de')), 'Dimmer für die Hutschiene')
    const attributes = attributesRegion()
    await expandAll(u, attributes)
    const width = group('Attribute 1', attributes)
    await u.type((await translation(u, width, 'Description', 'de')), 'Breite in TE')

    await u.click(screen.getByRole('button', { name: 'Update' }))

    // The English tabs open by themselves (the German ones were shown), and the first one is focused.
    const basics = shownTranslation(region('Basics'), 'Description')
    expect(basics.language).toBe('English')
    expect(basics.input).toHaveAttribute('lang', 'en')
    expect(basics.input).toHaveAccessibleDescription('This field is required.')
    expect(basics.input).toHaveFocus()
    const own = shownTranslation(width, 'Description')
    expect(own.language).toBe('English')
    expect(own.input).toHaveAccessibleDescription('This field is required.')
    expect(puts).toHaveLength(0)
  })

  it('shows a server error of an option label translation on its tab in a collapsed card, also after a second save', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () =>
      problem(422, {
        code: 'validation.failed',
        fields: [{ location: 'body.attributes[1].options[0].label.de', code: 'validation.control_chars' }],
      }),
    )
    const attributes = attributesRegion()
    expect(within(group('Attribute 2', attributes)).queryByLabelText('Key')).not.toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Update' }))

    // The card opens, the German tab of the option's label opens and its input is focused.
    const white = group('Option 1', group('Attribute 2', attributes))
    await waitFor(() => expect(shownTranslation(white, 'Label').language).toBe('German'))
    const label = shownTranslation(white, 'Label').input
    expect(label).toHaveValue('Weiß')
    expect(label).toHaveAccessibleDescription(/control characters/i)
    expect(label).toHaveFocus()
    expect(within(white).getByRole('tab', { name: 'German' })).toHaveAccessibleDescription('Has an error')

    // Looking at the English text and saving again: back to the German error.
    await u.click(within(white).getByRole('tab', { name: 'English' }))
    expect(shownTranslation(white, 'Label').language).toBe('English')
    await u.click(screen.getByRole('button', { name: 'Update' }))
    const option = () => group('Option 1', group('Attribute 2', attributesRegion()))
    await waitFor(() => expect(shownTranslation(option(), 'Label').language).toBe('German'))
    expect(shownTranslation(option(), 'Label').input).toHaveFocus()
  })

  it('sends only what applies after an attribute type change', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()
    const attributes = attributesRegion()
    await expandAll(u, attributes)

    // A linked attribute's type is locked until the link is removed.
    expect(within(group('Attribute 1', attributes)).getByLabelText('Type')).toBeDisabled()
    await chooseOption(u, within(group('Attribute 1', attributes)).getByLabelText('Catalog field'), 'No link')
    // integer with min/max -> boolean; enum with options -> text; list of text -> list of enum.
    await chooseOption(u, within(group('Attribute 1', attributes)).getByLabelText('Type'), 'Yes/no')
    await chooseOption(u, within(group('Attribute 2', attributes)).getByLabelText('Type'), 'Text')
    const protocols = group('Attribute 3', attributes)
    await chooseOption(u, within(protocols).getByLabelText('Item type'), 'Choice')
    await u.click(within(protocols).getByRole('button', { name: 'Add option' }))
    await u.type(within(group('Option 1', protocols)).getByLabelText('Key'), 'knx')
    await u.type((await translation(u, group('Option 1', protocols), 'Label', 'en')), 'KNX')

    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].attributes).toEqual([
      { key: 'width_te', label: { en: 'Width', de: 'Breite' }, type: 'boolean', required: true, unit: 'TE', scope: 'product' },
      { key: 'colour', label: { en: 'Colour' }, type: 'text', required: false, scope: 'variant' },
      {
        key: 'protocols',
        label: { en: 'Protocols' },
        type: 'list',
        itemType: 'enum',
        max: 4,
        required: false,
        scope: 'product',
        options: [{ key: 'knx', label: { en: 'KNX' } }],
      },
    ])
  })

  it('sends a list of text without options, even after options were entered', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()
    const attributes = attributesRegion()
    await expandAll(u, attributes)
    const protocols = group('Attribute 3', attributes)
    await chooseOption(u, within(protocols).getByLabelText('Item type'), 'Choice')
    await u.click(within(protocols).getByRole('button', { name: 'Add option' }))
    await u.type(within(group('Option 1', protocols)).getByLabelText('Key'), 'knx')
    await chooseOption(u, within(protocols).getByLabelText('Item type'), 'Text')

    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].attributes[2]).toEqual({ key: 'protocols', label: { en: 'Protocols' }, type: 'list', itemType: 'text', max: 4, required: false, scope: 'product' })
  })

  it('collapses, expands, duplicates, inserts and moves attributes', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()
    const attributes = attributesRegion()

    // One row opens and closes.
    await u.click(within(group('Attribute 2', attributes)).getByRole('button', { name: 'Expand attribute 2' }))
    expect(own(group('Attribute 2', attributes), 'Key')).toHaveValue('colour')
    await u.click(within(group('Attribute 2', attributes)).getByRole('button', { name: 'Collapse attribute 2' }))
    expect(within(group('Attribute 2', attributes)).queryByLabelText('Key')).not.toBeInTheDocument()

    // Protocols to the top; focus stays on a move button that still works.
    await cardAction(u, group('Attribute 3', attributes), 'Move to top')
    expect(group('Attribute 1', attributes)).toHaveTextContent('Protocols')
    expect(within(group('Attribute 1', attributes)).getByRole('button', { name: 'Move attribute 1 down' })).toHaveFocus()
    // To the bottom and back from the menu: focus lands on the moved card's working move button.
    await cardAction(u, group('Attribute 1', attributes), 'Move to bottom')
    expect(group('Attribute 3', attributes)).toHaveTextContent('Protocols')
    expect(within(group('Attribute 3', attributes)).getByRole('button', { name: 'Move attribute 3 up' })).toHaveFocus()
    await cardAction(u, group('Attribute 3', attributes), 'Move to top')
    expect(within(group('Attribute 1', attributes)).getByRole('button', { name: 'Move attribute 1 down' })).toHaveFocus()

    // Duplicate width (now attribute 2): an open copy below, whose key must be changed.
    await cardAction(u, group('Attribute 2', attributes), 'Duplicate')
    const copy = group('Attribute 3', attributes)
    expect(own(copy, 'Key')).toHaveValue('width_te_copy')
    expect(own(copy, 'Key')).toHaveFocus()
    expect(within(copy).getByLabelText('Minimum')).toHaveValue('1')
    await u.click(screen.getByRole('button', { name: 'Update' }))
    expect(own(copy, 'Key')).toHaveAccessibleDescription('Change the key of the copied attribute.')
    expect(puts).toHaveLength(0)
    await u.clear(own(copy, 'Key'))
    await u.type(own(copy, 'Key'), 'height_te')

    // Insert an empty row below the first.
    await cardAction(u, group('Attribute 1', attributes), 'Insert below')
    const inserted = group('Attribute 2', attributes)
    expect(own(inserted, 'Key')).toHaveValue('')
    expect(own(inserted, 'Key')).toHaveFocus()
    await u.type(own(inserted, 'Key'), 'bus_system')
    await u.type((await translation(u, inserted, 'Label', 'en')), 'Bus system')

    // Move the colour (last) to the bottom is disabled; to the top works.
    const last = group('Attribute 5', attributes)
    await u.click(within(last).getByRole('button', { name: 'More actions for attribute 5' }))
    expect(await screen.findByRole('menuitem', { name: 'Move to bottom' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('menuitem', { name: 'Move to top' })).not.toHaveAttribute('aria-disabled')
    await u.keyboard('{Escape}')

    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].attributes.map((a) => a.key)).toEqual(['protocols', 'bus_system', 'width_te', 'height_te', 'colour'])
    expect(puts[0].attributes[3]).toMatchObject({ type: 'integer', min: 1, max: 12, unit: 'TE', required: true })
  })

  it('moves focus sensibly when attributes and options are added and removed', async () => {
    const u = userEvent.setup()
    await openEditor()
    const attributes = attributesRegion()

    // Removing focuses the next row's first control ...
    await cardAction(u, group('Attribute 1', attributes), 'Remove')
    expect(within(group('Attribute 1', attributes)).getByRole('button', { name: 'Expand attribute 1' })).toHaveFocus()
    // ... or, without a next row, the add button.
    await cardAction(u, group('Attribute 2', attributes), 'Remove')
    expect(within(attributes).getByRole('button', { name: 'Add attribute' })).toHaveFocus()

    // Adding focuses the new row's first field, at the end or at the top.
    await u.click(within(attributes).getByRole('button', { name: 'Add attribute' }))
    expect(own(group('Attribute 2', attributes), 'Key')).toHaveFocus()
    await u.click(within(attributes).getByRole('button', { name: 'Add attribute at the top' }))
    expect(own(group('Attribute 1', attributes), 'Key')).toHaveFocus()

    // Options: the same.
    const colour = group('Attribute 2', attributes)
    await u.click(within(colour).getByRole('button', { name: 'Expand attribute 2' }))
    await u.click(within(colour).getByRole('button', { name: 'Add option' }))
    expect(within(group('Option 3', colour)).getByLabelText('Key')).toHaveFocus()
    await u.click(within(group('Option 1', colour)).getByRole('button', { name: 'Remove option 1' }))
    expect(within(group('Option 1', colour)).getByRole('button', { name: 'Move option 1 down' })).toHaveFocus()
    await u.click(within(group('Option 2', colour)).getByRole('button', { name: 'Move option 2 up' }))
    // At the top, "up" is disabled: focus moves to "down".
    expect(within(group('Option 1', colour)).getByRole('button', { name: 'Move option 1 down' })).toHaveFocus()
    await u.click(within(group('Option 2', colour)).getByRole('button', { name: 'Remove option 2' }))
    expect(within(colour).getByRole('button', { name: 'Add option' })).toHaveFocus()
  })

  it('reloads after someone else changed the category', async () => {
    let version = existing
    const { puts } = editHandlers(
      () => version,
      () => (puts.length === 1 ? problem(409, { code: 'category.stale' }) : HttpResponse.json(version)),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: editRoute })

    await u.clear(await (await translation(u, document.body, 'Name', 'en')))
    await u.type((await translation(u, document.body, 'Name', 'en')), 'My dimmer')
    version = { ...existing, name: { en: 'Their dimmer' }, updatedAt: '2026-02-01T00:00:00Z' }
    await u.click(screen.getByRole('button', { name: 'Update' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Someone else changed this category in the meantime.')
    await u.click(within(alert).getByRole('button', { name: 'Reload' }))

    await waitFor(async () => expect(await translation(u, document.body, 'Name', 'en')).toHaveValue('Their dimmer'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(puts.map((p) => [p.name.en, p.expectedUpdatedAt])).toEqual([
      ['My dimmer', existing.updatedAt],
      ['Their dimmer', '2026-02-01T00:00:00Z'],
    ])
  })

  it('never starts editing from cached data', async () => {
    const fresh = { ...existing, name: { en: 'Fresh name' }, updatedAt: '2026-03-01T00:00:00Z' }
    const { puts, gets } = editHandlers(() => fresh)
    const u = userEvent.setup()
    // A production-like client with a warm cache (staleTime 30 s by default).
    renderRoutes(routes, {
      me: adminMe,
      route: editRoute,
      appClient: true,
      prepare: (client) => client.setQueryData(getGetCategoryQueryKey(existing.id), existing),
    })

    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    expect(await (await translation(u, document.body, 'Name', 'en'))).toHaveValue('Fresh name')
    expect(gets).toHaveLength(1)
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].expectedUpdatedAt).toBe('2026-03-01T00:00:00Z')
  })

  it('asks before leaving with unsaved changes: stay keeps them, leave discards them', async () => {
    const u = userEvent.setup()
    await openEditor()

    await u.type((await translation(u, document.body, 'Name', 'de')), ' neu')
    await u.click(screen.getByRole('link', { name: 'Cancel' }))

    let dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await u.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await translation(u, document.body, 'Name', 'de')).toHaveValue('Dimmaktor neu')

    await u.click(screen.getByRole('link', { name: 'Cancel' }))
    dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await u.click(within(dialog).getByRole('button', { name: 'Leave page' }))

    expect(await screen.findByText('list page')).toBeInTheDocument()
  })

  it('leaves without asking when nothing changed', async () => {
    const u = userEvent.setup()
    await openEditor()

    expect(screen.queryByRole('link', { name: 'Cancel' })).not.toBeInTheDocument()
    await u.click(screen.getByRole('link', { name: 'Back to list' }))

    expect(await screen.findByText('list page')).toBeInTheDocument()
  })

  it('stays after an update and restarts from the saved version', async () => {
    let version = existing
    const { puts } = editHandlers(
      () => version,
      () => {
        version = { ...existing, name: { en: puts[puts.length - 1].name.en }, updatedAt: `2026-0${puts.length + 1}-01T00:00:00Z` }
        return HttpResponse.json(version)
      },
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: editRoute })

    await u.clear(await (await translation(u, document.body, 'Name', 'en')))
    await u.type((await translation(u, document.body, 'Name', 'en')), 'Saved name')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(await translation(u, document.body, 'Name', 'en')).toHaveValue('Saved name')
    // The saved version is clean: no prompt, Back to list.
    expect(screen.getByRole('link', { name: 'Back to list' })).toBeInTheDocument()

    // The notice is over once something changes; the next update sends the saved version.
    await u.type((await translation(u, document.body, 'Name', 'en')), ' 2')
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Update' }))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(puts.map((p) => [p.name.en, p.expectedUpdatedAt])).toEqual([
      ['Saved name', existing.updatedAt],
      ['Saved name 2', '2026-02-01T00:00:00Z'],
    ])
  })

  it('reads "Back to list" while nothing is unsaved and "Cancel" while something is', async () => {
    const u = userEvent.setup()
    await openEditor()

    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/catalog/categories')
    await u.type((await translation(u, document.body, 'Name', 'de')), ' neu')
    expect(screen.queryByRole('link', { name: 'Back to list' })).not.toBeInTheDocument()
    await u.click(screen.getByRole('link', { name: 'Cancel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await u.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await u.click(screen.getByRole('button', { name: 'Update' }))
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to list' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Cancel' })).not.toBeInTheDocument()
    await u.click(screen.getByRole('link', { name: 'Back to list' }))
    expect(await screen.findByText('list page')).toBeInTheDocument()
  })

  it('shows the category read-only without catalog.write', async () => {
    server.use(http.get('/api/categories/:id', () => HttpResponse.json({ ...existing, can: { update: false, delete: false } })))
    renderRoutes(routes, { me: userMe, route: editRoute })

    expect(await screen.findByRole('heading', { name: 'Dimmer actuator' })).toBeInTheDocument()
    expect(screen.getByText('You can view this category but not change it.')).toBeInTheDocument()
    expect(within(region('Basics')).getByLabelText('Key')).toBeDisabled()
    // Categories have no colour (product types do).
    expect(within(region('Basics')).queryByLabelText('Colour')).not.toBeInTheDocument()
    // Everything is shown, nothing can be changed.
    const attributes = attributesRegion()
    expect(own(group('Attribute 1', attributes), 'Key')).toBeDisabled()
    expect(within(group('Option 1', group('Attribute 2', attributes))).getByLabelText('Key')).toHaveValue('white')
    // Every translation can be read: the language tabs still work (a plain click: user-event treats
    // everything inside a disabled fieldset as disabled, browsers only its controls).
    const name = within(region('Basics'))
    expect(name.getByLabelText('Name')).toHaveValue('Dimmer actuator')
    fireEvent.click(within(region('Basics')).getAllByRole('tab', { name: 'German' })[0])
    expect(name.getByLabelText('Name')).toHaveValue('Dimmaktor')
    expect(name.getByLabelText('Name')).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: /update|add attribute|remove|move|duplicate|insert|expand|collapse/i }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/catalog/categories')
  })

  it('does not offer creating to users without catalog.write', async () => {
    renderRoutes(appRoutes, { me: userMe, route: '/catalog/categories/new' })

    expect(await screen.findByText('You do not have permission to see this page.')).toBeInTheDocument()
  })

  it('shows when the category does not exist', async () => {
    server.use(http.get('/api/categories/:id', () => problem(404, { code: 'category.not_found' })))
    renderRoutes(routes, { me: adminMe, route: editRoute })

    expect(await screen.findByRole('heading', { name: 'Category not found' })).toBeInTheDocument()
    expect(screen.getByText('This category does not exist (anymore).')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/catalog/categories')
  })

  it('shows an invalid id in the URL as not found', async () => {
    server.use(
      http.get('/api/categories/:id', () =>
        problem(422, { code: 'validation.failed', fields: [{ location: 'path.id', code: 'validation.invalid' }] }),
      ),
    )
    renderRoutes(routes, { me: adminMe, route: '/catalog/categories/not-a-uuid' })

    expect(await screen.findByRole('heading', { name: 'Category not found' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Edit category' })).not.toBeInTheDocument()
  })
})
