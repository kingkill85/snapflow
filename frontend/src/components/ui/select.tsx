import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { type ReactNode, type Ref, useId } from 'react'
import { type Control, type FieldPath, type FieldValues, useController } from 'react-hook-form'

import { cn } from '@/lib/cn'

import { FieldLabel, FieldMessage } from './label'

/**
 * One choice. `label` is the plain text (typeahead, accessible name);
 * `content` optionally replaces it on screen, e.g. a TypeBadge with its colour dot.
 */
export type SelectOption = { value: string; label: string; content?: ReactNode; disabled?: boolean }

// Radix reserves the empty string for "nothing selected"; options with the
// value "" ("All types", "Not set") use this stand-in inside the component.
const emptyValue = '\u0000empty'
const toRadix = (value: string) => (value === '' ? emptyValue : value)
const fromRadix = (value: string) => (value === emptyValue ? '' : value)

export type SelectProps = {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  id?: string
  disabled?: boolean
  className?: string
  /** Shown while the value matches no option. */
  placeholder?: string
  onBlur?: () => void
  ref?: Ref<HTMLButtonElement>
  'aria-label'?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  'aria-required'?: boolean
}

/**
 * A dropdown styled like Input (not the native select, D98): a button that
 * opens a listbox; keyboard (arrows, Enter, Escape) and typeahead work.
 * Controlled: `value` + `onValueChange`; in a react-hook-form use FormSelectField.
 */
export function Select({ value, onValueChange, options, className, placeholder, disabled, onBlur, ref, ...aria }: SelectProps) {
  return (
    // A value no option has shows the placeholder (Radix shows it for "" only).
    <SelectPrimitive.Root
      value={options.some((o) => o.value === value) ? toRadix(value) : ''}
      onValueChange={(v) => onValueChange(fromRadix(v))}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        ref={ref}
        onBlur={onBlur}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-control border border-line bg-surface pr-2.5 pl-3 text-left text-sm outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger data-placeholder:text-muted',
          className,
        )}
        {...aria}
      >
        {/* Shrinks with the field: long (rich) values are cut off, never widen the form. */}
        <span className="flex min-w-0 flex-1 [&>span]:min-w-0 [&>span]:truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="size-4 shrink-0 text-muted" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-(--radix-select-content-available-height) max-w-[calc(100vw-1rem)] min-w-(--radix-select-trigger-width) overflow-hidden rounded-control border border-edge bg-raised text-ink shadow-lg"
        >
          <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-muted">
            <ChevronUp className="size-4" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={toRadix(o.value)}
                textValue={o.label}
                disabled={o.disabled}
                className="relative flex cursor-default items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none data-disabled:opacity-50 data-highlighted:bg-primary/10"
              >
                <SelectPrimitive.ItemText>{o.content ?? o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center">
                  <Check className="size-4 text-primary" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-muted">
            <ChevronDown className="size-4" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

type SelectFieldProps = Omit<SelectProps, 'aria-label' | 'aria-invalid' | 'aria-describedby'> & {
  label: string
  error?: string
  hint?: string
  /** Marks the label with an asterisk and the dropdown with aria-required. */
  required?: boolean
}

/** Label + dropdown + hint/error, wired for accessibility like Field. */
export function SelectField({ label, error, hint, required, id, 'aria-required': ariaRequired, ...props }: SelectFieldProps) {
  const generated = useId()
  const selectId = id ?? generated
  const messageId = `${selectId}-message`
  return (
    <div className="group/field min-w-0 space-y-1.5">
      <FieldLabel htmlFor={selectId} required={required}>
        {label}
      </FieldLabel>
      <Select
        id={selectId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        aria-required={required || ariaRequired || undefined}
        {...props}
      />
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  )
}

type FormSelectFieldProps<T extends FieldValues> = Omit<SelectFieldProps, 'value' | 'onValueChange' | 'onBlur' | 'ref'> & {
  control: Control<T>
  name: FieldPath<T>
}

/** SelectField bound to a react-hook-form field: `<FormSelectField control={form.control} name="role" … />`. */
export function FormSelectField<T extends FieldValues>({ control, name, disabled, ...props }: FormSelectFieldProps<T>) {
  const {
    field: { ref, value, onChange, onBlur },
  } = useController({ control, name })
  return (
    <SelectField
      {...props}
      ref={ref}
      value={(value as string | null | undefined) ?? ''}
      onValueChange={onChange}
      onBlur={onBlur}
      disabled={disabled}
    />
  )
}
