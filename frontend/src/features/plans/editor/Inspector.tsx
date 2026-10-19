import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { InstanceAttributeDefinition, PlanPlacement, PlanWarning, PlanZone, VariantSearchItem } from '@/api/generated/model'
import { useGetCategory } from '@/api/generated/categories/categories'
import { useGetProduct } from '@/api/generated/products/products'
import { AttributeValuesEditor } from '@/catalog/AttributeValuesEditor'
import { type AttributeFormValue, toApiValue, toFormValue } from '@/catalog/attribute-values'
import { useDecimalSeparator } from '@/catalog/decimal'
import { Button, CheckboxField, ColorField, Field, SelectField, SwitchField, useFieldError } from '@/components/ui'
import type { Size } from '@/canvas'
import { useLocalized } from '@/i18n/localized'
import { cn } from '@/lib/cn'

import { groupPalette, type PaletteProduct } from './catalog'
import type { PlacementPatch, ZonePatch } from './document'
import type { EditorAction } from './editor-state'
import type { ActiveVertex } from './PlanCanvas'
import { changeProduct, clampGeometry, resizeChanges } from './placements'
import { minZonePoints, removeVertex, zoneColors } from './zones'

type Props = {
  placements: PlanPlacement[]
  zones: PlanZone[]
  /** Every placement of the plan ("resize all of this product"). */
  allPlacements: PlanPlacement[]
  variants: Map<string, VariantSearchItem>
  allVariants: VariantSearchItem[]
  /** The palette's products (available products of the project's types): the product picker offers them. */
  products: PaletteProduct[]
  /** The plan image: positions and sizes stay inside it. */
  image: Size
  warnings: Map<string, PlanWarning[]>
  /** Save errors per item id, translated. */
  errors: Map<string, string[]>
  editable: boolean
  dispatch: (action: EditorAction) => void
  resizeAll: boolean
  onResizeAll: (on: boolean) => void
  activeVertex: ActiveVertex | null
  onActiveVertex: (vertex: ActiveVertex | null) => void
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

function ErrorList({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null
  return (
    <ul role="alert" className="space-y-1 rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  )
}

/** The Inspector tab: one placement, one zone, or what can be done with a multi-selection. */
export function Inspector(props: Props) {
  const { t } = useTranslation('plans')
  const { placements, zones } = props
  const count = placements.length + zones.length
  if (count === 0) return <p className="text-sm text-muted">{t('inspector.none')}</p>
  if (count > 1) return <MultiInspector {...props} />
  if (zones.length === 1) return <ZoneInspector {...props} zone={zones[0]} />
  return <PlacementInspector {...props} placement={placements[0]} />
}

/** Several items: their count, delete, and the existing switch for the placements among them. */
function MultiInspector({ placements, zones, editable, dispatch }: Props) {
  const { t } = useTranslation('plans')
  const ids = [...placements.map((p) => p.id), ...zones.map((z) => z.id)]
  const allExisting = placements.length > 0 && placements.every((p) => p.existing)
  return (
    <div className="space-y-4">
      <p className="text-sm">{t('inspector.many', { count: ids.length })}</p>
      <p className="text-sm text-muted">{t('inspector.manyDetail', { products: placements.length, zones: zones.length })}</p>
      {placements.length > 0 && (
        <SwitchField
          label={t('inspector.existing')}
          hint={t('inspector.existingManyHint')}
          checked={allExisting}
          disabled={!editable}
          onChange={(e) =>
            dispatch({ type: 'change', action: { type: 'updatePlacements', changes: placements.map((p) => ({ id: p.id, patch: { existing: e.target.checked } })) } })
          }
        />
      )}
      <Button variant="danger-quiet" disabled={!editable} onClick={() => dispatch({ type: 'change', action: { type: 'remove', ids } })}>
        <Trash2 /> {t('inspector.deleteSelected', { count: ids.length })}
      </Button>
    </div>
  )
}

/** One zone: name, colour (palette or any), opacity, corners. */
function ZoneInspector({ zone: z, errors, editable, dispatch, activeVertex, onActiveVertex }: Props & { zone: PlanZone }) {
  const { t } = useTranslation('plans')
  const update = (patch: ZonePatch, field?: string) => dispatch({ type: 'change', action: { type: 'updateZones', changes: [{ id: z.id, patch }] }, key: field && `${z.id}:${field}` })
  const vertex = activeVertex?.zoneId === z.id && activeVertex.index < z.points.length ? activeVertex.index : undefined
  return (
    <div className="space-y-4">
      <p className="text-xs font-medium text-muted">{t('zones.zone')}</p>
      <ErrorList messages={errors.get(z.id) ?? []} />
      <Field label={t('zones.name')} required value={z.name} maxLength={100} disabled={!editable} onChange={(e) => update({ name: e.target.value }, 'name')} />
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t('zones.palette')}</p>
        <div className="flex flex-wrap gap-1.5">
          {zoneColors.map((c) => (
            <Button
              key={c}
              size="icon"
              variant="secondary"
              aria-label={t('zones.useColor', { color: c })}
              aria-pressed={z.color.toLowerCase() === c}
              disabled={!editable}
              className={cn('p-1', z.color.toLowerCase() === c && 'ring-2 ring-primary')}
              onClick={() => update({ color: c })}
            >
              <span className="block size-full rounded-sm" style={{ backgroundColor: c }} />
            </Button>
          ))}
        </div>
      </div>
      <ColorField label={t('zones.color')} value={z.color} disabled={!editable} onChange={(color) => /^#[0-9a-fA-F]{6}$/.test(color) && update({ color: color.toLowerCase() }, 'color')} />
      <NumberField
        label={t('zones.opacity')}
        value={Math.round(z.opacity * 100)}
        suffix="%"
        disabled={!editable}
        onCommit={(n) => n >= 0 && n <= 100 && update({ opacity: n / 100 }, 'opacity')}
      />
      <div className="space-y-2">
        <p className="text-sm">{t('zones.corners', { count: z.points.length })}</p>
        <p className="text-xs text-muted">{t('zones.cornerHint')}</p>
        <Button
          variant="danger-quiet"
          size="sm"
          disabled={!editable || vertex === undefined || z.points.length <= minZonePoints}
          onClick={() => {
            if (vertex === undefined) return
            update({ points: removeVertex(z.points, vertex) })
            onActiveVertex(null)
          }}
        >
          <Trash2 /> {t('zones.removeCorner')}
        </Button>
      </div>
    </div>
  )
}

/** One placement: product, variant, add-ons, instance values, label, geometry, existing. */
function PlacementInspector({ placement: p, allPlacements, variants, allVariants, products, image, warnings, errors, editable, dispatch, resizeAll, onResizeAll }: Props & { placement: PlanPlacement }) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()

  const variant = p.variantId ? variants.get(p.variantId) : undefined
  const siblings = variant ? allVariants.filter((v) => v.productId === variant.productId && (v.available || v.id === variant.id)) : []
  // Typing into one field is one undo step (D199).
  const update = (patch: PlacementPatch, field?: string) =>
    dispatch({ type: 'change', action: { type: 'updatePlacements', changes: [{ id: p.id, patch }] }, key: field && `${p.id}:${field}` })
  // Sizes go to every placement of the product when "resize all" is on (one step).
  const resize = (patch: { width?: number; height?: number }, field: string) =>
    dispatch({ type: 'change', action: { type: 'updatePlacements', changes: resizeChanges(allPlacements, p.id, patch, variants, resizeAll) }, key: `${p.id}:${field}` })
  const itemWarnings = warnings.get(p.id) ?? []
  const sameProduct = variant ? allPlacements.filter((x) => x.variantId && variants.get(x.variantId)?.productId === variant.productId).length : 1

  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-muted">{t('inspector.product')}</p>
        <p className="font-medium">{variant ? localize(variant.productName) : t('inspector.deleted')}</p>
        {variant && <p className="text-sm text-muted">{variant.modelNumber}</p>}
      </div>
      {editable && (
        <ProductPicker
          products={products}
          current={variant?.productId}
          onPick={(product) => update(changeProduct(p, product.defaultVariant, variant))}
        />
      )}
      <ErrorList messages={errors.get(p.id) ?? []} />
      {itemWarnings.length > 0 && <Warnings warnings={itemWarnings} placement={p} productId={variant?.productId} />}
      {variant && (
        <SelectField
          label={t('inspector.variant')}
          value={variant.id}
          disabled={!editable || siblings.length < 2}
          options={siblings.map((v) => ({ value: v.id, label: localize(v.name) }))}
          // Switching keeps the size; chosen add-ons belong to the old variant.
          onValueChange={(id) => update({ variantId: id, addonVariantIds: [] })}
        />
      )}
      {variant && <Addons placement={p} variant={variant} editable={editable} onChange={(ids) => update({ addonVariantIds: ids })} />}
      <Field label={t('inspector.label')} value={p.label} maxLength={100} disabled={!editable} onChange={(e) => update({ label: e.target.value }, 'label')} />
      {variant && <InstanceValues key={p.id} placement={p} categoryId={variant.categoryId} editable={editable} dispatch={dispatch} />}
      <div className="grid grid-cols-2 gap-3">
        <NumberField label={t('inspector.x')} value={p.x} suffix="px" disabled={!editable} onCommit={(x) => update(clampGeometry({ x }, image), 'x')} />
        <NumberField label={t('inspector.y')} value={p.y} suffix="px" disabled={!editable} onCommit={(y) => update(clampGeometry({ y }, image), 'y')} />
        <NumberField label={t('inspector.width')} value={p.width} suffix="px" disabled={!editable} onCommit={(width) => width > 0 && resize(clampGeometry({ width }, image), 'width')} />
        <NumberField label={t('inspector.height')} value={p.height} suffix="px" disabled={!editable} onCommit={(height) => height > 0 && resize(clampGeometry({ height }, image), 'height')} />
        <NumberField label={t('inspector.rotation')} value={p.rotation} suffix="°" disabled={!editable} onCommit={(rotation) => update({ rotation }, 'rotation')} />
      </div>
      {variant && (
        <SwitchField
          label={t('inspector.resizeAll')}
          hint={t('inspector.resizeAllHint', { count: sameProduct })}
          checked={resizeAll}
          disabled={!editable}
          onChange={(e) => onResizeAll(e.target.checked)}
        />
      )}
      <SwitchField label={t('inspector.existing')} hint={t('inspector.existingHint')} checked={p.existing} disabled={!editable} onChange={(e) => update({ existing: e.target.checked })} />
    </div>
  )
}

/**
 * "Change product": the palette's products with the palette's search; picking
 * one puts its default variant on the placement (D216).
 */
function ProductPicker({ products, current, onPick }: { products: PaletteProduct[]; current?: string; onPick: (product: PaletteProduct) => void }) {
  const { t } = useTranslation('plans')
  const { t: tc } = useTranslation()
  const localize = useLocalized()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t('inspector.changeProduct')}
      </Button>
    )
  }
  const groups = groupPalette(products, search, localize)
  return (
    <div className="space-y-2 rounded-control border border-line p-2">
      <Field label={t('inspector.changeProduct')} type="search" value={search} autoFocus onChange={(e) => setSearch(e.target.value)} hint={t('palette.searchHint')} />
      {groups.length === 0 ? (
        <p className="text-sm text-muted">{t('palette.noMatch')}</p>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {groups.map((group) => (
            <section key={group.category.id} aria-label={localize(group.category.name)} className="space-y-1">
              <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{localize(group.category.name)}</h3>
              <ul className="space-y-1">
                {group.products.map((product) => (
                  <li key={product.productId}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-current={product.productId === current || undefined}
                      disabled={product.productId === current}
                      className="h-auto w-full justify-start py-1 text-left font-normal whitespace-normal"
                      onClick={() => {
                        onPick(product)
                        setOpen(false)
                        setSearch('')
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{localize(product.name)}</span>
                        <span className="block truncate text-xs text-muted">{product.modelNumber}</span>
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
        {tc('action.cancel')}
      </Button>
    </div>
  )
}

/** The placement's warnings with texts (add-on warnings name the add-on when the product is loaded). */
function Warnings({ warnings, placement, productId }: { warnings: PlanWarning[]; placement: PlanPlacement; productId?: string }) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()
  const product = useGetProduct(productId ?? '', { query: { enabled: !!productId && warnings.some((w) => w.addonVariantId) } })
  const addons = product.data?.variants.find((v) => v.id === placement.variantId)?.addons ?? []
  return (
    <ul className="space-y-1 rounded-control border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
      {warnings.map((w) => {
        const addon = w.addonVariantId ? addons.find((a) => a.addonVariantId === w.addonVariantId) : undefined
        return (
          <li key={`${w.code}-${w.addonVariantId ?? ''}`}>
            {t(`warning.${w.code}`)}
            {addon && ` (${localize(addon.productName)} – ${localize(addon.variantName)})`}
          </li>
        )
      })}
    </ul>
  )
}

/** Add-ons of the variant: optional ones as checkboxes, required ones checked and fixed; unavailable ones say so. */
function Addons({ placement: p, variant, editable, onChange }: { placement: PlanPlacement; variant: VariantSearchItem; editable: boolean; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()
  const product = useGetProduct(variant.productId)
  const addons = product.data?.variants.find((v) => v.id === variant.id)?.addons ?? []
  if (addons.length === 0) return null
  const chosen = new Set(p.addonVariantIds)
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{t('inspector.addons')}</legend>
      {addons.map((a) => {
        const on = a.required || chosen.has(a.addonVariantId)
        const hint = [a.required ? t('inspector.addonRequired') : undefined, a.available ? undefined : t('inspector.addonUnavailable')].filter(Boolean).join(' · ')
        return (
          <CheckboxField
            key={a.addonVariantId}
            label={`${localize(a.productName)} – ${localize(a.variantName)}`}
            hint={hint || undefined}
            checked={on}
            // Required ones are implied; an unavailable one can only be removed.
            disabled={!editable || a.required || (!a.available && !on)}
            onChange={(e) => onChange(e.target.checked ? [...p.addonVariantIds, a.addonVariantId] : p.addonVariantIds.filter((id) => id !== a.addonVariantId))}
          />
        )
      })}
    </fieldset>
  )
}

/**
 * The category's instance attributes (D65) of one placement. What is typed
 * is kept per key; a value that converts is written to the document at once
 * (one undo step per attribute), one that does not shows its error. A typed
 * text is shown as long as it still means the stored value (undo/redo shows
 * the stored one again).
 */
function InstanceValues({ placement: p, categoryId, editable, dispatch }: { placement: PlanPlacement; categoryId: string; editable: boolean; dispatch: (action: EditorAction) => void }) {
  const { t } = useTranslation('plans')
  const fieldError = useFieldError()
  const separator = useDecimalSeparator()
  const category = useGetCategory(categoryId)
  const [typed, setTyped] = useState<Record<string, AttributeFormValue>>({})
  const definitions: InstanceAttributeDefinition[] = category.data?.instanceAttributes ?? []
  if (definitions.length === 0) return null

  const stored = p.instanceValues as Record<string, unknown>
  const values: Record<string, AttributeFormValue> = {}
  const errors: Record<string, string | undefined> = {}
  for (const d of definitions) {
    const own = typed[d.key]
    const converted = own === undefined ? undefined : toApiValue(d, own)
    if (own !== undefined && converted && (converted.error || JSON.stringify(converted.value) === JSON.stringify(stored[d.key]))) {
      values[d.key] = own
      errors[d.key] = fieldError(converted.error)
    } else {
      values[d.key] = toFormValue(d, stored[d.key], separator)
    }
  }

  const change = (key: string, value: AttributeFormValue) => {
    setTyped((prev) => ({ ...prev, [key]: value }))
    const d = definitions.find((x) => x.key === key)
    if (!d) return
    const { value: api, error } = toApiValue(d, value)
    if (error) return
    const next = { ...stored }
    if (api === undefined) delete next[key]
    else next[key] = api
    dispatch({ type: 'change', action: { type: 'updatePlacements', changes: [{ id: p.id, patch: { instanceValues: next } }] }, key: `${p.id}:attr:${key}` })
  }

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{t('inspector.instanceValues')}</legend>
      <AttributeValuesEditor definitions={definitions} values={values} onChange={change} errors={errors} disabled={!editable} />
    </fieldset>
  )
}
