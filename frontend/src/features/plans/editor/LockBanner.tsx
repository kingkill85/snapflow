import { useTranslation } from 'react-i18next'

import { Button, ErrorMessage, Notice } from '@/components/ui'

import type { LockState } from './use-plan-lock'

/** A time of today in the UI language, e.g. "14:32". */
function useFormatTime() {
  const { i18n } = useTranslation()
  const format = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { timeStyle: 'short' })
  return (value: string) => {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : format.format(date)
  }
}

type Props = {
  lock: LockState
  /** The user may break the lock (can.breakLock). */
  canTakeOver: boolean
  onTakeOver: () => void
  onRetry: () => void
}

/** Why the editor is read-only because of the edit lock, with "Take over" (D202). */
export function LockBanner({ lock, canTakeOver, onTakeOver, onRetry }: Props) {
  const { t } = useTranslation('plans')
  const time = useFormatTime()
  if (lock.status === 'error') return <ErrorMessage error={lock.error} action={<Button size="sm" variant="secondary" onClick={onRetry}>{t('lock.retry')}</Button>} />
  if (lock.status !== 'held') return null
  return (
    <Notice tone="warning">
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span>
          {lock.takenOver ? t('lock.takenOver', { name: lock.name }) : t('lock.heldBy', { name: lock.name, time: time(lock.expiresAt) })}
        </span>
        <span className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {t('lock.retry')}
          </Button>
          {canTakeOver && (
            <Button size="sm" variant="secondary" onClick={onTakeOver}>
              {t('lock.takeOver')}
            </Button>
          )}
        </span>
      </span>
    </Notice>
  )
}
