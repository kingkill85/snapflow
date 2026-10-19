import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useEffect, useReducer } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Capabilities, VariantSearchItem } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { boardCaps, pid, variant } from '../test-fixtures'
import { type BoardDocument, type BoardModuleDoc, boardPaletteProducts, moduleWidth } from './board'
import { boardReducer, initBoard } from './board-state'
import { BoardSettings, ModuleInspector } from './BoardPanels'

const r1 = pid(1)
const r2 = pid(2)
const actuator = variant(1, { productName: { en: 'Actuator' }, capabilities: boardCaps(4, { channels: [{ outputKindId: pid(60), outputKindKey: 'relay', count: 8, limitsW: [], limitsA: [], minLoadsW: [], alternatives: [] }] }) })
const wide = variant(2, { productName: { en: 'Wide one' }, capabilities: boardCaps(10) })
const enclosure = variant(3, { productName: { en: 'Cabinet' }, capabilities: boardCaps(0, { railWidthTe: undefined, enclosureRows: 1, enclosureTePerRow: 18 }) })
const all: VariantSearchItem[] = [actuator, wide, enclosure]
const byId = new Map(all.map((v) => [v.id, v]))
const caps = (id: string): Capabilities | undefined => byId.get(id)?.capabilities
const widthOf = (m: BoardModuleDoc) => moduleWidth(m.variantId, caps)

const module = (id: string, rowId: string, offsetTe: number): BoardModuleDoc => ({ id, rowId, offsetTe, variantId: actuator.id, label: '', existing: false, addonVariantIds: [], instanceValues: {} })
const start = (modules: BoardModuleDoc[] = []): BoardDocument => ({
  enclosureVariantId: null,
  enclosureExisting: false,
  removeEnclosure: false,
  rows: [
    { id: r1, capacityTe: 12 },
    { id: r2, capacityTe: 12 },
  ],
  modules,
})

const seen: { doc?: BoardDocument } = {}
function Harness({ initial, panel, selection = [], enclosureDeleted = false }: { initial: BoardDocument; panel: 'settings' | 'inspector'; selection?: string[]; enclosureDeleted?: boolean }) {
  const [state, dispatch] = useReducer(boardReducer, initial, (d) => ({ ...initBoard(d), selection }))
  useEffect(() => {
    seen.doc = state.history.present
  })
  return panel === 'settings' ? (
    <BoardSettings doc={state.history.present} enclosures={[enclosure]} variants={byId} caps={caps} widthOf={widthOf} editable dispatch={dispatch} warnings={[]} enclosureDeleted={enclosureDeleted} />
  ) : (
    <ModuleInspector
      doc={state.history.present}
      modules={state.history.present.modules.filter((m) => state.selection.includes(m.id))}
      variants={byId}
      allVariants={all}
      products={boardPaletteProducts(all, [actuator.productTypeId])}
      caps={caps}
      widthOf={widthOf}
      warnings={new Map()}
      errors={new Map()}
      editable
      dispatch={dispatch}
      onNotice={(text) => {
        notices.push(text)
      }}
    />
  )
}
let notices: string[] = []

beforeEach(() => {
  notices = []
  server.use(
    http.get('/api/output-kinds', () => HttpResponse.json({ items: [{ id: pid(60), key: 'relay', name: { en: 'Relay output' }, isActive: true }] })),
    http.get('/api/load-types', () => HttpResponse.json({ items: [] })),
    http.get('/api/products/:id', () => HttpResponse.json({ id: actuator.productId, variants: [{ id: actuator.id, addons: [] }] })),
    http.get('/api/categories/:id', () => HttpResponse.json({ id: actuator.categoryId, instanceAttributes: [] })),
  )
})

