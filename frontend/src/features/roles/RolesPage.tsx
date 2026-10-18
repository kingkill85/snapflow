import { Check, Minus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { Permission } from '@/api/generated/model'
import { useGetRoleMatrix } from '@/api/generated/users/users'
import { type Column, DataTable, EmptyState, ErrorMessage, Loading, Page } from '@/components/ui'

export function RolesPage() {
  const { t } = useTranslation('roles')
  const { t: tCommon } = useTranslation()
  const matrix = useGetRoleMatrix()

  if (matrix.isPending) return <Loading />
  if (matrix.isError) return <ErrorMessage error={matrix.error} />

  const columns: Column<Permission>[] = [
    {
      header: t('permission'),
      cell: (p) => (
        <>
          <span className="block font-medium">{t(`permissions.${p}.label`)}</span>
          <span className="block text-xs text-muted">{t(`permissions.${p}.description`)}</span>
        </>
      ),
    },
    ...matrix.data.roles.map((r) => ({
      header: tCommon(`role.${r.role}`),
      className: 'text-center',
      cell: (p: Permission) =>
        r.permissions.includes(p) ? (
          <Check className="mx-auto size-4 text-success" aria-label={t('allowed')} />
        ) : (
          <Minus className="mx-auto size-4 text-muted" aria-label={t('denied')} />
        ),
    })),
  ]

  return (
    <Page title={t('title')} description={t('description')}>
      <DataTable rows={matrix.data.permissions} rowKey={(p) => p} columns={columns} empty={<EmptyState title="" />} />
    </Page>
  )
}
