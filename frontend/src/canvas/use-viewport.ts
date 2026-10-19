import { useCallback, useEffect, useRef, useState } from 'react'

import { fitViewport, type Size, type Viewport, zoomAt } from './geometry'

/**
 * The viewport of a canvas over an image: zoom and pan state plus the
 * stage's size (set by CanvasStage). Fits the image once the stage size is
 * first known.
 */
export function useViewport(image: Size | undefined) {
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 })
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
  const fitted = useRef(false)

  const fit = useCallback(() => {
    if (image && stage.width > 0) setViewport(fitViewport(image, stage))
  }, [image, stage])

  useEffect(() => {
    if (!fitted.current && image && stage.width > 0 && stage.height > 0) {
      fitted.current = true
      fit()
    }
  }, [fit, image, stage])

  /** Zooms by a factor around the stage centre (toolbar buttons). */
  const zoomBy = useCallback(
    (factor: number) => setViewport((v) => zoomAt(v, { x: stage.width / 2, y: stage.height / 2 }, v.scale * factor)),
    [stage],
  )

  return { viewport, setViewport, stage, setStage, fit, zoomBy }
}
