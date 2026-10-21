import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import type { Product, ProductInput, ProductUpdate } from '@/api/generated/model'
import { routes as appRoutes } from '@/app/routes'
import i18n from '@/i18n'
import { adminMe, userMe } from '@/test/fixtures'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'
import { shownTranslation, translation } from '@/test/translatable'
import { chooseOption, optionTexts } from '@/test/select'

import { ProductEditorPage } from './ProductEditorPage'
import {
  black,
  categories,
  dimmer,
  dimmerCategory,
  gatewayCategory,
  ids,
  inactiveCategory,
  ivory,
  knxType,
  legacyType,
  loadTypes,
  outputKinds,
  problem,
  types,
  zigbeeType,
} from './test-fixtures'

const routes = [
  { path: '/catalog/products', element: <p>list page</p> },
  { path: '/catalog/products/new', element: <ProductEditorPage /> },
  { path: '/catalog/products/:id', element: <ProductEditorPage /> },
  { path: '/catalog/products/:id/variants/new', element: <p>new variant page</p> },
  { path: '/catalog/products/:id/variants/:variantId', element: <p>variant page</p> },
]
const editRoute = `/catalog/products/${dimmer.id}`

const region = (name: string) => screen.getByRole('region', { name })
const attributes = () => region('Attributes')
const inAttributes = (label: string) => within(attributes()).getByLabelText(label)

type User = ReturnType<typeof userEvent.setup>

/** GET returns `item()`, PUT records the body and answers with `respond` (default: the item). */
function editHandlers(item: () => Product = () => dimmer, respond?: () => Response) {
  const puts: ProductUpdate[] = []
  server.use(
    http.get('/api/product-types', () => HttpResponse.json({ items: types })),
    http.get('/api/categories', () => HttpResponse.json({ items: categories })),
    http.get('/api/products/:id', () => HttpResponse.json(item())),
    http.get('/api/output-kinds', () => HttpResponse.json({ items: outputKinds })),
    http.get('/api/load-types', () => HttpResponse.json({ items: loadTypes })),
    http.put('/api/products/:id', async ({ request }) => {
      puts.push((await request.json()) as ProductUpdate)
      return respond ? respond() : HttpResponse.json(item())
    }),
  )
  return { puts }
}

async function openEditor(item?: () => Product, respond?: () => Response, heading = 'Edit product') {
  const calls = editHandlers(item, respond)
  renderRoutes(routes, { me: adminMe, route: editRoute })
  await screen.findByRole('heading', { name: heading })
  return calls
}

const add = async (u: User, label: string, ...items: string[]) => {
  for (const item of items) await u.type(inAttributes(label), `${item}{Enter}`)
}

