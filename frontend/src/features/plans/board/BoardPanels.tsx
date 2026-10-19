import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { BoardWarning, Capabilities, Finding, VariantSearchItem } from '@/api/generated/model'
import { useListOutputKinds } from '@/api/generated/output-kinds/output-kinds'
import { formatDecimal, parseDecimal, useDecimalSeparator } from '@/catalog/decimal'
import { Button, Field, IconButton, Notice, SelectField, SwitchField } from '@/components/ui'
import type { WiringModel } from '@/features/checks'
import { useDescribeCapabilities } from '@/features/products/describe-capabilities'
import { useLocalized } from '@/i18n/localized'

import type { PaletteProduct } from '../editor/catalog'
import { AddressLine } from '../editor/AddressLine'
import { Addons, ItemInstanceValues, ProductPicker, Warnings } from '../editor/Inspector'
import { type BoardDocument, type BoardModuleDoc, enclosureSize, fitToEnclosure, type ModulePatch, newId, rowUsed, slotIn } from './board'
import type { BoardEditorAction } from './board-state'
import { ModuleChannels } from './ModuleChannels'

const maxCapacity = 999.9

// ---------------------------------------------------------------- board settings

type SettingsProps = {
  doc: BoardDocument
  enclosures: VariantSearchItem[]
  variants: Map<string, VariantSearchItem>
  caps: (variantId: string) => Capabilities | undefined
  widthOf: (m: BoardModuleDoc) => number
  editable: boolean
  dispatch: (action: BoardEditorAction) => void
  warnings: BoardWarning[]
  /** The stored enclosure's variant was deleted from the catalog (kept until removed explicitly). */
  enclosureDeleted?: boolean
}

/** The Board tab: the enclosure (D357 explained) and, without an enclosure of known size, the rows editor. */
export function BoardSettings({ doc, enclosures, variants, caps, widthOf, editable, dispatch, warnings, enclosureDeleted = false }: SettingsProps) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()
  const separator = useDecimalSeparator()
  const current = doc.enclosureVariantId ? variants.get(doc.enclosureVariantId) : undefined
  const size = doc.enclosureVariantId ? enclosureSize(caps(doc.enclosureVariantId)) : null
  const none = '-'
  const options = [
    { value: none, label: t('board.noEnclosure') },
    ...enclosures.map((v) => ({ value: v.id, label: `${localize(v.productName)} – ${localize(v.name)}` })),
    ...(current && !enclosures.some((v) => v.id === current.id) ? [{ value: current.id, label: `${localize(current.productName)} – ${localize(current.name)}` }] : []),
  ]

  const chooseEnclosure = (value: string) => {
    const id = value === none ? null : value
    const fitted = id ? enclosureSize(caps(id)) : null
    // D357: rows follow an enclosure of known size; removing it keeps the rows (now editable).
    const { rows, modules } = fitted ? fitToEnclosure(doc, fitted, widthOf) : { rows: doc.rows, modules: doc.modules }
    dispatch({ type: 'change', action: { type: 'setEnclosure', enclosureVariantId: id, rows, modules } })
  }

  const setCapacity = (rowId: string, capacityTe: number) =>
    dispatch({ type: 'change', action: { type: 'setRows', rows: doc.rows.map((r) => (r.id === rowId ? { ...r, capacityTe } : r)) }, key: `${rowId}:capacity` })

  return (
    <div className="space-y-4">
      <SelectField label={t('board.enclosure')} value={doc.enclosureVariantId ?? none} options={options} disabled={!editable} onValueChange={chooseEnclosure} hint={t('board.enclosureHint')} />
      {enclosureDeleted && !doc.enclosureVariantId && (
        <div className="space-y-2">
          <Notice tone="warning">{doc.removeEnclosure ? t('board.enclosureRemoved') : t('board.enclosureDeleted')}</Notice>
          {!doc.removeEnclosure && (
            <Button variant="secondary" size="sm" disabled={!editable} onClick={() => dispatch({ type: 'change', action: { type: 'setEnclosureFlags', patch: { removeEnclosure: true } } })}>
              <Trash2 /> {t('board.removeEnclosure')}
            </Button>
          )}
        </div>
      )}
      {(doc.enclosureVariantId || (enclosureDeleted && !doc.removeEnclosure)) && (
        <SwitchField
          label={t('board.enclosureExisting')}
          hint={t('board.enclosureExistingHint')}
          checked={doc.enclosureExisting}
          disabled={!editable}
          onChange={(e) => dispatch({ type: 'change', action: { type: 'setEnclosureFlags', patch: { enclosureExisting: e.target.checked } } })}
        />
      )}
      {warnings.some((w) => w.code === 'enclosure_size_unknown') && <Notice tone="warning">{t('warning.enclosure_size_unknown')}</Notice>}
      {size ? (
        <Notice>{t('board.fromEnclosure', { rows: size.rows, te: formatDecimal(size.te, separator) })}</Notice>
      ) : (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">{t('board.rows')}</legend>
          <ul className="space-y-2">
            {doc.rows.map((row, i) => {
              const used = rowUsed(doc, row.id, widthOf)
              const occupied = doc.modules.some((m) => m.rowId === row.id)
              return (
                <li key={row.id} className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <CapacityField label={t('board.rowCapacity', { n: i + 1 })} value={row.capacityTe} disabled={!editable} onCommit={(n) => setCapacity(row.id, n)} />
                  </div>
                  <IconButton
                    label={occupied ? t('board.removeRowBusy', { n: i + 1 }) : t('board.removeRow', { n: i + 1 })}
                    icon={<Trash2 />}
                    disabled={!editable || occupied || doc.rows.length === 1}
                    onClick={() => dispatch({ type: 'change', action: { type: 'setRows', rows: doc.rows.filter((r) => r.id !== row.id) } })}
                  />
                  <span className="sr-only">{used}</span>
                </li>
              )
            })}
          </ul>
          <Button
            variant="secondary"
            size="sm"
            disabled={!editable || doc.rows.length >= 50}
            onClick={() => dispatch({ type: 'change', action: { type: 'setRows', rows: [...doc.rows, { id: newId(), capacityTe: doc.rows[doc.rows.length - 1]?.capacityTe ?? 12 }] } })}
          >
            <Plus /> {t('board.addRow')}
          </Button>
        </fieldset>
      )}
    </div>
  )
}

