import { useTranslation } from 'react-i18next'

import type { ProjectStatus } from '@/api/generated/model'
import { Badge } from '@/components/ui'

const variants = { active: 'success', completed: 'primary', cancelled: 'neutral' } as const

/** A project's status: Active, Completed or Cancelled. */
export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const { t } = useTranslation('projects')
  return <Badge variant={variants[status]}>{t(`status.${status}`)}</Badge>
}
