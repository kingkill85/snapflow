import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'
import type { ProductType } from '@/api/generated/model'
import {
  getListProductTypesQueryKey,
  getListProductTypesQueryOptions,
  useDeleteProductType,
  useListProductTypes,
  useReorderProductTypes,
} from '@/api/generated/product-types/product-types'
import { useCan } from '@/app/session'
import { invalidateProductQueries } from '@/catalog/invalidate'
import {
  Badge,
  Button,
  CheckboxField,
  type Column,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorMessage,
  IconButton,
  Loading,
  Page,
  RowAction,
  TypeBadge,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { ProductTypeFormDialog } from './ProductTypeFormDialog'

/** Tries of a move whose save meets a list changed meanwhile (see move). */
const moveAttempts = 3

/** catalog/product-types: the systems and product lines (Zigbee, KNX, …), edited in a dialog. */
export function ProductTypesPage() {
  const { t } = useTranslation('productTypes')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const canWrite = useCan()('catalog.write')
  const queryClient = useQueryClient()
  const [showInactive, setShowInactive] = useState(false)
  const list = useListProductTypes(showInactive ? { includeInactive: true } : undefined)
  const remove = useDeleteProductType()
  const reorder = useReorderProductTypes()
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<unknown>(null)
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
    await Promise.all([queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() }), invalidateProductQueries(queryClient)])
    setDeleting(null)
  }

  // Moves a type past its visible neighbour. The order covers inactive types
  // too and the API wants all ids, so the move is applied to the full list,
  // fetched fresh (D29). If the item or its neighbour is gone, nothing is
  // sent. If another type was created or deleted between the fetch and the
  // save (order_mismatch), the move is still well defined: it is applied to
  // the list fetched again, a few times at most (D92).
  const move = async (item: ProductType, neighbour: ProductType, direction: 'up' | 'down') => {
    setMoving(true)
    setMoveError(null)
    for (let attempt = 1; ; attempt++) {
      let gone = false
      try {
        const all = await queryClient.fetchQuery({ ...getListProductTypesQueryOptions({ includeInactive: true }), staleTime: 0 })
        const ids = all.items.map((i) => i.id).filter((id) => id !== item.id)
        const at = ids.indexOf(neighbour.id)
        if (at < 0 || ids.length === all.items.length) {
          gone = true
          throw new ApiError({ status: 422, code: 'product_type.order_mismatch' })
        }
        ids.splice(direction === 'up' ? at : at + 1, 0, item.id)
        await reorder.mutateAsync({ data: { ids } })
        break
      } catch (error) {
        if (!gone && attempt < moveAttempts && error instanceof ApiError && error.code === 'product_type.order_mismatch') continue
        setMoveError(error) // and reload below, in case the list changed meanwhile
        break
      }
    }
    await Promise.all([queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() }), invalidateProductQueries(queryClient)])
    setMoving(false)
  }

  const rows = list.data?.items ?? []
  const columns: Column<ProductType>[] = [
    // The position among the rows shown (sortOrder counts hidden inactive types too).
    { header: t('field.position'), cell: (p) => rows.indexOf(p) + 1, className: 'w-px whitespace-nowrap text-right tabular-nums' },
    {
      header: t('field.name'),
      mobile: 'title',
      cell: (p) => (
        <TypeBadge color={p.color} abbreviation={p.abbreviation} wrap>
          {localized(p.name)}
        </TypeBadge>
      ),
    },
    // Tablets: the key gives way to topology and addressing (the row actions fit).
    { header: t('field.key'), cell: (p) => <code className="text-xs">{p.key}</code>, className: 'md:max-lg:hidden' },
    { header: t('field.topology'), cell: (p) => t(`topology.${p.topology}`) },
    // "–" for none: a scheme is the exception, not the rule.
    { header: t('field.addressing'), cell: (p) => (p.addressing === 'none' ? '–' : t(`addressing.${p.addressing}`)) },
    {
      header: t('field.status'),
      cell: (p) => (
        <Badge variant={p.isActive ? 'success' : 'neutral'}>{p.isActive ? tCommon('status.active') : tCommon('status.inactive')}</Badge>
      ),
    },
  ]

  const rowActions = (p: ProductType) => {
    const index = rows.indexOf(p)
    return (
      <>
        <IconButton
          label={t('moveUp', { name: localized(p.name) })}
          icon={<ArrowUp />}
          disabled={index === 0 || moving}
          onClick={() => void move(p, rows[index - 1], 'up')}
        />
        <IconButton
          label={t('moveDown', { name: localized(p.name) })}
          icon={<ArrowDown />}
          disabled={index === rows.length - 1 || moving}
          onClick={() => void move(p, rows[index + 1], 'down')}
        />
        {p.can.update && <RowAction onClick={() => openForm(p)} icon={<Pencil />} label={tCommon('action.edit')} />}
        {p.can.delete && (
          <RowAction variant="danger-quiet" onClick={() => openDelete(p)} icon={<Trash2 />} label={tCommon('action.delete')} />
        )}
      </>
    )
  }

  // Without catalog.write the page is read-only.
  const createButton = canWrite ? (
    <Button onClick={() => openForm(null)}>
      <Plus /> {t('new')}
    </Button>
  ) : undefined

  return (
    <Page width="wide" title={t('title')} description={t('description')} actions={createButton}>
      <CheckboxField label={t('showInactive')} checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
      <ErrorMessage error={moveError} />
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorMessage error={list.error} />
      ) : (
        <DataTable
          rows={rows}
          rowKey={(p) => p.id}
          columns={columns}
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
