import { useTranslation } from 'react-i18next'

import type { ImportItemStatus, ImportRunState } from '@/api/generated/model'
import { fileUrl } from '@/catalog/files'
import { useFormatPrice } from '@/catalog/money'
import { Badge, Thumbnail, TypeBadge } from '@/components/ui'
import { type LocalizedText, useLocalized } from '@/i18n/localized'
import { cn } from '@/lib/cn'

// States and the values of the diff and the change log, in the UI language.
const runStateVariant = {
  uploaded: 'neutral',
  previewed: 'primary',
  applied: 'success',
  failed: 'danger',
  undone: 'warning',
} as const

export function RunStateBadge({ state }: { state: ImportRunState }) {
  const { t } = useTranslation('imports')
  return <Badge variant={runStateVariant[state]}>{t(`state.${state}`)}</Badge>
}

const itemStatusVariant = { new: 'success', changed: 'primary', unchanged: 'neutral', deactivate: 'warning' } as const

export function ItemStatusBadge({ status }: { status: ImportItemStatus }) {
  const { t } = useTranslation('imports')
  return <Badge variant={itemStatusVariant[status]}>{t(`status.${status}`)}</Badge>
}

type AddonRef = { label: string; required: boolean; variantId?: string }
type Ref = { name?: LocalizedText; key?: string; abbreviation?: string; color?: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * One value of the diff or the change log: images as thumbnails, product
 * types with their badge, add-on lists, flags and prices in the UI language.
 */
export function FieldValue({ field, value }: { field: string; value: unknown }) {
  const { t } = useTranslation('imports')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const { price } = useFormatPrice()
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
    return <span className="text-muted">{t('value.none')}</span>
  }
  if ((field === 'image' || field === 'imageFileId') && typeof value === 'string') {
    return (
      <span className="inline-flex items-center gap-2">
        <Thumbnail src={fileUrl(value)} alt={t('value.image')} size="md" />
      </span>
    )
  }
  if (field === 'productType' && isObject(value)) {
    const ref = value as Ref
    return (
      <TypeBadge color={ref.color} abbreviation={ref.abbreviation} wrap>
        {localized(ref.name) || ref.key}
      </TypeBadge>
    )
  }
  if (field === 'category' && isObject(value)) {
    const ref = value as Ref
    return <span>{localized(ref.name) || ref.key}</span>
  }
  if (field === 'addons' && Array.isArray(value)) {
    return (
      <ul className="space-y-0.5">
        {(value as AddonRef[]).map((a, i) => (
          <li key={i} className="flex flex-wrap items-center gap-1.5">
            <span className="break-all">{a.label}</span>
            <Badge variant={a.required ? 'primary' : 'neutral'}>{a.required ? t('value.required') : t('value.optional')}</Badge>
          </li>
        ))}
      </ul>
    )
  }
  if (field === 'isActive' && typeof value === 'boolean') return <span>{value ? tCommon('status.active') : tCommon('status.inactive')}</span>
  if (field === 'price' && typeof value === 'string') return <span className="tabular-nums">{price(value)}</span>
  if (typeof value === 'boolean') return <span>{value ? t('value.yes') : t('value.no')}</span>
  if (Array.isArray(value)) return <span className="break-words">{value.map((v) => (isObject(v) ? JSON.stringify(v) : String(v))).join(', ')}</span>
  if (isObject(value)) {
    // A translatable text ({"en": …}) or anything else structured.
    const texts = Object.values(value).every((v) => typeof v === 'string')
    return <span className="break-words">{texts ? localized(value as LocalizedText) : JSON.stringify(value)}</span>
  }
  return <span className="break-words whitespace-pre-line">{String(value)}</span>
}

export type DiffRow = { key: string; label: string; before: { field: string; value: unknown }; after: { field: string; value: unknown } }

/** Fields before and after (or only the values of something new), side by side from small tablets up. */
export function DiffList({ rows, showBefore }: { rows: DiffRow[]; showBefore: boolean }) {
  const { t } = useTranslation('imports')
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-x-4 gap-y-1 border-t border-line pt-2 text-sm',
        showBefore ? 'sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)_minmax(0,1fr)]' : 'sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)]',
      )}
    >
      <div className="hidden text-xs font-medium text-muted sm:contents">
        <span>{t('items.field')}</span>
        {showBefore && <span>{t('items.before')}</span>}
        <span>{showBefore ? t('items.after') : t('items.value')}</span>
      </div>
      {rows.map((r) => (
        <div key={r.key} className="contents">
          <dt className="pt-1 font-medium sm:pt-0 sm:font-normal sm:text-muted">{r.label}</dt>
          {showBefore && (
            <dd className="min-w-0">
              <span className="text-xs text-muted sm:hidden">{t('items.before')}: </span>
              <span className="text-muted line-through decoration-muted/50 [&_img]:opacity-60">
                <FieldValue field={r.before.field} value={r.before.value} />
              </span>
            </dd>
          )}
          <dd className="min-w-0">
            {showBefore && <span className="text-xs text-muted sm:hidden">{t('items.after')}: </span>}
            <FieldValue field={r.after.field} value={r.after.value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}
