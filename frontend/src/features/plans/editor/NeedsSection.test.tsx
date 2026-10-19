import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useReducer } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { NeedWarning, PlanNeed, PlanZone } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { chooseOption } from '@/test/select'

import { functionTypes, loadTypes, needCatalog, pid } from '../test-fixtures'
import type { PlanDocument } from './document'
import { type EditorAction, editorReducer, initEditor } from './editor-state'
import { Inspector } from './Inspector'
import { newNeed } from './needs'

const zone: PlanZone = {
  id: pid(950),
  name: 'Living',
  color: '#3b82f6',
  opacity: 0.25,
  points: [
    [0, 0],
    [300, 0],
    [300, 300],
    [0, 300],
  ],
}
const need = (n: number, over: Partial<PlanNeed> = {}): PlanNeed => ({ ...newNeed(functionTypes[0].id, zone.id), id: pid(1300 + n), ...over })

/** The inspector over a real reducer with undo buttons, so steps can be checked. */
function Harness({ needs, selection, spy, warnings = new Map(), errors = new Map() }: { needs: PlanNeed[]; selection: string[]; spy: (a: EditorAction) => void; warnings?: Map<string, NeedWarning[]>; errors?: Map<string, string[]> }) {
  const start: PlanDocument = { scale: null, zones: [zone], placements: [], needs }
  const [state, dispatch] = useReducer(editorReducer, start, initEditor)
  const doc = state.history.present
  return (
    <>
      <button type="button" onClick={() => dispatch({ type: 'undo' })}>
        undo
      </button>
      <output data-testid="needs">{JSON.stringify(doc.needs.map((n) => [n.label || n.functionTypeId, n.quantity]))}</output>
      <Inspector
        placements={[]}
        zones={doc.zones.filter((z) => selection.includes(z.id))}
        needs={doc.needs.filter((n) => selection.includes(n.id))}
        allNeeds={doc.needs}
        allZones={doc.zones}
        needCatalog={needCatalog}
        needWarnings={warnings}
        allPlacements={[]}
        variants={new Map()}
        allVariants={[]}
        image={{ width: 1000, height: 800 }}
        products={[]}
        warnings={new Map()}
        errors={errors}
        editable
        dispatch={(a) => {
          spy(a)
          dispatch(a)
        }}
        resizeAll={false}
        onResizeAll={vi.fn()}
        activeVertex={null}
        onActiveVertex={vi.fn()}
      />
    </>
  )
}

const needsOf = () => JSON.parse(screen.getByTestId('needs').textContent ?? '[]') as [string, number][]

describe('zone needs section', () => {
  it('lists needs in plain words with errors and warnings at the row; reorders and deletes', async () => {
    const user = userEvent.setup()
    const needs = [need(1, { quantity: 3, powerW: 60, loadTypeId: loadTypes[0].id, label: 'Ceiling', note: 'Over the table' }), need(2, { functionTypeId: functionTypes[1].id, label: 'Window' })]
    renderWithProviders(
      <Harness
        needs={needs}
        selection={[zone.id]}
        spy={vi.fn()}
        warnings={new Map([[pid(1302), [{ needId: pid(1302), code: 'need_function_type_inactive' }]]])}
        errors={new Map([[pid(1301), ['Must be between 1 and 100.']]])}
      />,
    )
    const section = screen.getByRole('region', { name: 'Needs' })
    const first = within(section).getByRole('listitem', { name: '3 × Dimmable light · 60 W · LED · Ceiling' })
    expect(within(first).getByText('Over the table')).toBeInTheDocument()
    expect(within(first).getByRole('alert')).toHaveTextContent('Must be between 1 and 100.')
    expect(within(section).getByText('The function type is inactive in the catalog.')).toBeInTheDocument()

    await user.click(within(section).getByRole('button', { name: 'Move Blind · Window up' }))
    expect(needsOf()).toEqual([
      ['Window', 1],
      ['Ceiling', 3],
    ])
    await user.click(within(section).getByRole('button', { name: 'Delete Blind · Window' }))
    expect(needsOf()).toEqual([['Ceiling', 3]])
    await user.click(screen.getByRole('button', { name: 'undo' }))
    await user.click(screen.getByRole('button', { name: 'undo' }))
    expect(needsOf()).toEqual([
      ['Ceiling', 3],
      ['Window', 1],
    ])
  })

  it('adds a need of an active function and edits it, one undo step per field', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness needs={[]} selection={[zone.id]} spy={vi.fn()} />)
    const section = screen.getByRole('region', { name: 'Needs' })
    expect(within(section).getByText('No needs yet.')).toBeInTheDocument()

    const add = within(section).getByRole('combobox', { name: 'Add need' })
    await user.click(add)
    // Inactive function types are not offered.
    expect(screen.queryByRole('option', { name: 'Old function' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('option', { name: 'Dimmable light' }))
    expect(needsOf()).toEqual([[functionTypes[0].id, 1]])

    // The new need opens for editing; the load type list follows the function type.
    await user.clear(within(section).getByRole('spinbutton', { name: /Quantity/ }))
    await user.type(within(section).getByRole('spinbutton', { name: /Quantity/ }), '4')
    await user.type(within(section).getByRole('textbox', { name: 'Power per unit' }), '7,5')
    await user.type(within(section).getByRole('textbox', { name: 'Label' }), 'Ceiling')
    await user.click(within(section).getByRole('combobox', { name: 'Load type' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'LED'])
    await user.click(screen.getByRole('option', { name: 'LED' }))
    await user.click(within(section).getByRole('button', { name: 'Done' }))
    expect(within(section).getByRole('listitem', { name: '4 × Dimmable light · 7.5 W · LED · Ceiling' })).toBeInTheDocument()

    // Load type, label, power and quantity were one step each.
    for (let i = 0; i < 4; i++) await user.click(screen.getByRole('button', { name: 'undo' }))
    expect(needsOf()).toEqual([[functionTypes[0].id, 1]])
  })

  it('applies a room template in one undo step and says which lines were skipped', async () => {
    const user = userEvent.setup()
    const spy = vi.fn()
    renderWithProviders(<Harness needs={[]} selection={[zone.id]} spy={spy} />)
    const section = screen.getByRole('region', { name: 'Needs' })
    await chooseOption(user, within(section).getByRole('combobox', { name: 'Apply template' }), 'Living room · Comfort')

    expect(needsOf()).toEqual([
      ['Ceiling', 3],
      [functionTypes[1].id, 2],
    ])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(within(section).getByText('2 needs added from “Living room”.')).toBeInTheDocument()
    expect(within(section).getByText('1 line was skipped: its function type or load type is inactive.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'undo' }))
    expect(needsOf()).toEqual([])
  })

  it('shows a selected load symbol with its fields and zone', async () => {
    const user = userEvent.setup()
    const symbol = need(5, { x: 100, y: 100, zoneId: null, label: 'Hall' })
    renderWithProviders(<Harness needs={[symbol]} selection={[symbol.id]} spy={vi.fn()} />)
    expect(screen.getByText('Dimmable light · Hall')).toBeInTheDocument()
    expect(screen.getByText('Zone: Living')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(needsOf()).toEqual([])
  })
})
