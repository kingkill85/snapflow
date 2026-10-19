import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  getListLoadTypesQueryKey,
  getListLoadTypesQueryOptions,
  useDeleteLoadType,
  useListLoadTypes,
  useReorderLoadTypes,
} from '@/api/generated/load-types/load-types'
import type { LoadType } from '@/api/generated/model'
import { useCan } from '@/app/session'
import { invalidateProductQueries } from '@/catalog/invalidate'
import { type Column } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { ActiveBadge } from './ActiveBadge'
import { CatalogListPage } from './CatalogListPage'
import { LoadTypeFormDialog } from './LoadTypeFormDialog'
import { useReorder } from './use-reorder'

/** catalog/load-types: the kinds of electrical load a need can have (LED, halogen, motor, …). */
export function LoadTypesPage() {
  const { t } = useTranslation('capabilities')
  const localized = useLocalized()
  const canWrite = useCan()('catalog.write')
  const queryClient = useQueryClient()
  const [showInactive, setShowInactive] = useState(false)
  const list = useListLoadTypes(showInactive ? { includeInactive: true } : undefined)
  const remove = useDeleteLoadType()
  const reorderMutation = useReorderLoadTypes()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<LoadType | null>(null)

  const invalidate = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: getListLoadTypesQueryKey() }), invalidateProductQueries(queryClient)])
  const reorder = useReorder({
    fetchAll: async () =>
      (
        await queryClient.fetchQuery({
          ...getListLoadTypesQueryOptions({ includeInactive: true }),
          staleTime: 0,
        })
      ).items,
    save: (ids) => reorderMutation.mutateAsync({ data: { ids } }),
    mismatchCode: 'load_type.order_mismatch',
    invalidate,
  })

  const columns: Column<LoadType>[] = [
    {
      header: t('field.name'),
      mobile: 'title',
      cell: (p) => localized(p.name),
    },
    {
      header: t('field.key'),
      cell: (p) => <code className="text-xs">{p.key}</code>,
    },
    {
      header: t('field.status'),
      cell: (p) => <ActiveBadge active={p.isActive} />,
    },
  ]

  return (
    <CatalogListPage
      title={t('loadTypes.title')}
      description={t('loadTypes.description')}
      empty={t('loadTypes.empty')}
      newLabel={t('loadTypes.new')}
      deleteTitle={t('loadTypes.deleteTitle')}
      deleteMessage={(p) => t('deleteMessage', { name: localized(p.name) })}
      moveLabel={(p, d) => t(d === 'up' ? 'moveUp' : 'moveDown', { name: localized(p.name) })}
      inactive={{ show: showInactive, onChange: setShowInactive }}
      rows={list.data?.items ?? []}
      pending={list.isPending}
      error={list.error}
      columns={columns}
      canWrite={canWrite}
      onEdit={(item) => {
        setEditing(item)
        setFormOpen(true)
      }}
      onDelete={async (p) => {
        await remove.mutateAsync({ id: p.id })
        await invalidate()
      }}
      deletePending={remove.isPending}
      deleteError={remove.error}
      resetDelete={remove.reset}
      reorder={reorder}
    >
      <LoadTypeFormDialog open={formOpen} onOpenChange={setFormOpen} item={editing} onSaved={invalidate} />
    </CatalogListPage>
  )
}
