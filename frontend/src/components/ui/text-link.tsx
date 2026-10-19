import type { ComponentProps } from 'react'
import { Link } from 'react-router'

import { cn } from '@/lib/cn'

const linkClasses = 'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus'

/** An in-app link inside running text. */
export function TextLink({ className, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(linkClasses, className)}
      {...props}
    />
  )
}

/** A download link to an API file inside running text (the API names the file, Content-Disposition). */
export function DownloadLink({ href, className, ...props }: Omit<ComponentProps<'a'>, 'download'> & { href: string }) {
  return <a href={href} download className={cn(linkClasses, className)} {...props} />
}