describe('ProductEditorPage', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('creates a product with a value of every attribute type, sending exactly what is set', async () => {
    let posted: ProductInput | undefined
    const created = { ...dimmer, id: ids.id(299), variants: [] }
    server.use(
      http.get('/api/product-types', () => HttpResponse.json({ items: types })),
      http.get('/api/categories', () => HttpResponse.json({ items: categories })),
      http.post('/api/products', async ({ request }) => {
        posted = (await request.json()) as ProductInput
        return HttpResponse.json(created, { status: 201 })
      }),
      http.get('/api/products/:id', () => HttpResponse.json(created)),
    )
    const u = userEvent.setup()
    const { router } = renderRoutes(routes, { me: adminMe, route: '/catalog/products/new' })

    expect(await screen.findByRole('heading', { name: 'New product' })).toBeInTheDocument()
    expect(attributes()).toHaveTextContent('Choose a category to fill in its attributes.')
    // Only active types and categories are offered for a new product; types with their badge.
    expect(await optionTexts(u, screen.getByLabelText('System'))).toEqual(['Choose a system', 'ZBZigbee', 'KNX'])
    expect(await optionTexts(u, screen.getByLabelText('Category'))).toEqual(['Choose a category', 'Dimmer actuators', 'Gateways'])
    await chooseOption(u, screen.getByLabelText('System'), 'Zigbee')
    // The attributes come from the category.
    expect(attributes()).toHaveTextContent('Choose a category to fill in its attributes.')
    await chooseOption(u, screen.getByLabelText('Category'), 'Dimmer actuators')
    await u.type(screen.getByLabelText('Model number'), ' M1 ')
    await u.type((await translation(u, document.body, 'Name', 'en')), 'Dimmer')

    await u.type(inAttributes('Series'), 'Pro')
    await u.type(inAttributes('Power'), '12.5')
    await u.type(inAttributes('Width'), '4')
    await u.click(inAttributes('DALI'))
    await chooseOption(u, inAttributes('Bus system'), 'KNX')
    const loads = within(attributes()).getByRole('group', { name: 'Loads' })
    await u.click(within(loads).getByLabelText('Motor'))
    await u.click(within(loads).getByLabelText('LED'))
    await add(u, 'Protocols', 'DALI', 'KNX')
    await add(u, 'Channel currents', '1.5')
    await u.type(inAttributes('Channel currents'), '2')
    await u.click(within(attributes()).getAllByRole('button', { name: 'Add' })[1])
    // Variant attributes are not set on the product.
    expect(within(attributes()).queryByLabelText('Colour')).not.toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Create' }))

    // The new product's page, to add its variants.
    expect(await screen.findByText('Product created. Add its variants below.')).toBeInTheDocument()
    // Read once: removed from the history entry, so a reload does not show it again.
    await waitFor(() => expect(router.state.location.state).not.toHaveProperty('notice'))
    expect(screen.getByText('Product created. Add its variants below.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Edit product' })).toBeInTheDocument()
    expect(posted).toEqual({
      productTypeId: zigbeeType.id,
      categoryId: dimmerCategory.id,
      modelNumber: 'M1',
      name: { en: 'Dimmer' },
      attributes: {
        series: 'Pro',
        power: 12.5,
        width_te: 4,
        dali: true,
        bus_system: 'knx',
        loads: ['led', 'motor'],
        protocols: ['DALI', 'KNX'],
        currents: [1.5, 2],
      },
      isActive: true,
      mounting: '',
    })
  })

  it('renders one input per attribute type with its unit, bounds and required mark', async () => {
    const u = userEvent.setup()
    await openEditor()

    expect(inAttributes('Series')).toHaveValue('Pro')
    expect(inAttributes('Series')).toHaveAccessibleDescription('At most 20 characters')
    const power = inAttributes('Power')
    expect(power).toHaveValue('300')
    expect(power).toHaveAttribute('inputmode', 'decimal')
    expect(power).toHaveAccessibleDescription('0 to 500')
    expect(power.parentElement).toHaveTextContent('W')
    const width = inAttributes('Width')
    expect(width).toHaveAttribute('inputmode', 'numeric')
    expect(width).toHaveAttribute('aria-required', 'true')
    expect(width).toHaveAccessibleDescription('1 to 12 · Whole number')
    expect(inAttributes('DALI')).toBeChecked()
    const bus = inAttributes('Bus system')
    expect(bus).toHaveTextContent('Zigbee')
    expect(await optionTexts(u, bus)).toEqual(['Not set', 'Zigbee', 'KNX'])
    const loads = within(attributes()).getByRole('group', { name: 'Loads' })
    expect(within(loads).getByLabelText('LED')).toBeChecked()
    expect(within(loads).getByLabelText('Halogen')).not.toBeChecked()
    expect(within(loads).getByLabelText('Motor')).toBeChecked()
    expect(inAttributes('Protocols')).toHaveAccessibleDescription('At most 4 items')
    expect(within(attributes()).getByRole('button', { name: 'Remove DALI' })).toBeInTheDocument()
    expect(attributes()).toHaveTextContent('1.5 A')
    expect(attributes()).toHaveTextContent('2 A')
  })

  it('saves unchanged values as stored, with the version it was loaded from', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(puts).toEqual([
      {
        productTypeId: zigbeeType.id,
        categoryId: dimmerCategory.id,
        modelNumber: dimmer.modelNumber,
        name: dimmer.name,
        description: dimmer.description,
        attributes: dimmer.attributes,
        isActive: true,
        // The stored mounting override is sent back (D294).
        mounting: 'board',
        expectedUpdatedAt: dimmer.updatedAt,
      },
    ])
  })

  it('shows what SnapFlow knows about the product and its variants, and edits the mounting override', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    const block = await screen.findByTestId('capabilities')
    await waitFor(() =>
      expect(block).toHaveTextContent(
        '6 × dimmer output, max 200 W LED, 220 W halogen, max 2.5 A per channel, min 3 W LED per channel · max 6 A for the whole module · max 1200.5 W for the whole module · uses 20 mA bus current (system default) · 6 TE wide · mounting: Distribution board',
      ),
    )
    // One line per variant.
    expect(within(block).getByText('Ivory White')).toBeInTheDocument()

    const mounting = within(region('Basics')).getByLabelText('Mounting')
    expect(mounting).toHaveTextContent('Distribution board')
    await chooseOption(u, mounting, 'As category (Floorplan)')
    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].mounting).toBe('')
  })

  it('lists what is still missing in plain words, and nothing when complete (D447)', async () => {
    await openEditor(() => ({ ...dimmer, capabilities: { ...dimmer.capabilities, missing: [{ code: 'product_board_without_width' }, { code: 'product_channel_without_limit' }] } }))
    const missing = await screen.findByTestId('still-missing')
    expect(within(missing).getByRole('heading', { name: 'Still missing' })).toBeInTheDocument()
    expect(within(missing).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Width on the DIN rail (TE): the board cannot place it without one',
      'Load limit per channel (W or A): loads on its channels are not checked',
    ])
  })

  it('shows no missing lines for a complete product', async () => {
    await openEditor()
    await screen.findByTestId('capabilities')
    expect(screen.queryByTestId('still-missing')).not.toBeInTheDocument()
  })

  it('edits lists and clears values, leaving out what is not set', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    await u.clear(inAttributes('Series'))
    await u.clear(inAttributes('Power'))
    await u.click(inAttributes('DALI'))
    await chooseOption(u, inAttributes('Bus system'), 'Not set')
    await u.click(within(attributes()).getByLabelText('LED'))
    await u.click(within(attributes()).getByLabelText('Motor'))
    await u.click(within(attributes()).getByRole('button', { name: 'Remove DALI' }))
    await u.click(within(attributes()).getByRole('button', { name: 'Remove 1.5' }))
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    // An unchecked yes/no is "no", not "not set".
    expect(puts[0].attributes).toEqual({ width_te: 4, dali: false, currents: [2] })
  })

  it('checks that numbers are numbers before saving', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    await u.clear(inAttributes('Width'))
    await u.type(inAttributes('Width'), '2.5')
    await u.clear(inAttributes('Power'))
    await u.type(inAttributes('Power'), 'much')
    await add(u, 'Channel currents', 'x')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await within(attributes()).findByText('This value must be a whole number.')).toBeInTheDocument()
    expect(inAttributes('Power')).toHaveAccessibleDescription('Enter a number.')
    expect(inAttributes('Channel currents')).toHaveAccessibleDescription('Enter a number.')
    expect(inAttributes('Power')).toHaveFocus()
    expect(puts).toEqual([])
  })

  it('shows server errors of attribute values at their inputs, list items at their list', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () =>
      problem(422, {
        code: 'validation.failed',
        fields: [
          { location: 'body.attributes.width_te', code: 'attribute.range', params: { min: 1, max: 12 } },
          { location: 'body.attributes.protocols[1]', code: 'attribute.length_max', params: { max: 10 } },
        ],
      }),
    )

    await add(u, 'Protocols', 'A very long protocol')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Please check the highlighted fields.')
    expect(inAttributes('Width')).toHaveAccessibleDescription('Enter a value between 1 and 12.')
    expect(inAttributes('Width')).toHaveAttribute('aria-invalid', 'true')
    expect(inAttributes('Protocols')).toHaveAccessibleDescription('Number of characters: at most 10.')
    expect(inAttributes('Width')).toHaveFocus()
  })

  it('shows server errors of German texts on the German tabs', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () =>
      problem(422, {
        code: 'validation.failed',
        fields: [
          { location: 'body.name.de', code: 'validation.control_chars' },
          { location: 'body.description.de', code: 'validation.too_long', params: { max: 5000 } },
        ],
      }),
    )

    await u.click(screen.getByRole('button', { name: 'Update' }))

    const basics = region('Basics')
    await waitFor(() => expect(shownTranslation(basics, 'Name').language).toBe('German'))
    expect(shownTranslation(basics, 'Name').input).toHaveAccessibleDescription(/control characters/i)
    expect(shownTranslation(basics, 'Name').input).toHaveFocus()
    expect(shownTranslation(basics, 'Description').language).toBe('German')
    expect(shownTranslation(basics, 'Description').input).toHaveAccessibleDescription('This value is too long (at most 5,000 characters).')
    expect(within(basics).getAllByRole('tab', { name: 'English' })[0]).toHaveAccessibleDescription('Filled in')
  })

  it('shows a taken model number at its field', async () => {
    const u = userEvent.setup()
    await openEditor(undefined, () => problem(409, { code: 'product.model_number_taken', params: { modelNumber: 'M485/DIM.4' } }))

    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() =>
      expect(screen.getByLabelText('Model number')).toHaveAccessibleDescription('The model number "M485/DIM.4" is already used.'),
    )
  })

  it('lists values no longer in the schema: kept unless removed, wrong-scope values with their error', async () => {
    const withStale: Product = {
      ...dimmer,
      attributes: { ...dimmer.attributes, power: 600, colour: 'white' },
      staleAttributes: { old_width: 4, legacy_flag: true },
      attributeErrors: [
        { location: 'attributes.colour', code: 'attribute.wrong_scope', params: { scope: 'variant' } },
        { location: 'attributes.power', code: 'attribute.range_max', params: { max: 500 } },
      ],
    }
    const u = userEvent.setup()
    const { puts } = await openEditor(() => withStale)

    // Problems of the stored values show from the start.
    expect(attributes()).toHaveTextContent('Some stored values do not match')
    expect(inAttributes('Power')).toHaveAccessibleDescription('Enter a value of at most 500.')
    const extra = within(attributes()).getByRole('group', { name: 'Values no longer in the schema' })
    const rows = within(extra).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('colourwhite'),
      expect.stringContaining('legacy_flagYes'),
      expect.stringContaining('old_width4'),
    ])
    expect(rows[0]).toHaveTextContent('This attribute is set per variant.')

    await u.click(within(extra).getByRole('button', { name: 'Remove colour' }))
    await u.click(within(extra).getByRole('button', { name: 'Remove legacy_flag' }))
    expect(rows[1]).toHaveTextContent('Removed on save')
    await u.click(within(extra).getByRole('button', { name: 'Keep legacy_flag' }))
    await u.click(within(extra).getByRole('button', { name: 'Remove old_width' }))
    await u.clear(inAttributes('Power'))
    await u.type(inAttributes('Power'), '450')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    // Kept stale values go back unchanged; removed ones are left out.
    expect(puts[0].attributes).toEqual({ ...dimmer.attributes, power: 450, legacy_flag: true })
  })

  it('re-renders the attributes for a new category and keeps the old values as no longer in the schema', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    await u.clear(inAttributes('Power'))
    await u.type(inAttributes('Power'), '250')
    // Another system changes nothing about the attributes.
    await chooseOption(u, screen.getByLabelText('System'), 'KNX')
    expect(inAttributes('Power')).toHaveValue('250')
    expect(screen.queryByText(/You changed the category/)).not.toBeInTheDocument()
    await chooseOption(u, screen.getByLabelText('Category'), 'Gateways')

    expect(screen.getByText(/You changed the category/)).toHaveTextContent(
      "Its variants' values are never refused or removed by the change: values that do not match the new category are flagged on the variants.",
    )
    // A required yes/no of the new category starts as "no".
    expect(inAttributes('Managed')).not.toBeChecked()
    expect(within(attributes()).queryByLabelText('Power')).not.toBeInTheDocument()
    expect(inAttributes('Series')).toHaveValue('Pro')
    await u.type(inAttributes('Ports'), '8')
    const extra = within(attributes()).getByRole('group', { name: 'Values no longer in the schema' })
    expect(within(extra).getAllByRole('listitem').map((r) => r.querySelector('code')?.textContent)).toEqual([
      'bus_system',
      'currents',
      'dali',
      'loads',
      'power',
      'protocols',
      'width_te',
    ])
    await u.click(within(extra).getByRole('button', { name: 'Remove dali' }))

    // Back to the old category: its inputs again, with the values as edited.
    await chooseOption(u, screen.getByLabelText('Category'), 'Dimmer actuators')
    expect(inAttributes('Power')).toHaveValue('250')
    expect(inAttributes('DALI')).toBeChecked()
    await chooseOption(u, screen.getByLabelText('Category'), 'Gateways')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    const { dali: _removed, series: _series, ...stale } = dimmer.attributes as Record<string, unknown>
    expect(puts[0].productTypeId).toBe(knxType.id)
    expect(puts[0].categoryId).toBe(gatewayCategory.id)
    // Stale values are sent back as stored (the edited power was an input of the old category only).
    expect(puts[0].attributes).toEqual({ series: 'Pro', ports: 8, managed: false, ...stale })
  })

  it('reloads after someone else changed the product', async () => {
    let version = dimmer
    const { puts } = editHandlers(
      () => version,
      () => (puts.length === 1 ? problem(409, { code: 'product.stale' }) : HttpResponse.json(version)),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: editRoute })

    await u.clear(await (await translation(u, document.body, 'Name', 'en')))
    await u.type((await translation(u, document.body, 'Name', 'en')), 'My dimmer')
    version = { ...dimmer, name: { en: 'Their dimmer' }, updatedAt: '2026-02-01T00:00:00Z' }
    await u.click(screen.getByRole('button', { name: 'Update' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Someone else changed this product in the meantime.')
    await u.click(within(alert).getByRole('button', { name: 'Reload' }))

    await waitFor(async () => expect(await translation(u, document.body, 'Name', 'en')).toHaveValue('Their dimmer'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts.map((p) => [p.name.en, p.expectedUpdatedAt])).toEqual([
      ['My dimmer', dimmer.updatedAt],
      ['Their dimmer', '2026-02-01T00:00:00Z'],
    ])
  })

  it('asks before leaving with unsaved changes; variants open only once the product is saved', async () => {
    const u = userEvent.setup()
    await openEditor()
    const variants = region('Variants')
    expect(within(variants).getByRole('link', { name: 'Add variant' })).toBeInTheDocument()

    await u.type((await translation(u, document.body, 'Name', 'de')), ' neu')

    // While the product form is dirty, the variant links and buttons are off.
    expect(variants).toHaveTextContent('Save the product first to open or add variants.')
    expect(within(variants).queryByRole('link', { name: 'Ivory White' })).not.toBeInTheDocument()
    expect(within(variants).getByRole('button', { name: 'Add variant' })).toBeDisabled()
    expect(within(variants).getAllByRole('button', { name: 'Edit' })[0]).toBeDisabled()

    await u.click(screen.getByRole('link', { name: 'Cancel' }))
    let dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await u.click(within(dialog).getByRole('button', { name: 'Stay' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await translation(u, document.body, 'Name', 'de')).toHaveValue('Dimmer 4-fach neu')

    await u.click(screen.getByRole('link', { name: 'Cancel' }))
    dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await u.click(within(dialog).getByRole('button', { name: 'Leave page' }))
    expect(await screen.findByText('list page')).toBeInTheDocument()
  })

  it('reads "Back to list" while nothing is unsaved, "Cancel" while it is, and stays after an update', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor(undefined, () =>
      HttpResponse.json({ ...dimmer, name: { ...dimmer.name, de: 'Dimmer 4-fach neu' }, updatedAt: '2026-03-01T00:00:00Z' }),
    )

    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/catalog/products')
    expect(screen.queryByRole('link', { name: 'Cancel' })).not.toBeInTheDocument()
    await u.type((await translation(u, document.body, 'Name', 'de')), ' neu')
    expect(screen.getByRole('link', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Back to list' })).not.toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Update' }))

    // Stays on the page, restarted from the saved version.
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    expect(await translation(u, document.body, 'Name', 'de')).toHaveValue('Dimmer 4-fach neu')
    expect(screen.getByRole('link', { name: 'Back to list' })).toBeInTheDocument()
    expect(within(region('Variants')).getByRole('link', { name: 'Ivory White' })).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1].expectedUpdatedAt).toBe('2026-03-01T00:00:00Z')

    await u.click(screen.getByRole('link', { name: 'Back to list' }))
    expect(await screen.findByText('list page')).toBeInTheDocument()
  })

  it('shows a stored choice that is no option any more, and lets it be cleared', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor(() => ({ ...dimmer, attributes: { ...dimmer.attributes, bus_system: 'can', loads: ['led', 'dimmer2'] } }))

    const bus = inAttributes('Bus system')
    expect(bus).toHaveTextContent('can (not an option)')
    expect(await optionTexts(u, bus)).toEqual(['Not set', 'Zigbee', 'KNX', 'can (not an option)'])
    const loads = within(attributes()).getByRole('group', { name: 'Loads' })
    expect(within(loads).getByLabelText('dimmer2 (not an option)')).toBeChecked()

    // Unchanged, they are sent back as stored (the server reports them).
    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].attributes).toMatchObject({ bus_system: 'can', loads: ['led', 'dimmer2'] })

    // The form restarted from the saved version.
    await screen.findByText('Saved.')
    const reloaded = within(attributes()).getByRole('group', { name: 'Loads' })
    await chooseOption(u, inAttributes('Bus system'), 'Not set')
    await u.click(within(reloaded).getByLabelText('dimmer2 (not an option)'))
    expect(within(reloaded).queryByLabelText('dimmer2 (not an option)')).not.toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1].attributes).not.toHaveProperty('bus_system')
    expect(puts[1].attributes).toMatchObject({ loads: ['led'] })
  })

  it('keeps stored values the input cannot hold, shows them and sends them back until changed', async () => {
    const odd: Product = {
      ...dimmer,
      attributes: { ...dimmer.attributes, dali: 'yes', currents: [{ channel: 1, amps: 2 }] },
      attributeErrors: [
        { location: 'attributes.dali', code: 'attribute.type', params: { expected: 'boolean' } },
        { location: 'attributes.currents[0]', code: 'attribute.type', params: { expected: 'number' } },
      ],
    }
    const u = userEvent.setup()
    const { puts } = await openEditor(() => odd)

    expect(inAttributes('DALI')).not.toBeChecked()
    expect(attributes()).toHaveTextContent('Stored value: yes')
    expect(attributes()).toHaveTextContent('Stored value: {"channel":1,"amps":2}')
    // The server's error stays visible at the input.
    expect(inAttributes('DALI')).toHaveAttribute('aria-invalid', 'true')

    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].attributes).toMatchObject({ dali: 'yes', currents: [{ channel: 1, amps: 2 }] })

    // Once changed, the input's value is sent.
    await u.click(inAttributes('DALI'))
    expect(attributes()).not.toHaveTextContent('Stored value: yes')
    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1].attributes).toMatchObject({ dali: true, currents: [{ channel: 1, amps: 2 }] })
  })

  it('takes a decimal comma in numbers and refuses other number forms', async () => {
    const u = userEvent.setup()
    const { puts } = await openEditor()

    await u.clear(inAttributes('Power'))
    await u.type(inAttributes('Power'), '0x10')
    await u.click(screen.getByRole('button', { name: 'Update' }))
    expect(await within(attributes()).findByText('Enter a number.')).toBeInTheDocument()
    expect(puts).toEqual([])

    await u.clear(inAttributes('Power'))
    await u.type(inAttributes('Power'), '12,5')
    await add(u, 'Channel currents', '0,75')
    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].attributes).toMatchObject({ power: 12.5, currents: [1.5, 2, 0.75] })
  })

  it('shows stored numbers with the German decimal comma and sends them back unchanged', async () => {
    await i18n.changeLanguage('de')
    const u = userEvent.setup()
    const decimals = { ...dimmer, attributes: { ...dimmer.attributes, power: 12.5 } }
    const { puts } = await openEditor(() => decimals, undefined, 'Produkt bearbeiten')

    const section = region('Attribute')
    expect(within(section).getByLabelText('Power')).toHaveValue('12,5')
    expect(within(section).getByRole('button', { name: '1,5 entfernen' })).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Aktualisieren' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].attributes).toEqual(decimals.attributes)
  })

  it('sends stored zero and "no" back as they are', async () => {
    const u = userEvent.setup()
    const zero = { ...dimmer, attributes: { power: 0, width_te: 4, dali: false, currents: [0] } }
    const { puts } = await openEditor(() => zero)

    expect(inAttributes('Power')).toHaveValue('0')
    expect(inAttributes('DALI')).not.toBeChecked()
    await u.click(screen.getByRole('button', { name: 'Update' }))

    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0].attributes).toEqual(zero.attributes)
  })

  it('offers the current inactive type and category to an existing product only', async () => {
    const u = userEvent.setup()
    await openEditor(() => ({ ...dimmer, productTypeId: legacyType.id, categoryId: inactiveCategory.id, attributes: {} }))

    expect(await optionTexts(u, screen.getByLabelText('System'))).toEqual(['ZBZigbee', 'KNX', 'Legacy (inactive)'])
    expect(screen.getByLabelText('System')).toHaveTextContent('Legacy (inactive)')
    expect(await optionTexts(u, screen.getByLabelText('Category'))).toEqual(['Dimmer actuators', 'Gateways', 'Retired (inactive)'])
    expect(screen.getByLabelText('Category')).toHaveTextContent('Retired (inactive)')
    // The inactive category has no attributes.
    expect(attributes()).toHaveTextContent('This category defines no attributes here.')
  })

  it('shows errors of the type, category, model number and conflicts at their place', async () => {
    let respond = () =>
      problem(422, {
        code: 'validation.failed',
        fields: [
          { location: 'body.productTypeId', code: 'product.type_inactive' },
          { location: 'body.categoryId', code: 'product.category_not_found' },
          { location: 'body.modelNumber', code: 'validation.control_chars' },
        ],
      })
    const u = userEvent.setup()
    await openEditor(undefined, () => respond())

    await u.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(screen.getByLabelText('System')).toHaveAccessibleDescription('This system is inactive. Choose an active system.'))
    expect(screen.getByLabelText('Category')).toHaveAccessibleDescription('The selected category no longer exists.')
    expect(screen.getByLabelText('Model number')).toHaveAccessibleDescription(
      'Control characters (such as tabs, line breaks or invisible characters) are not allowed.',
    )

    respond = () => problem(409, { code: 'request.conflict_retry' })
    await u.click(screen.getByRole('button', { name: 'Update' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Someone else changed this at the same time. Please try again.')
  })

  it('names the variants whose values no longer match, after a category change too', async () => {
    const flagged: Product = {
      ...dimmer,
      categoryId: gatewayCategory.id,
      variantsWithProblems: 2,
      variants: [
        { ...ivory, staleAttributes: { colour: 'white' } },
        { ...black, attributeErrors: [{ location: 'attributes.gloss', code: 'attribute.type', params: { expected: 'boolean' } }] },
      ],
    }
    let product = dimmer
    const u = userEvent.setup()
    await openEditor(
      () => product,
      () => {
        product = flagged
        return HttpResponse.json(flagged)
      },
    )
    expect(region('Variants')).not.toHaveTextContent('no longer match')

    await chooseOption(u, screen.getByLabelText('Category'), 'Gateways')
    await u.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Saved.')).toBeInTheDocument()
    const variants = region('Variants')
    expect(variants).toHaveTextContent('2 variants have values that no longer match the schema: Ivory White, Black')
    const links = within(variants).getAllByRole('link', { name: 'Ivory White' })
    expect(links[0]).toHaveAttribute('href', `/catalog/products/${dimmer.id}/variants/${ivory.id}`)
  })

  it('reloads the variants when the order changed meanwhile, and clears the error on the next move', async () => {
    let product = dimmer
    let gets = 0
    server.use(
      http.get('/api/product-types', () => HttpResponse.json({ items: types })),
      http.get('/api/categories', () => HttpResponse.json({ items: categories })),
      http.get('/api/products/:id', () => {
        gets++
        return HttpResponse.json(product)
      }),
    )
    let mismatch = true
    server.use(
      http.put('/api/products/:id/variants/order', async ({ request }) => {
        if (mismatch) {
          mismatch = false
          const third = { ...black, id: ids.id(303), name: { en: 'Grey' } }
          product = { ...dimmer, variants: [ivory, black, third] }
          return problem(409, { code: 'variant.order_mismatch' })
        }
        const { ids: order } = (await request.json()) as { ids: string[] }
        product = { ...product, variants: order.map((id) => product.variants.find((v) => v.id === id)!) }
        return HttpResponse.json(product)
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: editRoute })

    const variants = await screen.findByRole('region', { name: 'Variants' })
    const before = gets
    await u.click(within(variants).getByRole('button', { name: 'Move Black up' }))

    expect(await within(variants).findByRole('alert')).toHaveTextContent('The list was reloaded — please try again.')
    await waitFor(() => expect(within(variants).getByRole('link', { name: 'Grey' })).toBeInTheDocument())
    expect(gets).toBeGreaterThan(before)

    await u.click(within(variants).getByRole('button', { name: 'Move Grey up' }))
    await waitFor(() => expect(within(variants).queryByRole('alert')).not.toBeInTheDocument())
    await waitFor(() =>
      expect(within(variants).getAllByRole('link', { name: /Ivory White|Black|Grey/ }).map((l) => l.textContent)).toEqual(['Ivory White', 'Grey', 'Black']),
    )
  })

  it('lists the variants with image, price, status and add-ons, and reorders them at once', async () => {
    let product = dimmer
    let order: unknown
    editHandlers(() => product)
    server.use(
      http.put('/api/products/:id/variants/order', async ({ request }) => {
        order = await request.json()
        product = { ...dimmer, variants: [black, ivory] }
        return HttpResponse.json(product)
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: editRoute })

    const variants = await screen.findByRole('region', { name: 'Variants' })
    const ivoryRow = within(variants).getByRole('link', { name: 'Ivory White' }).closest('tr')!
    expect(ivoryRow.querySelector('img')).toHaveAttribute('src', `/api/files/${ivory.imageFileId}`)
    expect(ivoryRow).toHaveTextContent('M485-IW')
    expect(ivoryRow).toHaveTextContent('$27.00')
    expect(ivoryRow).toHaveTextContent('Active')
    expect(ivoryRow.lastElementChild?.previousElementSibling).toHaveTextContent('1')
    const blackRow = within(variants).getByRole('link', { name: 'Black' }).closest('tr')!
    expect(blackRow).toHaveTextContent('Inactive')
    expect(within(variants).getByRole('link', { name: 'Add variant' })).toHaveAttribute('href', `/catalog/products/${dimmer.id}/variants/new`)

    await u.click(within(variants).getByRole('button', { name: 'Move Black up' }))

    await waitFor(() => expect(within(variants).getAllByRole('link', { name: /Ivory White|Black/ }).map((l) => l.textContent)).toEqual(['Black', 'Ivory White']))
    expect(order).toEqual({ ids: [black.id, ivory.id] })
  })

  it('deletes a variant after confirming', async () => {
    let product = dimmer
    let deleted = ''
    editHandlers(() => product)
    server.use(
      http.delete('/api/products/:id/variants/:variantId', ({ params }) => {
        deleted = String(params.variantId)
        product = { ...dimmer, variants: [black] }
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const u = userEvent.setup()
    renderRoutes(routes, { me: adminMe, route: editRoute })

    const variants = await screen.findByRole('region', { name: 'Variants' })
    const ivoryRow = within(variants).getByRole('link', { name: 'Ivory White' }).closest('tr')!
    await u.click(within(ivoryRow).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete variant' })
    await u.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(within(variants).queryByRole('link', { name: 'Ivory White' })).not.toBeInTheDocument())
    expect(deleted).toBe(ivory.id)
  })

  it('shows the product read-only without catalog.write', async () => {
    const readOnly = (p: Product): Product => ({ ...p, can: { update: false, delete: false } })
    editHandlers(() => ({ ...readOnly(dimmer), variants: dimmer.variants.map((v) => ({ ...v, can: { update: false, delete: false } })) }))
    renderRoutes(routes, { me: userMe, route: editRoute })

    expect(await screen.findByRole('heading', { name: 'Dimmer 4ch' })).toBeInTheDocument()
    expect(screen.getByText('You can view this product but not change it.')).toBeInTheDocument()
    expect(screen.getByLabelText('Model number')).toBeDisabled()
    expect(inAttributes('Width')).toBeDisabled()
    expect(inAttributes('DALI')).toBeDisabled()
    expect(attributes()).toHaveTextContent('DALI')
    expect(screen.queryByRole('button', { name: /update|remove|move|delete|add/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /add variant|edit/i })).not.toBeInTheDocument()
    expect(within(region('Variants')).getByRole('link', { name: 'Ivory White' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/catalog/products')
  })

  it('does not offer creating to users without catalog.write', async () => {
    renderRoutes(appRoutes, { me: userMe, route: '/catalog/products/new' })

    expect(await screen.findByText('You do not have permission to see this page.')).toBeInTheDocument()
  })

  it.each([
    ['does not exist', () => problem(404, { code: 'product.not_found' })],
    ['id is invalid', () => problem(422, { code: 'validation.failed', fields: [{ location: 'path.id', code: 'validation.invalid' }] })],
  ])('shows not found when the product %s', async (_, respond) => {
    server.use(
      http.get('/api/product-types', () => HttpResponse.json({ items: types })),
      http.get('/api/categories', () => HttpResponse.json({ items: categories })),
      http.get('/api/products/:id', respond),
    )
    renderRoutes(routes, { me: adminMe, route: editRoute })

    expect(await screen.findByRole('heading', { name: 'Product not found' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to list' })).toHaveAttribute('href', '/catalog/products')
  })
})
