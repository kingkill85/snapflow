import { createEvent, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useReducer } from 'react'
import { describe, expect, it } from 'vitest'

import { renderWithProviders } from '@/test/render'

import { boardCaps, pid } from '../test-fixtures'
import { type BoardDocument, type BoardModuleDoc, moduleWidth, newModule } from './board'
import { type BoardState, boardReducer, initBoard } from './board-state'
import { BoardGrid, moduleDragType } from './BoardGrid'

const r1 = pid(1)
const r2 = pid(2)
const mod = (n: number, rowId: string, offsetTe: number): BoardModuleDoc => ({ ...newModule('w2', rowId, offsetTe), id: `m${n}`, label: `M${n}` })
const widthOf = (m: BoardModuleDoc) => moduleWidth(m.variantId, () => boardCaps(2))

/** The grid with the editor's reducer; `latest` is the state after each render. */
function harness(doc: BoardDocument) {
  const latest: { state?: BoardState } = {}
  function Harness() {
    const [state, dispatch] = useReducer(boardReducer, doc, initBoard)
    useEffect(() => {
      latest.state = state
    })
    return (
      <BoardGrid
        doc={state.history.present}
        selection={state.selection}
        variants={new Map()}
        widthOf={widthOf}
        warnings={new Map()}
        errorIds={new Set()}
        editable
        dispatch={dispatch}
        onPlace={() => undefined}
        armed={null}
        productWidth={() => 1}
      />
    )
  }
  renderWithProviders(<Harness />)
  return latest
}

const board = (modules: BoardModuleDoc[]): BoardDocument => ({
  enclosureVariantId: null,
  enclosureExisting: false,
  removeEnclosure: false,
  rows: [
    { id: r1, capacityTe: 12 },
    { id: r2, capacityTe: 12 },
  ],
  modules,
})

const rail = (n: number) => screen.getByRole('group', { name: new RegExp(`^Row ${n}:`) })
const box = (n: number) => screen.getByRole('button', { name: new RegExp(`M${n}`) })

describe('BoardGrid', () => {
  it('moves a module to another row by drag and drop, into the nearest free gap', () => {
    const latest = harness(board([mod(1, r1, 0), mod(2, r2, 4)]))
    const data = new Map<string, string>()
    const dataTransfer = { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? '', types: [moduleDragType], effectAllowed: '', dropEffect: '' }
    fireEvent.dragStart(box(1), { dataTransfer })
    // jsdom has no DragEvent: the pointer position is set on the event by hand.
    const pxPerTe = Math.min(64, Math.max(22, (800 - 96) / 12))
    const drop = createEvent.drop(rail(2), { dataTransfer })
    // Aimed at 4.5 TE (centre of a 2 TE module at 4.5), where M2 sits: it lands right after M2.
    Object.defineProperty(drop, 'clientX', { value: 5.5 * pxPerTe })
    fireEvent(rail(2), drop)
    const moved = latest.state?.history.present.modules.find((m) => m.id === 'm1')
    expect(moved).toMatchObject({ rowId: r2, offsetTe: 6 })
    expect(latest.state?.selection).toEqual(['m1'])
  })

  it('merges a run of arrow moves into one undo step', async () => {
    const user = userEvent.setup()
    const latest = harness(board([mod(1, r1, 0)]))
    box(1).focus()
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    expect(latest.state?.history.present.modules[0].offsetTe).toBe(1.5)
    expect(latest.state?.history.past).toHaveLength(1)
    // The focus stays on the moved module (set in the next frame).
    await waitFor(() => expect(box(1)).toHaveFocus())
  })

  it('moves the focus to the neighbour after Delete, then to the rail', async () => {
    const user = userEvent.setup()
    const latest = harness(board([mod(1, r1, 0), mod(2, r1, 4), mod(3, r1, 8)]))
    box(2).focus()
    await user.keyboard('{Delete}')
    await waitFor(() => expect(box(3)).toHaveFocus())
    await user.keyboard('{Delete}')
    await waitFor(() => expect(box(1)).toHaveFocus())
    await user.keyboard('{Delete}')
    await waitFor(() => expect(rail(1)).toHaveFocus())
    expect(latest.state?.history.present.modules).toEqual([])
  })

  it('draws the TE ticks as one rail element per row', () => {
    harness(board([]))
    expect(screen.getAllByTestId('rail')).toHaveLength(2)
  })
})
