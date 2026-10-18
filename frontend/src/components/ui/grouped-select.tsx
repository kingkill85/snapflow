import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import type { Ref } from 'react'

import { cn } from '@/lib/cn'

import type { SelectOption } from './select'

/** A titled group of options, e.g. "Product" or "Attributes". */
export type SelectGroup = { label: string; options: SelectOption[] }

// Radix reserves the empty string for "nothing selected" (see Select).
const emptyValue = '\u0000empty'
const toRadix = (value: string) => (value === '' ? emptyValue : value)
const fromRadix = (value: string) => (value === emptyValue ? '' : value)

type GroupedSelectProps = {
  value: string
  onValueChange: (value: string) => void
  /** Options above the groups, e.g. "Not imported". */
  options?: SelectOption[]
  groups: SelectGroup[]
  id?: string
  disabled?: boolean
  className?: string
  placeholder?: string
  ref?: Ref<HTMLButtonElement>
  'aria-label'?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
}

const itemClass =
  'relative flex cursor-default items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none data-disabled:opacity-50 data-highlighted:bg-primary/10'

/**
 * A dropdown like Select whose options are grouped under headings (e.g. the
 * targets of an import mapping). Empty groups are left out.
 */
export function GroupedSelect({ value, onValueChange, options = [], groups, className, placeholder, disabled, ref, ...aria }: GroupedSelectProps) {
  const item = (o: SelectOption) => (
    <SelectPrimitive.Item key={o.value} value={toRadix(o.value)} textValue={o.label} disabled={o.disabled} className={itemClass}>
      <SelectPrimitive.ItemText>{o.content ?? o.label}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex items-center">
        <Check className="size-4 text-primary" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
  return (
    <SelectPrimitive.Root value={toRadix(value)} onValueChange={(v) => onValueChange(fromRadix(v))} disabled={disabled}>
      <SelectPrimitive.Trigger
        ref={ref}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-control border border-line bg-surface pr-2.5 pl-3 text-left text-sm outline-none focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger data-placeholder:text-muted',
          className,
        )}
        {...aria}
      >
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
          className="z-50 max-h-(--radix-select-content-available-height) max-w-[calc(100vw-1rem)] min-w-(--radix-select-trigger-width) overflow-hidden rounded-control border border-line bg-surface text-ink shadow-lg"
        >
          <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-muted">
            <ChevronUp className="size-4" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="p-1">
            {options.map(item)}
            {groups
              .filter((g) => g.options.length > 0)
              .map((g) => (
                <SelectPrimitive.Group key={g.label}>
                  <SelectPrimitive.Label className="px-2 pt-2.5 pb-1 text-xs font-semibold tracking-wide text-muted uppercase">{g.label}</SelectPrimitive.Label>
                  {g.options.map(item)}
                </SelectPrimitive.Group>
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
