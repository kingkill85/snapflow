import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react'
import { Image as KonvaImage, Layer, Stage } from 'react-konva'

import { cn } from '@/lib/cn'

import { distance, midpoint, type Point, type Size, screenToImage, type Viewport, wheelFactor, zoomAt } from './geometry'
import { isTypingTarget } from './keyboard'
import { useHtmlImage } from './use-html-image'

/** A pointer event on the canvas, with its position in image pixels. */
export type CanvasPointer = {
  /** Position in image pixels. */
  point: Point
  /** The Konva node under the pointer (the stage itself on empty canvas). */
  target: Konva.Node
  evt: PointerEvent
}

type CanvasStageProps = {
  viewport: Viewport
  onViewportChange: (update: (v: Viewport) => Viewport) => void
  /** Reports the stage's size in screen pixels (it fills its container). */
  onSize: (size: Size) => void
  /** Pan with a plain left drag (the hand tool); space, the middle button and two fingers always pan. */
  panMode?: boolean
  onPointerDown?: (e: CanvasPointer) => void
  onPointerMove?: (e: CanvasPointer) => void
  onPointerUp?: (e: CanvasPointer) => void
  /** Accessible name of the canvas region. */
  label: string
  className?: string
  stageRef?: Ref<Konva.Stage>
  /** Konva layers, drawn in image coordinates. */
  children: ReactNode
}

/**
 * The shared canvas base (D198): a Konva stage filling its container, drawn
 * in image pixels under a viewport. Zoom 10–800 % around the pointer with the
 * wheel or a pinch, pan with space + drag, the middle mouse button, two
 * fingers or `panMode`. Pointer events are reported in image pixels unless a
 * pan takes them.
 */
export function CanvasStage({
  viewport,
  onViewportChange,
  onSize,
  panMode,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  label,
  className,
  stageRef,
  children,
}: CanvasStageProps) {
  const container = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [space, setSpace] = useState(false)
  const pan = useRef<{ last: Point } | null>(null)
  const pinch = useRef<{ distance: number; centre: Point } | null>(null)
  const [panning, setPanning] = useState(false)

  // Fill the container.
  useEffect(() => {
    const el = container.current
    if (!el) return
    const measure = () => {
      const next = { width: el.clientWidth, height: el.clientHeight }
      setSize(next)
      onSize(next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [onSize])

  // Space held = pan (not while typing).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        e.preventDefault()
        setSpace(true)
      }
    }
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false)
    const blur = () => setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const pointerOf = (e: KonvaEventObject<PointerEvent>): CanvasPointer | undefined => {
    const pos = e.target.getStage()?.getPointerPosition()
    if (!pos) return undefined
    return { point: screenToImage(viewport, pos), target: e.target, evt: e.evt }
  }

  const handleWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault()
    const pos = e.target.getStage()?.getPointerPosition()
    if (!pos) return
    // Ctrl + wheel is a trackpad pinch in browsers: zoom too.
    onViewportChange((v) => zoomAt(v, pos, v.scale * wheelFactor(e.evt.deltaY)))
  }

  const handleDown = (e: KonvaEventObject<PointerEvent>) => {
    if (pinch.current) return
    // Keep getting the moves and the release when the pointer leaves the canvas.
    try {
      e.target.getStage()?.content.setPointerCapture(e.evt.pointerId)
    } catch {
      // not capturable (e.g. synthetic events)
    }
    if (e.evt.button === 1 || space || (panMode && e.evt.button === 0)) {
      e.evt.preventDefault()
      pan.current = { last: { x: e.evt.clientX, y: e.evt.clientY } }
      setPanning(true)
      return
    }
    const p = pointerOf(e)
    if (p) onPointerDown?.(p)
  }
  const handleMove = (e: KonvaEventObject<PointerEvent>) => {
    if (pinch.current) return
    if (pan.current) {
      const { last } = pan.current
      const dx = e.evt.clientX - last.x
      const dy = e.evt.clientY - last.y
      pan.current = { last: { x: e.evt.clientX, y: e.evt.clientY } }
      onViewportChange((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
      return
    }
    const p = pointerOf(e)
    if (p) onPointerMove?.(p)
  }
  const handleUp = (e: KonvaEventObject<PointerEvent>) => {
    if (pan.current) {
      pan.current = null
      setPanning(false)
      return
    }
    const p = pointerOf(e)
    if (p) onPointerUp?.(p)
  }

  // Two fingers: pinch zoom around their midpoint and pan with it.
  const touchPoints = (e: TouchEvent): [Point, Point] | undefined => {
    const rect = container.current?.getBoundingClientRect()
    if (!rect || e.touches.length < 2) return undefined
    const t = (i: number) => ({ x: e.touches[i].clientX - rect.left, y: e.touches[i].clientY - rect.top })
    return [t(0), t(1)]
  }
  const handleTouchMove = (e: KonvaEventObject<TouchEvent>) => {
    const points = touchPoints(e.evt)
    if (!points) return
    e.evt.preventDefault()
    const centre = midpoint(...points)
    const d = distance(...points)
    const prev = pinch.current
    pinch.current = { distance: d, centre }
    if (!prev || prev.distance === 0) return
    onViewportChange((v) => {
      const zoomed = zoomAt(v, prev.centre, (v.scale * d) / prev.distance)
      return { ...zoomed, x: zoomed.x + centre.x - prev.centre.x, y: zoomed.y + centre.y - prev.centre.y }
    })
  }
  const handleTouchEnd = (e: KonvaEventObject<TouchEvent>) => {
    if (e.evt.touches.length < 2) pinch.current = null
  }

  return (
    <div
      ref={container}
      role="region"
      aria-label={label}
      className={cn('relative h-full w-full touch-none overflow-hidden bg-canvas', (space || panMode) && 'cursor-grab', panning && 'cursor-grabbing', className)}
    >
      {size.width > 0 && size.height > 0 && (
        <Stage
          ref={stageRef}
          width={size.width}
          height={size.height}
          x={viewport.x}
          y={viewport.y}
          scaleX={viewport.scale}
          scaleY={viewport.scale}
          onWheel={handleWheel}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {children}
        </Stage>
      )}
    </div>
  )
}

/** The plan image as the bottom layer, at its natural size in image pixels. */
export function ImageLayer({ url, width, height }: { url: string; width: number; height: number }) {
  const image = useHtmlImage(url)
  return (
    <Layer listening={false}>
      {image && <KonvaImage image={image} x={0} y={0} width={width} height={height} />}
    </Layer>
  )
}
