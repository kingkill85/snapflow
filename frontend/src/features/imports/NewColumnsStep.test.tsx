import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import type { CatalogField, ImportColumnAnswers, ImportColumns, ImportMapping } from '@/api/generated/model'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'
import { chooseOption } from '@/test/select'

import { ImportRunPage } from './ImportRunPage'
import { id, lookups, mapping, previewed, previewHandler, previewLists, problem, run, runHandlers, zigbee } from './test-fixtures'

// The "New columns – what do they mean?" step (D188): a preview blocked by
// unknown columns asks for their meaning, saves the answers and previews
// the answered mapping.

const routes = [
  { path: '/catalog/imports', element: <p>runs</p> },
  { path: '/catalog/imports/:id', element: <ImportRunPage /> },
]
const runRoute = `/catalog/imports/${id(1)}`
const at = '2026-10-18T12:00:00Z'

vi.setConfig({ testTimeout: 20_000 })

/** The run's mapping: column D (Price) is imported as the attribute dimmer_w, which no catalog field knows. */
const withAttribute: ImportMapping = { ...mapping, fields: [...mapping.fields, { target: 'attribute.dimmer_w', column: 'Price', columnLetter: 'D' }] }

const widthField: CatalogField = {
  id: id(701),
  key: 'width_te',
  label: { en: 'Width' },
  type: 'number',
  unit: 'TE',
  meaning: 'rail_width_te',
  options: [],
  productTypeIds: [],
  sortOrder: 1,
  createdAt: at,
  updatedAt: at,
  can: { update: true, delete: true },
}

const check = (m: ImportMapping): ImportColumns => ({
  mapping: m,
  unknown: 1,
  columns: [
    { fieldIndex: 3, target: 'attribute.dimmer_w', key: 'dimmer_w', column: 'Price', columnLetter: 'D', status: 'unknown' },
    { fieldIndex: 4, target: 'attribute.width_te', key: 'width_te', column: 'Width', columnLetter: 'E', status: 'field', field: widthField },
  ],
})

/** The lookups of the step, the column check, and the answers (recorded, answered by `answer`). */
function columnHandlers(answer: (body: ImportColumnAnswers) => Response) {
  const answers: ImportColumnAnswers[] = []
  server.use(
    http.get('/api/catalog-field-meanings', () =>
      HttpResponse.json({
        items: [
          { meaning: 'channels_supplied', outputKind: true, loadType: false, types: ['integer'] },
          { meaning: 'channel_limit_w', outputKind: true, loadType: true, types: ['number', 'integer'] },
        ],
      }),
    ),
    http.get('/api/output-kinds', () =>
      HttpResponse.json({ items: [{ id: id(801), key: 'dimmer_output', name: { en: 'Dimmer output' }, isActive: true, functionTypeIds: [], sortOrder: 1, createdAt: at, updatedAt: at, can: { update: true, delete: true } }] }),
    ),
    http.get('/api/load-types', () =>
      HttpResponse.json({ items: [{ id: id(811), key: 'led', name: { en: 'LED' }, isActive: true, sortOrder: 1, createdAt: at, updatedAt: at, can: { update: true, delete: true } }] }),
    ),
    http.get('/api/product-types', () => HttpResponse.json({ items: [zigbee] })),
    http.post('/api/import-columns', async ({ request }) => {
      const body = (await request.json()) as { mapping: ImportMapping }
      return HttpResponse.json(check(body.mapping))
    }),
    http.post('/api/import-columns/answers', async ({ request }) => {
      const body = (await request.json()) as ImportColumnAnswers
      answers.push(body)
      return answer(body)
    }),
  )
  return answers
}

/** The preview: blocked while the mapping has an unanswered attribute column, else previewed. */
const blockedUntilAnswered = (body: { mapping?: ImportMapping }) =>
  body.mapping?.fields.some((f) => f.target === 'attribute.dimmer_w' && !f.fieldKey && !f.information)
    ? problem(422, { code: 'import.columns_unknown', params: { count: 1, columns: 'attribute.dimmer_w' } })
    : HttpResponse.json(previewed({ mapping: body.mapping }))

