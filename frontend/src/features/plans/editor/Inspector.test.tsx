import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useReducer, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { PlanPlacement, PlanZone } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { catalog, pid, placement, zigbeeId } from '../test-fixtures'
import { paletteProducts } from './catalog'
import { type PlanDocument } from './document'
import { type EditorAction, editorReducer, initEditor } from './editor-state'
import { Inspector } from './Inspector'
import type { ActiveVertex } from './PlanCanvas'

const variants = new Map(catalog.map((v) => [v.id, v]))
const square: number[][] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
]
const zone = (over: Partial<PlanZone> = {}): PlanZone => ({ id: pid(950), name: 'Zone 1', color: '#3b82f6', opacity: 0.25, points: square, ...over })

const required = pid(990)
const optional = pid(991)
const unavailable = pid(992)

function serveCatalog() {
  server.use(
    http.get('/api/products/:id', () =>
      HttpResponse.json({
        id: catalog[0].productId,
        variants: [
          {
            id: catalog[0].id,
            addons: [
              { addonVariantId: required, productId: pid(880), productName: { en: 'Frame' }, variantName: { en: 'White' }, required: true, available: true, modelNumber: 'F', price: '1.00', sortOrder: 1 },
              { addonVariantId: optional, productId: pid(881), productName: { en: 'Battery' }, variantName: { en: 'AA' }, required: false, available: true, modelNumber: 'B', price: '1.00', sortOrder: 2 },
              { addonVariantId: unavailable, productId: pid(882), productName: { en: 'Cover' }, variantName: { en: 'Grey' }, required: false, available: false, modelNumber: 'C', price: '1.00', sortOrder: 3 },
            ],
          },
        ],
      }),
    ),
    http.get('/api/categories/:id', () =>
      HttpResponse.json({
        id: catalog[0].categoryId,
        instanceAttributes: [
          { key: 'address', type: 'text', label: { en: 'Bus address' } },
          { key: 'power', type: 'number', label: { en: 'Power' }, unit: 'W' },
        ],
      }),
    ),
  )
}

/** The inspector over a real reducer: what it dispatches changes the document it shows. */
function Harness({ doc, selection, spy, initialVertex = null, resizeAll: initialResizeAll = false }: { doc: PlanDocument; selection: string[]; spy: (a: EditorAction) => void; initialVertex?: ActiveVertex | null; resizeAll?: boolean }) {
  const [state, dispatch] = useReducer(editorReducer, doc, initEditor)
  const [resizeAll, setResizeAll] = useState(initialResizeAll)
  const [vertex, setVertex] = useState<ActiveVertex | null>(initialVertex)
  const present = state.history.present
  return (
    <Inspector
      placements={present.placements.filter((p) => selection.includes(p.id))}
      zones={present.zones.filter((z) => selection.includes(z.id))}
      allPlacements={present.placements}
      variants={variants}
      allVariants={catalog}
      image={{ width: 1000, height: 800 }}
      products={paletteProducts(catalog, [zigbeeId])}
      warnings={new Map()}
      errors={new Map()}
      editable
      dispatch={(a) => {
        spy(a)
        dispatch(a)
      }}
      resizeAll={resizeAll}
      onResizeAll={setResizeAll}
      activeVertex={vertex}
      onActiveVertex={setVertex}
    />
  )
}

const docOf = (placements: PlanPlacement[], zones: PlanZone[] = []): PlanDocument => ({ scale: null, placements, zones })
const lastChange = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0] as Extract<EditorAction, { type: 'change' }>

