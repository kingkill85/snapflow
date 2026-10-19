import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApplyCatalogChanges, useGetCatalogChanges } from '@/api/generated/bom/bom'
import type { CatalogChange, ChangeValues } from '@/api/generated/model'
import { Badge, Button, CheckboxField, DataTable, Dialog, ErrorMessage, Loading, Thumbnail } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { fresh, useFormatMoney, useLineName, useRefreshBom } from './format'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  versionId: string
}

const fieldKeys = ['unitPrice', 'productName', 'variantName', 'modelNumber', 'sku', 'image', 'requiredAddons'] as const
type FieldKey = (typeof fieldKeys)[number]

/**
 * "Update from catalog" (D234): every snapshot that differs from the catalog
 * with its fields before and after and its effect on the grand total; the
 * user picks some or all, the API re-snapshots them, the BOM reloads.
 * Deleted variants are listed but cannot be picked: their quote stays frozen.
 */
export function CatalogChangesDialog({ open, onOpenChange, versionId }: Props) {
  const { t } = useTranslation('bom')
  const { t: tCommon } = useTranslation()
  const money = useFormatMoney()
  const lineName = useLineName()
  const refresh = useRefreshBom(versionId)
  const query = useGetCatalogChanges(versionId, { query: { ...fresh, enabled: open } })
  const apply = useApplyCatalogChanges()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const { reset } = apply

  const items = query.data?.items ?? []
  const applicable = items.filter((i) => i.canApply)
  // Every applicable item is selected when the list arrives.
  const dataKey = query.dataUpdatedAt
  useEffect(() => {
    if (!open) return
    reset()
    setSelected(new Set(applicable.map((i) => i.variantId)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dataKey, reset])

  const allSelected = applicable.length > 0 && applicable.every((i) => selected.has(i.variantId))
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const submit = async () => {
    try {
      await apply.mutateAsync({ versionId, data: { variantIds: [...selected] } })
    } catch {
      return // shown by ErrorMessage via apply.error
    }
    await refresh()
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('changes.title')}
      description={t('changes.description')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {tCommon('action.cancel')}
          </Button>
          <Button disabled={selected.size === 0 || apply.isPending} onClick={() => void submit()}>
            {t('changes.apply')}
          </Button>
        </>
      }
    >
      <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
        <ErrorMessage error={apply.error} />
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorMessage error={query.error} />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">{t('changes.none')}</p>
        ) : (
          <>
            <p className="text-sm">
              {t('changes.totals', { before: money(query.data.grandTotal), after: money(query.data.grandTotalAfter) })}{' '}
              <span className="text-muted">({money(query.data.effect, undefined, 'signed')})</span>
            </p>
            {applicable.length > 1 && (
              <CheckboxField
                label={t('changes.selectAll')}
                checked={allSelected}
                onChange={(e) => setSelected(new Set(e.target.checked ? applicable.map((i) => i.variantId) : []))}
              />
            )}
            <ul className="space-y-3">
              {items.map((item) => {
                const name = lineName({ name: '', snapshot: item.snapshot })
                return (
                  <li key={item.variantId} className="space-y-2 rounded-control border border-line p-3">
                    <CheckboxField
                      label={name}
                      checked={selected.has(item.variantId)}
                      disabled={!item.canApply}
                      onChange={(e) => toggle(item.variantId, e.target.checked)}
                      hint={item.canApply ? t('changes.effect', { amount: money(item.effect, undefined, 'signed') }) : undefined}
                    />
                    {item.deleted && <Badge variant="danger">{t('changes.notApplicable')}</Badge>}
                    {!item.deleted && !item.available && <Badge variant="warning">{t('changes.unavailable')}</Badge>}
                    {item.after && item.fields.length > 0 && <FieldDiff item={item} after={item.after} />}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  )
}

/** The changed fields of one item: before and after. */
function FieldDiff({ item, after }: { item: CatalogChange; after: ChangeValues }) {
  const { t } = useTranslation('bom')
  const localize = useLocalized()
  const money = useFormatMoney()
  const show = (values: ChangeValues, field: FieldKey): ReactNode => {
    switch (field) {
      case 'unitPrice':
        return money(values.unitPrice)
      case 'productName':
        return localize(values.productName)
      case 'variantName':
        return localize(values.variantName)
      case 'modelNumber':
        return values.modelNumber
      case 'sku':
        return values.sku
      case 'image':
        return values.imageUrl ? <Thumbnail src={values.imageUrl} /> : t('changes.noImage')
      case 'requiredAddons':
        // One per line, named as BOM lines are ("Product – Variant"); the model number when the name is unknown.
        return values.requiredAddons.length ? (
          <ul className="space-y-1">
            {values.requiredAddons.map((a) => (
              <li key={a.variantId}>{[localize(a.productName), localize(a.variantName)].filter(Boolean).join(' – ') || a.modelNumber}</li>
            ))}
          </ul>
        ) : (
          t('changes.noAddons')
        )
    }
  }
  const rows = fieldKeys.filter((f) => item.fields.includes(f))
  return (
    <DataTable
      flat
      label={t('changes.title')}
      rows={rows}
      rowKey={(f) => f}
      empty={null}
      columns={[
        { header: t('changes.field'), cell: (f) => <span className="text-muted">{t(`changes.fields.${f}`)}</span> },
        { header: t('changes.before'), cell: (f) => show(item.before, f) },
        { header: t('changes.after'), cell: (f) => <span className="font-medium">{show(after, f)}</span> },
      ]}
    />
  )
}
