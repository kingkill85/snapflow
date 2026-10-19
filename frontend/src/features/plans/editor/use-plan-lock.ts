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
  /** The project became read-only (completed or cancelled) while the editor was open. */
  | { status: 'readOnly' }
  | { status: 'error'; error: unknown }

/** A failure worth waiting out (the lock lasts 2 minutes): no answer at all or a server error. */
export const isTransientLockError = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500

const off: LockState = { status: 'off' }

type Options = {
  /** Runs before the lock is released when the editor closes (the autosave's flush). */
  beforeRelease?: () => Promise<void>
  /**
   * Runs on `pagehide` (tab closed or reloaded) instead of the normal close;
   * returns true when it sent a keepalive save, then the lock is not released
   * (a release request could overtake the save; the lock expires in 2 minutes).
   */
  onPageHide?: () => boolean
}

/**
 * The edit lock of an open plan (D202, D215): taken when the editor opens,
 * renewed every 30 s, released when it closes (and with a keepalive request
 * when the page unloads; `beforeRelease`, e.g. the autosave's flush, runs
 * first). Held by someone else, the editor is read-only; `takeOver` breaks
 * the lock (users with `can.breakLock`). A heartbeat that gets no answer or a
 * server error keeps the lock; `plan.locked` means it was taken over,
 * `project.read_only` turns the editor read-only, anything else (e.g.
 * `plan.not_found`: the plan was deleted) is an error. A lock that arrives
 * after the editor closed is released at once.
 */
export function usePlanLock(planId: string, wanted: boolean, { beforeRelease, onPageHide }: Options = {}) {
  const callbacks = useRef({ beforeRelease, onPageHide })
  useEffect(() => {
    callbacks.current = { beforeRelease, onPageHide }
  })
  const [state, setState] = useState<LockState>(wanted ? { status: 'acquiring' } : { status: 'off' })
  const mine = useRef(false)
  // Bumped when the editor closes (or opens another plan): answers of older requests are dropped.
  const generation = useRef(0)

  const take = useCallback(
    async (force: boolean) => {
      const asked = generation.current
      const hadIt = mine.current
      try {
        const lock = await lockPlan(planId, force ? { force: true } : undefined)
        if (asked !== generation.current) {
          // The editor closed while the request ran: give the lock back now instead of holding it 2 minutes.
          // (A heartbeat's lock is released by the close itself, after the pending save.)
          if (!hadIt) void unlockPlan(planId).catch(() => undefined)
          return
        }
        mine.current = true
        setState({ status: 'mine', lock })
      } catch (e) {
        if (asked !== generation.current) return
        const wasMine = mine.current
        // A heartbeat without an answer keeps the lock: it lasts 2 minutes, the next beat renews it.
        if (wasMine && !force && isTransientLockError(e)) return
        mine.current = false
        if (e instanceof ApiError && e.code === 'plan.locked') {
          setState({ status: 'held', name: String(e.params.name ?? ''), expiresAt: String(e.params.expiresAt ?? ''), takenOver: wasMine })
        } else if (e instanceof ApiError && e.code === 'project.read_only') {
          setState({ status: 'readOnly' })
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
    const opened = generation.current
    // The request answers later; the state changes then.
    void Promise.resolve().then(() => {
      if (opened === generation.current) void take(false)
    })
    const unload = () => {
      if (!mine.current) return
      // A keepalive save of pending changes needs the lock: then it expires on its own.
      if (callbacks.current.onPageHide?.()) return
      releaseLockOnUnload(planId)
    }
    window.addEventListener('pagehide', unload)
    return () => {
      generation.current++
      window.removeEventListener('pagehide', unload)
      if (mine.current) {
        mine.current = false
        // Pending changes are saved first (they need the lock).
        const release = async () => {
          await callbacks.current.beforeRelease?.().catch(() => undefined)
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
