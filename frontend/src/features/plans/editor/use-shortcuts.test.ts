import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PlanNeed } from '@/api/generated/model'

import { functionTypes, placement } from '../test-fixtures'
import { newNeed } from './needs'
import { initEditor } from './editor-state'
import { useShortcuts } from './use-shortcuts'

const image = { width: 1000, height: 800 }

function setup(needs: PlanNeed[] = []) {
  const p = placement(1, { x: 995, y: 100 })
  const state = { ...initEditor({ scale: null, zones: [], placements: [p], needs }), selection: [p.id, ...needs.map((n) => n.id)] }
  const dispatch = vi.fn()
  const onCopy = vi.fn(() => ({ action: null, placements: [], needs: [], skipped: 0, overLimit: false }))
  renderHook(() => useShortcuts({ state, dispatch, editable: true, image, onEscape: () => undefined, onCopy }))
  return { dispatch, p, onCopy }
}

const press = (target: EventTarget, key: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

describe('editor shortcuts', () => {
  it('nudges and deletes when focus is on the page', () => {
    const { dispatch, p } = setup()
    press(document.body, 'ArrowLeft')
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'change', action: { type: 'moveBy', ids: [p.id], dx: -1, dy: 0 } })
    press(document.body, 'Delete')
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'change', action: { type: 'remove', ids: [p.id] } })
  })

  it('leaves arrows, Delete and Backspace to a focused button, switch or tab', () => {
    const { dispatch } = setup()
    for (const html of ['<button>x</button>', '<button role="switch">x</button>', '<div role="tab" tabindex="0">x</div>', '<input type="checkbox" />']) {
      const host = document.createElement('div')
      host.innerHTML = html
      document.body.append(host)
      const el = host.firstElementChild!
      for (const key of ['ArrowLeft', 'ArrowDown', 'Delete', 'Backspace']) press(el, key)
      host.remove()
    }
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('stops a nudge at the image edge', () => {
    const { dispatch, p } = setup()
    const shift = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(shift)
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'change', action: { type: 'moveBy', ids: [p.id], dx: 5, dy: 0 } })
  })

  it('stops a nudge of a load symbol at the image edge, moving the selection together', () => {
    const symbol = { ...newNeed(functionTypes[0].id, null, { x: 100, y: 797 }), id: 'sym' }
    const { dispatch, p } = setup([symbol])
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(down)
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'change', action: { type: 'moveBy', ids: [p.id, 'sym'], dx: 0, dy: 3 } })
  })

  it('duplicates the selected placements and symbols through the editor copy', () => {
    const symbol = { ...newNeed(functionTypes[0].id, null, { x: 100, y: 100 }), id: 'sym' }
    const { onCopy, p } = setup([symbol])
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(onCopy).toHaveBeenCalledWith({ placements: [expect.objectContaining({ id: p.id })], needs: [symbol] }, 20, 20)
  })
})
