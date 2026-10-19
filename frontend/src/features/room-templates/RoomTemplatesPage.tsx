import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { RoomTemplate } from '@/api/generated/model'
import {
  getListRoomTemplatesQueryKey,
  getListRoomTemplatesQueryOptions,
  useDeleteRoomTemplate,
  useListRoomTemplates,
  useReorderRoomTemplates,
} from '@/api/generated/room-templates/room-templates'
import { useCan } from '@/app/session'
import { type Column } from '@/components/ui'
import { ActiveBadge } from '@/features/capabilities/ActiveBadge'
import { CatalogListPage } from '@/features/capabilities/CatalogListPage'
import { useReorder } from '@/features/capabilities/use-reorder'
import { useLocalized } from '@/i18n/localized'

import { RoomTemplateFormDialog } from './RoomTemplateFormDialog'

/** catalog/room-templates: typical needs of a room, applied to a zone in the plan editor. */
export function RoomTemplatesPage() {
  const { t } = useTranslation('roomTemplates')
  const localized = useLocalized()
  const canWrite = useCan()('catalog.write')
  const queryClient = useQueryClient()
  const [showInactive, setShowInactive] = useState(false)
  const list = useListRoomTemplates(showInactive ? { includeInactive: true } : undefined)
  const remove = useDeleteRoomTemplate()
  const reorderMutation = useReorderRoomTemplates()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<RoomTemplate | null>(null)

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListRoomTemplatesQueryKey() })
  const reorder = useReorder({
    fetchAll: async () => (await queryClient.fetchQuery({ ...getListRoomTemplatesQueryOptions({ includeInactive: true }), staleTime: 0 })).items,
    save: (ids) => reorderMutation.mutateAsync({ data: { ids } }),
    mismatchCode: 'room_template.order_mismatch',
    invalidate,
  })

  const columns: Column<RoomTemplate>[] = [
    { header: t('field.name'), mobile: 'title', cell: (p) => localized(p.name) },
    { header: t('field.equipmentLevel'), cell: (p) => localized(p.equipmentLevel) },
    { header: t('field.lines'), className: 'whitespace-nowrap', cell: (p) => t('lineCount', { count: p.lines.length }) },
    { header: t('field.status'), cell: (p) => <ActiveBadge active={p.isActive} /> },
  ]

  return (
    <CatalogListPage
      title={t('title')}
      description={t('description')}
      empty={t('empty')}
      newLabel={t('new')}
      deleteTitle={t('deleteTitle')}
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
      <RoomTemplateFormDialog open={formOpen} onOpenChange={setFormOpen} item={editing} onSaved={invalidate} />
    </CatalogListPage>
  )
}
