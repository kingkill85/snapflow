import type Konva from 'konva'
import { type DragEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, Group, Image as KonvaImage, Layer, Line, Rect, Shape, Text } from 'react-konva'

import type { Plan, PlanPlacement, PlanWarning, PlanZone, VariantSearchItem } from '@/api/generated/model'
import {
  angleTo,
  boundsOf,
  boxCorners,
  type CanvasPointer,
  CanvasStage,
  distance,
  isTypingTarget,
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
  paperColors,
  useHtmlImages,
  type Viewport,
} from '@/canvas'
import { fileUrl } from '@/catalog/files'

import type { PlanDocument } from './document'
import type { EditorAction } from './editor-state'
import { chromeName } from './export'
import { type Layers, placementVisible, zoneVisible } from './layers'
import { clampMove, duplicatePlacements, resizeChanges } from './placements'
import {
  canClose,
  clampToImage,
  edgeMidpoints,
  type FrameHandle,
  frameHandles,
  insertVertex,
  labelPoint,
  minZonePoints,
  moveVertex,
  newZone,
  rectCorners,
  removeVertex,
  scaleZone,
  toPoint,
  zoneBounds,
} from './zones'

/** The data type of a palette product dragged onto the canvas. */
export const productDragType = 'application/x-snapflow-product'

export type Tool = 'select' | 'pan' | 'zoneRect' | 'zonePolygon' | 'calibrate'

/** A corner of a zone picked on the canvas (the inspector can remove it). */
export type ActiveVertex = { zoneId: string; index: number }

type Interaction =
  | { kind: 'move'; start: Point; ids: string[]; dx: number; dy: number; copy: boolean }
  | { kind: 'resize'; id: string; corner: Corner; preview: PlanPlacement }
  | { kind: 'rotate'; id: string; rotation: number }
  | { kind: 'band'; start: Point; end: Point; add: boolean }
  | { kind: 'drawRect'; start: Point; end: Point }
  /** Dragging a zone corner; `points` already holds a corner added at an edge midpoint. */
  | { kind: 'vertex'; id: string; index: number; points: number[][]; point: Point; inserted: boolean }
  /** Resizing a zone as a whole by a handle of its frame (D252); `points` is the preview. */
  | { kind: 'scaleZone'; id: string; handle: FrameHandle; start: Point; points: number[][] }

/** Clicks of the polygon and calibration tools, kept until the shape is done. */
type Draft = { tool: Tool; points: Point[]; cursor: Point | null; lastClick: number }

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
  onToolChange: (tool: Tool) => void
  viewport: Viewport
  onViewportChange: (update: (v: Viewport) => Viewport) => void
  onSize: (size: Size) => void
  dispatch: (action: EditorAction) => void
  /** Armed by a palette click: the next click on the canvas places it. */
  placing: boolean
  /** Place the armed product (click) or a dropped one (by product id) at an image point. */
  onPlace: (point: Point, productId?: string) => void
  /** What is hidden (view state). */
  layers: Layers
  /** Resizing a placement resizes every placement of its product. */
  resizeAll: boolean
  activeVertex: ActiveVertex | null
  onActiveVertex: (vertex: ActiveVertex | null) => void
  /** The two points of the calibration tool were picked. */
  onCalibrate: (a: Point, b: Point) => void
  /** The two calibration points while their distance is asked for: the line stays drawn (D225). */
  measured?: [Point, Point] | null
  stageRef?: RefObject<Konva.Stage | null>
  /** While the PNG export draws: one screen pixel is this many image pixels (strokes and labels relative to the image, not the zoom). */
  exportPixel?: number
}

type PlanColors = typeof paperColors

const handleSize = 9 // screen px
const framePadding = 10 // screen px between a selected zone's bounds and its frame (the frame handles stay clear of the corner handles)
const rotateOffset = 24 // screen px above the box
const closeDistance = 8 // screen px: a click this near the first corner (or the last, as a double-click) closes a polygon
const doubleClickMs = 400

