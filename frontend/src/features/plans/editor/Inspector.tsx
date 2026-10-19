import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PlanPlacement, PlanWarning, VariantSearchItem } from '@/api/generated/model'
import { Field, SelectField, SwitchField } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import type { PlacementPatch } from './document'
import type { EditorAction } from './editor-state'

type Props = {
  placements: PlanPlacement[]
  variants: Map<string, VariantSearchItem>
  allVariants: VariantSearchItem[]
  warnings: Map<string, PlanWarning[]>
  /** Save errors per item id, translated. */
  errors: Map<string, string[]>
  editable: boolean
  dispatch: (action: EditorAction) => void
}

/** A number input that commits valid numbers as they are typed and shows the document's value otherwise. */
function NumberField({ label, value, onCommit, disabled, suffix }: { label: string; value: number; onCommit: (n: number) => void; disabled: boolean; suffix?: string }) {
  // What is typed while the field has the focus; otherwise the document's value shows.
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Field
      label={label}
      type="number"
      inputMode="decimal"
      value={draft ?? String(value)}
      suffix={suffix}
      disabled={disabled}
      onFocus={() => setDraft(String(value))}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && Number.isFinite(n)) onCommit(n)
      }}
    />
  )
}

/**
 * The Inspector tab, part A: one placement's product, variant, label,
 * existing flag and geometry. Part B adds add-ons, instance attributes,
 * "resize all of this product" and multi-selection.
 */
export function Inspector({ placements, variants, allVariants, warnings, errors, editable, dispatch }: Props) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()

  if (placements.length === 0) return <p className="text-sm text-muted">{t('inspector.none')}</p>
  if (placements.length > 1) return <p className="text-sm text-muted">{t('inspector.many', { count: placements.length })}</p>

  const p = placements[0]
  const variant = p.variantId ? variants.get(p.variantId) : undefined
  const siblings = variant ? allVariants.filter((v) => v.productId === variant.productId && (v.available || v.id === variant.id)) : []
  // Typing into one field is one undo step (D199).
  const update = (patch: PlacementPatch, field?: string) =>
    dispatch({ type: 'change', action: { type: 'updatePlacements', changes: [{ id: p.id, patch }] }, key: field && `${p.id}:${field}` })
  const itemErrors = errors.get(p.id) ?? []
  const itemWarnings = warnings.get(p.id) ?? []

  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-muted">{t('inspector.product')}</p>
        <p className="font-medium">{variant ? localize(variant.productName) : t('inspector.deleted')}</p>
        {variant && <p className="text-sm text-muted">{variant.modelNumber}</p>}
      </div>
      {itemErrors.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {itemErrors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      {itemWarnings.length > 0 && (
        <ul className="space-y-1 rounded-control border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          {itemWarnings.map((w) => (
            <li key={`${w.code}-${w.addonVariantId ?? ''}`}>{t(`warning.${w.code}`)}</li>
          ))}
        </ul>
      )}
      {variant && (
        <SelectField
          label={t('inspector.variant')}
          value={variant.id}
          disabled={!editable || siblings.length < 2}
          options={siblings.map((v) => ({ value: v.id, label: localize(v.name) }))}
          // Switching keeps the size; chosen add-ons belong to the old variant (part B offers the new one's).
          onValueChange={(id) => update({ variantId: id, addonVariantIds: [] })}
        />
      )}
      <Field label={t('inspector.label')} value={p.label} maxLength={100} disabled={!editable} onChange={(e) => update({ label: e.target.value }, 'label')} />
      <div className="grid grid-cols-2 gap-3">
        <NumberField label={t('inspector.x')} value={p.x} suffix="px" disabled={!editable} onCommit={(x) => update({ x }, 'x')} />
        <NumberField label={t('inspector.y')} value={p.y} suffix="px" disabled={!editable} onCommit={(y) => update({ y }, 'y')} />
        <NumberField label={t('inspector.width')} value={p.width} suffix="px" disabled={!editable} onCommit={(width) => width > 0 && update({ width }, 'width')} />
        <NumberField label={t('inspector.height')} value={p.height} suffix="px" disabled={!editable} onCommit={(height) => height > 0 && update({ height }, 'height')} />
        <NumberField label={t('inspector.rotation')} value={p.rotation} suffix="°" disabled={!editable} onCommit={(rotation) => update({ rotation }, 'rotation')} />
      </div>
      <SwitchField label={t('inspector.existing')} hint={t('inspector.existingHint')} checked={p.existing} disabled={!editable} onChange={(e) => update({ existing: e.target.checked })} />
    </div>
  )
}
