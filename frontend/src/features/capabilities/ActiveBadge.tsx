import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui'

export function ActiveBadge({ active }: { active: boolean }) {
  const { t: tCommon } = useTranslation()
  return <Badge variant={active ? 'success' : 'neutral'}>{active ? tCommon('status.active') : tCommon('status.inactive')}</Badge>
}