/**
 * The floorplan canvas: image, zones, placements. Interactions keep a local
 * preview and commit one history step when the pointer is released; the
 * polygon and calibration tools collect clicks in a draft.
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
  onToolChange,
  viewport,
  onViewportChange,
  onSize,
  dispatch,
  placing,
  onPlace,
  layers,
  resizeAll,
  activeVertex,
  onActiveVertex,
  onCalibrate,
  measured,
  stageRef,
  exportPixel,
}: Props) {
  const { t } = useTranslation('plans')
  // Drawn on the (light) plan image: the same colours in light and dark mode (D221).
  const theme = paperColors
  const ownStage = useRef<Konva.Stage>(null)
  const stage = stageRef ?? ownStage
  const wrapper = useRef<HTMLDivElement>(null)
  const [interaction, setInteraction] = useState<Interaction | null>(null)
  const [rawDraft, setDraft] = useState<Draft | null>(null)
  // A draft belongs to its tool: switching tools drops it.
  const draft = rawDraft?.tool === tool ? rawDraft : null
  const selected = useMemo(() => new Set(selection), [selection])
  const k = exportPixel ?? 1 / viewport.scale // one screen pixel in image pixels

  const placements = useMemo(() => document.placements.filter((p) => placementVisible(p, layers, variants)), [document.placements, layers, variants])
  const zones = useMemo(() => document.zones.filter((z) => zoneVisible(z, layers)), [document.zones, layers])

  const imageUrls = useMemo(
    () => placements.flatMap((p) => (p.variantId ? [fileUrl(variants.get(p.variantId)?.imageFileId)] : [])).filter((u): u is string => !!u),
    [placements, variants],
  )
  const images = useHtmlImages(imageUrls)

  // Only what is shown can be handled.
  const placementById = useMemo(() => new Map(placements.map((p) => [p.id, p])), [placements])
  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones])
  const single = selection.length === 1 ? placementById.get(selection[0]) : undefined
  const singleZone = selection.length === 1 ? zoneById.get(selection[0]) : undefined
  const clampPoint = (p: Point) => clampToImage(p, plan.image)

  /** The placement as drawn now (with the running interaction's preview). */
  const shown = (p: PlanPlacement): PlanPlacement => {
    if (!interaction) return p
    if (interaction.kind === 'move' && !interaction.copy && interaction.ids.includes(p.id)) return { ...p, x: p.x + interaction.dx, y: p.y + interaction.dy }
    if (interaction.kind === 'resize' && interaction.id === p.id) return interaction.preview
    if (interaction.kind === 'rotate' && interaction.id === p.id) return { ...p, rotation: interaction.rotation }
    return p
  }
  const shownZone = (z: PlanZone): PlanZone => {
    if (interaction?.kind === 'move' && !interaction.copy && interaction.ids.includes(z.id))
      return { ...z, points: z.points.map(([x, y]) => [x + interaction.dx, y + interaction.dy]) }
    if (interaction?.kind === 'vertex' && interaction.id === z.id) return { ...z, points: moveVertex(interaction.points, interaction.index, interaction.point) }
    if (interaction?.kind === 'scaleZone' && interaction.id === z.id) return { ...z, points: interaction.points }
    return z
  }

  const addZone = (points: Point[]) => {
    const zone = newZone(points.map(clampPoint), document.zones, t('zones.newName'))
    dispatch({ type: 'change', action: { type: 'addZones', zones: [zone] }, select: [zone.id] })
    onToolChange('select')
  }

  const closePolygon = (points: Point[]) => {
    setDraft(null)
    if (canClose(points)) addZone(points)
  }

  // Enter closes a polygon, Esc drops a draft (polygon or calibration).
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  })
  const closeRef = useRef(closePolygon)
  useEffect(() => {
    closeRef.current = closePolygon
  })
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const current = draftRef.current
      if (!current || isTypingTarget(e.target)) return
      if (e.key === 'Escape') setDraft(null)
      if (e.key === 'Enter' && current.tool === 'zonePolygon') {
        e.preventDefault()
        closeRef.current(current.points)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const clickDraft = (point: Point, now: number) => {
    const p = clampPoint(point)
    const points = draft?.points ?? []
    if (tool === 'calibrate') {
      if (points.length === 0) {
        setDraft({ tool, points: [p], cursor: p, lastClick: now })
      } else {
        setDraft(null)
        onToolChange('select')
        if (distance(points[0], p) > 0) onCalibrate(points[0], p)
      }
      return
    }
    // Polygon: a click near the first corner, or a double-click, closes it.
    const last = points.at(-1)
    const nearFirst = points.length >= 3 && distance(points[0], p) <= closeDistance * k
    const doubleClick = !!last && !!draft && now - draft.lastClick < doubleClickMs && distance(last, p) <= closeDistance * k
    if (nearFirst || doubleClick) {
      closePolygon(points)
      return
    }
    setDraft({ tool, points: [...points, p], cursor: p, lastClick: now })
  }

  const down = ({ point, target, evt }: CanvasPointer) => {
    if (evt.button !== 0) return
    if (editable && tool === 'zoneRect') {
      const p = clampPoint(point)
      setInteraction({ kind: 'drawRect', start: p, end: p })
      return
    }
    if ((editable && tool === 'zonePolygon') || tool === 'calibrate') {
      if (tool === 'calibrate' && !editable) return
      clickDraft(point, evt.timeStamp)
      return
    }
    if (tool !== 'select') return
    const name = target.name()
    if (editable && single && name.startsWith('handle-')) {
      const handle = name.slice('handle-'.length)
      setInteraction(handle === 'rotate' ? { kind: 'rotate', id: single.id, rotation: single.rotation } : { kind: 'resize', id: single.id, corner: handle as Corner, preview: single })
      return
    }
    if (editable && singleZone && name.startsWith('vertex-')) {
      const index = Number(name.slice('vertex-'.length))
      if (evt.altKey) {
        if (singleZone.points.length > minZonePoints) {
          dispatch({ type: 'change', action: { type: 'updateZones', changes: [{ id: singleZone.id, patch: { points: removeVertex(singleZone.points, index) } }] } })
        }
        onActiveVertex(null)
        return
      }
      onActiveVertex({ zoneId: singleZone.id, index })
      setInteraction({ kind: 'vertex', id: singleZone.id, index, points: singleZone.points, point: toPoint(singleZone.points[index]), inserted: false })
      return
    }
    if (editable && singleZone && name.startsWith('frame-')) {
      setInteraction({ kind: 'scaleZone', id: singleZone.id, handle: name.slice('frame-'.length) as FrameHandle, start: point, points: singleZone.points })
      return
    }
    if (editable && singleZone && name.startsWith('mid-')) {
      const index = Number(name.slice('mid-'.length))
      const at = edgeMidpoints(singleZone.points)[index]
      onActiveVertex({ zoneId: singleZone.id, index: index + 1 })
      setInteraction({ kind: 'vertex', id: singleZone.id, index: index + 1, points: insertVertex(singleZone.points, index, at), point: at, inserted: true })
      return
    }
    const placementId = target.findAncestor('.placement', true)?.id()
    // An armed palette product is placed on empty canvas and on zones.
    if (placing && editable && !placementId) {
      onPlace(point)
      return
    }
    const id = placementId ?? target.findAncestor('.zone', true)?.id()
    if (id) {
      let ids = selection
      if (evt.shiftKey) {
        dispatch({ type: 'toggleSelect', ids: [id] })
        return
      }
      if (!selected.has(id)) {
        ids = [id]
        dispatch({ type: 'select', ids })
        onActiveVertex(null)
      }
      if (editable) setInteraction({ kind: 'move', start: point, ids, dx: 0, dy: 0, copy: evt.altKey })
      return
    }
    if (!evt.shiftKey) dispatch({ type: 'select', ids: [] })
    onActiveVertex(null)
    setInteraction({ kind: 'band', start: point, end: point, add: evt.shiftKey })
  }

  const move = ({ point, evt }: CanvasPointer) => {
    if (draft) setDraft({ ...draft, cursor: clampPoint(point) })
    if (!interaction) return
    switch (interaction.kind) {
      case 'move': {
        // Every moved centre and corner stays inside the image.
        const d = clampMove(document, interaction.ids, point.x - interaction.start.x, point.y - interaction.start.y, plan.image)
        setInteraction({ ...interaction, ...d })
        break
      }
      case 'resize': {
        const p = placementById.get(interaction.id)
        if (p) setInteraction({ ...interaction, preview: { ...p, ...resizeBox(p, interaction.corner, point, !evt.shiftKey, 1, plan.image) } })
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
      case 'drawRect':
        setInteraction({ ...interaction, end: clampPoint(point) })
        break
      case 'vertex':
        setInteraction({ ...interaction, point: clampPoint(point) })
        break
      case 'scaleZone': {
        const z = zoneById.get(interaction.id)
        const delta = { x: point.x - interaction.start.x, y: point.y - interaction.start.y }
        // Shift scales a corner freely (width and height independently).
        if (z) setInteraction({ ...interaction, points: scaleZone(z.points, interaction.handle, delta, evt.shiftKey, plan.image) })
        break
      }
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
        // Rounded to whole pixels, still inside the image.
        const { dx, dy } = clampMove(document, done.ids, Math.round(done.dx), Math.round(done.dy), plan.image)
        if (done.copy) {
          const copies = duplicatePlacements(document.placements.filter((p) => done.ids.includes(p.id)), dx, dy, plan.image)
          if (copies.length > 0) dispatch({ type: 'change', action: { type: 'addPlacements', placements: copies }, select: copies.map((c) => c.id) })
        } else {
          dispatch({ type: 'change', action: { type: 'moveBy', ids: done.ids, dx, dy } })
        }
        return
      }
      case 'resize': {
        const { x, y, width, height } = done.preview
        const round = (n: number) => Math.round(n * 10) / 10
        const changes = resizeChanges(document.placements, done.id, { x: round(x), y: round(y), width: round(width), height: round(height) }, variants, resizeAll)
        dispatch({ type: 'change', action: { type: 'updatePlacements', changes } })
        return
      }
      case 'rotate':
        dispatch({ type: 'change', action: { type: 'updatePlacements', changes: [{ id: done.id, patch: { rotation: done.rotation } }] } })
        return
      case 'band': {
        const band = rectFromPoints(done.start, done.end)
        if (band.width < 2 * k && band.height < 2 * k) return
        const hits = [
          ...zones.filter((z) => rectsIntersect(band, zoneBounds(z))).map((z) => z.id),
          ...placements.filter((p) => rectsIntersect(band, boundsOf(boxCorners(p)))).map((p) => p.id),
        ]
        dispatch(done.add ? { type: 'select', ids: [...new Set([...selection, ...hits])] } : { type: 'select', ids: hits })
        return
      }
      case 'drawRect': {
        const r = rectFromPoints(done.start, done.end)
        // Too small to be meant (a click): nothing.
        if (r.width < 4 * k || r.height < 4 * k) return
        addZone(rectCorners(r))
        return
      }
      case 'vertex': {
        const points = moveVertex(done.points, done.index, done.point)
        const before = zoneById.get(done.id)?.points
        if (!done.inserted && before && JSON.stringify(before) === JSON.stringify(points)) return
        dispatch({ type: 'change', action: { type: 'updateZones', changes: [{ id: done.id, patch: { points } }] } })
        return
      }
      case 'scaleZone': {
        const before = zoneById.get(done.id)?.points
        if (!before || JSON.stringify(before) === JSON.stringify(done.points)) return
        dispatch({ type: 'change', action: { type: 'updateZones', changes: [{ id: done.id, patch: { points: done.points } }] } })
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
  const drawnRect = interaction?.kind === 'drawRect' ? rectFromPoints(interaction.start, interaction.end) : undefined
  const singleShown = single && shown(single)
  const singleZoneShown = singleZone && shownZone(singleZone)
  const drawing = tool === 'zoneRect' || tool === 'zonePolygon' || tool === 'calibrate'
  const draftLine = draft ? [...draft.points, ...(draft.cursor ? [draft.cursor] : [])].flatMap((p) => [p.x, p.y]) : []

  return (
    <div ref={wrapper} className="h-full w-full" onDragOver={dragOver} onDrop={drop} data-testid="plan-canvas" data-tool={tool} data-draft-points={draft?.points.length ?? 0}>
      <CanvasStage
        label={t('editor.canvas')}
        viewport={viewport}
        onViewportChange={onViewportChange}
        onSize={onSize}
        panMode={tool === 'pan'}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        stageRef={stage}
        className={placing || drawing ? 'cursor-crosshair' : undefined}
      >
        <ImageLayer url={plan.image.url} width={plan.image.width} height={plan.image.height} />
        <Layer>
          {zones.map((z) => (
            <ZoneNode key={z.id} zone={shownZone(z)} selected={selected.has(z.id)} error={errorIds.has(z.id)} k={k} theme={theme} />
          ))}
          {editable && singleZoneShown && interaction?.kind !== 'move' && <ZoneFrame zone={singleZoneShown} k={k} theme={theme} />}
          {editable && singleZoneShown && interaction?.kind !== 'move' && (
            <VertexHandles zone={singleZoneShown} active={activeVertex?.zoneId === singleZoneShown.id ? activeVertex.index : -1} k={k} theme={theme} />
          )}
        </Layer>
        <Layer>
          {placements.map((p) => {
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
          <Group name={chromeName} listening={false}>
            {band && <Rect x={band.x} y={band.y} width={band.width} height={band.height} stroke={theme.primary} strokeWidth={k} dash={[4 * k, 4 * k]} fill={theme.primary} opacity={0.15} />}
            {drawnRect && <Rect x={drawnRect.x} y={drawnRect.y} width={drawnRect.width} height={drawnRect.height} stroke={theme.primary} strokeWidth={2 * k} fill={theme.primary} opacity={0.2} />}
            {draft && draftLine.length >= 4 && <Line points={draftLine} stroke={theme.primary} strokeWidth={2 * k} dash={tool === 'calibrate' ? [6 * k, 4 * k] : undefined} />}
            {measured && <Line points={measured.flatMap((p) => [p.x, p.y])} stroke={theme.primary} strokeWidth={2 * k} dash={[6 * k, 4 * k]} />}
            {measured?.map((p, i) => (
              <Circle key={`m${i}`} x={p.x} y={p.y} radius={4 * k} fill={theme.surface} stroke={theme.primary} strokeWidth={1.5 * k} />
            ))}
            {draft?.points.map((p, i) => (
              <Circle key={i} x={p.x} y={p.y} radius={4 * k} fill={theme.surface} stroke={theme.primary} strokeWidth={1.5 * k} />
            ))}
          </Group>
        </Layer>
        <Layer listening={false}>
          {zones.map((z) => (
            <ZoneLabel key={z.id} zone={shownZone(z)} k={k} theme={theme} />
          ))}
        </Layer>
      </CanvasStage>
    </div>
  )
}

/** A zone: its polygon filled in its colour at its opacity and outline (the name is drawn by `ZoneLabel`, above the placements). */
function ZoneNode({ zone: z, selected, error, k, theme }: { zone: PlanZone; selected: boolean; error: boolean; k: number; theme: PlanColors }) {
  const flat = z.points.flat()
  return (
    <Group name="zone" id={z.id}>
      <Line points={flat} closed fill={z.color} opacity={z.opacity} />
      <Line points={flat} closed stroke={error ? theme.danger : z.color} strokeWidth={(error ? 3 : 2) * k} listening={false} />
      {selected && <Line name={chromeName} points={flat} closed stroke={theme.primary} strokeWidth={k} dash={[6 * k, 4 * k]} listening={false} />}
    </Group>
  )
}

/** A zone's name with a halo (D221), in its own layer above the placements so a product never hides it (D224). */
function ZoneLabel({ zone: z, k, theme }: { zone: PlanZone; k: number; theme: PlanColors }) {
  const label = labelPoint(z)
  return (
    <Text
      text={z.name}
      x={label.x - 100 * k}
      y={label.y - 8 * k}
      width={200 * k}
      align="center"
      fontSize={14 * k}
      fontStyle="bold"
      fill={theme.ink}
      stroke={theme.surface}
      strokeWidth={3 * k}
      lineJoin="round"
      fillAfterStrokeEnabled
      listening={false}
    />
  )
}

const frameCursors: Record<FrameHandle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }
const setCursor = (node: Konva.Node, cursor: string) => {
  const container = node.getStage()?.container()
  if (container) container.style.cursor = cursor
}

/**
 * The frame around one selected zone (D252): its bounds a little outside,
 * lighter than the corner handles (drawn before them, so they win where they
 * meet), with corner handles that scale and side handles that stretch.
 */
function ZoneFrame({ zone, k, theme }: { zone: PlanZone; k: number; theme: PlanColors }) {
  const b = zoneBounds(zone)
  const pad = framePadding * k
  const x0 = b.x - pad
  const y0 = b.y - pad
  const x1 = b.x + b.width + pad
  const y1 = b.y + b.height + pad
  const xm = (x0 + x1) / 2
  const ym = (y0 + y1) / 2
  const at: Record<FrameHandle, [number, number]> = { nw: [x0, y0], n: [xm, y0], ne: [x1, y0], e: [x1, ym], se: [x1, y1], s: [xm, y1], sw: [x0, y1], w: [x0, ym] }
  const s = handleSize * 0.8 * k
  // A cursor set on hover is reset when the frame goes away under the pointer.
  const group = useRef<Konva.Group>(null)
  useEffect(() => {
    const container = group.current?.getStage()?.container()
    return () => {
      if (container) container.style.cursor = ''
    }
  }, [])
  return (
    <Group ref={group} name={chromeName}>
      <Rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} stroke={theme.primary} strokeWidth={k} opacity={0.5} listening={false} />
      {frameHandles.map((h) => (
        <Rect
          key={h}
          name={`frame-${h}`}
          x={at[h][0] - s / 2}
          y={at[h][1] - s / 2}
          width={s}
          height={s}
          fill={theme.surface}
          stroke={theme.primary}
          strokeWidth={k}
          opacity={0.75}
          hitStrokeWidth={4 * k}
          onMouseEnter={(e) => setCursor(e.target, frameCursors[h])}
          onMouseLeave={(e) => setCursor(e.target, '')}
        />
      ))}
    </Group>
  )
}

/** Corner handles of one selected zone (drag; Alt-click removes) and edge midpoints (drag or click adds a corner). */
function VertexHandles({ zone, active, k, theme }: { zone: PlanZone; active: number; k: number; theme: PlanColors }) {
  const s = handleSize * k
  return (
    <Group name={chromeName}>
      {edgeMidpoints(zone.points).map((m, i) => (
        <Circle key={`m${i}`} name={`mid-${i}`} x={m.x} y={m.y} radius={s / 2.6} fill={theme.primary} opacity={0.6} />
      ))}
      {zone.points.map(([x, y], i) => (
        <Rect
          key={`v${i}`}
          name={`vertex-${i}`}
          x={x - s / 2}
          y={y - s / 2}
          width={s}
          height={s}
          fill={i === active ? theme.primary : theme.surface}
          stroke={theme.primary}
          strokeWidth={1.5 * k}
        />
      ))}
    </Group>
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
  theme: PlanColors
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
      {selected && <Rect name={chromeName} x={-hw - 3 * k} y={-hh - 3 * k} width={p.width + 6 * k} height={p.height + 6 * k} stroke={theme.primary} strokeWidth={k} dash={[4 * k, 3 * k]} listening={false} />}
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
          stroke={theme.surface}
          strokeWidth={3 * k}
          lineJoin="round"
          fillAfterStrokeEnabled
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
    <Group name={chromeName} x={p.x} y={p.y} rotation={p.rotation}>
      <Line points={[0, -hh, 0, -hh - rotateOffset * k]} stroke={color} strokeWidth={k} listening={false} />
      <Circle name="handle-rotate" x={0} y={-hh - rotateOffset * k} radius={s / 1.6} fill={surface} stroke={color} strokeWidth={1.5 * k} />
      {corners.map(([corner, x, y]) => (
        <Rect key={corner} name={`handle-${corner}`} x={x - s / 2} y={y - s / 2} width={s} height={s} fill={surface} stroke={color} strokeWidth={1.5 * k} />
      ))}
    </Group>
  )
}
