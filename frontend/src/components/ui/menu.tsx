import * as MenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'

import { cn } from '@/lib/cn'

/**
 * A dropdown menu (navigation sections, the user menu): opens from a trigger,
 * arrow keys move, Enter chooses, Escape closes, typeahead jumps to an item.
 * Compose: <Menu trigger={<Button …/>}> <MenuItem/> <MenuRadioGroup/> … </Menu>.
 */
export function Menu({
  trigger,
  children,
  align = 'start',
  label,
  onCloseAutoFocus,
}: {
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  label?: string
  /** Called before focus returns to the trigger on close; `preventDefault()` keeps focus where an action put it. */
  onCloseAutoFocus?: (event: Event) => void
}) {
  return (
    <MenuPrimitive.Root modal={false}>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          className={contentClass}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {children}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  )
}

const contentClass = 'z-50 min-w-48 rounded-control border border-edge bg-raised p-1 text-sm text-ink shadow-lg'
const itemClass =
  'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none select-none data-disabled:opacity-50 data-highlighted:bg-primary/10 [&_svg]:size-4 [&_svg]:shrink-0'

type MenuItemProps = Omit<ComponentProps<typeof MenuPrimitive.Item>, 'className'> & {
  active?: boolean
  /** A destructive entry (Remove), in the danger colour. */
  danger?: boolean
}

/** One entry. `asChild` with a router Link for navigation; `active` marks the current page. */
export function MenuItem({ active, danger, ...props }: MenuItemProps) {
  return (
    <MenuPrimitive.Item
      className={cn(itemClass, active && 'font-medium text-primary', danger && 'text-danger data-highlighted:bg-danger/10')}
      aria-current={active ? 'page' : undefined}
      {...props}
    />
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <MenuPrimitive.Label className="px-2 py-1.5 text-xs font-medium text-muted">{children}</MenuPrimitive.Label>
}

export function MenuSeparator() {
  return <MenuPrimitive.Separator className="-mx-1 my-1 h-px bg-line" />
}

type MenuRadioGroupProps = {
  value: string
  onValueChange: (value: string) => void
  options: { value: string; label: string }[]
}

/** Exclusive choices inside a menu, e.g. language or theme; the chosen one has a check. */
export function MenuRadioGroup({ value, onValueChange, options }: MenuRadioGroupProps) {
  return (
    <MenuPrimitive.RadioGroup value={value} onValueChange={onValueChange}>
      {options.map((o) => (
        <MenuPrimitive.RadioItem key={o.value} value={o.value} className={cn(itemClass, 'pl-8')} onSelect={(e) => e.preventDefault()}>
          <MenuPrimitive.ItemIndicator className="absolute left-2 inline-flex items-center">
            <Check className="text-primary" />
          </MenuPrimitive.ItemIndicator>
          {o.label}
        </MenuPrimitive.RadioItem>
      ))}
    </MenuPrimitive.RadioGroup>
  )
}