/** A TE capacity input (above 0, at most 999.9, one decimal): commits valid values as typed. */
export function CapacityField({ label, value, disabled, onCommit }: { label: string; value: number; disabled?: boolean; onCommit: (n: number) => void }) {
  const { t } = useTranslation('plans')
  const separator = useDecimalSeparator()
  const [draft, setDraft] = useState<string | null>(null)
  const parsed = draft === null ? undefined : parseDecimal(draft)
  const n = parsed === undefined ? NaN : Number(parsed)
  const invalid = draft !== null && !(n > 0 && n <= maxCapacity && Math.round(n * 10) === n * 10)
  return (
    <Field
      label={label}
      inputMode="decimal"
      value={draft ?? formatDecimal(value, separator)}
      disabled={disabled}
      error={invalid ? t('board.capacityInvalid', { max: formatDecimal(maxCapacity, separator) }) : undefined}
      onChange={(e) => {
        setDraft(e.target.value)
        const p = parseDecimal(e.target.value)
        const v = p === undefined ? NaN : Number(p)
        if (v > 0 && v <= maxCapacity && Math.round(v * 10) === v * 10) onCommit(v)
      }}
      onBlur={() => setDraft(null)}
    />
  )
}

// ---------------------------------------------------------------- module inspector

type InspectorProps = {
  doc: BoardDocument
  modules: BoardModuleDoc[]
  variants: Map<string, VariantSearchItem>
  allVariants: VariantSearchItem[]
  products: PaletteProduct[]
  caps: (variantId: string) => Capabilities | undefined
  widthOf: (m: BoardModuleDoc) => number
  warnings: Map<string, BoardWarning[]>
  errors: Map<string, string[]>
  editable: boolean
  dispatch: (action: BoardEditorAction) => void
  onNotice: (text: string) => void
  versionId: string
  planId: string
  /** The version's wiring view (channels and connections); undefined in tests that do not need it. */
  wiring?: WiringModel
  /** The version's checks findings (channel errors in the channel list). */
  findings?: Finding[]
}

/** The Inspector tab of the board editor: one module (product, variant, row, add-ons, values, capabilities), or a count. */
export function ModuleInspector(props: InspectorProps) {
  const { t } = useTranslation('plans')
  const { t: tc } = useTranslation()
  const { modules, editable, dispatch } = props
  if (modules.length === 0) return <p className="text-sm text-muted">{t('board.inspectorNone')}</p>
  if (modules.length > 1) {
    return (
      <div className="space-y-3">
        <p className="text-sm">{t('board.selected', { count: modules.length })}</p>
        <Button variant="danger-quiet" size="sm" disabled={!editable} onClick={() => dispatch({ type: 'change', action: { type: 'remove', ids: modules.map((m) => m.id) } })}>
          <Trash2 /> {tc('action.delete')}
        </Button>
      </div>
    )
  }
  return <OneModule key={modules[0].id} {...props} module={modules[0]} />
}

