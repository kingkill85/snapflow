import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui'

import { statusTone } from './format'

/** A reserve status (ok / amber / red / unknown) as a badge: colour and text together (D394). */
export function StatusChip({ status, title }: { status: string; title?: string }) {
  const { t } = useTranslation('checks')
  const known = status === 'ok' || status === 'amber' || status === 'red' ? status : 'unknown'
  return (
    <Badge variant={statusTone(known)} title={title}>
      {t(`status.${known}`)}
    </Badge>
  )
}
