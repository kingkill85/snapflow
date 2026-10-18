import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  getListFunctionTypesQueryKey,
  useDeleteFunctionType,
  useListFunctionTypes,
} from '@/api/generated/function-types/function-types'
import type { FunctionType } from '@/api/generated/model'
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorMessage, Loading, Page } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { FunctionTypeFormDialog } from './FunctionTypeFormDialog'

export function FunctionTypesPage() {
  const { t } = useTranslation('functionTypes')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const queryClient = useQueryClient()
  const list = useListFunctionTypes()
  const remove = useDeleteFunctionType()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<FunctionType | null>(null)
  const [deleting, setDeleting] = useState<FunctionType | null>(null)

  const openForm = (ft: FunctionType | null) => {
    setEditing(ft)
    setFormOpen(true)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ id: deleting.id })
    } catch {
      return // shown by ErrorMessage via remove.error
    }
    await queryClient.invalidateQueries({ queryKey: getListFunctionTypesQueryKey() })
    setDeleting(null)
  }

  const createButton = (
    <Button onClick={() => openForm(null)}>
      <Plus /> {t('new')}
    </Button>
  )

  return (
    <Page title={t('title')} description={t('description')} actions={createButton}>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorMessage error={list.error} />
      ) : (
        <DataTable
          rows={list.data.items}
          rowKey={(ft) => ft.id}
          columns={[
            { header: t('field.key'), cell: (ft) => <code className="text-xs">{ft.key}</code> },
            { header: t('field.name'), cell: (ft) => localized(ft.name) },
          ]}
          actions={(ft) => (
            <>
              <Button size="sm" variant="secondary" onClick={() => openForm(ft)}>
                <Pencil /> {tCommon('action.edit')}
              </Button>
              <Button size="sm" variant="danger" onClick={() => setDeleting(ft)}>
                <Trash2 /> {tCommon('action.delete')}
              </Button>
            </>
          )}
          empty={<EmptyState title={t('empty')} action={createButton} />}
        />
      )}

      <FunctionTypeFormDialog open={formOpen} onOpenChange={setFormOpen} functionType={editing} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('deleteTitle')}
        message={t('deleteMessage', { name: localized(deleting?.name) })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Page>
  )
}
