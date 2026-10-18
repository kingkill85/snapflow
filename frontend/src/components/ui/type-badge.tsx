import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

/**
 * A catalog type's name with its badge colour as a dot in front, e.g. a product
 * type in lists and pickers. Without a colour the dot is an empty outline, so
 * names stay aligned. The colour is data ("#rrggbb"), not a design token.
 * Long names are cut off with an ellipsis, or wrap with `wrap` (table cells).
 */
export function TypeBadge({ color, wrap, children }: { color?: string; wrap?: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        data-testid="type-color"
        className={cn('size-2.5 shrink-0 rounded-full border', color ? 'border-transparent' : 'border-line')}
        style={color ? { backgroundColor: color } : undefined}
      />
      <span className={wrap ? 'min-w-0 break-words' : 'min-w-0 truncate'}>{children}</span>
    </span>
  )
}
