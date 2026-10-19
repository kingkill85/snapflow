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
      image.onerror = null
    }
  }, [url])
  return loaded && loaded.url === url ? loaded.image : undefined
}

/**
 * Loads several images by URL, e.g. the product images of a plan's
 * placements. Nothing is set after unmount; a failed URL may be tried again.
 */
export function useHtmlImages(urls: string[]): Map<string, HTMLImageElement> {
  const [images, setImages] = useState(() => new Map<string, HTMLImageElement>())
  const requested = useRef(new Map<string, HTMLImageElement>())
  const key = [...new Set(urls)].sort().join('\n')
  useEffect(() => {
    for (const url of key ? key.split('\n') : []) {
      if (requested.current.has(url)) continue
      const image = new window.Image()
      requested.current.set(url, image)
      image.onload = () => {
        image.onload = image.onerror = null
        setImages((prev) => new Map(prev).set(url, image))
      }
      image.onerror = () => {
        image.onload = image.onerror = null
        requested.current.delete(url)
      }
      image.src = url
    }
  }, [key])
  // Unmounted: loads still running must not set state.
  useEffect(() => {
    const pending = requested.current
    return () => {
      for (const image of pending.values()) image.onload = image.onerror = null
      pending.clear()
    }
  }, [])
  return images
}
