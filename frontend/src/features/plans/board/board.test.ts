import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'

import { boardCaps, pid, variant } from '../test-fixtures'
import {
  applyBoardAction,
  type BoardDocument,
  type BoardModuleDoc,
  boardPaletteProducts,
  copyModules,
  enclosureSize,
  enclosureVariants,
  fittedBySave,
  fitToEnclosure,
  keyboardMove,
  moduleWidth,
  nearestSlot,
  newModule,
  rowOverflows,
  slotIn,
  snapTe,
} from './board'
import { boardErrorsByModule } from './board-errors'
import { boardReducer, initBoard } from './board-state'

const r1 = pid(1)
const r2 = pid(2)
const mod = (n: number, rowId: string, offsetTe: number, variantId = 'w2'): BoardModuleDoc => ({ ...newModule(variantId, rowId, offsetTe), id: `m${n}` })
// Widths by variant id: "w2" is 2 TE wide, "w4" 4 TE, anything else unknown (1 TE).
const widthOf = (m: BoardModuleDoc) => moduleWidth(m.variantId, (id) => (id === 'w2' ? boardCaps(2) : id === 'w4' ? boardCaps(4) : undefined))
const doc = (modules: BoardModuleDoc[] = []): BoardDocument => ({
  enclosureVariantId: null,
  enclosureExisting: false,
  removeEnclosure: false,
  rows: [
    { id: r1, capacityTe: 12 },
    { id: r2, capacityTe: 12 },
  ],
  modules,
})

describe('slots (snap 0.5 TE, no overlap)', () => {
  it('snaps to half TE', () => {
    expect(snapTe(1.24)).toBe(1)
    expect(snapTe(1.26)).toBe(1.5)
  })

  it('takes the wanted place when free, else the nearest gap', () => {
    const d = doc([mod(1, r1, 2), mod(2, r1, 6)])
    expect(slotIn(d, r1, 2, 0.2, widthOf)).toBe(0)
    // 3 would overlap module 1 [2, 4): the gap [4, 6) takes it.
    expect(slotIn(d, r1, 2, 3.4, widthOf)).toBe(4)
    expect(slotIn(d, r1, 2, 7, widthOf)).toBe(8)
  })

  it('refuses when no gap is wide enough', () => {
    const d = doc([mod(1, r1, 0, 'w4'), mod(2, r1, 4, 'w4'), mod(3, r1, 8, 'w4')])
    expect(slotIn(d, r1, 1, 5, widthOf)).toBeNull()
    expect(nearestSlot([{ start: 0, end: 10 }], 12, 4, 0)).toBeNull()
  })

  it('ignores the moved module itself', () => {
    const d = doc([mod(1, r1, 0, 'w4')])
    expect(slotIn(d, r1, 4, 1, widthOf, new Set(['m1']))).toBe(1)
  })

  it('moves by keyboard half a TE, to another row, and stops at neighbours and ends', () => {
    const d = doc([mod(1, r1, 0), mod(2, r1, 2.5)])
    expect(keyboardMove(d, 'm1', 'left', widthOf)).toBeNull()
    expect(keyboardMove(d, 'm1', 'right', widthOf)).toEqual({ rowId: r1, offsetTe: 0.5 })
    expect(keyboardMove(doc([mod(1, r1, 0), mod(2, r1, 2)]), 'm1', 'right', widthOf)).toBeNull()
    expect(keyboardMove(d, 'm2', 'down', widthOf)).toEqual({ rowId: r2, offsetTe: 2.5 })
    expect(keyboardMove(d, 'm2', 'up', widthOf)).toBeNull()
  })

  it('copies after the source, then into the next row, refusing when the board is full', () => {
    const d = doc([mod(1, r1, 0, 'w4'), mod(2, r1, 4, 'w4')])
    const { modules, refused } = copyModules(d, [d.modules[0], d.modules[1]], widthOf)
    expect(refused).toBe(0)
    expect(modules.map((m) => [m.rowId, m.offsetTe])).toEqual([
      [r1, 8],
      [r2, 0],
    ])
    const full = doc([mod(1, r1, 0, 'w4'), mod(2, r1, 4, 'w4'), mod(3, r1, 8, 'w4'), mod(4, r2, 0, 'w4'), mod(5, r2, 4, 'w4'), mod(6, r2, 8, 'w4')])
    expect(copyModules(full, [full.modules[0]], widthOf)).toEqual({ modules: [], refused: 1 })
  })

  it('reports overflow beyond the capacity', () => {
    expect(rowOverflows(doc([mod(1, r1, 11)]), r1, widthOf)).toBe(true)
    expect(rowOverflows(doc([mod(1, r1, 10)]), r1, widthOf)).toBe(false)
  })
})

