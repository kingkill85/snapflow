import { ImageOff } from 'lucide-react'

import { cn } from '@/lib/cn'

const sizes = { sm: 'size-10', md: 'size-16', lg: 'size-40' } as const

type ThumbnailProps = {
  /** The image URL; without one a placeholder is shown. */
  src?: string
  /** Empty (the default) when the image only decorates a row that names the item anyway. */
  alt?: string
  size?: keyof typeof sizes
}

/** A small square preview of an image (e.g. a product photo), or a placeholder. */
export function Thumbnail({ src, alt = '', size = 'sm' }: ThumbnailProps) {
  const box = cn('shrink-0 overflow-hidden rounded-control border border-line bg-canvas', sizes[size])
  if (!src) {
    return (
      <span aria-hidden="true" data-testid="thumbnail-placeholder" className={cn(box, 'flex items-center justify-center text-muted [&_svg]:size-4')}>
        <ImageOff />
      </span>
    )
  }
  return <img src={src} alt={alt} loading="lazy" className={cn(box, 'object-contain')} />
}