function OneModule({ doc, module: m, variants, allVariants, products, caps, widthOf, warnings, errors, editable, dispatch, onNotice, versionId, planId, wiring, findings }: InspectorProps & { module: BoardModuleDoc }) {
  const { t } = useTranslation('plans')
  const { t: tc } = useTranslation()
  const localize = useLocalized()
  const separator = useDecimalSeparator()
  const describe = useDescribeCapabilities()
  const kinds = useListOutputKinds({ includeInactive: true }).data?.items ?? []
  const kindName = (id: string, key: string) => {
    const kind = kinds.find((k) => k.id === id)
    return kind ? localize(kind.name) : key
  }
  const variant = m.variantId ? variants.get(m.variantId) : undefined
  const siblings = variant ? allVariants.filter((v) => v.productId === variant.productId && (v.available || v.id === variant.id)) : []
  const capabilities = m.variantId ? caps(m.variantId) : undefined
  const update = (patch: ModulePatch, field?: string) => dispatch({ type: 'change', action: { type: 'updateModules', changes: [{ id: m.id, patch }] }, key: field && `${m.id}:${field}` })

  /** A change that may widen the module: refused when it no longer fits where it is (no overlap, D356). */
  const updateWidth = (patch: ModulePatch) => {
    const next = { ...m, ...patch }
    const offset = slotIn(doc, m.rowId, widthOf(next), m.offsetTe, widthOf, new Set([m.id]))
    if (offset === null) {
      onNotice(t('board.noRoom'))
      return
    }
    update({ ...patch, offsetTe: offset })
  }
  const moveToRow = (rowId: string) => {
    const offset = slotIn(doc, rowId, widthOf(m), m.offsetTe, widthOf, new Set([m.id]))
    if (offset === null) {
      onNotice(t('board.noRoom'))
      return
    }
    update({ rowId, offsetTe: offset })
  }
  const itemWarnings = warnings.get(m.id) ?? []
  const te = (n: number) => formatDecimal(n, separator)

  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-muted">{t('inspector.product')}</p>
        <p className="font-medium">{variant ? localize(variant.productName) : t('inspector.deleted')}</p>
        {variant && <p className="text-sm text-muted">{variant.modelNumber}</p>}
        <p className="text-sm text-muted">{t('board.position', { width: te(widthOf(m)), offset: te(m.offsetTe) })}</p>
      </div>
      {/* Version data like the channels: shown with the wiring view (absent in isolated tests), D427. */}
      {wiring && <AddressLine versionId={versionId} planId={planId} itemId={m.id} />}
      {editable && <ProductPicker products={products} current={variant?.productId} onPick={(product) => updateWidth({ variantId: product.defaultVariant.id, addonVariantIds: [], instanceValues: variant?.categoryId === product.defaultVariant.categoryId ? m.instanceValues : {} })} />}
      {(errors.get(m.id) ?? []).length > 0 && (
        <ul role="alert" className="space-y-1 rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {(errors.get(m.id) ?? []).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {itemWarnings.length > 0 && <Warnings warnings={itemWarnings} placement={m} productId={variant?.productId} />}
      {variant && (
        <SelectField
          label={t('inspector.variant')}
          value={variant.id}
          disabled={!editable || siblings.length < 2}
          options={siblings.map((v) => ({ value: v.id, label: localize(v.name) }))}
          onValueChange={(id) => updateWidth({ variantId: id, addonVariantIds: [] })}
        />
      )}
      <SelectField
        label={t('board.row')}
        value={m.rowId}
        disabled={!editable || doc.rows.length < 2}
        options={doc.rows.map((r, i) => ({ value: r.id, label: t('board.rowShort', { n: i + 1 }) }))}
        onValueChange={moveToRow}
      />
      {variant && <Addons placement={m} variant={variant} editable={editable} onChange={(ids) => update({ addonVariantIds: ids })} />}
      <Field label={t('inspector.label')} value={m.label} maxLength={100} disabled={!editable} onChange={(e) => update({ label: e.target.value }, 'label')} />
      {variant && <ItemInstanceValues item={m} categoryId={variant.categoryId} editable={editable} onChange={(next, key) => update({ instanceValues: next }, `attr:${key}`)} />}
      {capabilities && (
        <section aria-label={t('board.capabilities')} className="space-y-1">
          <h3 className="text-sm font-medium">{t('board.capabilities')}</h3>
          <p className="text-sm text-muted">{describe(capabilities)}</p>
          {capabilities.channels.length > 0 && (
            <ul className="list-inside list-disc text-sm">
              {capabilities.channels.map((c) => (
                <li key={c.outputKindId}>{t('board.channel', { count: c.count, kind: kindName(c.outputKindId, c.outputKindKey) })}</li>
              ))}
            </ul>
          )}
        </section>
      )}
      {wiring && <ModuleChannels versionId={versionId} planId={planId} moduleId={m.id} hasChannels={(capabilities?.channels.length ?? 0) > 0} wiring={wiring} findings={findings} />}
      <SwitchField label={t('inspector.existing')} hint={t('inspector.existingHint')} checked={m.existing} disabled={!editable} onChange={(e) => update({ existing: e.target.checked })} />
      <Button variant="danger-quiet" size="sm" disabled={!editable} onClick={() => dispatch({ type: 'change', action: { type: 'remove', ids: [m.id] } })}>
        <Trash2 /> {tc('action.delete')}
      </Button>
    </div>
  )
}
