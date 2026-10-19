import type Konva from 'konva'
import { type DragEvent, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, Group, Image as KonvaImage, Layer, Line, Rect, Shape, Text } from 'react-konva'

import type { Plan, PlanPlacement, PlanWarning, VariantSearchItem } from '@/api/generated/model'
import {
  angleTo,
  boundsOf,
  boxCorners,
  type CanvasPointer,
  CanvasStage,
  type Corner,
  containSize,
  ImageLayer,
  type Point,
  rectFromPoints,
  rectsIntersect,
  resizeBox,
  screenToImage,
  type Size,
  snapAngle,
  useCanvasTheme,
  useHtmlImages,
  type Viewport,
} from '@/canvas'
import { fileUrl } from '@/catalog/files'

import type { PlanDocument } from './document'
import type { EditorAction } from './editor-state'
import { duplicatePlacements } from './placements'

/** The data type of a palette product dragged onto the canvas. */
export const productDragType = 'application/x-snapflow-product'

export type Tool = 'select' | 'pan'

type Interaction =
  | { kind: 'move'; start: Point; ids: string[]; dx: number; dy: number; copy: boolean }
  | { kind: 'resize'; id: string; corner: Corner; preview: PlanPlacement }
  | { kind: 'rotate'; id: string; rotation: number }
  | { kind: 'band'; start: Point; end: Point; add: boolean }

type Props = {
  plan: Plan
  document: PlanDocument
  selection: string[]
  variants: Map<string, VariantSearchItem>
  warnings: Map<string, PlanWarning[]>
  /** Items with a save error (drawn in the danger colour). */
  errorIds: Set<string>
  editable: boolean
  tool: Tool
  viewport: Viewport
  onViewportChange: (update: (v: Viewport) => Viewport) => void
  onSize: (size: Size) => void
  dispatch: (action: EditorAction) => void
  /** Armed by a palette click: the next click on the canvas places it. */
  placing: boolean
  /** Place the armed product (click) or a dropped one (by product id) at an image point. */
  onPlace: (point: Point, productId?: string) => void
}

const handleSize = 9 // screen px
const rotateOffset = 24 // screen px above the box

/**
 * The floorplan canvas (part A: image and placements). Interactions keep a
 * local preview and commit one history step when the pointer is released.
 * Part B adds a zone layer below the placements and zone tools.
 */
