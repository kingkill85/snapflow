import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import { useCreateManualLine, useUpdateManualLine } from '@/api/generated/bom/bom'
import { formatDecimal, parseDecimal, useDecimalSeparator } from '@/catalog/decimal'
import { pricePattern } from '@/catalog/money'
import {
  apiFields,
  Button,
  errorKey,
  ErrorMessage,
  Field,
  FormDialog,
  FormSelectField,
  setApiFieldErrors,
  TextareaField,
  Thumbnail,
  TypeBadge,
  useFieldError,
} from '@/components/ui'
import { groupPalette, paletteProducts, useCatalogVariants } from '@/features/plans'
import { useLocalized } from '@/i18n/localized'
import { cn } from '@/lib/cn'

import { type BomManualLine, useFormatMoney, useLineName, useRefreshBom } from './format'

export type ManualLineKindChoice = 'catalog' | 'freeText'

const schema = (kind: ManualLineKindChoice) =>
  z.object({
    variantId: kind === 'catalog' ? z.string().min(1, errorKey('validation.required')) : z.string(),
    name: kind === 'freeText' ? z.string().trim().min(1, errorKey('validation.required')).max(200, errorKey('validation.too_long', { max: 200 })) : z.string(),
    unitPrice:
      kind === 'freeText'
        ? z
            .string()
            .trim()
            .min(1, errorKey('validation.required'))
            .refine((v) => {
              const p = parseDecimal(v)
              return p !== undefined && pricePattern.test(p)
            }, errorKey('bom.unit_price_invalid'))
        : z.string(),
    quantity: z
      .string()
      .trim()
      .min(1, errorKey('validation.required'))
      .refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 100000, errorKey('bom.quantity_range', { min: 1, max: 100000 })),
    note: z.string().trim().max(500, errorKey('validation.too_long', { max: 500 })),
  })
type FormValues = z.infer<ReturnType<typeof schema>>

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  versionId: string
  /** null = a new line of `kind`. */
  item: BomManualLine | null
  kind: ManualLineKindChoice
  productTypeIds: string[]
}

/**
 * A manual line: a catalog product (picked like in the plan palette, then its
 * variant) or free text with a USD unit price (decimal comma or point, D144);
 * quantity and note. A catalog line's product is fixed once added (D236).
 */
export function ManualLineDialog({ open, onOpenChange, versionId, item, kind, productTypeIds }: Props) {
  const { t } = useTranslation('bom')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const separator = useDecimalSeparator()
  const refresh = useRefreshBom(versionId)
  const lineName = useLineName()
  const create = useCreateManualLine()
  const update = useUpdateManualLine()
  const mutation = item ? update : create
  const lineKind: ManualLineKindChoice = item ? (item.kind === 'catalog' ? 'catalog' : 'freeText') : kind
  const fields = apiFields<FormValues>(['variantId', 'name', 'unitPrice', 'quantity', 'note'])
  const form = useForm<FormValues>({ resolver: zodResolver(schema(lineKind)) })
  const { errors } = form.formState
  const { reset } = form
  const variantId = useWatch({ control: form.control, name: 'variantId' })
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  useEffect(() => {
    if (!open) return
    reset({
      variantId: item?.variantId ?? '',
      name: item?.name ?? '',
      unitPrice: item && item.kind === 'freeText' ? formatDecimal(item.unitPrice, separator) : '',
      quantity: String(item?.quantity ?? 1),
      note: item?.note ?? '',
    })
    resetCreate()
    resetUpdate()
    // Only when the dialog opens or switches line (not when a refetch brings a newer updatedAt).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id, reset, resetCreate, resetUpdate])

  const submit = form.handleSubmit(async (v) => {
    const body = {
      quantity: Number(v.quantity),
      note: v.note,
      ...(lineKind === 'catalog' ? { variantId: v.variantId } : { name: v.name, unitPrice: parseDecimal(v.unitPrice) }),
    }
    try {
      if (item) await update.mutateAsync({ versionId, id: item.id, data: { ...body, expectedUpdatedAt: item.updatedAt } })
      else await create.mutateAsync({ versionId, data: body })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      // Someone else changed the line: load the current one, so saving again overwrites knowingly.
      if (error instanceof ApiError && error.code === 'bom.line_stale') await refresh()
      return // shown by ErrorMessage via mutation.error
    }
    await refresh()
    onOpenChange(false)
  })

  const title = item ? t('manual.editTitle') : lineKind === 'catalog' ? t('manual.newCatalogTitle') : t('manual.newFreeTextTitle')
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={mutation.error} fields={fields} />}
    >
      {lineKind === 'catalog' &&
        (item ? (
          <p className="text-sm">
            <span className="block text-xs font-medium text-muted">{t('manual.product')}</span>
            {lineName(item)}
          </p>
        ) : (
          <ProductPicker
            productTypeIds={productTypeIds}
            value={variantId}
            onChange={(id) => form.setValue('variantId', id, { shouldValidate: form.formState.isSubmitted })}
            control={form.control}
            error={fieldError(errors.variantId?.message)}
          />
        ))}
      {lineKind === 'freeText' && (
        <>
          <Field label={t('manual.name')} autoComplete="off" required error={fieldError(errors.name?.message)} {...form.register('name')} />
          <Field
            label={t('manual.unitPrice')}
            inputMode="decimal"
            autoComplete="off"
            required
            hint={t('manual.unitPriceHint')}
            error={fieldError(errors.unitPrice?.message)}
            {...form.register('unitPrice')}
          />
        </>
      )}
      <Field label={t('manual.quantity')} inputMode="numeric" autoComplete="off" required error={fieldError(errors.quantity?.message)} {...form.register('quantity')} />
      <TextareaField label={t('manual.note')} error={fieldError(errors.note?.message)} {...form.register('note')} />
    </FormDialog>
  )
}

