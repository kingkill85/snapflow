import { Check, ChevronDown } from 'lucide-react'
import { type KeyboardEvent, type Ref, useId, useRef, useState } from 'react'
import { type Control, type FieldPath, type FieldValues, useController } from 'react-hook-form'

import { cn } from '@/lib/cn'

import { inputClass } from './field'
import { FieldLabel, FieldMessage } from './label'
import type { SelectOption } from './select'

export type ComboboxOption = SelectOption & {
  /** Extra text the search matches besides the label (e.g. a code). */
  keywords?: string
}

export type ComboboxProps = {
  value: string
  onValueChange: (value: string) => void
  options: ComboboxOption[]
  id?: string
  disabled?: boolean
  className?: string
  placeholder?: string
  /** Shown when the search matches nothing. */
  emptyText?: string
  onBlur?: () => void
  ref?: Ref<HTMLInputElement>
  'aria-label'?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  'aria-required'?: boolean
}

const matches = (o: ComboboxOption, query: string) => {
  const q = query.trim().toLocaleLowerCase()
  return q === '' || o.label.toLocaleLowerCase().includes(q) || (o.keywords?.toLocaleLowerCase().includes(q) ?? false)
}

/**
 * A searchable dropdown for long lists (currencies): an input with
 * role="combobox" that filters a listbox as one types. Arrow keys move,
 * Enter picks, Escape closes; closed, the input shows the chosen option's label.
 * Controlled: `value` + `onValueChange`; in a react-hook-form use FormComboboxField.
 */
export function Combobox({ value, onValueChange, options, id, disabled, className, placeholder, emptyText, onBlur, ref, ...aria }: ComboboxProps) {
  const generated = useId()
  const inputId = id ?? generated
  const listId = `${inputId}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const selected = options.find((o) => o.value === value)
  const filtered = open ? options.filter((o) => !o.disabled && matches(o, query)) : []

  const show = (q: string) => {
    setOpen(true)
    setQuery(q)
    const i = q === '' ? Math.max(0, options.filter((o) => !o.disabled).findIndex((o) => o.value === value)) : 0
    setActive(i)
    scrollTo(i)
  }
  const close = () => {
    setOpen(false)
    setQuery('')
  }
  const pick = (o: ComboboxOption) => {
    onValueChange(o.value)
    close()
  }
  const scrollTo = (i: number) =>
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView?.({ block: 'nearest' }))
  const move = (by: number) => {
    if (!open) return show('')
    if (filtered.length === 0) return
    const i = (active + by + filtered.length) % filtered.length
    setActive(i)
    scrollTo(i)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter') {
      if (open) {
        e.preventDefault() // never submits the form while choosing
        const o = filtered[active]
        if (o) pick(o)
      }
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation() // closes the list, not the dialog
      close()
    }
  }

  const activeOption = open ? filtered[active] : undefined
  return (
    <div className={cn('relative', className)}>
      <input
        ref={ref}
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeOption ? `${listId}-${active}` : undefined}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        className={cn(inputClass, 'pr-8')}
        value={open ? query : (selected?.label ?? '')}
        onChange={(e) => show(e.target.value)}
        onClick={() => !open && show('')}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          close()
          onBlur?.()
        }}
        onKeyDown={onKeyDown}
        {...aria}
      />
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-2.5 right-2.5 size-4 text-muted" />
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-control border border-edge bg-raised p-1 text-sm text-ink shadow-lg"
        >
          {filtered.length === 0 && emptyText && <li className="px-2 py-1.5 text-muted">{emptyText}</li>}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              // Keeps the focus in the input, so blur does not close before the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              onMouseMove={() => i !== active && setActive(i)}
              className={cn('relative flex cursor-default items-center rounded-sm py-1.5 pr-8 pl-2 select-none', i === active && 'bg-primary/10')}
            >
              {o.content ?? o.label}
              {o.value === value && <Check aria-hidden="true" className="absolute right-2 size-4 text-primary" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type ComboboxFieldProps = Omit<ComboboxProps, 'aria-label' | 'aria-invalid' | 'aria-describedby'> & {
  label: string
  error?: string
  hint?: string
  required?: boolean
}

/** Label + searchable dropdown + hint/error, wired like SelectField. */
export function ComboboxField({ label, error, hint, required, id, 'aria-required': ariaRequired, ...props }: ComboboxFieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const messageId = `${inputId}-message`
  return (
    <div className="group/field min-w-0 space-y-1.5">
      <FieldLabel htmlFor={inputId} required={required}>
        {label}
      </FieldLabel>
      <Combobox
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        aria-required={required || ariaRequired || undefined}
        {...props}
      />
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  )
}

type FormComboboxFieldProps<T extends FieldValues> = Omit<ComboboxFieldProps, 'value' | 'onValueChange' | 'onBlur' | 'ref'> & {
  control: Control<T>
  name: FieldPath<T>
}

/** ComboboxField bound to a react-hook-form field. */
export function FormComboboxField<T extends FieldValues>({ control, name, disabled, ...props }: FormComboboxFieldProps<T>) {
  const {
    field: { ref, value, onChange, onBlur },
  } = useController({ control, name })
  return (
    <ComboboxField
      {...props}
      ref={ref}
      value={(value as string | null | undefined) ?? ''}
      onValueChange={onChange}
      onBlur={onBlur}
      disabled={disabled}
    />
  )
}