export function PlanCanvas({
  plan,
  document,
  selection,
  variants,
  warnings,
  errorIds,
  editable,
  tool,
  viewport,
  onViewportChange,
  onSize,
  dispatch,
  placing,
  onPlace,
}: Props) {
  const { t } = useTranslation('plans')
  const theme = useCanvasTheme()
  const stageRef = useRef<Konva.Stage>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const [interaction, setInteraction] = useState<Interaction | null>(null)
  const selected = useMemo(() => new Set(selection), [selection])
  const k = 1 / viewport.scale // one screen pixel in image pixels

  const imageUrls = useMemo(
    () => document.placements.flatMap((p) => (p.variantId ? [fileUrl(variants.get(p.variantId)?.imageFileId)] : [])).filter((u): u is string => !!u),
    [document.placements, variants],
  )
  const images = useHtmlImages(imageUrls)

  const placementById = useMemo(() => new Map(document.placements.map((p) => [p.id, p])), [document.placements])
  const single = selection.length === 1 ? placementById.get(selection[0]) : undefined

  /** The placement as drawn now (with the running interaction's preview). */
  const shown = (p: PlanPlacement): PlanPlacement => {
    if (!interaction) return p
    if (interaction.kind === 'move' && !interaction.copy && interaction.ids.includes(p.id)) return { ...p, x: p.x + interaction.dx, y: p.y + interaction.dy }
    if (interaction.kind === 'resize' && interaction.id === p.id) return interaction.preview
    if (interaction.kind === 'rotate' && interaction.id === p.id) return { ...p, rotation: interaction.rotation }
    return p
  }

  const down = ({ point, target, evt }: CanvasPointer) => {
    if (evt.button !== 0 || tool !== 'select') return
    const name = target.name()
    if (editable && single && name.startsWith('handle-')) {
      const handle = name.slice('handle-'.length)
      setInteraction(handle === 'rotate' ? { kind: 'rotate', id: single.id, rotation: single.rotation } : { kind: 'resize', id: single.id, corner: handle as Corner, preview: single })
      return
    }
    const group = target.findAncestor('.placement', true)
    const id = group?.id()
    if (id) {
      let ids = selection
      if (evt.shiftKey) {
        dispatch({ type: 'toggleSelect', ids: [id] })
        return
      }
      if (!selected.has(id)) {
        ids = [id]
        dispatch({ type: 'select', ids })
      }
      if (editable) setInteraction({ kind: 'move', start: point, ids, dx: 0, dy: 0, copy: evt.altKey })
      return
    }
    if (placing && editable) {
      onPlace(point)
      return
    }
    if (!evt.shiftKey) dispatch({ type: 'select', ids: [] })
    setInteraction({ kind: 'band', start: point, end: point, add: evt.shiftKey })
  }

  const move = ({ point, evt }: CanvasPointer) => {
    if (!interaction) return
    switch (interaction.kind) {
      case 'move':
        setInteraction({ ...interaction, dx: point.x - interaction.start.x, dy: point.y - interaction.start.y })
        break
      case 'resize': {
        const p = placementById.get(interaction.id)
        if (p) setInteraction({ ...interaction, preview: { ...p, ...resizeBox(p, interaction.corner, point, !evt.shiftKey) } })
        break
      }
      case 'rotate': {
        const p = placementById.get(interaction.id)
        if (!p) break
        const angle = angleTo(p, point)
        setInteraction({ ...interaction, rotation: evt.shiftKey ? snapAngle(angle) : Math.round(angle * 10) / 10 })
        break
      }
      case 'band':
        setInteraction({ ...interaction, end: point })
        break
    }
  }

  const up = () => {
    const done = interaction
    setInteraction(null)
    if (!done) return
    switch (done.kind) {
      case 'move': {
        // A click without moving (less than 2 screen px) is no step.
        if (Math.hypot(done.dx, done.dy) < 2 * k) return
        const dx = Math.round(done.dx)
        const dy = Math.round(done.dy)
        if (done.copy) {
          const copies = duplicatePlacements(document.placements.filter((p) => done.ids.includes(p.id)), dx, dy)
          dispatch({ type: 'change', action: { type: 'addPlacements', placements: copies }, select: copies.map((c) => c.id) })
        } else {
          dispatch({ type: 'change', action: { type: 'moveBy', ids: done.ids, dx, dy } })
        }
        return
      }
      case 'resize': {
        const { x, y, width, height } = done.preview
        const round = (n: number) => Math.round(n * 10) / 10
        dispatch({ type: 'change', action: { type: 'updatePlacements', changes: [{ id: done.id, patch: { x: round(x), y: round(y), width: round(width), height: round(height) } }] } })
        return
      }
      case 'rotate':
        dispatch({ type: 'change', action: { type: 'updatePlacements', changes: [{ id: done.id, patch: { rotation: done.rotation } }] } })
        return
      case 'band': {
        const band = rectFromPoints(done.start, done.end)
        if (band.width < 2 * k && band.height < 2 * k) return
        const hits = document.placements.filter((p) => rectsIntersect(band, boundsOf(boxCorners(p)))).map((p) => p.id)
        dispatch(done.add ? { type: 'select', ids: [...new Set([...selection, ...hits])] } : { type: 'select', ids: hits })
        return
      }
    }
  }

  // Palette products dropped onto the canvas.
  const dragOver = (e: DragEvent) => {
    if (editable && e.dataTransfer.types.includes(productDragType)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const drop = (e: DragEvent) => {
    const productId = e.dataTransfer.getData(productDragType)
    const rect = wrapper.current?.getBoundingClientRect()
    if (!editable || !productId || !rect) return
    e.preventDefault()
    onPlace(screenToImage(viewport, { x: e.clientX - rect.left, y: e.clientY - rect.top }), productId)
  }

  const copies = interaction?.kind === 'move' && interaction.copy ? document.placements.filter((p) => interaction.ids.includes(p.id)) : []
  const band = interaction?.kind === 'band' ? rectFromPoints(interaction.start, interaction.end) : undefined
  const singleShown = single && shown(single)

  return (
    <div ref={wrapper} className="h-full w-full" onDragOver={dragOver} onDrop={drop} data-testid="plan-canvas">
      <CanvasStage
        label={t('editor.canvas')}
        viewport={viewport}
        onViewportChange={onViewportChange}
        onSize={onSize}
        panMode={tool === 'pan'}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        stageRef={stageRef}
        className={placing ? 'cursor-crosshair' : undefined}
      >
        <ImageLayer url={plan.image.url} width={plan.image.width} height={plan.image.height} />
        {/* Part B: the zone layer goes here, below the placements. */}
        <Layer>
          {document.placements.map((p) => {
            const variant = p.variantId ? variants.get(p.variantId) : undefined
            const url = fileUrl(variant?.imageFileId)
            return (
              <PlacementNode
                key={p.id}
                placement={shown(p)}
                image={url ? images.get(url) : undefined}
                color={variant?.productType.color ?? theme.muted}
                warning={(warnings.get(p.id)?.length ?? 0) > 0 || !variant}
                error={errorIds.has(p.id)}
                selected={selected.has(p.id)}
                k={k}
                theme={theme}
                existingLabel={t('existing.badge')}
              />
            )
          })}
          {copies.map((p) => (
            <PlacementNode
              key={`copy-${p.id}`}
              placement={{ ...p, x: p.x + (interaction?.kind === 'move' ? interaction.dx : 0), y: p.y + (interaction?.kind === 'move' ? interaction.dy : 0) }}
              image={undefined}
              color={theme.primary}
              warning={false}
              error={false}
              selected
              k={k}
              theme={theme}
              existingLabel=""
            />
          ))}
          {editable && singleShown && interaction?.kind !== 'move' && <Handles placement={singleShown} k={k} color={theme.primary} surface={theme.surface} />}
          {band && <Rect x={band.x} y={band.y} width={band.width} height={band.height} stroke={theme.primary} strokeWidth={k} dash={[4 * k, 4 * k]} fill={theme.primary} opacity={0.15} listening={false} />}
        </Layer>
      </CanvasStage>
    </div>
  )
}

type NodeProps = {
  placement: PlanPlacement
  image: HTMLImageElement | undefined
  color: string
  warning: boolean
  error: boolean
  selected: boolean
  /** One screen pixel in image pixels: strokes and labels keep their screen size. */
  k: number
  theme: ReturnType<typeof useCanvasTheme>
  existingLabel: string
}

/** One placement: the variant image contain-fitted into its box, a border in the product type colour, label, existing hatching, warning marker. */
function PlacementNode({ placement: p, image, color, warning, error, selected, k, theme, existingLabel }: NodeProps) {
  const fitted = image ? containSize({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height }, p) : undefined
  const hw = p.width / 2
  const hh = p.height / 2
  return (
    <Group name="placement" id={p.id} x={p.x} y={p.y} rotation={p.rotation}>
      <Rect x={-hw} y={-hh} width={p.width} height={p.height} fill={theme.surface} opacity={0.85} />
      {fitted && image && <KonvaImage image={image} x={-fitted.width / 2} y={-fitted.height / 2} width={fitted.width} height={fitted.height} opacity={p.existing ? 0.6 : 1} />}
      {p.existing && (
        <Shape
          listening={false}
          sceneFunc={(ctx, shape) => {
            ctx.save()
            ctx.beginPath()
            ctx.rect(-hw, -hh, p.width, p.height)
            ctx.clip()
            ctx.beginPath()
            const step = 8 * k
            for (let d = -p.height; d < p.width; d += step) {
              ctx.moveTo(-hw + d, -hh)
              ctx.lineTo(-hw + d + p.height, hh)
            }
            ctx.strokeShape(shape)
            ctx.restore()
          }}
          stroke={theme.muted}
          strokeWidth={k}
        />
      )}
      <Rect
        x={-hw}
        y={-hh}
        width={p.width}
        height={p.height}
        stroke={error ? theme.danger : color}
        strokeWidth={(selected || error ? 3 : 2) * k}
        dash={p.existing ? [6 * k, 3 * k] : undefined}
      />
      {selected && <Rect x={-hw - 3 * k} y={-hh - 3 * k} width={p.width + 6 * k} height={p.height + 6 * k} stroke={theme.primary} strokeWidth={k} dash={[4 * k, 3 * k]} listening={false} />}
      {p.existing && existingLabel && (
        <Group x={-hw} y={-hh - 16 * k} listening={false}>
          <Rect width={existingLabel.length * 6.5 * k + 8 * k} height={14 * k} fill={theme.muted} cornerRadius={3 * k} />
          <Text text={existingLabel} x={4 * k} y={2 * k} fontSize={10 * k} fill={theme.surface} />
        </Group>
      )}
      {warning && (
        <Group x={hw} y={-hh} listening={false}>
          <Circle radius={7 * k} fill={theme.warning} />
          <Text text="!" x={-2 * k} y={-6 * k} fontSize={12 * k} fontStyle="bold" fill={theme.surface} />
        </Group>
      )}
      {p.label && (
        <Text
          text={p.label}
          x={-Math.max(hw, 60 * k)}
          y={hh + 4 * k}
          width={Math.max(p.width, 120 * k)}
          align="center"
          fontSize={12 * k}
          fill={theme.ink}
          listening={false}
        />
      )}
    </Group>
  )
}

/** Resize handles at the corners and a rotate handle above the box (one selected placement). */
function Handles({ placement: p, k, color, surface }: { placement: PlanPlacement; k: number; color: string; surface: string }) {
  const hw = p.width / 2
  const hh = p.height / 2
  const s = handleSize * k
  const corners: [Corner, number, number][] = [
    ['nw', -hw, -hh],
    ['ne', hw, -hh],
    ['se', hw, hh],
    ['sw', -hw, hh],
  ]
  return (
    <Group x={p.x} y={p.y} rotation={p.rotation}>
      <Line points={[0, -hh, 0, -hh - rotateOffset * k]} stroke={color} strokeWidth={k} listening={false} />
      <Circle name="handle-rotate" x={0} y={-hh - rotateOffset * k} radius={s / 1.6} fill={surface} stroke={color} strokeWidth={1.5 * k} />
      {corners.map(([corner, x, y]) => (
        <Rect key={corner} name={`handle-${corner}`} x={x - s / 2} y={y - s / 2} width={s} height={s} fill={surface} stroke={color} strokeWidth={1.5 * k} />
      ))}
    </Group>
  )
}