describe('NewColumnsStep', () => {
  it('lists the unknown and the known columns; "just information" continues to the preview', async () => {
    lookups([])
    runHandlers(() => run({ mapping: withAttribute }))
    const answers = columnHandlers((body) =>
      HttpResponse.json({ ...check(body.mapping), unknown: 0, mapping: { ...body.mapping, fields: body.mapping.fields.map((f) => (f.target === 'attribute.dimmer_w' ? { ...f, information: true } : f)) } }),
    )
    const bodies = previewHandler(blockedUntilAnswered)
    previewLists()
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    await user.click(await screen.findByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('heading', { name: 'New columns – what do they mean?' })).toBeInTheDocument()
    const row = screen.getByRole('listitem', { name: 'Column "Price" (D)' })
    expect(within(row).getByText('attribute dimmer_w')).toBeInTheDocument()
    // The known column, with its field and meaning.
    expect(screen.getByText('Catalog field "Width" · Width on the DIN rail (TE)')).toBeInTheDocument()

    await chooseOption(user, within(row).getByRole('combobox', { name: 'This column is' }), 'Just information')
    expect(within(row).queryByLabelText(/Field key/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save answers and preview' }))

    await waitFor(() => expect(answers).toHaveLength(1))
    expect(answers[0].answers).toEqual([{ target: 'attribute.dimmer_w', information: true }])
    // The answered mapping is previewed.
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1].mapping?.fields.find((f) => f.target === 'attribute.dimmer_w')).toMatchObject({ information: true })
  })

  it('creates a new field with its meaning and shows its errors at the row', async () => {
    lookups([])
    runHandlers(() => run({ mapping: withAttribute }))
    let fail = true
    const answers = columnHandlers((body) => {
      if (fail) {
        fail = false
        return problem(422, {
          code: 'validation.failed',
          fields: [{ location: 'body.answers[0].field.key', code: 'catalog_field.key_taken', params: { key: 'dimmer_w' } }],
        })
      }
      return HttpResponse.json({
        ...check(body.mapping),
        unknown: 0,
        mapping: { ...body.mapping, fields: body.mapping.fields.map((f) => (f.target === 'attribute.dimmer_w' ? { ...f, fieldKey: 'dimmer_led_w' } : f)) },
      })
    })
    const bodies = previewHandler(blockedUntilAnswered)
    previewLists()
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    await user.click(await screen.findByRole('button', { name: 'Preview' }))
    const row = await screen.findByRole('listitem', { name: 'Column "Price" (D)' })
    await chooseOption(user, within(row).getByRole('combobox', { name: 'Meaning for the checks' }), 'Max watts per channel (per load type)')
    // The meaning's type and parameters follow.
    expect(within(row).getByRole('combobox', { name: /Value type/ })).toHaveTextContent('Number')
    await chooseOption(user, within(row).getByRole('combobox', { name: /Output kind/ }), 'Dimmer output')
    await chooseOption(user, within(row).getByRole('combobox', { name: /Load type/ }), 'LED')
    await user.type(within(row).getByRole('textbox', { name: /Unit/ }), 'W')
    await user.click(screen.getByRole('button', { name: 'Save answers and preview' }))

    expect(await within(row).findByText('The key "dimmer_w" is already used.')).toBeInTheDocument()
    expect(within(row).getByRole('textbox', { name: /Field key/ })).toHaveAttribute('aria-invalid', 'true')
    expect(answers[0].answers[0]).toEqual({
      target: 'attribute.dimmer_w',
      field: { key: 'dimmer_w', label: { en: 'Price' }, type: 'number', unit: 'W', meaning: 'channel_limit_w', outputKindId: id(801), loadTypeId: id(811) },
    })

    const key = within(row).getByRole('textbox', { name: /Field key/ })
    await user.clear(key)
    await user.type(key, 'dimmer_led_w')
    await user.click(screen.getByRole('button', { name: 'Save answers and preview' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1].mapping?.fields.find((f) => f.target === 'attribute.dimmer_w')).toMatchObject({ fieldKey: 'dimmer_led_w' })
  })

  it('goes back to the mapping without answering', async () => {
    lookups([])
    runHandlers(() => run({ mapping: withAttribute }))
    columnHandlers(() => HttpResponse.json({}))
    previewHandler(blockedUntilAnswered)
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    await user.click(await screen.findByRole('button', { name: 'Preview' }))
    await user.click(await screen.findByRole('button', { name: 'Back to the mapping' }))
    expect(await screen.findByRole('button', { name: 'Preview' })).toBeInTheDocument()
  })

  it('shows the columns a previewed mapping linked to catalog fields', async () => {
    lookups()
    const linked: ImportMapping = {
      ...mapping,
      fields: [
        ...mapping.fields,
        { target: 'attribute.width_te', column: 'Width', columnLetter: 'E', fieldKey: 'width_te' },
        { target: 'attribute.notes', column: 'Notes', columnLetter: 'F', information: true },
      ],
    }
    runHandlers(() => previewed({ mapping: linked }))
    previewLists()
    server.use(http.get('/api/catalog-fields', () => HttpResponse.json({ items: [widthField] })))
    renderRoutes(routes, { route: runRoute })

    const known = await screen.findByRole('region', { name: 'Known columns' })
    expect(await within(known).findByText('Catalog field "Width" · Width on the DIN rail (TE)')).toBeInTheDocument()
    expect(within(known).getByText('Just information')).toBeInTheDocument()
  })
})
