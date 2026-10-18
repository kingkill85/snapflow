import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { ApiError } from '@/api/client'
import type { Category } from '@/api/generated/model'
import {
  getGetCategoryQueryKey,
  getListCategoriesQueryKey,
  getListCategoriesQueryOptions,
  useDeleteCategory,
  useListCategories,
  useReorderCategories,
} from '@/api/generated/categories/categories'
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
  TextLink,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { listPath } from './CategoryEditorPage'

/** Tries of a move whose save meets a list changed meanwhile (see move). */
const moveAttempts = 3

export function CategoriesPage() {
  const { t } = useTranslation('categories')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const canWrite = useCan()('catalog.write')
  const queryClient = useQueryClient()
  const [showInactive, setShowInactive] = useState(false)
  const list = useListCategories(showInactive ? { includeInactive: true } : undefined)
  const remove = useDeleteCategory()
  const reorder = useReorderCategories()
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<unknown>(null)
  const [deleting, setDeleting] = useState<Category | null>(null)

  // Each delete starts without the previous attempt's error.
  const openDelete = (item: Category | null) => {
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
    queryClient.removeQueries({ queryKey: getGetCategoryQueryKey(deleting.id) })
    await Promise.all([queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() }), invalidateProductQueries(queryClient)])
    setDeleting(null)
  }

  // Moves a category past its visible neighbour. The order covers inactive
  // categories too and the API wants all ids, so the move is applied to the
  // full list, fetched fresh (D29). If the item or its neighbour is gone,
  // nothing is sent. If another category was created or deleted between the
  // fetch and the save (order_mismatch), the move is still well defined: it
  // is applied to the list fetched again, a few times at most (D92).
  const move = async (item: Category, neighbour: Category, direction: 'up' | 'down') => {
    setMoving(true)
    setMoveError(null)
    for (let attempt = 1; ; attempt++) {
      let gone = false
      try {
        const all = await queryClient.fetchQuery({ ...getListCategoriesQueryOptions({ includeInactive: true }), staleTime: 0 })
        const ids = all.items.map((i) => i.id).filter((id) => id !== item.id)
        const at = ids.indexOf(neighbour.id)
        if (at < 0 || ids.length === all.items.length) {
          gone = true
          throw new ApiError({ status: 422, code: 'category.order_mismatch' })
        }
        ids.splice(direction === 'up' ? at : at + 1, 0, item.id)
        await reorder.mutateAsync({ data: { ids } })
        break
      } catch (error) {
        if (!gone && attempt < moveAttempts && error instanceof ApiError && error.code === 'category.order_mismatch') continue
        setMoveError(error) // and reload below, in case the list changed meanwhile
        break
      }
    }
    await Promise.all([queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() }), invalidateProductQueries(queryClient)])
    setMoving(false)
  }

  const rows = list.data?.items ?? []
  const columns: Column<Category>[] = [
    // The position among the rows shown (sortOrder counts hidden inactive categories too).
    { header: t('field.position'), cell: (p) => rows.indexOf(p) + 1, className: 'w-px text-right tabular-nums' },
    {
      header: t('field.name'),
      cell: (p) => <TextLink to={`${listPath}/${p.id}`}>{localized(p.name)}</TextLink>,
    },
    { header: t('field.key'), cell: (p) => <code className="text-xs">{p.key}</code> },
    { header: t('field.attributeCount'), cell: (p) => p.attributes.length, className: 'tabular-nums' },
    {
      header: t('field.status'),
      cell: (p) => (
        <Badge variant={p.isActive ? 'success' : 'neutral'}>{p.isActive ? tCommon('status.active') : tCommon('status.inactive')}</Badge>
      ),
    },
  ]

  const rowActions = (p: Category) => {
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
        {p.can.update && (
          <RowAction to={`${listPath}/${p.id}`} icon={<Pencil />} label={tCommon('action.edit')} />
        )}
        {p.can.delete && (
          <RowAction variant="danger" onClick={() => openDelete(p)} icon={<Trash2 />} label={tCommon('action.delete')} />
        )}
      </>
    )
  }

  // Without catalog.write the page is read-only.
  const createButton = canWrite ? (
    <Button asChild>
      <Link to={`${listPath}/new`}>
        <Plus /> {t('new')}
      </Link>
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