describe('rows editor', () => {
  it('adds a row, changes a capacity, removes only empty rows', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={start([module('m1', r1, 0)])} panel="settings" />)
    expect(screen.getByRole('button', { name: 'Row 1 has modules and cannot be removed' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    expect(seen.doc!.rows).toHaveLength(3)
    expect(seen.doc!.rows[2].capacityTe).toBe(12)
    const field = screen.getByLabelText('Row 2 in TE')
    await user.clear(field)
    await user.type(field, '24.5')
    expect(seen.doc!.rows[1].capacityTe).toBe(24.5)
    await user.type(field, '5')
    expect(screen.getByText(/one decimal/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove row 3' }))
    expect(seen.doc!.rows).toHaveLength(2)
  })

  it('choosing an enclosure fits rows to it (D357) and hides the rows editor', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={start([module('m1', r1, 0), module('m2', r2, 0)])} panel="settings" />)
    await user.click(screen.getByRole('combobox', { name: 'Enclosure' }))
    await user.click(screen.getByRole('option', { name: /Cabinet/ }))
    expect(seen.doc!.enclosureVariantId).toBe(enclosure.id)
    expect(seen.doc!.rows).toEqual([{ id: r1, capacityTe: 18 }])
    expect(seen.doc!.modules.find((m) => m.id === 'm2')).toMatchObject({ rowId: r1, offsetTe: 4 })
    expect(screen.getByText('The enclosure gives 1 rows of 18 TE.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add row' })).not.toBeInTheDocument()
  })
})

describe('enclosure flags', () => {
  it('marks an enclosure as existing (not in the BOM), undoable', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={start()} panel="settings" />)
    expect(screen.queryByRole('switch', { name: /Enclosure already exists/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'Enclosure' }))
    await user.click(screen.getByRole('option', { name: /Cabinet/ }))
    await user.click(screen.getByRole('switch', { name: /Enclosure already exists/ }))
    expect(seen.doc!.enclosureExisting).toBe(true)
    expect(screen.getByText(/not in the bill of materials/)).toBeInTheDocument()
  })

  it('keeps a deleted enclosure until it is removed explicitly', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={start()} panel="settings" enclosureDeleted />)
    expect(screen.getByText(/The enclosure was deleted from the catalog/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /Enclosure already exists/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove enclosure' }))
    expect(seen.doc!.removeEnclosure).toBe(true)
    expect(screen.getByText('The deleted enclosure is removed with the next save.')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /Enclosure already exists/ })).not.toBeInTheDocument()
  })
})

describe('module inspector', () => {
  it('shows capabilities and channels, edits label and existing, moves to another row', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={start([module('m1', r1, 2)])} panel="inspector" selection={['m1']} />)
    expect(screen.getByText('Actuator')).toBeInTheDocument()
    expect(screen.getByText('4 TE at 2 TE')).toBeInTheDocument()
    const capabilities = screen.getByRole('region', { name: 'Capabilities' })
    expect(await within(capabilities).findByText('8 × Relay output')).toBeInTheDocument()
    expect(within(capabilities).getByText(/comes in a later step/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('Label'), 'Q1')
    expect(seen.doc!.modules[0].label).toBe('Q1')
    await user.click(screen.getByRole('switch', { name: /Existing/ }))
    expect(seen.doc!.modules[0].existing).toBe(true)

    await user.click(screen.getByRole('combobox', { name: 'Row' }))
    await user.click(screen.getByRole('option', { name: 'Row 2' }))
    expect(seen.doc!.modules[0]).toMatchObject({ rowId: r2, offsetTe: 2 })
  })

  it('refuses a product change that no longer fits', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={start([module('m1', r1, 0), module('m2', r1, 4)])} panel="inspector" selection={['m1']} />)
    await user.click(screen.getByRole('button', { name: 'Change product' }))
    await user.click(screen.getByRole('button', { name: /Wide one/ }))
    expect(notices).toEqual(['There is no free space for it there.'])
    expect(seen.doc!.modules[0].variantId).toBe(actuator.id)
  })

  it('deletes several selected modules at once', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={start([module('m1', r1, 0), module('m2', r1, 4)])} panel="inspector" selection={['m1', 'm2']} />)
    expect(screen.getByText('2 modules selected.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(seen.doc!.modules).toEqual([])
  })
})
