import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { ApiError } from '@/api/client'
import type { ProductType } from '@/api/generated/model'
import {
  getGetProductTypeQueryKey,
  getListProductTypesQueryKey,
  getListProductTypesQueryOptions,
  useDeleteProductType,
  useListProductTypes,
  useReorderProductTypes,
} from '@/api/generated/product-types/product-types'
import { useCan } from '@/app/session'
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
  TextLink,
  TypeBadge,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { listPath } from './ProductTypeEditorPage'

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
  const [deleting, setDeleting] = useState<ProductType | null>(null)

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
    queryClient.removeQueries({ queryKey: getGetProductTypeQueryKey(deleting.id) })
    await queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() })
    setDeleting(null)
  }

  // Moves a type past its visible neighbour. The order covers inactive types
  // too and the API wants all ids, so the move is applied to the full list,
  // fetched fresh (D29). If the list changed meanwhile, nothing is sent.
  const move = async (item: ProductType, neighbour: ProductType, direction: 'up' | 'down') => {
    setMoving(true)
    setMoveError(null)
    try {
      const all = await queryClient.fetchQuery({ ...getListProductTypesQueryOptions({ includeInactive: true }), staleTime: 0 })
      const ids = all.items.map((i) => i.id).filter((id) => id !== item.id)
      const at = ids.indexOf(neighbour.id)
      if (at < 0 || ids.length === all.items.length) {
        throw new ApiError({ status: 422, code: 'product_type.order_mismatch' })
      }
      ids.splice(direction === 'up' ? at : at + 1, 0, item.id)
      await reorder.mutateAsync({ data: { ids } })
    } catch (error) {
      setMoveError(error) // and reload below, in case the list changed meanwhile
    }
    await queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() })
    setMoving(false)
  }

  const rows = list.data?.items ?? []
  const columns: Column<ProductType>[] = [
    // The position among the rows shown (sortOrder counts hidden inactive types too).
    { header: t('field.position'), cell: (p) => rows.indexOf(p) + 1, className: 'w-px text-right tabular-nums' },
    {
      header: t('field.name'),
      cell: (p) => (
        <TypeBadge color={p.color}>
          <TextLink to={`${listPath}/${p.id}`}>{localized(p.name)}</TextLink>
        </TypeBadge>
      ),
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
        {p.can.update && (
          <Button asChild size="sm" variant="secondary">
            <Link to={`${listPath}/${p.id}`}>
              <Pencil /> {tCommon('action.edit')}
            </Link>
          </Button>
        )}
        {p.can.delete && (
          <Button size="sm" variant="danger" onClick={() => openDelete(p)}>
            <Trash2 /> {tCommon('action.delete')}
          </Button>
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
    <Page title={t('title')} description={t('description')} actions={createButton}>
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
