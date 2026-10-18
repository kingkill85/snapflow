import type { ComponentProps } from 'react'
import { Link } from 'react-router'

import { cn } from '@/lib/cn'

/** An in-app link inside running text. */
export function TextLink({ className, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn('font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus', className)}
      {...props}
    />
  )
}
