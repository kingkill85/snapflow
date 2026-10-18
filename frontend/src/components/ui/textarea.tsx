import { type ComponentProps, type CSSProperties, type Ref, useCallback, useId, useLayoutEffect, useRef } from 'react'

import { cn } from '@/lib/cn'

import { FieldLabel, FieldMessage } from './label'

/** How far a textarea grows with its text before it scrolls. */
const maxRows = 12

// Browsers with CSS `field-sizing: content` size the textarea themselves;
// elsewhere it is measured after every change.
const sizesItself = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

type TextareaProps = ComponentProps<'textarea'> & {
  /** The rows it shows at least (default 3); it grows with its text up to 12 rows, then scrolls. */
  rows?: number
}

/** A multi-line text input styled like Input that grows with its text (D110). */
export function Textarea({ className, rows = 3, style, ref, onInput, ...props }: TextareaProps) {
  const inner = useRef<HTMLTextAreaElement | null>(null)
  // The value last measured: measuring only when it changed, so typing
  // elsewhere on the page never resizes (or scrolls) this textarea.
  const measured = useRef<string | null>(null)
  const measure = useCallback(() => {
    const el = inner.current
    if (!el || sizesItself || el.value === measured.current) return
    measured.current = el.value
    // Collapsing to measure must not move the page or the text: both scroll positions are kept.
    const page = document.scrollingElement
    const pageTop = page?.scrollTop ?? 0
    const ownTop = el.scrollTop
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
    el.scrollTop = ownTop
    if (page) page.scrollTop = pageTop
  }, [])
  // After every render, cheaply: also catches a value set from outside (a form reset), which fires no input event.
  useLayoutEffect(measure)
  const setRef = (el: HTMLTextAreaElement | null) => {
    inner.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = el
  }
  // Line height 1.25rem (text-sm), padding 1rem, border 2px.
  const sizes: CSSProperties = {
    minHeight: `calc(${rows} * 1.25rem + 1rem + 2px)`,
    maxHeight: `calc(${maxRows} * 1.25rem + 1rem + 2px)`,
    fieldSizing: 'content',
  } as CSSProperties
  return (
    <textarea
      ref={setRef as Ref<HTMLTextAreaElement>}
      rows={rows}
      style={{ ...sizes, ...style }}
      onInput={(e) => {
        measure()
        onInput?.(e)
      }}
      className={cn(
        'block w-full resize-none overflow-y-auto rounded-control border border-line bg-surface px-3 py-2 text-sm/5 outline-none placeholder:text-muted focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  )
}

type TextareaFieldProps = TextareaProps & { label: string; error?: string; hint?: string; required?: boolean }

/** Label + textarea + hint/error, wired for accessibility (the multi-line Field). */
export function TextareaField({ label, error, hint, required, id, ...props }: TextareaFieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const messageId = `${inputId}-message`
  return (
    <div className="group/field min-w-0 space-y-1.5">
      <FieldLabel htmlFor={inputId} required={required}>
        {label}
      </FieldLabel>
      <Textarea
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        aria-required={required || undefined}
        {...props}
      />
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  )
}
