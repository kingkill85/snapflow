import { keepPreviousData, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useSearchParams } from 'react-router'

import type { ProductListItem } from '@/api/generated/model'
import { useListProductTypes } from '@/api/generated/product-types/product-types'
import {
  getGetProductQueryKey,
  getListProductsQueryKey,
  getSearchVariantsQueryKey,
  useDeleteProduct,
  useListProducts,
} from '@/api/generated/products/products'
import { useCan } from '@/app/session'
import { fileUrl } from '@/catalog/files'
import { useFormatPrice } from '@/catalog/money'
import {
  Button,
  CheckboxField,
  type Column,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorMessage,
  Field,
  lastPageOffset,
  Loading,
  Page,
  Pagination,
  SelectField,
  TextLink,
  Thumbnail,
  TypeBadge,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { type EditorState, listPath, productPath } from './paths'
import { ProblemsBadge, StatusBadge } from './StatusBadge'

/** Rows per page. */
export const pageSize = 50
/** How long typing pauses before the search runs. */
const searchDelayMs = 300
/** The API's limit of the search text. */
const searchMaxLength = 200

/** catalog/products: the filtered, paged product list. Filters live in the URL, so Back returns to them. */
export function ProductsPage() {
  const { t } = useTranslation('products')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const { range } = useFormatPrice()
  const canWrite = useCan()('catalog.write')
  const queryClient = useQueryClient()

  const location = useLocation()
  // Opening a product passes the filters along, so its Cancel and Back return to them (D86).
  const linkState: EditorState = { listSearch: location.search }
  const [params, setParams] = useSearchParams()
  const search = params.get('search') ?? ''
  const productTypeId = params.get('type') ?? ''
  const showInactive = params.get('inactive') === '1'
  const offset = Math.max(0, Math.floor(Number(params.get('offset'))) || 0)

  /**
   * Changes filters; any change but paging starts again at the first page.
   * A user's change is applied synchronously (`flushSync`): in a transition
   * the controlled checkbox and select would show the old value until the
   * navigation finished. `sync: false` from effects, where flushSync is not allowed.
   */
  const setFilters = useCallback(
    (changes: Record<string, string>, { sync = true } = {}) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (!('offset' in changes)) next.delete('offset')
          for (const [name, value] of Object.entries(changes)) {
            if (value === '' || value === '0') next.delete(name)
            else next.set(name, value)
          }
          return next
        },
        { replace: true, flushSync: sync },
      ),
    [setParams],
  )

  // The search runs once typing pauses.
  const [draft, setDraft] = useState(search)
  // The URL changed from outside (e.g. the navigation link to the bare list):
  // the box shows what is searched.
  const [searched, setSearched] = useState(search)
  if (searched !== search) {
    setSearched(search)
    if (draft.trim() !== search) setDraft(search)
  }
  useEffect(() => {
    if (draft.trim() === search) return
    const timer = setTimeout(() => setFilters({ search: draft.trim() }), searchDelayMs)
    return () => clearTimeout(timer)
  }, [draft, search, setFilters])

  const types = useListProductTypes({ includeInactive: true })
  const list = useListProducts(
    {
      ...(search ? { search } : {}),
      ...(productTypeId ? { productTypeId } : {}),
      ...(showInactive ? { includeInactive: true } : {}),
      limit: pageSize,
      offset,
    },
    { query: { placeholderData: keepPreviousData } },
  )
  // An offset past the end (the last row of the last page was deleted, or
  // the URL says so) moves to the last page.
  const total = list.data?.total
  useEffect(() => {
    if (total !== undefined && total > 0 && offset >= total) setFilters({ offset: String(lastPageOffset(total, pageSize)) }, { sync: false })
  }, [total, offset, setFilters])

  const remove = useDeleteProduct()
  const [deleting, setDeleting] = useState<ProductListItem | null>(null)

  // Each delete starts without the previous attempt's error.
  const openDelete = (item: ProductListItem | null) => {
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
    queryClient.removeQueries({ queryKey: getGetProductQueryKey(deleting.id) })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getSearchVariantsQueryKey() }),
    ])
    setDeleting(null)
  }

  // Products of an inactive type are unavailable, which the list hides unless
  // inactive ones are shown: choosing such a type shows them (D87).
  const chooseType = (id: string) => {
    const inactive = types.data?.items.some((pt) => pt.id === id && !pt.isActive)
    setFilters(inactive ? { type: id, inactive: '1' } : { type: id })
  }

  const typeOptions = [
    { value: '', label: t('allTypes') },
    ...(types.data?.items ?? []).map((pt) => ({
      value: pt.id,
      label: pt.isActive ? localized(pt.name) : t('field.inactiveType', { name: localized(pt.name) }),
    })),
  ]

  const columns: Column<ProductListItem>[] = [
    { header: t('column.image'), cell: (p) => <Thumbnail src={fileUrl(p.previewImageFileId)} />, className: 'w-px' },
    {
      header: t('column.modelNumber'),
      cell: (p) => (
        <TextLink to={productPath(p.id)} state={linkState}>
          {p.modelNumber}
        </TextLink>
      ),
      className: 'whitespace-nowrap',
    },
    // On narrow screens the table scrolls instead of breaking names word by word.
    { header: t('column.name'), cell: (p) => localized(p.name), className: 'min-w-48' },
    {
      header: t('column.type'),
      cell: (p) => <TypeBadge color={p.productType.color}>{localized(p.productType.name)}</TypeBadge>,
    },
    { header: t('column.variants'), cell: (p) => p.variantCount, className: 'text-right tabular-nums' },
    {
      header: t('column.price'),
      cell: (p) => range(p.priceMin, p.priceMax) || t('noPrice'),
      className: 'text-right whitespace-nowrap tabular-nums',
    },
    {
      header: t('column.status'),
      cell: (p) => <StatusBadge available={p.available} isActive={p.isActive} unavailableHint={t('unavailableHint')} />,
    },
    { header: t('column.problems'), cell: (p) => <ProblemsBadge count={p.attributeErrors + p.staleAttributes} /> },
  ]

  const rowActions = (p: ProductListItem) => (
    <>
      {p.can.update && (
        <Button asChild size="sm" variant="secondary">
          <Link to={productPath(p.id)} state={linkState}>
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

  // Without catalog.write the page is read-only.
  const createButton = canWrite ? (
    <Button asChild>
      <Link to={`${listPath}/new`} state={linkState}>
        <Plus /> {t('new')}
      </Link>
    </Button>
  ) : undefined
  const filtered = search !== '' || productTypeId !== '' || showInactive

  return (
    <Page title={t('title')} description={t('description')} actions={createButton}>
      <div className="grid items-end gap-4 sm:grid-cols-3">
        <Field
          type="search"
          label={t('search')}
          placeholder={t('searchHint')}
          maxLength={searchMaxLength}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <SelectField label={t('typeFilter')} value={productTypeId} options={typeOptions} onChange={(e) => chooseType(e.target.value)} />
        <div className="sm:pb-2">
          <CheckboxField label={t('showInactive')} checked={showInactive} onChange={(e) => setFilters({ inactive: e.target.checked ? '1' : '' })} />
        </div>
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorMessage error={list.error} />
      ) : (
        <>
          <DataTable
            rows={list.data.items}
            rowKey={(p) => p.id}
            columns={columns}
            actions={canWrite ? rowActions : undefined}
            empty={filtered ? <EmptyState title={t('emptyFiltered')} /> : <EmptyState title={t('empty')} action={createButton} />}
          />
          <Pagination offset={offset} limit={pageSize} total={list.data.total} onChange={(o) => setFilters({ offset: String(o) })} />
        </>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && openDelete(null)}
        title={t('deleteTitle')}
        message={t('deleteMessage', { name: deleting ? `${deleting.modelNumber} ${localized(deleting.name)}` : '' })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Page>
  )
}
