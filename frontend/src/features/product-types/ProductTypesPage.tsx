import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  getListProductTypesQueryKey,
  useDeleteProductType,
  useListProductTypes,
} from '@/api/generated/product-types/product-types'
import type { ProductType } from '@/api/generated/model'
import { useCan } from '@/app/session'
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorMessage, Loading, Page } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { ProductTypeFormDialog } from './ProductTypeFormDialog'

export function ProductTypesPage() {
  const { t } = useTranslation('productTypes')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const canWrite = useCan()('catalog.write')
  const queryClient = useQueryClient()
  const list = useListProductTypes()
  const remove = useDeleteProductType()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ProductType | null>(null)
  const [deleting, setDeleting] = useState<ProductType | null>(null)

  const openForm = (item: ProductType | null) => {
    setEditing(item)
    setFormOpen(true)
  }

  // Each delete starts without the previous attempt's error.
  const openDelete = (item: ProductType | null) => {
    remove.reset()
    setDeleting(item)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ id: deleting.id })
    } catch {
      return // shown by ErrorMessage via remove.error
    }
    await queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() })
    setDeleting(null)
  }

  // Without catalog.write the page is read-only.
  const createButton = canWrite ? (
    <Button onClick={() => openForm(null)}>
      <Plus /> {t('new')}
    </Button>
  ) : undefined

  const rowActions = (item: ProductType) => (
    <>
      <Button size="sm" variant="secondary" onClick={() => openForm(item)}>
        <Pencil /> {tCommon('action.edit')}
      </Button>
      <Button size="sm" variant="danger" onClick={() => openDelete(item)}>
        <Trash2 /> {tCommon('action.delete')}
      </Button>
    </>
  )

  return (
    <Page title={t('title')} actions={createButton}>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorMessage error={list.error} />
      ) : (
        <DataTable
          rows={list.data.items}
          rowKey={(item) => item.id}
          columns={[{ header: t('field.name'), cell: (item) => localized(item.name) }]}
          actions={canWrite ? rowActions : undefined}
          empty={<EmptyState title={t('empty')} action={createButton} />}
        />
      )}

      <ProductTypeFormDialog open={formOpen} onOpenChange={setFormOpen} item={editing} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && openDelete(null)}
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
