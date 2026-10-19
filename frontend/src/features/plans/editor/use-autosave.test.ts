import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'

import { useAutosave } from './use-autosave'

type Doc = { v: number }

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(save: (d: Doc) => Promise<void>, enabled = true) {
  const first: Doc = { v: 0 }
  return renderHook(({ document }) => useAutosave({ document, save, enabled }), { initialProps: { document: first } })
}

describe('useAutosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('saves 1 s after the last change, one request at a time, then what changed meanwhile', async () => {
    const calls: Doc[] = []
    const pending: ReturnType<typeof deferred>[] = []
    const save = vi.fn((d: Doc) => {
      calls.push(d)
      const p = deferred()
      pending.push(p)
      return p.promise
    })
    const { result, rerender } = setup(save)
    expect(result.current.status).toBe('saved')

    rerender({ document: { v: 1 } })
    expect(result.current.status).toBe('unsaved')
    await act(() => vi.advanceTimersByTimeAsync(500))
    rerender({ document: { v: 2 } })
    await act(() => vi.advanceTimersByTimeAsync(999))
    expect(save).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(calls).toEqual([{ v: 2 }])
    expect(result.current.status).toBe('saving')

    // A change during the save waits for it.
    rerender({ document: { v: 3 } })
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(save).toHaveBeenCalledTimes(1)
    await act(async () => pending[0].resolve())
    expect(result.current.status).toBe('unsaved')
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(calls).toEqual([{ v: 2 }, { v: 3 }])
    await act(async () => pending[1].resolve())
    expect(result.current.status).toBe('saved')
  })

  it('shows a failure until Retry or the next change', async () => {
    let fail = true
    const save = vi.fn(() => (fail ? Promise.reject(new ApiError({ status: 500, code: 'internal' })) : Promise.resolve()))
    const { result, rerender } = setup(save)
    rerender({ document: { v: 1 } })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(result.current.status).toBe('failed')
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(save).toHaveBeenCalledTimes(1)

    fail = false
    await act(() => result.current.retry())
    expect(result.current.status).toBe('saved')
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('stops on plan.stale until reset', async () => {
    const save = vi.fn(() => Promise.reject(new ApiError({ status: 409, code: 'plan.stale' })))
    const { result, rerender } = setup(save)
    rerender({ document: { v: 1 } })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(result.current.status).toBe('stale')
    rerender({ document: { v: 2 } })
    await act(() => vi.advanceTimersByTimeAsync(5000))
    expect(save).toHaveBeenCalledTimes(1)

    const loaded = { v: 9 }
    act(() => result.current.reset(loaded))
    rerender({ document: loaded })
    expect(result.current.status).toBe('saved')
  })

  it('flushes at once (leaving) and never saves while disabled', async () => {
    const save = vi.fn(() => Promise.resolve())
    const { result, rerender } = setup(save)
    rerender({ document: { v: 1 } })
    await act(() => result.current.flush())
    expect(save).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('saved')

    const off = setup(save, false)
    off.rerender({ document: { v: 1 } })
    await act(() => vi.advanceTimersByTimeAsync(5000))
    await act(() => off.result.current.flush())
    expect(save).toHaveBeenCalledTimes(1)
  })
})
