import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Plus, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'
import type { Addon, Product, ProductType, SearchVariantsParams, Variant, VariantSearchItem } from '@/api/generated/model'
import { getGetProductQueryKey, getSearchVariantsQueryKey, searchVariants, useReplaceVariantAddons } from '@/api/generated/products/products'
import { fileUrl } from '@/catalog/files'
import { useFormatPrice } from '@/catalog/money'
import {
  type ApiFieldMap,
  Badge,
  Button,
  CheckboxField,
  ErrorMessage,
  Field,
  type MoveAction,
  Notice,
  RepeaterControls,
  RepeaterItem,
  Section,
  SelectField,
  TextLink,
  Thumbnail,
  TypeBadge,
  useErrorMessage,
  useRepeaterFocus,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { type EditorState, productPath } from './paths'

/** Variants loaded per page of the picker ("Show more" loads the next). */
export const pickerPageSize = 20
const searchDelayMs = 300
/** The API's limit of the search text. */
const searchMaxLength = 200

/** One linked add-on as the editor shows it. */
type Item = Omit<Addon, 'sortOrder'> & { id: string }

const fromAddon = (a: Addon): Item => ({ ...a, id: a.addonVariantId })
const fromSearch = (v: VariantSearchItem): Item => ({
  id: v.id,
  addonVariantId: v.id,
  required: false,
  modelNumber: v.modelNumber,
  productId: v.productId,
  productName: v.productName,
  variantName: v.name,
  price: v.price,
  imageFileId: v.imageFileId,
  available: v.available,
})
const signature = (items: { addonVariantId: string; required: boolean }[]) => JSON.stringify(items.map((i) => [i.addonVariantId, i.required]))

type AddonsEditorProps = {
  product: Product
  variant: Variant
  /** The product types, for the picker's type filter. */
  types: ProductType[]
  readOnly: boolean
  /** Navigation state for the links to the add-ons' products. */
  linkState?: EditorState
  onDirtyChange: (dirty: boolean) => void
}

/**
 * A variant's add-ons: browse or search variants across the catalog, mark
 * them required, order and remove them, then save the whole list at once
 * (D53, D83).
 */
export function AddonsEditor({ product, variant, types, readOnly, linkState, onDirtyChange }: AddonsEditorProps) {
  const { t } = useTranslation('products')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const { price } = useFormatPrice()
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const replace = useReplaceVariantAddons()

  // The list as last saved (or loaded), and as edited.
  const [baseline, setBaseline] = useState(() => variant.addons.map(fromAddon))
  const [items, setItems] = useState(baseline)
  const [saved, setSaved] = useState(false)
  // Row errors of the last failed save, by add-on variant id (rows move meanwhile).
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [errorFields, setErrorFields] = useState<ApiFieldMap>()
  const focus = useRepeaterFocus(items)
  const dirty = signature(items) !== signature(baseline)
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  // The picker lists variants in catalog order before anything is typed;
  // typing and the type filter narrow it; "Show more" loads the next page (D83).
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setSearch(draft.trim()), searchDelayMs)
    return () => clearTimeout(timer)
  }, [draft])
  const params: SearchVariantsParams = { ...(search ? { search } : {}), ...(typeFilter ? { productTypeId: typeFilter } : {}) }
  const results = useInfiniteQuery({
    queryKey: [...getSearchVariantsQueryKey(params), 'pages'],
    queryFn: ({ pageParam, signal }) => searchVariants({ ...params, limit: pickerPageSize, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.items.length, 0)
      return last.items.length > 0 && loaded < last.total ? loaded : undefined
    },
    enabled: !readOnly,
    placeholderData: keepPreviousData,
  })
  // For convenience only: the server rejects self and duplicates anyway. The
  // count names the rows shown, not the server's total, which includes them.
  const linked = new Set(items.map((i) => i.addonVariantId))
  const offered = (results.data?.pages ?? []).flatMap((page) => page.items).filter((r) => r.id !== variant.id && !linked.has(r.id))
  const typeOptions = [
    { value: '', label: t('allTypes') },
    ...types.map((pt) => ({ value: pt.id, label: pt.isActive ? localized(pt.name) : t('field.inactiveType', { name: localized(pt.name) }) })),
  ]

  const change = (next: Item[]) => {
    setItems(next)
    setSaved(false)
  }
  const add = (v: VariantSearchItem) => change([...items, fromSearch(v)])
  const move = (from: number, to: number, action: MoveAction) => {
    const next = [...items]
    next.splice(to, 0, ...next.splice(from, 1))
    focus.moved(to, action)
    change(next)
  }
  const remove = (index: number) => {
    focus.removed(index)
    change(items.filter((_, i) => i !== index))
  }
  const setRequired = (index: number, required: boolean) => change(items.map((item, i) => (i === index ? { ...item, required } : item)))

  const save = async () => {
    const sent = items
    let result: Variant
    try {
      result = await replace.mutateAsync({
        id: product.id,
        variantId: variant.id,
        data: { addons: sent.map((i) => ({ addonVariantId: i.addonVariantId, required: i.required })) },
      })
    } catch (error) {
      // Errors at body.addons[i].addonVariantId belong to the row sent at i.
      const byRow: Record<string, string> = {}
      const fields: Record<string, string> = {}
      if (error instanceof ApiError) {
        for (const f of error.fields) {
          const match = /^body\.addons\[(\d+)\]/.exec(f.location)
          const item = match ? sent[Number(match[1])] : undefined
          if (!item) continue
          byRow[item.addonVariantId] = errorMessage(new ApiError({ status: 422, code: f.code, params: f.params }))
          fields[f.location.slice('body.'.length)] = item.addonVariantId
        }
      }
      setRowErrors(byRow)
      setErrorFields(fields)
      return
    }
    setRowErrors({})
    const next = result.addons.map(fromAddon)
    setBaseline(next)
    setItems(next)
    setSaved(true)
    queryClient.setQueryData(getGetProductQueryKey(product.id), (p: Product | undefined) =>
      p ? { ...p, variants: p.variants.map((v) => (v.id === result.id ? result : v)) } : p,
    )
  }

  const itemName = (i: Item) => `${i.modelNumber} ${localized(i.variantName)}`

  return (
    <Section title={t('addons.title')} description={t('addons.description')}>
      {!readOnly && (
        <div className="space-y-2">
          <div className="grid items-end gap-4 sm:grid-cols-2">
            <Field
              type="search"
              label={t('addons.search')}
              placeholder={t('addons.searchHint')}
              maxLength={searchMaxLength}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <SelectField label={t('addons.typeFilter')} value={typeFilter} options={typeOptions} onChange={(e) => setTypeFilter(e.target.value)} />
          </div>
          <div role="region" aria-label={t('addons.results')} className="space-y-2">
            {results.isError ? (
              <ErrorMessage error={results.error} />
            ) : results.isPending ? (
              <p className="text-sm text-muted">{tCommon('state.loading')}</p>
            ) : (
              <>
                {offered.length === 0 && !results.hasNextPage ? (
                  <p className="text-sm text-muted">{t('addons.noResults')}</p>
                ) : (
                  offered.length > 0 && (
                    <ul className="max-h-96 divide-y divide-line overflow-y-auto rounded-control border border-line">
                      {offered.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                          <Thumbnail src={fileUrl(r.imageFileId)} />
                          {/* Long model numbers and SKUs wrap; on a phone, price and Add move below. */}
                          <div className="min-w-0 flex-1 basis-48 space-y-0.5 text-sm wrap-anywhere">
                            <p className="font-medium">
                              {r.modelNumber} · {localized(r.name)}
                            </p>
                            {r.sku && <p className="text-xs text-muted">{t('addons.sku', { sku: r.sku })}</p>}
                            <p className="text-muted">
                              <TypeBadge color={r.productType.color}>{localized(r.productName)}</TypeBadge>
                            </p>
                          </div>
                          <span className="text-sm tabular-nums">{price(r.price)}</span>
                          {!r.available && <Badge>{tCommon('status.unavailable')}</Badge>}
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-label={t('addons.add', { name: `${r.modelNumber} ${localized(r.name)}` })}
                            onClick={() => add(r)}
                          >
                            <Plus /> {t('addons.addShort')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {offered.length > 0 && (
                    <p className="text-xs text-muted" aria-live="polite">
                      {t('addons.shown', { count: offered.length })}
                    </p>
                  )}
                  {results.hasNextPage && (
                    <Button size="sm" variant="secondary" disabled={results.isFetchingNextPage} onClick={() => void results.fetchNextPage()}>
                      <ChevronDown /> {t('addons.showMore')}
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div role="list" aria-label={t('addons.linked')} className="space-y-2">
        {items.length === 0 && <p className="text-sm text-muted">{t('addons.empty')}</p>}
        {items.map((item, index) => (
          <div role="listitem" key={item.id}>
            <RepeaterItem
              compact
              itemId={item.id}
              title={itemName(item)}
              subtitle={price(item.price)}
              invalid={rowErrors[item.addonVariantId] !== undefined}
              controls={
                !readOnly && (
                  <RepeaterControls index={index} count={items.length} name={itemName(item)} onMove={move} onRemove={remove} />
                )
              }
            >
              <div className="flex flex-wrap items-center gap-3">
                <Thumbnail src={fileUrl(item.imageFileId)} />
                <p className="min-w-0 flex-1 text-sm text-muted">
                  <TextLink to={productPath(item.productId)} state={linkState}>
                    {localized(item.productName)}
                  </TextLink>
                </p>
                {!item.available && <Badge>{tCommon('status.unavailable')}</Badge>}
                <CheckboxField
                  label={t('addons.required')}
                  aria-label={t('addons.requiredFor', { name: itemName(item) })}
                  checked={item.required}
                  disabled={readOnly}
                  onChange={(e) => setRequired(index, e.target.checked)}
                />
              </div>
              {rowErrors[item.addonVariantId] && (
                <p data-field-error tabIndex={-1} className="text-xs text-danger outline-none">
                  {rowErrors[item.addonVariantId]}
                </p>
              )}
            </RepeaterItem>
          </div>
        ))}
      </div>

      {!readOnly && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="min-w-0 flex-1">
            <ErrorMessage error={replace.error} fields={errorFields} />
            {saved && !replace.error && <Notice>{t('addons.saved')}</Notice>}
            {dirty && <Notice tone="warning">{t('addons.unsaved')}</Notice>}
          </div>
          <Button disabled={!dirty || replace.isPending} onClick={() => void save()}>
            <Save /> {t('addons.save')}
          </Button>
        </div>
      )}
    </Section>
  )
}