describe('Inspector', () => {
  it('says what to do with nothing selected', () => {
    const spy = vi.fn()
    renderWithProviders(<Harness doc={docOf([])} selection={[]} spy={spy} />)
    expect(screen.getByText(/Select a product or zone/)).toBeInTheDocument()
  })

  describe('zone', () => {
    it('renames with one undo key, picks a palette colour and sets the opacity in percent', async () => {
      const spy = vi.fn()
      const user = userEvent.setup()
      const z = zone()
      renderWithProviders(<Harness doc={docOf([], [z])} selection={[z.id]} spy={spy} />)

      const name = screen.getByLabelText(/^Name/)
      await user.clear(name)
      await user.type(name, 'Kitchen')
      expect(name).toHaveValue('Kitchen')
      expect(lastChange(spy)).toEqual({ type: 'change', action: { type: 'updateZones', changes: [{ id: z.id, patch: { name: 'Kitchen' } }] }, key: `${z.id}:name` })

      await user.click(screen.getByRole('button', { name: 'Use colour #22c55e' }))
      expect(lastChange(spy).action).toEqual({ type: 'updateZones', changes: [{ id: z.id, patch: { color: '#22c55e' } }] })
      expect(screen.getByRole('button', { name: 'Use colour #22c55e' })).toHaveAttribute('aria-pressed', 'true')

      const opacity = screen.getByLabelText('Opacity')
      expect(opacity).toHaveValue(25)
      await user.clear(opacity)
      await user.type(opacity, '50')
      expect(lastChange(spy).action).toEqual({ type: 'updateZones', changes: [{ id: z.id, patch: { opacity: 0.5 } }] })
    })

    it('removes the active corner, never below three', async () => {
      const spy = vi.fn()
      const user = userEvent.setup()
      const z = zone()
      renderWithProviders(<Harness doc={docOf([], [z])} selection={[z.id]} spy={spy} initialVertex={{ zoneId: z.id, index: 1 }} />)

      expect(screen.getByText('4 corners')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Remove selected corner' }))
      expect(lastChange(spy).action).toEqual({ type: 'updateZones', changes: [{ id: z.id, patch: { points: [square[0], square[2], square[3]] } }] })
      expect(screen.getByText('3 corners')).toBeInTheDocument()
      // The active corner is cleared, and three are the minimum anyway.
      expect(screen.getByRole('button', { name: 'Remove selected corner' })).toBeDisabled()
    })

    it('cannot remove a corner without an active one', () => {
      const z = zone()
      renderWithProviders(<Harness doc={docOf([], [z])} selection={[z.id]} spy={vi.fn()} />)
      expect(screen.getByRole('button', { name: 'Remove selected corner' })).toBeDisabled()
    })
  })

  describe('placement', () => {
    it('shows required add-ons fixed, toggles optional ones and marks unavailable ones', async () => {
      serveCatalog()
      const spy = vi.fn()
      const user = userEvent.setup()
      const p = placement(1, { variantId: catalog[0].id })
      renderWithProviders(<Harness doc={docOf([p])} selection={[p.id]} spy={spy} />)

      const frame = await screen.findByRole('checkbox', { name: 'Frame – White' })
      expect(frame).toBeChecked()
      expect(frame).toBeDisabled()
      expect(screen.getByText('Required: always included')).toBeInTheDocument()
      const cover = screen.getByRole('checkbox', { name: 'Cover – Grey' })
      expect(cover).toBeDisabled()
      expect(screen.getByText('Not available')).toBeInTheDocument()

      const battery = screen.getByRole('checkbox', { name: 'Battery – AA' })
      expect(battery).not.toBeChecked()
      await user.click(battery)
      expect(lastChange(spy).action).toEqual({ type: 'updatePlacements', changes: [{ id: p.id, patch: { addonVariantIds: [optional] } }] })
      expect(battery).toBeChecked()
      await user.click(battery)
      expect(lastChange(spy).action).toEqual({ type: 'updatePlacements', changes: [{ id: p.id, patch: { addonVariantIds: [] } }] })
    })

    it('edits instance values of the category', async () => {
      serveCatalog()
      const spy = vi.fn()
      const user = userEvent.setup()
      const p = placement(1, { variantId: catalog[0].id })
      renderWithProviders(<Harness doc={docOf([p])} selection={[p.id]} spy={spy} />)

      const address = await screen.findByLabelText('Bus address')
      await user.type(address, '1.1.5')
      expect(address).toHaveValue('1.1.5')
      expect(lastChange(spy)).toEqual({
        type: 'change',
        action: { type: 'updatePlacements', changes: [{ id: p.id, patch: { instanceValues: { address: '1.1.5' } } }] },
        key: `${p.id}:attr:address`,
      })

      const power = screen.getByLabelText('Power')
      await user.type(power, '2,5')
      expect(power).toHaveValue('2,5')
      expect(lastChange(spy).action).toEqual({ type: 'updatePlacements', changes: [{ id: p.id, patch: { instanceValues: { address: '1.1.5', power: 2.5 } } }] })

      // Text that is no number is kept with its error and not written.
      const calls = spy.mock.calls.length
      await user.clear(power)
      await user.type(power, 'x')
      expect(power).toHaveValue('x')
      expect(spy.mock.calls.length).toBe(calls + 1) // the clear removed the value; "x" wrote nothing
      expect(lastChange(spy).action).toEqual({ type: 'updatePlacements', changes: [{ id: p.id, patch: { instanceValues: { address: '1.1.5' } } }] })
    })

    it('resizes every placement of the product when "resize all" is on', async () => {
      serveCatalog()
      const spy = vi.fn()
      const user = userEvent.setup()
      // Variants 1 and 2 are one product; 3 is another.
      const a = placement(1, { variantId: catalog[0].id })
      const b = placement(2, { variantId: catalog[1].id })
      const c = placement(3, { variantId: catalog[2].id })
      renderWithProviders(<Harness doc={docOf([a, b, c])} selection={[a.id]} spy={spy} />)

      const resizeAll = screen.getByRole('switch', { name: 'Resize all of this product' })
      expect(screen.getByText(/all 2 placements of this product/)).toBeInTheDocument()
      await user.click(resizeAll)
      expect(resizeAll).toBeChecked()

      const width = screen.getByLabelText('Width')
      await user.clear(width)
      await user.type(width, '80')
      expect(lastChange(spy)).toEqual({
        type: 'change',
        action: {
          type: 'updatePlacements',
          changes: [
            { id: a.id, patch: { width: 80 } },
            { id: b.id, patch: { width: 80 } },
          ],
        },
        key: `${a.id}:width`,
      })
    })
  })

  describe('product and geometry', () => {
    it('changes the product in one step, keeping the placement and dropping what does not apply', async () => {
      serveCatalog()
      const spy = vi.fn()
      const user = userEvent.setup()
      const p = placement(1, { variantId: catalog[0].id, label: 'Hall', existing: true, addonVariantIds: [optional], instanceValues: { address: '1.1.5' } })
      renderWithProviders(<Harness doc={docOf([p])} selection={[p.id]} spy={spy} />)

      await user.click(screen.getByRole('button', { name: 'Change product' }))
      await user.type(screen.getByRole('searchbox', { name: 'Change product' }), 'motion')
      expect(screen.queryByRole('button', { name: /Wall switch/ })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /Motion sensor/ }))
      // Another category: add-ons and instance values go; position, size, label and existing stay (not in the patch).
      expect(lastChange(spy)).toEqual({
        type: 'change',
        action: { type: 'updatePlacements', changes: [{ id: p.id, patch: { variantId: catalog[2].id, addonVariantIds: [], instanceValues: {} } }] },
        key: undefined,
      })
      expect(screen.getByText('Motion sensor')).toBeInTheDocument()
    })

    it('keeps positions and sizes inside the image', async () => {
      serveCatalog()
      const spy = vi.fn()
      const user = userEvent.setup()
      const p = placement(1, { variantId: catalog[0].id })
      renderWithProviders(<Harness doc={docOf([p])} selection={[p.id]} spy={spy} />)
      const width = screen.getByLabelText('Width')
      await user.clear(width)
      await user.type(width, '2000')
      expect(lastChange(spy).action).toEqual({ type: 'updatePlacements', changes: [{ id: p.id, patch: { width: 1000 } }] })
      const x = screen.getByLabelText('X')
      await user.clear(x)
      await user.type(x, '1500')
      expect(lastChange(spy).action).toEqual({ type: 'updatePlacements', changes: [{ id: p.id, patch: { x: 1000 } }] })
    })
  })

  describe('multi-selection', () => {
    it('shows the count, toggles existing for all products and deletes everything selected', async () => {
      const spy = vi.fn()
      const user = userEvent.setup()
      const a = placement(1, { existing: true })
      const b = placement(2)
      const z = zone()
      renderWithProviders(<Harness doc={docOf([a, b], [z])} selection={[a.id, b.id, z.id]} spy={spy} />)

      expect(screen.getByText('3 items selected.')).toBeInTheDocument()
      expect(screen.getByText('Products: 2 · Zones: 1')).toBeInTheDocument()
      const existing = screen.getByRole('switch', { name: 'Existing' })
      expect(existing).not.toBeChecked()
      await user.click(existing)
      expect(lastChange(spy).action).toEqual({
        type: 'updatePlacements',
        changes: [
          { id: a.id, patch: { existing: true } },
          { id: b.id, patch: { existing: true } },
        ],
      })
      await waitFor(() => expect(existing).toBeChecked())

      await user.click(screen.getByRole('button', { name: 'Delete 3 items' }))
      expect(lastChange(spy).action).toEqual({ type: 'remove', ids: [a.id, b.id, z.id] })
      expect(within(document.body).getByText(/Select a product or zone/)).toBeInTheDocument()
    })
  })
})
