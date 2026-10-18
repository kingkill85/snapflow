import { Check, CircleAlert } from 'lucide-react'
import { type KeyboardEvent, type Ref, useId, useRef, useState } from 'react'
import { type Control, type FieldError, type FieldPath, type FieldValues, useController } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { type ContentLocale, contentLocales } from '@/i18n/content-locales'
import { cn } from '@/lib/cn'

import { useFieldError } from './form-errors'
import { Input } from './field'
import { FieldLabel, FieldMessage, RequiredMark } from './label'
import { Textarea } from './textarea'
import { defaultLanguage, type TranslatableValue } from './translatable'

/** A language's name in the UI language, e.g. "German" (English UI) or "Deutsch" (German UI). */
function useLanguageName() {
  const { i18n } = useTranslation()
  const ui = i18n.resolvedLanguage ?? defaultLanguage
  let names: Intl.DisplayNames | undefined
  try {
    names = new Intl.DisplayNames([ui], { type: 'language' })
  } catch {
    names = undefined
  }
  return (lng: string) => {
    const name = names?.of(lng) ?? lng.toUpperCase()
    return name.charAt(0).toLocaleUpperCase(ui) + name.slice(1)
  }
}

export type TranslatableFieldProps = {
  label: string
  hint?: string
  /** The default language must be filled in: its tab and the label are marked. */
  required?: boolean
  /** A textarea (growing with the text) instead of a one-line input. */
  multiline?: boolean
  /** Rows a multi-line field shows at least. */
  rows?: number
  value: TranslatableValue
  onChange: (value: TranslatableValue) => void
  onBlur?: () => void
  /** Translated errors by language; the tab of each is marked, and the first opens when the active one has none. */
  errors?: Partial<Record<string, string | undefined>>
  /** A translated error of the text as a whole. */
  error?: string
  /**
   * The form's submit count (FormTranslatableField passes it): after each
   * submit with errors, the tab of the first language with an error opens
   * unless the shown one has one. Without it, any change of the errors does.
   */
  submitCount?: number
  disabled?: boolean
  inputRef?: Ref<HTMLInputElement & HTMLTextAreaElement>
  autoComplete?: string
}

/**
 * One field for a translatable text (D109): the label, a tab per language of
 * `contentLocales` (filled in, missing or with an error; the default language
 * marked when required), and the input of the chosen language. It opens on
 * the UI language; an empty translation shows the default language's text as
 * placeholder, which is what users of that language will see. Tabs stay
 * usable when the form is read-only (a disabled fieldset), to read every
 * translation.
 */
