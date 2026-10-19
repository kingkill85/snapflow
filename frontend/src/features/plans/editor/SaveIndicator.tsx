import { AlertCircle, Check, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'

import type { SaveStatus } from './use-autosave'

/** Saved / Saving… / Unsaved changes / Save failed – Retry (spec 2b). */
export function SaveIndicator({ status, onRetry }: { status: SaveStatus; onRetry: () => void }) {
  const { t } = useTranslation('plans')
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm whitespace-nowrap [&_svg]:size-4">
      {status === 'saved' && (
        <span className="inline-flex items-center gap-1 text-muted">
          <Check aria-hidden="true" /> {t('save.saved')}
        </span>
      )}
      {status === 'saving' && (
        <span className="inline-flex items-center gap-1 text-muted">
          <Loader2 aria-hidden="true" className="animate-spin" /> {t('save.saving')}
        </span>
      )}
      {status === 'unsaved' && <span className="text-muted">{t('save.unsaved')}</span>}
      {status === 'failed' && (
        <>
          <span className="inline-flex items-center gap-1 text-danger">
            <AlertCircle aria-hidden="true" /> {t('save.failed')}
          </span>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {t('save.retry')}
          </Button>
        </>
      )}
      {status === 'stale' && (
        <span className="inline-flex items-center gap-1 text-danger">
          <AlertCircle aria-hidden="true" /> {t('save.stale')}
        </span>
      )}
    </span>
  )
}
