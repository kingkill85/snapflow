import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import type { Product, Variant } from '@/api/generated/model'
import {
  getGetProductQueryKey,
  getListProductsQueryKey,
  getSearchVariantsQueryKey,
  useDeleteVariant,
  useReorderVariants,
} from '@/api/generated/products/products'
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
  Notice,
  RowAction,
  Section,
  TextLink,
  Thumbnail,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { type EditorState, newVariantPath, variantPath } from './paths'
import { ProblemsBadge, StatusBadge } from './StatusBadge'

/** Whether a variant's stored values need attention (errors or values no longer in the schema). */
const problemCount = (v: Variant) => v.attributeErrors.length + Object.keys(v.staleAttributes).length

type VariantsSectionProps = {
  product: Product
  /**
   * The product form has unsaved changes: opening or adding a variant is
   * disabled until it is saved (D88). Reordering and deleting stay, they do
   * not leave the page.
   */
  locked?: boolean
  /** Navigation state passed to the variant pages (the list's filters). */
  linkState?: EditorState
}

/**
 * The variants of a product, always as currently stored (outside the product
 * form): open, reorder (saved at once), delete, add.
 */
export function VariantsSection({ product, locked = false, linkState }: VariantsSectionProps) {
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
    // Each move starts without the previous one's error.
    reorder.reset()
    const ids = rows.map((v) => v.id)
    ids.splice(to, 0, ...ids.splice(from, 1))
    try {
      queryClient.setQueryData(productKey, await reorder.mutateAsync({ id: product.id, data: { ids } }))
    } catch {
      // Shown by ErrorMessage; the variants may have changed meanwhile.
      await queryClient.invalidateQueries({ queryKey: productKey })
      return
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getSearchVariantsQueryKey() }),
    ])
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
      queryClient.invalidateQueries({ queryKey: getSearchVariantsQueryKey() }),
    ])
    setDeleting(null)
  }

  const columns: Column<Variant>[] = [
    { header: t('variants.column.image'), cell: (v) => <Thumbnail src={fileUrl(v.imageFileId)} />, className: 'w-px' },
    {
      header: t('variants.column.name'),
      cell: (v) =>
        locked ? (
          localized(v.name)
        ) : (
          <TextLink to={variantPath(product.id, v.id)} state={linkState}>
            {localized(v.name)}
          </TextLink>
        ),
      // On narrow screens the table scrolls instead of breaking names word by word.
      className: 'min-w-40',
    },
    { header: t('variants.column.sku'), cell: (v) => v.sku ?? '', className: 'min-w-48 wrap-anywhere' },
    { header: t('variants.column.price'), cell: (v) => price(v.price), className: 'text-right whitespace-nowrap tabular-nums' },
    {
      header: t('variants.column.status'),
      cell: (v) => (
        <span className="inline-flex flex-wrap gap-1">
          <StatusBadge available={v.available} isActive={v.isActive} unavailableHint={t('variant.productInactive')} />
          <ProblemsBadge count={problemCount(v)} />
        </span>
      ),
    },
    { header: t('variants.column.addons'), cell: (v) => v.addons.length, className: 'text-right whitespace-nowrap tabular-nums' },
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
        {v.can.update &&
          (locked ? (
            <RowAction disabled title={t('variants.saveFirst')} icon={<Pencil />} label={tCommon('action.edit')} />
          ) : (
            <RowAction to={variantPath(product.id, v.id)} state={linkState} icon={<Pencil />} label={tCommon('action.edit')} />
          ))}
        {v.can.delete && (
          <RowAction variant="danger" onClick={() => openDelete(v)} icon={<Trash2 />} label={tCommon('action.delete')} />
        )}
      </>
    )
  }

  const addButton = !canWrite ? undefined : locked ? (
    <Button size="sm" disabled title={t('variants.saveFirst')}>
      <Plus /> {t('variants.add')}
    </Button>
  ) : (
    <Button asChild size="sm">
      <Link to={newVariantPath(product.id)} state={linkState}>
        <Plus /> {t('variants.add')}
      </Link>
    </Button>
  )

  // Variants whose stored values no longer match the category's schema, e.g.
  // after the product's category changed (D68): flagged, never refused.
  const withProblems = rows.filter((v) => problemCount(v) > 0)

  return (
    <Section title={t('section.variants')} description={t('section.variantsHint')} actions={rows.length > 0 ? addButton : undefined}>
      {locked && <Notice tone="warning">{t('variants.saveFirst')}</Notice>}
      {product.variantsWithProblems > 0 && (
        <Notice tone="warning">
          {t('variants.problems', { count: product.variantsWithProblems })}{' '}
          {withProblems.map((v, i) => (
            <Fragment key={v.id}>
              {i > 0 && ', '}
              {locked ? (
                localized(v.name)
              ) : (
                <TextLink to={variantPath(product.id, v.id)} state={linkState}>
                  {localized(v.name)}
                </TextLink>
              )}
            </Fragment>
          ))}
        </Notice>
      )}
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
