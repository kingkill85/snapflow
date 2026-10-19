import { type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'

import { fitViewport, type Size, type Viewport, zoomAt } from './geometry'

/**
 * The viewport of a canvas over an image: zoom and pan state plus the
 * stage's size (set by CanvasStage). The image stays fitted to the stage
 * (also when the stage changes size, e.g. a notice above it comes or goes)
 * until the user zooms or pans; "fit" fits it again and keeps it fitted.
 */
export function useViewport(image: Size | undefined) {
  const [viewport, setViewportState] = useState<Viewport>({ x: 0, y: 0, scale: 1 })
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 })
  const fitting = useRef(true)

  const fit = useCallback(() => {
    fitting.current = true
    if (image && stage.width > 0 && stage.height > 0) setViewportState(fitViewport(image, stage))
  }, [image, stage])

  useEffect(() => {
    if (fitting.current && image && stage.width > 0 && stage.height > 0) setViewportState(fitViewport(image, stage))
  }, [image, stage])

  /** A zoom or pan by the user: the stage's size no longer refits the image. */
  const setViewport = useCallback((next: SetStateAction<Viewport>) => {
    fitting.current = false
    setViewportState(next)
  }, [])

  /** Zooms by a factor around the stage centre (toolbar buttons). */
  const zoomBy = useCallback(
    (factor: number) => setViewport((v) => zoomAt(v, { x: stage.width / 2, y: stage.height / 2 }, v.scale * factor)),
    [stage, setViewport],
  )

  return { viewport, setViewport, stage, setStage, fit, zoomBy }
}
