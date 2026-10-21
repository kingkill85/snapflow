import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Finding, LoadType, PlanNeed, PlanZone, RoomTemplate } from '@/api/generated/model'
import { useDecimalSeparator } from '@/catalog/decimal'
import { Button, errorKey, Field, IconButton, Notice, SelectField, TextareaField, useFieldError } from '@/components/ui'
import { formatWatts, maxPowerW, parsePower } from '@/features/needs'
import { useLocalized } from '@/i18n/localized'

import { NeedConnections } from './connections'
import { isSymbol, type NeedPatch } from './document'
import type { EditorAction } from './editor-state'
import { functionTypeOptions, type NeedCatalog, useNeedText } from './need-catalog'
import { allowedLoadTypes, applyTemplate, functionTypePatch, maxNeeds, needZoneId, newNeed } from './needs'
import { ItemFindings } from './ItemFindings'

type SectionProps = {
  zoneId: string
  needs: PlanNeed[]
  zones: PlanZone[]
  catalog: NeedCatalog
  /** The plan's findings by need (D454). */
  warnings: Map<string, Finding[]>
  errors: Map<string, string[]>
  editable: boolean
  dispatch: (action: EditorAction) => void
}

/** The zone inspector's Needs section: rows in plain words, add, edit inline, reorder, delete, apply a room template. */
export function ZoneNeeds({ zoneId, needs: all, zones, catalog, warnings, errors, editable, dispatch }: SectionProps) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()
  const text = useNeedText(catalog)
  const [open, setOpen] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; lines: string[] } | null>(null)
  const needs = all.filter((n) => !isSymbol(n) && n.zoneId === zoneId)
  const symbols = all.filter((n) => isSymbol(n) && needZoneId(n, zones) === zoneId)
  const active = catalog.functionTypes.filter((f) => f.isActive)

  // A plan holds at most maxNeeds needs: refused here instead of a failing save.
  const limitNotice = () => setNotice({ tone: 'warning', lines: [t('needs.limit', { max: maxNeeds })] })
  const add = (functionTypeId: string) => {
    if (all.length + 1 > maxNeeds) return limitNotice()
    const need = newNeed(functionTypeId, zoneId)
    dispatch({ type: 'change', action: { type: 'addNeeds', needs: [need] } })
    setOpen(need.id)
    setNotice(null)
  }
  const move = (index: number, by: number) => {
    const ids = needs.map((n) => n.id)
    const target = index + by
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    dispatch({ type: 'change', action: { type: 'reorderNeeds', ids } })
  }
  const apply = (template: RoomTemplate) => {
    const result = applyTemplate(template, zoneId, catalog.functionTypeById, catalog.loadTypeById)
    if (all.length + result.needs.length > maxNeeds) return limitNotice()
    // All lines in one undo step.
    if (result.needs.length > 0) dispatch({ type: 'change', action: { type: 'addNeeds', needs: result.needs } })
    const name = localize(template.name)
    setNotice({
      tone: result.skipped > 0 ? 'warning' : 'success',
      lines: [t('needs.applied', { count: result.needs.length, name }), ...(result.skipped > 0 ? [t('needs.skipped', { count: result.skipped })] : [])],
    })
  }

  return (
    <section aria-label={t('needs.title')} className="space-y-3 border-t border-line pt-3">
      <h3 className="text-sm font-semibold">{t('needs.title')}</h3>
      {needs.length === 0 ? (
        <p className="text-sm text-muted">{t('needs.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {needs.map((n, i) => {
            const name = text(n)
            const rowErrors = errors.get(n.id) ?? []
            const rowWarnings = warnings.get(n.id) ?? []
            return (
              <li key={n.id} className="space-y-2 rounded-control border border-line p-2" aria-label={name}>
                <div className="flex items-start gap-1">
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="break-words">{name}</p>
                    {n.note && <p className="text-xs break-words text-muted">{n.note}</p>}
                  </div>
                  {editable && (
                    <>
                      <IconButton label={t('needs.moveUp', { name })} icon={<ArrowUp />} disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton label={t('needs.moveDown', { name })} icon={<ArrowDown />} disabled={i === needs.length - 1} onClick={() => move(i, 1)} />
                      <IconButton
                        variant="secondary"
                        label={t('needs.edit', { name })}
                        icon={<Pencil />}
                        aria-expanded={open === n.id}
                        onClick={() => setOpen(open === n.id ? null : n.id)}
                      />
                      <IconButton
                        variant="danger-quiet"
                        label={t('needs.delete', { name })}
                        icon={<Trash2 />}
                        onClick={() => dispatch({ type: 'change', action: { type: 'remove', ids: [n.id] } })}
                      />
                    </>
                  )}
                </div>
                <NeedMessages errors={rowErrors} warnings={rowWarnings} />
                <NeedConnections needId={n.id} name={name} />
                {editable && open === n.id && (
                  <div className="space-y-3 border-t border-line pt-2">
                    <NeedFields need={n} catalog={catalog} editable={editable} dispatch={dispatch} />
                    <Button size="sm" variant="secondary" onClick={() => setOpen(null)}>
                      {t('needs.done')}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {symbols.length > 0 && <p className="text-xs text-muted">{t('needs.symbolsHint', { count: symbols.length })}</p>}
      {notice && (
        <Notice tone={notice.tone}>
          {notice.lines.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </Notice>
      )}
      {editable && (
        <div className="space-y-3">
          {active.length === 0 ? (
            <p className="text-sm text-muted">{t('needs.noFunctionTypes')}</p>
          ) : (
            <SelectField
              label={t('needs.add')}
              hint={t('needs.addHint')}
              value=""
              placeholder={t('needs.functionType')}
              options={active.map((f) => ({ value: f.id, label: localize(f.name) }))}
              onValueChange={(id) => id && add(id)}
            />
          )}
          {catalog.templates.length > 0 ? (
            <SelectField
              label={t('needs.applyTemplate')}
              hint={t('needs.applyTemplateHint')}
              value=""
              placeholder={t('needs.applyTemplate')}
              options={catalog.templates.map((tpl) => ({
                value: tpl.id,
                label: Object.keys(tpl.equipmentLevel).length > 0 ? `${localize(tpl.name)} · ${localize(tpl.equipmentLevel)}` : localize(tpl.name),
              }))}
              onValueChange={(id) => {
                const tpl = catalog.templates.find((x) => x.id === id)
                if (tpl) apply(tpl)
              }}
            />
          ) : (
            <p className="text-xs text-muted">{t('needs.noTemplates')}</p>
          )}
        </div>
      )}
    </section>
  )
}

/** Save errors and warnings of one need. */
export function NeedMessages({ errors, warnings }: { errors: string[]; warnings: Finding[] }) {
  return (
    <>
      {errors.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-control border border-danger/40 bg-danger/10 px-2 py-1 text-sm text-danger">
          {errors.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
      <ItemFindings findings={warnings} />
    </>
  )
}

/** The fields of one need; every change is written at once (typing in one field is one undo step, D199). */
export function NeedFields({ need: n, catalog, editable, dispatch }: { need: PlanNeed; catalog: NeedCatalog; editable: boolean; dispatch: (action: EditorAction) => void }) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()
  const update = (patch: NeedPatch, field?: string) => dispatch({ type: 'change', action: { type: 'updateNeeds', changes: [{ id: n.id, patch }] }, key: field && `${n.id}:${field}` })
  const ft = catalog.functionTypeById.get(n.functionTypeId)
  const options = functionTypeOptions(catalog.functionTypes, n.functionTypeId, localize, (name) => t('needs.inactive', { name }))
  const loadTypes = allowedLoadTypes(ft, catalog.loadTypes).filter((l) => l.isActive || l.id === n.loadTypeId)
  return (
    <div className="space-y-3">
      <SelectField
        label={t('needs.functionType')}
        required
        value={n.functionTypeId}
        disabled={!editable}
        options={options}
        onValueChange={(id) => update(functionTypePatch(n, catalog.functionTypeById.get(id)))}
      />
      <div className="grid grid-cols-2 gap-3">
        <QuantityField value={n.quantity} disabled={!editable} onCommit={(quantity) => update({ quantity }, 'quantity')} />
        <PowerField value={n.powerW} disabled={!editable} onCommit={(powerW) => update({ powerW }, 'powerW')} />
      </div>
      <SelectField
        label={t('needs.loadType')}
        value={n.loadTypeId ?? ''}
        disabled={!editable}
        options={[{ value: '', label: t('needs.noLoadType') }, ...loadTypes.map((l: LoadType) => ({ value: l.id, label: l.isActive ? localize(l.name) : t('needs.inactive', { name: localize(l.name) }) }))]}
        onValueChange={(id) => update({ loadTypeId: id || null })}
      />
      <Field label={t('needs.label')} value={n.label} maxLength={100} disabled={!editable} onChange={(e) => update({ label: e.target.value }, 'label')} />
      <TextareaField label={t('needs.note')} value={n.note} maxLength={500} rows={2} disabled={!editable} onChange={(e) => update({ note: e.target.value }, 'note')} />
    </div>
  )
}

function QuantityField({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (n: number) => void }) {
  const { t } = useTranslation('plans')
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Field
      label={t('needs.quantity')}
      required
      type="number"
      inputMode="numeric"
      min={1}
      max={100}
      value={draft ?? String(value)}
      disabled={disabled}
      onFocus={() => setDraft(String(value))}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = Number(e.target.value)
        if (Number.isInteger(n) && n >= 1 && n <= 100) onCommit(n)
      }}
    />
  )
}

/**
 * Power per unit in W: the UI language's decimal separator (D144), empty =
 * unknown; written as the API's decimal string with 2 decimals ("7.50"),
 * refused like the backend refuses it (more than 2 decimals, above 100000).
 */
function PowerField({ value, disabled, onCommit }: { value: string | null; disabled: boolean; onCommit: (watts: string | null) => void }) {
  const { t } = useTranslation('plans')
  const fieldError = useFieldError()
  const separator = useDecimalSeparator()
  const shown = value === null ? '' : formatWatts(value, separator)
  const [draft, setDraft] = useState<string | null>(null)
  const invalid = draft !== null && parsePower(draft) === undefined
  return (
    <Field
      label={t('needs.power')}
      hint={t('needs.powerHint')}
      inputMode="decimal"
      suffix="W"
      value={draft ?? shown}
      disabled={disabled}
      error={invalid ? fieldError(errorKey('need.power_invalid', { max: maxPowerW })) : undefined}
      onFocus={() => setDraft(shown)}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value)
        const watts = parsePower(e.target.value)
        if (watts !== undefined) onCommit(watts)
      }}
    />
  )
}

/** One selected load symbol: its function, fields, zone and Delete. */
export function NeedInspector({
  need,
  zoneName,
  catalog,
  warnings,
  errors,
  editable,
  dispatch,
}: {
  need: PlanNeed
  zoneName: string | undefined
  catalog: NeedCatalog
  warnings: Finding[]
  errors: string[]
  editable: boolean
  dispatch: (action: EditorAction) => void
}) {
  const { t } = useTranslation('plans')
  const { t: tc } = useTranslation('common')
  const text = useNeedText(catalog)
  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-muted">{t('needs.symbol')}</p>
        <p className="font-medium break-words">{text(need)}</p>
        <p className="text-sm text-muted">
          {t('needs.zoneOfSymbol')}: {zoneName ?? t('needs.noZone')}
        </p>
      </div>
      <NeedMessages errors={errors} warnings={warnings} />
      <NeedConnections needId={need.id} name={text(need)} />
      <NeedFields need={need} catalog={catalog} editable={editable} dispatch={dispatch} />
      <Button variant="danger-quiet" disabled={!editable} onClick={() => dispatch({ type: 'change', action: { type: 'remove', ids: [need.id] } })}>
        <Trash2 /> {tc('action.delete')}
      </Button>
    </div>
  )
}
