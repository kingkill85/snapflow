import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '@/api/client'

/** What the save indicator shows. */
export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed' | 'stale'

export const autosaveDelay = 1000

type Options<T> = {
  /** The current document; compared by reference with the last saved one. */
  document: T
  /** Saves a snapshot; rejects with an ApiError when the server refuses. */
  save: (snapshot: T) => Promise<void>
  /** Off while read-only (no lock): changes are never saved. */
  enabled: boolean
  delay?: number
}

/**
 * Autosave (D201): saves 1 s after the last change, one request at a time;
 * a change during a save is saved after it. A failed save waits for Retry or
 * the next change (the user may have fixed the item); `plan.stale` stops
 * saving until the editor reloads. `flush` saves at once (leaving the editor).
 */
export function useAutosave<T>({ document, save, enabled, delay = autosaveDelay }: Options<T>) {
  const saved = useRef(document)
  const current = useRef(document)
  const inFlight = useRef<Promise<void> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const saveRef = useRef(save)
  // The saved document for rendering (the ref serves the async code).
  const [savedDoc, setSavedDoc] = useState(document)
  const [saving, setSaving] = useState(false)
  // A failure belongs to the document it happened with: a newer document clears it.
  const [failure, setFailure] = useState<{ error: unknown; document: T } | null>(null)
  const [stale, setStale] = useState<unknown>(null)

  useEffect(() => {
    saveRef.current = save
    current.current = document
  })

  const run = useCallback((): Promise<void> => {
    clearTimeout(timer.current)
    if (inFlight.current) return inFlight.current
    const snapshot = current.current
    if (snapshot === saved.current) return Promise.resolve()
    setSaving(true)
    setFailure(null)
    const request = saveRef
      .current(snapshot)
      .then(() => {
        saved.current = snapshot
        setSavedDoc(snapshot)
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'plan.stale') setStale(error)
        else setFailure({ error, document: current.current })
      })
      .finally(() => {
        inFlight.current = null
        setSaving(false)
      })
    inFlight.current = request
    return request
  }, [])

  const failed = failure !== null && failure.document === document

  // Schedule after every change; also after a save that ran while things changed.
  useEffect(() => {
    if (!enabled || stale || saving || failed || document === savedDoc) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void run(), delay)
    return () => clearTimeout(timer.current)
  }, [document, savedDoc, enabled, stale, saving, failed, delay, run])

  useEffect(() => () => clearTimeout(timer.current), [])

  const dirty = document !== savedDoc
  let status: SaveStatus
  if (stale) status = 'stale'
  else if (saving) status = 'saving'
  else if (failed) status = 'failed'
  else status = dirty ? 'unsaved' : 'saved'

  /** Saves now (Retry, leaving); resolves when no save is running any more. */
  const flush = useCallback(async () => {
    if (!enabled || stale) return
    await inFlight.current
    await run()
  }, [enabled, stale, run])

  /** Starts over from a loaded document (after reloading). */
  const reset = useCallback((next: T) => {
    clearTimeout(timer.current)
    saved.current = next
    current.current = next
    setSavedDoc(next)
    setFailure(null)
    setStale(null)
  }, [])

  /** The latest document when it is not saved yet (for a last save while the page unloads), else undefined. */
  const pending = useCallback(() => (current.current === saved.current ? undefined : current.current), [])

  return { status, error: stale ?? failure?.error ?? null, dirty, flush, retry: flush, reset, pending }
}
