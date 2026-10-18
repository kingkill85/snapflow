import { RotateCcw, Trash2 } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button, CheckboxField, CheckboxGroupField, Field, SelectField, TagsField } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { type AttributeFormValue, type AttributeFormValues, type Definition, formValueOf } from './attribute-values'

/** The hint under an attribute's input: required, its bounds, its description. */
function useHint() {
  const { t } = useTranslation('catalog')
  const localized = useLocalized()
  const bounds = (kind: 'length' | 'range' | 'count', min?: number, max?: number) => {
    if (min !== undefined && max !== undefined) return t(`hint.${kind}`, { min, max })
    if (min !== undefined) return t(`hint.${kind}Min`, { min })
    if (max !== undefined) return t(`hint.${kind}Max`, { max })
    return undefined
  }
  return (d: Definition) => {
    const parts: (string | undefined)[] = [d.required ? t('hint.required') : undefined]
    if (d.type === 'text') parts.push(bounds('length', d.min, d.max))
    if (d.type === 'number' || d.type === 'integer') parts.push(bounds('range', d.min, d.max))
    if (d.type === 'integer') parts.push(t('hint.whole'))
    if (d.type === 'list') {
      parts.push(bounds('count', d.min, d.max))
      if (d.itemType === 'integer') parts.push(t('hint.wholeItems'))
    }
    parts.push(localized(d.description) || undefined)
    return parts.filter(Boolean).join(' · ') || undefined
  }
}

type AttributeInputProps = {
  definition: Definition
  value: AttributeFormValue
  onChange: (value: AttributeFormValue) => void
  /** Translated error text. */
  error?: string
  disabled?: boolean
}

/**
 * The input for one attribute value, by the definition's type: text, number
 * and whole number as text inputs (unit as suffix), yes/no as a checkbox, a
 * choice as a select, a list of choices as checkboxes, other lists as items
 * added one by one.
 */
export function AttributeInput({ definition: d, value, onChange, error, disabled }: AttributeInputProps) {
  const { t } = useTranslation('catalog')
  const localized = useLocalized()
  const hint = useHint()(d)
  const label = localized(d.label) || d.key
  const options = (d.options ?? []).map((o) => ({ value: o.key, label: localized(o.label) || o.key }))
  const text = typeof value === 'string' ? value : ''
  const list = Array.isArray(value) ? value : []

  switch (d.type) {
    case 'boolean':
      return (
        <CheckboxField
          label={label}
          hint={hint}
          error={error}
          checked={value === true}
          disabled={disabled}
          aria-required={d.required || undefined}
          onChange={(e) => onChange(e.target.checked)}
        />
      )
    case 'enum':
      return (
        <SelectField
          label={label}
          hint={hint}
          error={error}
          value={text}
          disabled={disabled}
          aria-required={d.required || undefined}
          onChange={(e) => onChange(e.target.value)}
          options={[{ value: '', label: t('notSet') }, ...options]}
        />
      )
    case 'list':
      if (d.itemType === 'enum') {
        return <CheckboxGroupField label={label} hint={hint} error={error} options={options} value={list} disabled={disabled} onChange={onChange} />
      }
      return (
        <TagsField
          label={label}
          hint={hint}
          error={error}
          value={list}
          suffix={d.unit}
          disabled={disabled}
          inputMode={d.itemType === 'integer' ? 'numeric' : d.itemType === 'number' ? 'decimal' : undefined}
          onChange={onChange}
        />
      )
    default:
      return (
        <Field
          label={label}
          hint={hint}
          error={error}
          suffix={d.unit}
          value={text}
          disabled={disabled}
          aria-required={d.required || undefined}
          inputMode={d.type === 'integer' ? 'numeric' : d.type === 'number' ? 'decimal' : undefined}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}

type AttributeValuesEditorProps = {
  definitions: Definition[]
  values: AttributeFormValues
  onChange: (key: string, value: AttributeFormValue) => void
  /** Translated errors by attribute key. */
  errors?: Record<string, string | undefined>
  disabled?: boolean
}

/** Inputs for the values of a list of attribute definitions (e.g. a product type's product attributes). */
export function AttributeValuesEditor({ definitions, values, onChange, errors, disabled }: AttributeValuesEditorProps) {
  const { t } = useTranslation('catalog')
  if (definitions.length === 0) return <p className="text-sm text-muted">{t('empty')}</p>
  return (
    <div className="grid items-start gap-4 sm:grid-cols-2">
      {definitions.map((d) => (
        <div key={d.key} className={d.type === 'list' ? 'sm:col-span-2' : undefined}>
          <AttributeInput
            definition={d}
            value={formValueOf(d, values)}
            onChange={(v) => onChange(d.key, v)}
            error={errors?.[d.key]}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  )
}

/** A stored value shown as text, e.g. "white, black" for a list. */
function useValueText() {
  const { t } = useTranslation('catalog')
  const text = (v: unknown): string => {
    if (typeof v === 'boolean') return v ? t('yes') : t('no')
    if (Array.isArray(v)) return v.map(text).join(', ')
    if (typeof v === 'object' && v !== null) return JSON.stringify(v)
    return String(v)
  }
  return text
}

export type ExtraValue = {
  key: string
  value: unknown
  /** Sent back on save (kept); false when the user removed it. */
  kept: boolean
  /** Translated error, e.g. "This attribute is set per variant." */
  error?: string
}

type ExtraValuesProps = {
  entries: ExtraValue[]
  onKeptChange: (key: string, kept: boolean) => void
  disabled?: boolean
}

/**
 * Stored values the current schema does not cover (D55): keys it no longer
 * has, or of attributes now set per product instead of per variant (or the
 * other way round). Each is kept unchanged unless removed.
 */
export function ExtraValues({ entries, onKeptChange, disabled }: ExtraValuesProps) {
  const { t } = useTranslation('catalog')
  const valueText = useValueText()
  const titleId = useId()
  if (entries.length === 0) return null
  return (
    <div role="group" aria-labelledby={titleId} className="space-y-3 rounded-control border border-warning/50 bg-warning/5 p-4">
      <div className="space-y-1">
        <p id={titleId} className="text-sm font-semibold">
          {t('extra.title')}
        </p>
        <p className="text-sm text-muted">{t('extra.description')}</p>
      </div>
      <ul className="divide-y divide-line">
        {entries.map((e) => (
          <li key={e.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm">
                <code className={e.kept ? 'text-xs' : 'text-xs text-muted line-through'}>{e.key}</code>
                <span className={e.kept ? 'ml-2' : 'ml-2 text-muted line-through'}>{valueText(e.value)}</span>
                {!e.kept && (
                  <span className="ml-2">
                    <Badge>{t('extra.removed')}</Badge>
                  </span>
                )}
              </p>
              {e.error && e.kept && (
                <p data-field-error tabIndex={-1} className="text-xs text-danger outline-none">
                  {e.error}
                </p>
              )}
            </div>
            {!disabled &&
              (e.kept ? (
                <Button size="sm" variant="secondary" aria-label={t('extra.remove', { key: e.key })} onClick={() => onKeptChange(e.key, false)}>
                  <Trash2 /> {t('extra.removeShort')}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" aria-label={t('extra.keep', { key: e.key })} onClick={() => onKeptChange(e.key, true)}>
                  <RotateCcw /> {t('extra.keepShort')}
                </Button>
              ))}
          </li>
        ))}
      </ul>
    </div>
  )
}
