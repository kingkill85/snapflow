import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  getListCatalogFieldsQueryKey,
  getListCatalogFieldsQueryOptions,
  useDeleteCatalogField,
  useListCatalogFields,
  useReorderCatalogFields,
} from '@/api/generated/catalog-fields/catalog-fields'
import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import type { CatalogField } from '@/api/generated/model'
import { useListOutputKinds } from '@/api/generated/output-kinds/output-kinds'
import { useCan } from '@/app/session'
import { invalidateProductQueries } from '@/catalog/invalidate'
import { type Column } from '@/components/ui'
import { useMeaningLabel } from '@/catalog/meaning-labels'
import { useLocalized } from '@/i18n/localized'

import { CatalogFieldFormDialog } from './CatalogFieldFormDialog'
import { CatalogListPage } from './CatalogListPage'
import { useReorder } from './use-reorder'

/** catalog/fields: the catalog-wide fields (columns) and what their values mean for the checks (D187/D188). */
export function CatalogFieldsPage() {
  const { t } = useTranslation('capabilities')
  const localized = useLocalized()
  const meaningLabel = useMeaningLabel()
  const canWrite = useCan()('catalog.write')
  const queryClient = useQueryClient()
  const list = useListCatalogFields()
  const kinds = useListOutputKinds({ includeInactive: true })
  const loadTypes = useListLoadTypes({ includeInactive: true })
  const remove = useDeleteCatalogField()
  const reorderMutation = useReorderCatalogFields()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CatalogField | null>(null)

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: getListCatalogFieldsQueryKey(),
      }),
      invalidateProductQueries(queryClient),
    ])
  const reorder = useReorder({
    fetchAll: async () =>
      (
        await queryClient.fetchQuery({
          ...getListCatalogFieldsQueryOptions(),
          staleTime: 0,
        })
      ).items,
    save: (ids) => reorderMutation.mutateAsync({ data: { ids } }),
    mismatchCode: 'catalog_field.order_mismatch',
    invalidate,
  })

  const kindName = (id?: string) => localized(kinds.data?.items.find((k) => k.id === id)?.name)
  const loadTypeName = (id?: string) => localized(loadTypes.data?.items.find((l) => l.id === id)?.name)
  // "Max W per channel · Dimmer output · LED"
  const meaningText = (f: CatalogField) =>
    f.meaning
      ? [meaningLabel(f.meaning), kindName(f.outputKindId), loadTypeName(f.loadTypeId)].filter(Boolean).join(' · ')
      : meaningLabel()

  const columns: Column<CatalogField>[] = [
    {
      header: t('fields.label'),
      mobile: 'title',
      cell: (f) => localized(f.label),
    },
    {
      header: t('field.key'),
      cell: (f) => <code className="text-xs">{f.key}</code>,
    },
    {
      header: t('fields.type'),
      cell: (f) => (f.unit ? `${t(`type.${f.type}`)} (${f.unit})` : t(`type.${f.type}`)),
    },
    { header: t('fields.meaning'), cell: meaningText },
  ]

  return (
    <CatalogListPage
      title={t('fields.title')}
      description={t('fields.description')}
      empty={t('fields.empty')}
      newLabel={t('fields.new')}
      deleteTitle={t('fields.deleteTitle')}
      deleteMessage={(f) => t('deleteMessage', { name: localized(f.label) })}
      moveLabel={(f, d) => t(d === 'up' ? 'moveUp' : 'moveDown', { name: localized(f.label) })}
      rows={list.data?.items ?? []}
      pending={list.isPending}
      error={list.error}
      columns={columns}
      canWrite={canWrite}
      onEdit={(item) => {
        setEditing(item)
        setFormOpen(true)
      }}
      onDelete={async (f) => {
        await remove.mutateAsync({ id: f.id })
        await invalidate()
      }}
      deletePending={remove.isPending}
      deleteError={remove.error}
      resetDelete={remove.reset}
      reorder={reorder}
    >
      <CatalogFieldFormDialog open={formOpen} onOpenChange={setFormOpen} item={editing} onSaved={invalidate} />
    </CatalogListPage>
  )
}
