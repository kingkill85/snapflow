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
import { useDescribeMeaning } from '@/catalog/meaning-labels'
import { useLocalized } from '@/i18n/localized'

import { CatalogFieldFormDialog } from './CatalogFieldFormDialog'
import { CatalogListPage } from './CatalogListPage'
import { useReorder } from './use-reorder'

/** catalog/fields: the catalog-wide fields (columns) and what their values mean for the checks (D187/D188). */
export function CatalogFieldsPage() {
  const { t } = useTranslation('capabilities')
  const localized = useLocalized()
  const describeMeaning = useDescribeMeaning()
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
  // with the meaning in plain words under it (D445).
  const meaningText = (f: CatalogField) => {
    const d = describeMeaning(f.meaning)
    return (
      <div className="min-w-0">
        <div>{f.meaning ? [d.title, kindName(f.outputKindId), loadTypeName(f.loadTypeId)].filter(Boolean).join(' · ') : d.title}</div>
        <div className="text-xs text-muted">{d.description}</div>
      </div>
    )
  }

  const columns: Column<CatalogField>[] = [
    {
      header: t('fields.label'),
      mobile: 'title',
      cell: (f) => localized(f.label),
    },
    {
      header: t('field.key'),
      // Tablets (768–1023 px): the key is in the editor; the row actions need the room (D322).
      className: 'md:max-lg:hidden',
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
