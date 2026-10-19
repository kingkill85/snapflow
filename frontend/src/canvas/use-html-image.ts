import { useEffect, useRef, useState } from 'react'

/** Loads an image for the canvas; undefined until it has loaded (or when it fails). */
export function useHtmlImage(url: string | undefined): HTMLImageElement | undefined {
  const [loaded, setLoaded] = useState<{ url: string; image: HTMLImageElement }>()
  useEffect(() => {
    if (!url) return
    const image = new window.Image()
    let live = true
    image.onload = () => live && setLoaded({ url, image })
    image.src = url
    return () => {
      live = false
      image.onload = null
    }
  }, [url])
  return loaded && loaded.url === url ? loaded.image : undefined
}

/** Loads several images by URL, e.g. the product images of a plan's placements. */
export function useHtmlImages(urls: string[]): Map<string, HTMLImageElement> {
  const [images, setImages] = useState(() => new Map<string, HTMLImageElement>())
  const requested = useRef(new Set<string>())
  const key = [...new Set(urls)].sort().join('\n')
  useEffect(() => {
    for (const url of key ? key.split('\n') : []) {
      if (requested.current.has(url)) continue
      requested.current.add(url)
      const image = new window.Image()
      image.onload = () => setImages((prev) => new Map(prev).set(url, image))
      image.onerror = () => requested.current.delete(url)
      image.src = url
    }
  }, [key])
  return images
}
