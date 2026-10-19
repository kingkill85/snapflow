import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { lockPlan, unlockPlan } from '@/api/generated/plans/plans'

import { releaseLockOnUnload } from '../api'
import { lockHeartbeat, usePlanLock } from './use-plan-lock'

vi.mock('@/api/generated/plans/plans', () => ({ lockPlan: vi.fn(), unlockPlan: vi.fn() }))
vi.mock('../api', () => ({ releaseLockOnUnload: vi.fn() }))

const lockMock = vi.mocked(lockPlan)
const unlockMock = vi.mocked(unlockPlan)
const lock = { userId: 'u', userName: 'Me', expiresAt: '2026-10-19T12:00:00Z' }
const apiError = (status: number, code: string, params: Record<string, unknown> = {}) => new ApiError({ status, code, params })

/** Lets pending promises (the take on open, a heartbeat) settle. */
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
})

beforeEach(() => {
  vi.useFakeTimers()
  lockMock.mockReset().mockResolvedValue(lock as never)
  unlockMock.mockReset().mockResolvedValue(undefined as never)
  vi.mocked(releaseLockOnUnload).mockReset()
})
afterEach(() => vi.useRealTimers())

describe('usePlanLock', () => {
  it('takes the lock on open and renews it every 30 s', async () => {
    const { result } = renderHook(() => usePlanLock('p1', true))
    expect(result.current.state.status).toBe('acquiring')
    await settle()
    expect(result.current.state.status).toBe('mine')
    expect(lockMock).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(lockHeartbeat))
    await settle()
    expect(lockMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the lock when a heartbeat gets no answer or a server error', async () => {
    const { result } = renderHook(() => usePlanLock('p1', true))
    await settle()
    lockMock.mockRejectedValueOnce(apiError(0, 'network.unavailable')).mockRejectedValueOnce(apiError(503, 'server.error'))
    for (let i = 0; i < 2; i++) {
      await act(async () => vi.advanceTimersByTime(lockHeartbeat))
      await settle()
    }
    expect(result.current.state.status).toBe('mine')
  })

  it('says who took the lock over', async () => {
    const { result } = renderHook(() => usePlanLock('p1', true))
    await settle()
    lockMock.mockRejectedValueOnce(apiError(409, 'plan.locked', { name: 'Eve', expiresAt: '2026-10-19T12:02:00Z' }))
    await act(async () => vi.advanceTimersByTime(lockHeartbeat))
    await settle()
    expect(result.current.state).toEqual({ status: 'held', name: 'Eve', expiresAt: '2026-10-19T12:02:00Z', takenOver: true })
  })

  it('turns read-only when the project became read-only and fails when the plan is gone', async () => {
    const { result } = renderHook(() => usePlanLock('p1', true))
    await settle()
    lockMock.mockRejectedValueOnce(apiError(409, 'project.read_only'))
    await act(async () => vi.advanceTimersByTime(lockHeartbeat))
    await settle()
    expect(result.current.state).toEqual({ status: 'readOnly' })

    const other = renderHook(() => usePlanLock('p2', true))
    await settle()
    lockMock.mockRejectedValueOnce(apiError(404, 'plan.not_found'))
    await act(async () => vi.advanceTimersByTime(lockHeartbeat))
    await settle()
    expect(other.result.current.state.status).toBe('error')
  })

  it('releases after the pending changes are saved', async () => {
    const order: string[] = []
    unlockMock.mockImplementation(async () => {
      order.push('unlock')
    })
    const flush = vi.fn(async () => {
      order.push('flush')
    })
    const { unmount } = renderHook(() => usePlanLock('p1', true, { beforeRelease: flush }))
    await settle()
    unmount()
    await settle()
    expect(order).toEqual(['flush', 'unlock'])
  })

  it('releases a lock that arrives after the editor closed', async () => {
    let answer: (value: unknown) => void = () => undefined
    lockMock.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never)
    const { unmount } = renderHook(() => usePlanLock('p1', true))
    await settle()
    expect(lockMock).toHaveBeenCalledTimes(1)
    unmount()
    expect(unlockMock).not.toHaveBeenCalled()
    answer(lock)
    await settle()
    expect(unlockMock).toHaveBeenCalledWith('p1')
  })

  it('on pagehide releases with keepalive, unless a keepalive save was sent', async () => {
    let saved = false
    renderHook(() => usePlanLock('p1', true, { onPageHide: () => saved }))
    await settle()
    window.dispatchEvent(new Event('pagehide'))
    expect(releaseLockOnUnload).toHaveBeenCalledTimes(1)
    saved = true
    window.dispatchEvent(new Event('pagehide'))
    expect(releaseLockOnUnload).toHaveBeenCalledTimes(1)
  })
})
