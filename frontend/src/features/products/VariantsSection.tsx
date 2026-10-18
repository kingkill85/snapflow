import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import type { Product, Variant } from '@/api/generated/model'
import { getGetProductQueryKey, getListProductsQueryKey, useDeleteVariant, useReorderVariants } from '@/api/generated/products/products'
import { fileUrl } from '@/catalog/files'
import { useFormatPrice } from '@/catalog/money'
import {
  Button,
  type Column,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorMessage,
  IconButton,
  Section,
  TextLink,
  Thumbnail,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { newVariantPath, variantPath } from './paths'
import { ProblemsBadge, StatusBadge } from './StatusBadge'

/**
 * The variants of a product, always as currently stored (outside the product
 * form): open, reorder (saved at once), delete, add.
 */
export function VariantsSection({ product }: { product: Product }) {
  const { t } = useTranslation('products')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const { price } = useFormatPrice()
  const queryClient = useQueryClient()
  const reorder = useReorderVariants()
  const remove = useDeleteVariant()
  const [deleting, setDeleting] = useState<Variant | null>(null)
  const canWrite = product.can.update
  const rows = product.variants
  const productKey = getGetProductQueryKey(product.id)

  const move = async (from: number, to: number) => {
    const ids = rows.map((v) => v.id)
    ids.splice(to, 0, ...ids.splice(from, 1))
    try {
      queryClient.setQueryData(productKey, await reorder.mutateAsync({ id: product.id, data: { ids } }))
    } catch {
      // Shown by ErrorMessage; the variants may have changed meanwhile.
      await queryClient.invalidateQueries({ queryKey: productKey })
      return
    }
    await queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
  }

  // Each delete starts without the previous attempt's error.
  const openDelete = (variant: Variant | null) => {
    remove.reset()
    setDeleting(variant)
  }
  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ id: product.id, variantId: deleting.id })
    } catch {
      return // shown by ErrorMessage via remove.error
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: productKey }),
      queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() }),
    ])
    setDeleting(null)
  }

  const columns: Column<Variant>[] = [
    { header: t('variants.column.image'), cell: (v) => <Thumbnail src={fileUrl(v.imageFileId)} />, className: 'w-px' },
    { header: t('variants.column.name'), cell: (v) => <TextLink to={variantPath(product.id, v.id)}>{localized(v.name)}</TextLink> },
    { header: t('variants.column.sku'), cell: (v) => v.sku ?? '' },
    { header: t('variants.column.price'), cell: (v) => price(v.price), className: 'text-right whitespace-nowrap tabular-nums' },
    {
      header: t('variants.column.status'),
      cell: (v) => (
        <span className="inline-flex flex-wrap gap-1">
          <StatusBadge available={v.available} isActive={v.isActive} unavailableHint={t('variant.productInactive')} />
          <ProblemsBadge count={v.attributeErrors.length + Object.keys(v.staleAttributes).length} />
        </span>
      ),
    },
    { header: t('variants.column.addons'), cell: (v) => v.addons.length, className: 'text-right tabular-nums' },
  ]

  const rowActions = (v: Variant) => {
    const index = rows.indexOf(v)
    const name = localized(v.name)
    return (
      <>
        <IconButton
          label={t('variants.moveUp', { name })}
          icon={<ArrowUp />}
          disabled={index === 0 || reorder.isPending}
          onClick={() => void move(index, index - 1)}
        />
        <IconButton
          label={t('variants.moveDown', { name })}
          icon={<ArrowDown />}
          disabled={index === rows.length - 1 || reorder.isPending}
          onClick={() => void move(index, index + 1)}
        />
        {v.can.update && (
          <Button asChild size="sm" variant="secondary">
            <Link to={variantPath(product.id, v.id)}>
              <Pencil /> {tCommon('action.edit')}
            </Link>
          </Button>
        )}
        {v.can.delete && (
          <Button size="sm" variant="danger" onClick={() => openDelete(v)}>
            <Trash2 /> {tCommon('action.delete')}
          </Button>
        )}
      </>
    )
  }

  const addButton = canWrite ? (
    <Button asChild size="sm">
      <Link to={newVariantPath(product.id)}>
        <Plus /> {t('variants.add')}
      </Link>
    </Button>
  ) : undefined

  return (
    <Section title={t('section.variants')} description={t('section.variantsHint')} actions={rows.length > 0 ? addButton : undefined}>
      <ErrorMessage error={reorder.error} />
      <DataTable
        rows={rows}
        rowKey={(v) => v.id}
        columns={columns}
        actions={canWrite ? rowActions : undefined}
        empty={<EmptyState title={t('variants.empty')} action={addButton} />}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && openDelete(null)}
        title={t('variants.deleteTitle')}
        message={t('variants.deleteMessage', { name: localized(deleting?.name) })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Section>
  )
}