type PickerProps = {
  productTypeIds: string[]
  value: string
  onChange: (variantId: string) => void
  control: ReturnType<typeof useForm<FormValues>>['control']
  error?: string
}

/** The project's available products with a search (like the plan palette), then the variant. */
function ProductPicker({ productTypeIds, value, onChange, control, error }: PickerProps) {
  const { t } = useTranslation('bom')
  const localize = useLocalized()
  const money = useFormatMoney()
  const [search, setSearch] = useState('')
  const variants = useCatalogVariants()
  if (variants.isPending) return <p className="text-sm text-muted">…</p>
  if (variants.isError) return <ErrorMessage error={variants.error} />
  const products = paletteProducts(variants.data, productTypeIds)
  const groups = groupPalette(products, search, localize)
  const chosen = products.find((p) => p.variants.some((v) => v.id === value))

  return (
    <div className="space-y-3">
      <Field label={t('manual.search')} type="search" value={search} onChange={(e) => setSearch(e.target.value)} hint={t('manual.searchHint')} />
      <div role="group" aria-label={t('manual.product')} className="max-h-64 space-y-2 overflow-y-auto rounded-control border border-line p-2">
        {products.length === 0 ? (
          <p className="text-sm text-muted">{t('manual.noProducts')}</p>
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted">{t('manual.noMatch')}</p>
        ) : (
          groups.map((group) => (
            <div key={group.category.id} className="space-y-1">
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">{localize(group.category.name)}</p>
              {group.products.map((p) => (
                <Button
                  key={p.productId}
                  variant="ghost"
                  aria-pressed={chosen?.productId === p.productId}
                  onClick={() => onChange(p.defaultVariant.id)}
                  className={cn('h-auto w-full justify-start px-2 py-1.5 text-left font-normal whitespace-normal', chosen?.productId === p.productId && 'bg-primary/10 ring-1 ring-primary')}
                >
                  <Thumbnail src={p.imageUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{localize(p.name)}</span>
                    <TypeBadge color={p.productType.color} abbreviation={p.productType.abbreviation}>
                      {p.modelNumber}
                    </TypeBadge>
                  </span>
                </Button>
              ))}
            </div>
          ))
        )}
      </div>
      {error && !chosen && <p className="text-xs text-danger">{error}</p>}
      {!chosen && !error && <p className="text-xs text-muted">{t('manual.chooseProduct')}</p>}
      {chosen && chosen.variants.length > 1 && (
        <FormSelectField
          control={control}
          name="variantId"
          label={t('manual.variant')}
          options={chosen.variants.map((v) => ({ value: v.id, label: `${localize(v.name)} (${money(v.price)})` }))}
        />
      )}
    </div>
  )
}
