import { TriangleAlert } from 'lucide-react'
import { type DragEvent, type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { BoardWarning, VariantSearchItem } from '@/api/generated/model'
import { formatDecimal, useDecimalSeparator } from '@/catalog/decimal'
import { useLocalized } from '@/i18n/localized'
import { cn } from '@/lib/cn'

import { paletteDrag, productDragType } from '../editor/catalog'
import { type BoardDocument, type BoardModuleDoc, keyboardMove, rowOverflows, rowUsed, slotIn } from './board'
import type { BoardEditorAction } from './board-state'

/** The drag data type of a module moved on the board. */
export const moduleDragType = 'application/x-snapflow-module'

/** Pixels per TE: the widest row fits the available width, but never below a readable minimum (the grid scrolls then). */
const minPxPerTe = 22
const maxPxPerTe = 64

type Props = {
  doc: BoardDocument
  selection: string[]
  variants: Map<string, VariantSearchItem>
  widthOf: (m: BoardModuleDoc) => number
  warnings: Map<string, BoardWarning[]>
  errorIds: Set<string>
  editable: boolean
  dispatch: (action: BoardEditorAction) => void
  /** A palette product dropped (or armed and clicked/Enter) onto a row near an offset; the page finds the slot. */
  onPlace: (productId: string, rowId: string, offsetTe: number) => void
  armed: string | null
  /** The width a dragged palette product would have (preview); undefined when unknown. */
  productWidth: (productId: string) => number
}

type Preview = { rowId: string; offsetTe: number; width: number } | null

/**
 * The board as DOM rails (D364): one DIN rail per row with TE ticks, modules
 * as focusable boxes. Drag from the palette or a module onto a rail (the
 * nearest free gap, 0.5 TE grid), arrows move the focused module, Delete
 * removes it. Everything else (undo, copy, ...) is in the page's shortcuts.
 */
export function BoardGrid({ doc, selection, variants, widthOf, warnings, errorIds, editable, dispatch, onPlace, armed, productWidth }: Props) {
  const { t } = useTranslation('plans')
  const separator = useDecimalSeparator()
  const ref = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(800)
  const [preview, setPreview] = useState<Preview>(null)
  // The product being dragged from the palette: dataTransfer is not readable during dragover.
  const dragging = useRef<{ kind: 'module'; id: string } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setAvailable(el.clientWidth || 800)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const widest = Math.max(1, ...doc.rows.map((r) => r.capacityTe))
  // 48 px: the row label column; 32 px of padding.
  const pxPerTe = Math.min(maxPxPerTe, Math.max(minPxPerTe, (available - 48 - 32) / widest))
  const te = (n: number) => formatDecimal(n, separator)

  const offsetAt = (e: { clientX: number }, rail: HTMLElement, width: number) => {
    const rect = rail.getBoundingClientRect()
    return (e.clientX - rect.left) / pxPerTe - width / 2
  }

  const dragOver = (e: DragEvent<HTMLDivElement>, rowId: string) => {
    if (!editable) return
    const types = e.dataTransfer.types
    let width: number
    let exclude = new Set<string>()
    if (types.includes(moduleDragType) && dragging.current) {
      const m = doc.modules.find((x) => x.id === dragging.current?.id)
      if (!m) return
      width = widthOf(m)
      exclude = new Set([m.id])
    } else if (types.includes(productDragType)) {
      // The data is hidden until the drop: the palette tells which product it drags.
      width = paletteDrag.productId ? productWidth(paletteDrag.productId) : 1
    } else return
    e.preventDefault()
    e.dataTransfer.dropEffect = types.includes(moduleDragType) ? 'move' : 'copy'
    const offset = slotIn(doc, rowId, width, offsetAt(e, e.currentTarget, width), widthOf, exclude)
    setPreview(offset === null ? null : { rowId, offsetTe: offset, width })
  }


  const drop = (e: DragEvent<HTMLDivElement>, rowId: string) => {
    if (!editable) return
    e.preventDefault()
    setPreview(null)
    const moduleId = e.dataTransfer.getData(moduleDragType)
    if (moduleId) {
      const m = doc.modules.find((x) => x.id === moduleId)
      dragging.current = null
      if (!m) return
      const width = widthOf(m)
      const offset = slotIn(doc, rowId, width, offsetAt(e, e.currentTarget, width), widthOf, new Set([m.id]))
      if (offset === null) return
      dispatch({ type: 'change', action: { type: 'updateModules', changes: [{ id: m.id, patch: { rowId, offsetTe: offset } }] }, select: [m.id] })
      return
    }
    const productId = e.dataTransfer.getData(productDragType)
    if (productId) {
      const width = productWidth(productId)
      onPlace(productId, rowId, offsetAt(e, e.currentTarget, width))
    }
  }

  const moduleKey = (e: KeyboardEvent<HTMLDivElement>, m: BoardModuleDoc) => {
    if (e.ctrlKey || e.metaKey) return
    const direction = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key] as 'left' | 'right' | 'up' | 'down' | undefined
    if (direction) {
      e.preventDefault()
      if (!editable) return
      const to = keyboardMove(doc, m.id, direction, widthOf)
      if (to) dispatch({ type: 'change', action: { type: 'updateModules', changes: [{ id: m.id, patch: to }] }, select: [m.id] })
      // Keep the focus on the moved module (it is re-rendered in another row).
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-module-id="${m.id}"]`)?.focus())
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (editable) dispatch({ type: 'change', action: { type: 'remove', ids: selection.includes(m.id) ? selection : [m.id] } })
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      dispatch(e.shiftKey ? { type: 'toggleSelect', ids: [m.id] } : { type: 'select', ids: [m.id] })
    }
  }

  return (
    <div ref={ref} className="h-full overflow-auto bg-canvas p-4" onDragLeave={(e) => e.currentTarget === e.target && setPreview(null)} onDragEnd={() => setPreview(null)}>
      {doc.rows.length === 0 ? (
        <p className="text-sm text-muted">{t('board.noRows')}</p>
      ) : (
        <ol className="space-y-6" aria-label={t('board.rails')}>
          {doc.rows.map((row, index) => {
            const used = rowUsed(doc, row.id, widthOf)
            const overflow = rowOverflows(doc, row.id, widthOf)
            const modules = doc.modules.filter((m) => m.rowId === row.id)
            const width = row.capacityTe * pxPerTe
            const reach = Math.max(width, ...modules.map((m) => (m.offsetTe + widthOf(m)) * pxPerTe))
            return (
              <li key={row.id} className="flex items-start gap-2">
                <div className="w-10 shrink-0 pt-6 text-right text-xs text-muted">{t('board.rowShort', { n: index + 1 })}</div>
                <div className="space-y-1">
                  <p className={cn('text-xs tabular-nums', overflow ? 'font-medium text-warning' : 'text-muted')}>
                    {t('board.rowTotals', { n: index + 1, used: te(used), capacity: te(row.capacityTe) })}
                    {overflow && ` · ${t('board.overflow')}`}
                  </p>
                  <div
                    role="group"
                    tabIndex={editable && armed ? 0 : -1}
                    aria-label={t('board.rowLabel', { n: index + 1, used: te(used), capacity: te(row.capacityTe) })}
                    data-row-id={row.id}
                    className={cn('relative h-24 rounded-sm border border-line bg-surface', armed && editable && 'cursor-copy')}
                    style={{ width: reach }}
                    onDragOver={(e) => dragOver(e, row.id)}
                    onDrop={(e) => drop(e, row.id)}
                    onClick={(e) => {
                      if (e.target !== e.currentTarget) return
                      if (armed && editable) onPlace(armed, row.id, offsetAt(e, e.currentTarget, productWidth(armed)))
                      else dispatch({ type: 'select', ids: [] })
                    }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || !armed || !editable) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onPlace(armed, row.id, 0)
                      }
                    }}
                  >
                    {/* The DIN rail with a tick per TE (every 5th longer). */}
                    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 border-y border-line bg-canvas" style={{ width }}>
                      {Array.from({ length: Math.floor(row.capacityTe) + 1 }, (_, i) => (
                        <span key={i} className={cn('absolute top-0 w-px bg-line', i % 5 === 0 ? 'h-3' : 'h-1.5')} style={{ left: i * pxPerTe }} />
                      ))}
                    </div>
                    {/* Beyond the capacity: overflowing modules sit on a marked area. */}
                    {reach > width && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l-2 border-dashed border-warning" style={{ left: width }} />}
                    {preview?.rowId === row.id && (
                      <div aria-hidden="true" className="pointer-events-none absolute inset-y-1 rounded-sm border-2 border-dashed border-primary" style={{ left: preview.offsetTe * pxPerTe, width: preview.width * pxPerTe }} />
                    )}
                    {modules.map((m) => (
                      <ModuleBox
                        key={m.id}
                        module={m}
                        width={widthOf(m)}
                        pxPerTe={pxPerTe}
                        variant={m.variantId ? variants.get(m.variantId) : undefined}
                        selected={selection.includes(m.id)}
                        warned={(warnings.get(m.id)?.length ?? 0) > 0 || m.offsetTe + widthOf(m) > row.capacityTe}
                        failed={errorIds.has(m.id)}
                        editable={editable}
                        te={te}
                        onSelect={(add) => dispatch(add ? { type: 'toggleSelect', ids: [m.id] } : { type: 'select', ids: [m.id] })}
                        onKeyDown={(e) => moduleKey(e, m)}
                        onDragStart={() => {
                          dragging.current = { kind: 'module', id: m.id }
                        }}
                      />
                    ))}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

type BoxProps = {
  module: BoardModuleDoc
  width: number
  pxPerTe: number
  variant?: VariantSearchItem
  selected: boolean
  warned: boolean
  failed: boolean
  editable: boolean
  te: (n: number) => string
  onSelect: (add: boolean) => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
  onDragStart: () => void
}

function ModuleBox({ module: m, width, pxPerTe, variant, selected, warned, failed, editable, te, onSelect, onKeyDown, onDragStart }: BoxProps) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()
  const name = variant ? localize(variant.productName) : t('inspector.deleted')
  const label = [name, m.label, t('board.moduleWidth', { width: te(width) }), m.existing ? t('existing.badge') : '', warned ? t('board.hasWarnings') : ''].filter(Boolean).join(', ')
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      data-module-id={m.id}
      draggable={editable}
      onDragStart={(e) => {
        e.dataTransfer.setData(moduleDragType, m.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onClick={(e) => onSelect(e.shiftKey)}
      onKeyDown={onKeyDown}
      className={cn(
        'absolute inset-y-1 flex flex-col overflow-hidden rounded-sm border bg-surface px-1 py-0.5 text-left text-[11px] leading-tight shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-focus',
        editable && 'cursor-grab',
        selected ? 'border-primary ring-2 ring-primary' : warned ? 'border-warning' : 'border-ink/40',
        failed && 'border-danger ring-2 ring-danger',
        m.existing && 'board-existing',
      )}
      style={{ left: m.offsetTe * pxPerTe + 1, width: Math.max(4, width * pxPerTe - 2) }}
    >
      {/* The product type's colour as a strip (the colour is data, like TypeBadge's). */}
      {variant && <span aria-hidden="true" className="-mx-1 -mt-0.5 mb-0.5 block h-1 shrink-0" style={{ backgroundColor: variant.productType.color }} />}
      <span className="truncate font-medium">{name}</span>
      {m.label && <span className="truncate text-muted">{m.label}</span>}
      <span className="mt-auto flex items-center gap-0.5 truncate text-muted tabular-nums">
        {warned && <TriangleAlert aria-hidden="true" className="size-3 shrink-0 text-warning" />}
        {te(width)}
        {variant?.productType.abbreviation && <span className="ml-auto">{variant.productType.abbreviation}</span>}
      </span>
    </div>
  )
}
