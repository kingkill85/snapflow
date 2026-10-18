import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker } from 'react-router'

import { ConfirmDialog } from './dialog'

/**
 * Asks before unsaved changes are lost (D28): leaving the page in the app
 * opens "Discard unsaved changes?", closing or reloading the tab the
 * browser's prompt. `allow()` lets the next navigation pass, e.g. after a save.
 */
export function useUnsavedChanges(dirty: boolean) {
  const { t } = useTranslation()
  const allowed = useRef(false)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && !allowed.current && currentLocation.pathname !== nextLocation.pathname,
  )
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const dialog = (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => !open && blocker.reset?.()}
      title={t('unsaved.title')}
      message={t('unsaved.message')}
      confirmLabel={t('action.leave')}
      cancelLabel={t('action.stay')}
      pending={false}
      onConfirm={() => blocker.proceed?.()}
    />
  )
  return {
    dialog,
    allow: () => {
      allowed.current = true
    },
  }
}
