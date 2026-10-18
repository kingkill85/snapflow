import * as LabelPrimitive from '@radix-ui/react-label'
import { type ComponentProps, useId } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

import { Input } from './field'

const hex = /^#[0-9a-fA-F]{6}$/

type ColorFieldProps = Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'type'> & {
  label: string
  /** "#rrggbb", or "" for none. */
  value: string
  onChange: (value: string) => void
  error?: string
  hint?: string
}

/**
 * An optional colour: a swatch that opens the browser's colour picker, and
 * the hex code as text (empty for none). Use with react-hook-form's Controller.
 */
export function ColorField({ label, value, onChange, error, hint, id, disabled, ...props }: ColorFieldProps) {
  const { t } = useTranslation()
  const generated = useId()
  const inputId = id ?? generated
  const messageId = `${inputId}-message`
  const message = error || hint
  return (
    <div className="group/field space-y-1.5">
      <LabelPrimitive.Root htmlFor={inputId} className="text-sm font-medium">
        {label}
      </LabelPrimitive.Root>
      <div className="flex gap-2">
        <input
          type="color"
          aria-label={t('action.pickColor')}
          value={hex.test(value) ? value.toLowerCase() : '#ffffff'}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-control border border-line bg-surface p-1 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Input
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#1f6feb"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          {...props}
        />
      </div>
      {message && (
        <p id={messageId} className={cn('text-xs', error ? 'text-danger' : 'text-muted group-has-[:disabled]/field:hidden')}>
          {message}
        </p>
      )}
    </div>
  )
}
