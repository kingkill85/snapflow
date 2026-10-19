import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useListFunctionTypes } from '@/api/generated/function-types/function-types'
import type { OutputKind } from '@/api/generated/model'
import {
  getListOutputKindsQueryKey,
  getListOutputKindsQueryOptions,
  useDeleteOutputKind,
  useListOutputKinds,
  useReorderOutputKinds,
} from '@/api/generated/output-kinds/output-kinds'
import { useCan } from '@/app/session'
import { invalidateProductQueries } from '@/catalog/invalidate'
import { type Column } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { ActiveBadge } from './ActiveBadge'
import { CatalogListPage } from './CatalogListPage'
import { OutputKindFormDialog } from './OutputKindFormDialog'
import { useReorder } from './use-reorder'

/** catalog/output-kinds: the kinds of channel a module supplies (dimmer output, relay output, …). */
export function OutputKindsPage() {
  const { t } = useTranslation('capabilities')
  const localized = useLocalized()
  const canWrite = useCan()('catalog.write')
  const queryClient = useQueryClient()
  const [showInactive, setShowInactive] = useState(false)
  const list = useListOutputKinds(showInactive ? { includeInactive: true } : undefined)
  // Names of alternatives that are inactive and of the served function types.
  const all = useListOutputKinds({ includeInactive: true })
  const functionTypes = useListFunctionTypes()
  const remove = useDeleteOutputKind()
  const reorderMutation = useReorderOutputKinds()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<OutputKind | null>(null)

  const invalidate = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: getListOutputKindsQueryKey() }), invalidateProductQueries(queryClient)])
  const reorder = useReorder({
    fetchAll: async () =>
      (
        await queryClient.fetchQuery({
          ...getListOutputKindsQueryOptions({ includeInactive: true }),
          staleTime: 0,
        })
      ).items,
    save: (ids) => reorderMutation.mutateAsync({ data: { ids } }),
    mismatchCode: 'output_kind.order_mismatch',
    invalidate,
  })

  const kindName = (id: string) => localized(all.data?.items.find((k) => k.id === id)?.name) || '…'
  const functionTypeName = (id: string) => localized(functionTypes.data?.items.find((f) => f.id === id)?.name) || '…'

  const columns: Column<OutputKind>[] = [
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
      header: t('outputKinds.functionTypes'),
      cell: (p) => p.functionTypeIds.map(functionTypeName).join(', ') || '–',
    },
    {
      header: t('outputKinds.alternatives'),
      cell: (p) =>
        p.alternatives.map((a) => t('outputKinds.alternativeText', { count: a.count, kind: kindName(a.outputKindId) })).join(', ') || '–',
    },
    {
      header: t('field.status'),
      cell: (p) => <ActiveBadge active={p.isActive} />,
    },
  ]

  return (
    <CatalogListPage
      title={t('outputKinds.title')}
      description={t('outputKinds.description')}
      empty={t('outputKinds.empty')}
      newLabel={t('outputKinds.new')}
      deleteTitle={t('outputKinds.deleteTitle')}
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
      <OutputKindFormDialog open={formOpen} onOpenChange={setFormOpen} item={editing} onSaved={invalidate} />
    </CatalogListPage>
  )
}