export function TranslatableField({
  label,
  hint,
  required,
  multiline,
  rows,
  value,
  onChange,
  onBlur,
  errors,
  error,
  submitCount,
  disabled,
  inputRef,
  autoComplete = 'off',
}: TranslatableFieldProps) {
  const { t, i18n } = useTranslation()
  const languageName = useLanguageName()
  const baseId = useId()
  const inputId = `${baseId}-input`
  const messageId = `${baseId}-message`
  const tabId = (l: string) => `${baseId}-tab-${l}`
  const statusId = (l: string) => `${baseId}-status-${l}`
  const tabRefs = useRef<Partial<Record<string, HTMLElement | null>>>({})

  const errorLanguages = contentLocales.filter((l) => errors?.[l])
  const ui = contentLocales.find((l) => l === i18n.resolvedLanguage) ?? defaultLanguage
  const [active, setActive] = useState<ContentLocale>(() => (errorLanguages.length > 0 ? errorLanguages[0] : ui))
  // A failed save (or, without a submit count, new errors): when the language
  // shown has no error, show the first that has. Not while typing after it, so
  // a tab never changes under the user's hands.
  const signature = errorLanguages.map((l) => `${l}:${errors?.[l]}`).join('|')
  const [seen, setSeen] = useState({ signature, submitCount })
  if (seen.signature !== signature || seen.submitCount !== submitCount) {
    const reveal = submitCount === undefined ? seen.signature !== signature : seen.submitCount !== submitCount
    setSeen({ signature, submitCount })
    if (reveal && errorLanguages.length > 0 && !errorLanguages.includes(active)) setActive(errorLanguages[0])
  }

  const text = value?.[active] ?? ''
  const fallback = active !== defaultLanguage && text === '' ? (value?.[defaultLanguage] ?? '') : ''
  const activeError = errors?.[active] ?? error
  const status = (l: ContentLocale) => {
    if (errors?.[l]) return 'error'
    if ((value?.[l] ?? '').trim() !== '') return 'filled'
    // The default language of a required text is not an optional translation.
    return required && l === defaultLanguage ? 'required' : 'missing'
  }

  const choose = (l: ContentLocale, focusTab = false) => {
    setActive(l)
    if (focusTab) tabRefs.current[l]?.focus()
  }
  const keyDown = (e: KeyboardEvent, index: number) => {
    const last = contentLocales.length - 1
    const to = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: last }[e.key]
    if (to !== undefined) {
      e.preventDefault()
      choose(contentLocales[(to + contentLocales.length) % contentLocales.length], true)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      choose(contentLocales[index])
    }
  }

  const tabs = (
    // Not buttons: a disabled fieldset (read-only form) would disable them, and reading every translation must stay possible.
    <div role="tablist" aria-label={t('translation.languages', { field: label })} className="-my-[3px] inline-flex flex-wrap gap-0.5 rounded-control border border-line bg-canvas p-0.5">
      {contentLocales.map((l, index) => {
        const s = status(l)
        const selected = l === active
        return (
          <div
            key={l}
            ref={(el) => {
              tabRefs.current[l] = el
            }}
            id={tabId(l)}
            role="tab"
            aria-selected={selected}
            aria-controls={`${baseId}-panel`}
            aria-describedby={statusId(l)}
            tabIndex={selected ? 0 : -1}
            onClick={() => choose(l)}
            onKeyDown={(e) => keyDown(e, index)}
            className={cn(
              'inline-flex h-5 cursor-pointer items-center gap-1 rounded-[calc(var(--radius-control)-2px)] px-2 text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-focus',
              selected ? 'bg-surface font-medium text-ink shadow-sm' : 'text-muted hover:text-ink',
              s === 'error' && 'text-danger hover:text-danger',
            )}
          >
            {languageName(l)}
            {required && l === defaultLanguage && <RequiredMark />}
            {s === 'error' ? (
              <CircleAlert aria-hidden="true" className="size-3 shrink-0" />
            ) : s === 'filled' ? (
              <Check aria-hidden="true" className="size-3 shrink-0 text-success" />
            ) : (
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-current" />
            )}
          </div>
        )
      })}
      {/* Each tab's state for screen readers (its description, not part of its name). */}
      <div hidden>
        {contentLocales.map((l) => (
          <span key={l} id={statusId(l)}>
            {t(`translation.${status(l)}`)}
          </span>
        ))}
      </div>
    </div>
  )

  const inputProps = {
    id: inputId,
    ref: inputRef,
    lang: active,
    value: text,
    placeholder: fallback || undefined,
    disabled,
    autoComplete,
    onBlur,
    'aria-invalid': activeError ? true : undefined,
    'aria-describedby': activeError || hint ? messageId : undefined,
    'aria-required': (required && active === defaultLanguage) || undefined,
  }
  const set = (next: string) => onChange({ ...value, [active]: next })

  return (
    <div data-translatable className="group/field min-w-0 space-y-1.5">
      <FieldLabel htmlFor={inputId} required={required} end={tabs}>
        {label}
      </FieldLabel>
      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={tabId(active)}>
        {multiline ? (
          <Textarea {...inputProps} rows={rows} onChange={(e) => set(e.target.value)} />
        ) : (
          <Input {...inputProps} onChange={(e) => set(e.target.value)} />
        )}
      </div>
      <FieldMessage id={messageId} error={activeError} hint={hint} />
    </div>
  )
}

type FormTranslatableFieldProps<T extends FieldValues> = Omit<TranslatableFieldProps, 'value' | 'onChange' | 'onBlur' | 'errors' | 'error' | 'inputRef'> & {
  control: Control<T>
  /** The form path of the text, e.g. "name" or "attributes.2.label". */
  name: FieldPath<T>
}

/** TranslatableField bound to a react-hook-form field holding a TranslatableValue; shows the errors at its contentLocales. */
export function FormTranslatableField<T extends FieldValues>({ control, name, ...props }: FormTranslatableFieldProps<T>) {
  const fieldError = useFieldError()
  const { field, fieldState, formState } = useController({ control, name })
  const error = fieldState.error as (FieldError & Partial<Record<string, FieldError>>) | undefined
  const errors = Object.fromEntries(contentLocales.map((l) => [l, fieldError(error?.[l]?.message)]))
  return (
    <TranslatableField
      {...props}
      value={field.value as TranslatableValue}
      onChange={field.onChange}
      onBlur={field.onBlur}
      inputRef={field.ref}
      errors={errors}
      error={fieldError(error?.message)}
      submitCount={formState.submitCount}
    />
  )
}