describe('document and history', () => {
  it('adds, moves, removes as undoable steps; field edits merge by key', () => {
    let s = initBoard(doc())
    const m = mod(1, r1, 0)
    s = boardReducer(s, { type: 'change', action: { type: 'addModules', modules: [m] }, select: [m.id] })
    s = boardReducer(s, { type: 'change', action: { type: 'updateModules', changes: [{ id: m.id, patch: { offsetTe: 2 } }] } })
    s = boardReducer(s, { type: 'change', action: { type: 'updateModules', changes: [{ id: m.id, patch: { label: 'Q' } }] }, key: 'm1:label' })
    s = boardReducer(s, { type: 'change', action: { type: 'updateModules', changes: [{ id: m.id, patch: { label: 'Q1' } }] }, key: 'm1:label' })
    expect(s.history.past).toHaveLength(3)
    expect(s.selection).toEqual([m.id])
    s = boardReducer(s, { type: 'undo' })
    expect(s.history.present.modules[0]).toMatchObject({ offsetTe: 2, label: '' })
    s = boardReducer(s, { type: 'undo' })
    s = boardReducer(s, { type: 'undo' })
    expect(s.history.present.modules).toEqual([])
    expect(s.selection).toEqual([])
    s = boardReducer(s, { type: 'redo' })
    expect(s.history.present.modules).toHaveLength(1)
  })

  it('a change that changes nothing is no step', () => {
    const d = doc([mod(1, r1, 0)])
    expect(applyBoardAction(d, { type: 'updateModules', changes: [{ id: 'm1', patch: { offsetTe: 0 } }] })).toBe(d)
    expect(applyBoardAction(d, { type: 'remove', ids: ['x'] })).toBe(d)
  })

  it('removing a row drops its modules', () => {
    const d = doc([mod(1, r1, 0), mod(2, r2, 0)])
    const next = applyBoardAction(d, { type: 'setRows', rows: [d.rows[0]] })
    expect(next.modules.map((m) => m.id)).toEqual(['m1'])
  })
})

describe('enclosure (D357)', () => {
  it('keeps the first rows, sets their TE, moves modules of rows beyond to the end of the last row', () => {
    const d = { ...doc([mod(1, r1, 0), mod(2, r2, 0, 'w4'), mod(3, r2, 6)]), rows: [...doc().rows, { id: pid(3), capacityTe: 8 }] }
    d.modules.push(mod(4, pid(3), 0))
    const fitted = fitToEnclosure(d, { rows: 2, te: 18 }, widthOf)
    expect(fitted.rows).toEqual([
      { id: r1, capacityTe: 18 },
      { id: r2, capacityTe: 18 },
    ])
    expect(fitted.modules.find((m) => m.id === 'm4')).toMatchObject({ rowId: r2, offsetTe: 8 })
    const grown = fitToEnclosure(doc(), { rows: 3, te: 12 }, widthOf)
    expect(grown.rows).toHaveLength(3)
    expect(grown.rows[2].id).not.toBe(r2)
  })
})

// The same cases as the backend's enclosureSize / fitRows (plans/board.go):
// client and server must fit a board identically (D357).
describe('enclosure rule as the backend applies it', () => {
  const enc = (rows: number, te: number) => boardCaps(0, { enclosureRows: rows, enclosureTePerRow: te, railWidthTe: undefined })
  it.each([
    [2, 12, { rows: 2, te: 12 }],
    [2.7, 12, { rows: 2, te: 12 }],
    [3, 12.34, { rows: 3, te: 12.3 }],
    [3, 12.35, { rows: 3, te: 12.4 }],
    [50, 999.9, { rows: 50, te: 999.9 }],
    [51, 12, null],
    [0.5, 12, null],
    [2, 1000, null],
    [2, 0.04, null],
  ])('enclosureRows %s × %s TE → %j', (rows, te, want) => {
    expect(enclosureSize(enc(rows, te))).toEqual(want)
  })
  it('is unknown without both values', () => {
    expect(enclosureSize(boardCaps(0, { enclosureRows: 2, enclosureTePerRow: undefined }))).toBeNull()
    expect(enclosureSize(undefined)).toBeNull()
  })

  it('moves modules of dropped rows to the end of the last row, one after another, from the furthest end', () => {
    const r3 = pid(3)
    const d: BoardDocument = {
      enclosureVariantId: null,
      enclosureExisting: false,
      removeEnclosure: false,
      rows: [
        { id: r1, capacityTe: 12 },
        { id: r2, capacityTe: 12 },
        { id: r3, capacityTe: 12 },
      ],
      // Row 2 ends at 6.5 (a half TE module), row 3's modules follow it.
      modules: [mod(1, r2, 0), mod(2, r2, 4.5), mod(3, r3, 0, 'w4'), mod(4, r3, 6, 'x'), mod(5, r1, 0)],
    }
    const fitted = fitToEnclosure(d, { rows: 2, te: 10 }, widthOf)
    expect(fitted.rows).toEqual([
      { id: r1, capacityTe: 10 },
      { id: r2, capacityTe: 10 },
    ])
    expect(fitted.modules.map((m) => [m.id, m.rowId, m.offsetTe])).toEqual([
      ['m1', r2, 0],
      ['m2', r2, 4.5],
      ['m3', r2, 6.5],
      ['m4', r2, 10.5],
      ['m5', r1, 0],
    ])
  })

  it('keeps everything when the rows already match', () => {
    const d = doc([mod(1, r1, 0)])
    expect(fitToEnclosure(d, { rows: 2, te: 12 }, widthOf)).toEqual({ rows: d.rows, modules: d.modules })
  })

  it('rounds capability widths to 0.1 TE like the backend', () => {
    expect(moduleWidth('v', () => boardCaps(1.24))).toBe(1.2)
    expect(moduleWidth('v', () => boardCaps(1.25))).toBe(1.3)
    expect(moduleWidth('v', () => boardCaps(0.04))).toBe(1)
    expect(moduleWidth('v', () => undefined)).toBe(1)
  })
})

