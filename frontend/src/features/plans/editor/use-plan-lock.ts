import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '@/api/client'
import type { PlanLock } from '@/api/generated/model'
import { lockPlan, unlockPlan } from '@/api/generated/plans/plans'

import { releaseLockOnUnload } from '../api'

/** Heartbeat of the edit lock; the server keeps it 2 minutes after the last one (D193). */
export const lockHeartbeat = 30_000

export type LockState =
  /** Not wanted (read-only project or no permission). */
  | { status: 'off' }
  | { status: 'acquiring' }
  | { status: 'mine'; lock: PlanLock }
  /** Another user holds it: name and expiry from plan.locked. */
  | { status: 'held'; name: string; expiresAt: string; takenOver: boolean }
  | { status: 'error'; error: unknown }

/**
 * The edit lock of an open plan (D202): taken when the editor opens, renewed
 * every 30 s, released when it closes (and with a keepalive request when the
 * page unloads; `beforeRelease`, e.g. the autosave's flush, runs first). Held by someone else, the editor is read-only; `takeOver`
 * breaks the lock (users with `can.breakLock`).
 */
const off: LockState = { status: 'off' }

export function usePlanLock(planId: string, wanted: boolean, beforeRelease?: () => Promise<void>) {
  const before = useRef(beforeRelease)
  useEffect(() => {
    before.current = beforeRelease
  })
  const [state, setState] = useState<LockState>(wanted ? { status: 'acquiring' } : { status: 'off' })
  const mine = useRef(false)

  const take = useCallback(
    async (force: boolean) => {
      try {
        const lock = await lockPlan(planId, force ? { force: true } : undefined)
        mine.current = true
        setState({ status: 'mine', lock })
      } catch (e) {
        const wasMine = mine.current
        // A failed heartbeat (network) keeps the lock: it lasts 2 minutes, the next beat renews it.
        if (wasMine && !force && !(e instanceof ApiError && e.code === 'plan.locked')) return
        mine.current = false
        if (e instanceof ApiError && e.code === 'plan.locked') {
          setState({ status: 'held', name: String(e.params.name ?? ''), expiresAt: String(e.params.expiresAt ?? ''), takenOver: wasMine })
        } else {
          setState({ status: 'error', error: e })
        }
      }
    },
    [planId],
  )

  // Take on open, release on close.
  useEffect(() => {
    if (!wanted) return
    // The request answers later; the state changes then.
    void Promise.resolve().then(() => take(false))
    const unload = () => {
      if (mine.current) releaseLockOnUnload(planId)
    }
    window.addEventListener('pagehide', unload)
    return () => {
      window.removeEventListener('pagehide', unload)
      if (mine.current) {
        mine.current = false
        // Pending changes are saved first (they need the lock).
        const release = async () => {
          await before.current?.().catch(() => undefined)
          await unlockPlan(planId)
        }
        void release().catch(() => undefined)
      }
    }
  }, [planId, wanted, take])

  // Heartbeat while it is ours.
  const holding = state.status === 'mine'
  useEffect(() => {
    if (!holding) return
    const id = setInterval(() => void take(false), lockHeartbeat)
    return () => clearInterval(id)
  }, [holding, take])

  return { state: wanted ? state : off, takeOver: () => take(true), retry: () => take(false) }
}
