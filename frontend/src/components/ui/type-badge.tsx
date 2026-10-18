import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

const hex = /^#[0-9a-fA-F]{6}$/

/** Relative luminance (WCAG) of a "#rrggbb" colour. */
function luminance(color: string): number {
  const channel = (i: number) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** Black or white, whichever contrasts more with the background colour. */
function badgeTextColor(background: string): string {
  const l = luminance(background)
  // Contrast with black is (l + 0.05) / 0.05, with white 1.05 / (l + 0.05).
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#ffffff'
}

/**
 * A catalog type's name with its badge in front, e.g. a product type in lists
 * and pickers. With an abbreviation ("ZB") the badge is a small label in the
 * colour, its text black or white for contrast; without one it is a dot in
 * the colour. Without a colour the label or dot is outlined. Label and dot
 * take the same width (at least 48 px), so names line up. The colour is data ("#rrggbb"), not a design token. The badge is
 * decoration: the name follows it. Long names are cut off with an ellipsis,
 * or wrap with `wrap` (table cells).
 */
export function TypeBadge({
  color,
  abbreviation,
  wrap,
  children,
}: {
  color?: string
  abbreviation?: string
  wrap?: boolean
  children: ReactNode
}) {
  const colored = color !== undefined && hex.test(color)
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2">
      {abbreviation ? (
        <span
          aria-hidden="true"
          data-testid="type-abbreviation"
          className={cn(
            'inline-flex h-5 min-w-12 shrink-0 items-center justify-center rounded-sm border px-1 text-[11px] leading-none font-semibold tracking-wide whitespace-nowrap',
            colored ? 'border-transparent' : 'border-line bg-canvas text-muted',
          )}
          style={colored ? { backgroundColor: color, color: badgeTextColor(color) } : undefined}
        >
          {abbreviation}
        </span>
      ) : (
        // The dot sits in a slot as wide as a label, so names line up in lists
        // that mix both.
        <span aria-hidden="true" className="inline-flex w-12 shrink-0 justify-center">
          <span
            data-testid="type-color"
            className={cn('size-2.5 rounded-full border', colored ? 'border-transparent' : 'border-line')}
            style={colored ? { backgroundColor: color } : undefined}
          />
        </span>
      )}
      <span className={wrap ? 'min-w-0 break-words' : 'min-w-0 truncate'}>{children}</span>
    </span>
  )
}