describe('adopting what a save stored', () => {
  it('returns the rows and places the server fitted, else null', () => {
    const d = doc([mod(1, r1, 0), mod(2, r2, 3)])
    const content = (rows: { id: string; capacityTe: number }[], places: [string, string, number][]) =>
      ({
        rows: rows.map((r) => ({ ...r, usedTe: 0 })),
        modules: places.map(([id, rowId, offsetTe]) => ({ ...d.modules.find((m) => m.id === id)!, rowId, offsetTe, widthTe: 2 })),
      }) as unknown as Parameters<typeof fittedBySave>[1]
    expect(fittedBySave(d, content(d.rows, [['m1', r1, 0], ['m2', r2, 3]]))).toBeNull()
    const r3 = pid(3)
    const fitted = fittedBySave(d, content([{ id: r1, capacityTe: 18 }, { id: r3, capacityTe: 18 }], [['m1', r1, 0], ['m2', r1, 2]]))
    expect(fitted?.rows).toEqual([{ id: r1, capacityTe: 18 }, { id: r3, capacityTe: 18 }])
    expect(fitted?.modules[1]).toMatchObject({ id: 'm2', rowId: r1, offsetTe: 2 })
    expect(fitted?.modules[0]).toBe(d.modules[0])
  })

  it('replaces the present document only while it is the one saved, without an undo step', () => {
    const d = doc()
    let state = boardReducer(initBoard(d), { type: 'change', action: { type: 'addModules', modules: [mod(1, r1, 0)] } })
    const saved = state.history.present
    const fitted = { ...saved, rows: [{ id: r1, capacityTe: 18 }, { id: r2, capacityTe: 18 }] }
    const adopted = boardReducer(state, { type: 'adopt', from: saved, document: fitted })
    expect(adopted.history.present).toBe(fitted)
    expect(adopted.history.past).toEqual(state.history.past)
    state = boardReducer(state, { type: 'change', action: { type: 'remove', ids: ['m1'] } })
    expect(boardReducer(state, { type: 'adopt', from: saved, document: fitted })).toBe(state)
  })
})

describe('palette and enclosures by mounting', () => {
  const types = [variant(1).productTypeId]
  const list = [
    variant(1, { capabilities: boardCaps(2) }),
    variant(2, { capabilities: { ...boardCaps(1), mounting: 'both' } }),
    variant(3),
    variant(4, { capabilities: boardCaps(0, { enclosureRows: 2, enclosureTePerRow: 12, railWidthTe: undefined }) }),
    variant(5, { capabilities: boardCaps(2), available: false }),
  ]

  it('offers board and both, never floorplan-only, enclosures or unavailable ones', () => {
    expect(boardPaletteProducts(list, types).map((p) => p.defaultVariant.id)).toEqual([list[0].id, list[1].id])
  })

  it('offers enclosures of known size', () => {
    expect(enclosureVariants(list, types).map((v) => v.id)).toEqual([list[3].id])
  })
})

describe('save errors', () => {
  it('maps body.modules[i] to the module sent at i', () => {
    const d = doc([mod(1, r1, 0), mod(2, r1, 1)])
    const error = new ApiError({ status: 422, code: 'validation', fields: [{ location: 'body.modules[1].offsetTe', code: 'board.overlap', params: { moduleId: 'm1' } }] })
    expect([...boardErrorsByModule(error, d, (f) => f.code)]).toEqual([['m2', ['board.overlap']]])
  })
})
