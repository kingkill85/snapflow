import { useTranslation } from 'react-i18next'

import type { ProjectTenant } from '@/api/generated/model'
import { Badge } from '@/components/ui'

/** A project's tenant, with an "Archived" badge when the tenant is archived. */
export function TenantName({ tenant }: { tenant: ProjectTenant }) {
  const { t } = useTranslation('projects')
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>{tenant.name}</span>
      {tenant.archived && <Badge variant="warning">{t('tenantArchived')}</Badge>}
    </span>
  )
}
