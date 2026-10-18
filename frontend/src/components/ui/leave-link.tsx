import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { Button } from './button'

type LeaveLinkProps = {
  /** Where leaving goes, e.g. the list. */
  to: string
  /** Navigation state passed along (e.g. the list's filters). */
  state?: unknown
  /** Whether the editor has unsaved changes. */
  dirty: boolean
  /** The label while nothing is unsaved, e.g. "Back to list" (the default). */
  backLabel?: string
}

/**
 * The way out of a page editor (D84): "Back to list" while nothing is
 * unsaved, "Cancel" while there are changes (leaving then asks first, see
 * useUnsavedChanges).
 */
export function LeaveLink({ to, state, dirty, backLabel }: LeaveLinkProps) {
  const { t } = useTranslation()
  return (
    <Button asChild variant="secondary">
      <Link to={to} state={state}>
        {dirty ? (
          t('action.cancel')
        ) : (
          <>
            <ArrowLeft /> {backLabel ?? t('action.backToList')}
          </>
        )}
      </Link>
    </Button>
  )
}
