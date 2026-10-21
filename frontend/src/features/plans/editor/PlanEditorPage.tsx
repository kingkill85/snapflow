import { useQueryClient } from '@tanstack/react-query'
import type Konva from 'konva'
import { ArrowLeft, CircleDot, Download, Hand, Hexagon, Maximize, MousePointer2, Redo2, Ruler, Square, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Link, useBlocker, useParams, useSearchParams } from 'react-router'

import { ApiError } from '@/api/client'
import type { Finding, Plan, PlanContent, Project, VariantSearchItem } from '@/api/generated/model'
import { getGetPlanContentQueryKey, getListPlansQueryKey, getPlanContent, savePlanContent, useGetPlan, useGetPlanContent } from '@/api/generated/plans/plans'
import { useGetProject } from '@/api/generated/projects/projects'
import { type Point, useViewport, type Viewport } from '@/canvas'
import { Button, ConfirmDialog, EmptyState, ErrorMessage, IconButton, Loading, Notice, Page, SelectField, type TabItem, Tabs, TextLink, useErrorMessage } from '@/components/ui'
import { fresh, isNotFound, versionPath } from '@/features/projects/paths'
import { useLocalized } from '@/i18n/localized'
import { cn } from '@/lib/cn'
import { FindingsList, markedIds } from '@/features/checks'

import { defaultPlacementSize, imageAspect, paletteProducts, useCatalogVariants } from './catalog'
import { documentOf, isSymbol, type PlanDocument, toContentInput } from './document'
import { copyItems } from './copies'
import { type EditorAction, editorReducer, initEditor } from './editor-state'
import { canRedo, canUndo } from './history'
import { CalibrateDialog } from './CalibrateDialog'
import { scaleBar } from './calibration'
import { download, exportFileName, exportPixel, stageToPng } from './export'
import { Inspector } from './Inspector'
import { allVisible, type Layers, visibleIds } from './layers'
import { LayersPanel } from './LayersPanel'
import { LockBanner } from './LockBanner'
import { maxNeeds, newNeed, symbolIcon, symbolLetter, usableForNewNeed } from './needs'
import { useNeedCatalog, useNeedText } from './need-catalog'
import { Palette } from './Palette'
import { PaletteEmpty } from './PaletteEmpty'
import { type ActiveVertex, PlanCanvas, type SymbolLook, type Tool } from './PlanCanvas'
import { newPlacement } from './placements'
import { SaveIndicator } from './SaveIndicator'
import { itemName, saveErrorsByItem, selectionFor } from './save-errors'
import { useAutosave } from './use-autosave'
import { usePlanLock } from './use-plan-lock'
import { type CopyItems, useShortcuts } from './use-shortcuts'
import { ZonesPanel } from './ZonesPanel'
import { focusWhenShown, templatePickerId } from './focus'
import { PlanWiringProvider } from './connections'
import { usePlanWiring, zoneBadge } from './plan-wiring'
import { isFloorplan, saveOnUnload, type Floorplan } from '../api'

/** /projects/:id/versions/:versionId/plans/:planId: loads what the editor needs. */
export function PlanEditorPage() {
  const { t } = useTranslation('plans')
  const { id = '', versionId = '', planId = '' } = useParams()
  const plan = useGetPlan(planId, { query: fresh })
  // The content only of a floorplan: a board on this route shows "does not exist" (its content endpoint is another one).
  const isFloorplanPlan = plan.data?.kind === 'floorplan'
  const content = useGetPlanContent(planId, { query: { ...fresh, enabled: isFloorplanPlan } })
  const project = useGetProject(id, { query: fresh })
  const catalog = useCatalogVariants()

  const notFound = (
    <Page title={t('editor.title')}>
      <EmptyState title={t('editor.notFound')} action={<TextLink to={versionPath(id, versionId)}>{t('editor.back')}</TextLink>} />
    </Page>
  )
  if (plan.data && !isFloorplan(plan.data)) return notFound
  const failed = [plan, content, project, catalog].find((q) => q.isError)
  if (failed) {
    return (
      <Page title={t('editor.title')}>
        {isNotFound(failed.error) ? (
          <EmptyState title={t('editor.notFound')} action={<TextLink to={versionPath(id, versionId)}>{t('editor.back')}</TextLink>} />
        ) : (
          <ErrorMessage error={failed.error} />
        )}
      </Page>
    )
  }
  // Never start from cached data (D44): a cached content from an earlier visit carries an old
  // contentUpdatedAt, so the first save would fail as stale.
  if (!plan.isFetchedAfterMount || !content.isFetchedAfterMount || !project.isFetchedAfterMount) return <Loading />
  if (!plan.data || !content.data || !project.data || !catalog.data || !isFloorplan(plan.data)) return <Loading />
  const loaded = plan.data
  return (
    <PlanWiringProvider versionId={loaded.versionId} planId={loaded.id}>
      {() => <PlanEditor key={loaded.id} plan={loaded} content={content.data} project={project.data} variants={catalog.data} />}
    </PlanWiringProvider>
  )
}

/** Wide enough for the full editor (tablets and up); phones get a view-only canvas with lists. */
function useWide() {
  const query = '(min-width: 768px)'
  const get = () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true)
  const [wide, setWide] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setWide(media.matches)
    media.addEventListener?.('change', update)
    return () => media.removeEventListener?.('change', update)
  }, [])
  return wide
}

/** The height from the element's top to the bottom of the window, so the editor fills the screen below the app header. */
function useFillHeight() {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    const update = () => {
      const top = ref.current?.getBoundingClientRect().top ?? 0
      setHeight(Math.max(320, window.innerHeight - top))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return { ref, height }
}

type PanelTab = 'products' | 'zones' | 'layers' | 'inspector' | 'findings'

const noFindings: Finding[] = []

type Props = { plan: Floorplan; content: PlanContent; project: Project; variants: VariantSearchItem[] }

function PlanEditor({ plan, content, project, variants }: Props) {
  const { t } = useTranslation('plans')
  const { t: tc } = useTranslation()
  const localize = useLocalized()
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const wide = useWide()
  const { ref: fillRef, height: fillHeight } = useFillHeight()

  // The lock is wanted where editing is possible at all; phones only view.
  const mayEdit = plan.can.update && project.status === 'active' && wide
  // Leaving saves what is pending, then releases the lock.
  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  const pageHideRef = useRef<() => boolean>(() => false)
  const planWiring = usePlanWiring()
  const refreshWiring = useRef(planWiring?.refresh)
  useEffect(() => {
    refreshWiring.current = planWiring?.refresh
  })
  const lock = usePlanLock(plan.id, mayEdit, { beforeRelease: () => flushRef.current(), onPageHide: () => pageHideRef.current() })
  const editable = lock.state.status === 'mine'

  const [state, dispatchEditor] = useReducer(editorReducer, documentOf(content), initEditor)
  const doc = state.history.present
  // A notice of the last change (symbols not copied, needs removed with a zone, the needs limit); the next change clears it.
  const [notice, setNotice] = useState<string | null>(null)
  const docRef = useRef(doc)
  useEffect(() => {
    docRef.current = doc
  })
  /** Every change goes through here: removing zones reports the needs they take along. */
  const dispatch = useCallback((action: EditorAction) => {
    if (action.type === 'change' || action.type === 'undo' || action.type === 'redo') setNotice(null)
    if (action.type === 'change' && action.action.type === 'remove') {
      const ids = new Set(action.action.ids)
      const taken = docRef.current.needs.filter((n) => !ids.has(n.id) && !isSymbol(n) && n.zoneId !== null && ids.has(n.zoneId)).length
      if (taken > 0) setNotice(t('notice.zoneNeeds', { count: taken }))
    }
    dispatchEditor(action)
  }, [t])
  const [tool, setTool] = useState<Tool>('select')
  const [tab, setTab] = useState<PanelTab>('products')
  // ?select=<zone, placement or need id> (links from the Checks and Needs tabs): select it once, then drop the param.
  const [params, setParams] = useSearchParams()
  const selectParam = params.get('select')
  const focusParam = params.get('focus')
  // The pending focus attempt stops when the editor closes (not when the params are dropped below).
  const stopFocus = useRef<(() => void) | null>(null)
  useEffect(() => () => stopFocus.current?.(), [])
  useEffect(() => {
    if (!selectParam) return
    const d = docRef.current
    const known = d.zones.some((z) => z.id === selectParam) || d.placements.some((p) => p.id === selectParam) || d.needs.some((n) => n.id === selectParam)
    if (known) {
      dispatchEditor({ type: 'select', ids: [selectionFor(selectParam, d)] })
      setTab('inspector')
      // &focus=template (the Needs tab's "Apply a room template"): focus the zone's template picker once it is shown.
      if (focusParam === 'template') stopFocus.current = focusWhenShown(templatePickerId)
    }
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        out.delete('select')
        out.delete('focus')
        return out
      },
      { replace: true },
    )
  }, [selectParam, focusParam, setParams])
  const [armed, setArmed] = useState<string | null>(null)
  // View state beside the document (not saved, not in the history).
  const [layers, setLayers] = useState<Layers>(allVisible)
  const [resizeAll, setResizeAll] = useState(false)
  const [activeVertex, setActiveVertex] = useState<ActiveVertex | null>(null)
  const [calibration, setCalibration] = useState<[Point, Point] | null>(null)
  // The calibration form docks over the right panel, so the measured line stays visible (D225).
  const [panel, setPanel] = useState<HTMLElement | null>(null)
  const stageRef = useRef<Konva.Stage>(null)

  // What the last load or save returned: the content version to send back, warnings and zone assignments.
  const [server, setServer] = useState(content)
  const contentVersion = useRef(content.contentUpdatedAt)
  // Every need id received from the server in this session: sent back as restoredNeedIds while in the document (undo of a saved delete).
  const serverNeedIds = useRef(new Set((content.needs ?? []).map((n) => n.id)))
  const remember = (needs: { id: string }[] | undefined) => {
    for (const n of needs ?? []) serverNeedIds.current.add(n.id)
  }
  const [saveErrors, setSaveErrors] = useState<Map<string, string[]>>(new Map())

  const variantsById = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants])
  const needCatalog = useNeedCatalog()
  // The function type of the next load symbol ("Place need" tool): the last one used while active, else the first active one.
  const [needFunction, setNeedFunction] = useState<string>('')
  const activeFunctions = needCatalog.functionTypes.filter((f) => f.isActive)
  const placeFunction = activeFunctions.some((f) => f.id === needFunction) ? needFunction : (activeFunctions[0]?.id ?? '')
  const symbolLooks = useMemo(
    () => new Map<string, SymbolLook>(needCatalog.functionTypes.map((f) => [f.id, { icon: symbolIcon(f.key), letter: symbolLetter(localize(f.name)) }])),
    [needCatalog.functionTypes, localize],
  )
  const products = useMemo(() => paletteProducts(variants, project.productTypeIds), [variants, project.productTypeIds])
  /** Hiding a layer also drops its items from the selection (hidden items cannot be handled). */
  const changeLayers = (next: Layers) => {
    setLayers(next)
    const visible = new Set(visibleIds(state.history.present, next, variantsById))
    const kept = state.selection.filter((id) => visible.has(id))
    if (kept.length !== state.selection.length) dispatch({ type: 'select', ids: kept })
  }
  // The plan's findings (D453, D454) by placement and by need: canvas markers and the inspector; as saved
  // (the checks are refreshed after each save).
  const findings = planWiring?.findings ?? noFindings
  const warnings = useMemo(() => {
    const map = new Map<string, Finding[]>()
    for (const f of findings) if (f.refs.targetPlanId === plan.id && f.refs.itemId) map.set(f.refs.itemId, [...(map.get(f.refs.itemId) ?? []), f])
    return map
  }, [findings, plan.id])
  const needWarnings = useMemo(() => {
    const map = new Map<string, Finding[]>()
    // need_unconnected: the need lists show the coverage (NeedConnections); the Problems tab lists it.
    for (const f of findings)
      if (f.refs.planId === plan.id && f.refs.needId && f.code !== 'need_unconnected') map.set(f.refs.needId, [...(map.get(f.refs.needId) ?? []), f])
    return map
  }, [findings, plan.id])
  // Markers only for errors and warnings (D454).
  const needWarningIds = useMemo(() => markedIds(needWarnings), [needWarnings])
  const markedPlacements = useMemo(() => markedIds(warnings), [warnings])

  const save = useCallback(
    async (snapshot: PlanDocument) => {
      try {
        const saved = await savePlanContent(plan.id, toContentInput(snapshot, contentVersion.current, serverNeedIds.current))
        contentVersion.current = saved.contentUpdatedAt
        remember(saved.needs)
        setServer(saved)
        setSaveErrors(new Map())
        // The plan cards show counts: refreshed when the project page shows them again (also after a save on leave).
        void queryClient.invalidateQueries({ queryKey: getListPlansQueryKey(plan.versionId) })
        // Needs changed: their connections and the zone statuses too (3d).
        void refreshWiring.current?.()
      } catch (e) {
        const byItem = saveErrorsByItem(e, snapshot, (f) => errorMessage(new ApiError({ status: 422, code: f.code, params: f.params })))
        setSaveErrors(byItem)
        const first = byItem.keys().next().value
        if (first) {
          dispatch({ type: 'select', ids: [selectionFor(first, snapshot)] })
          setTab('inspector')
        }
        throw e
      }
    },
    [plan.id, plan.versionId, errorMessage, queryClient, dispatch],
  )
  const autosave = useAutosave({ document: doc, save, enabled: editable })

  useEffect(() => {
    flushRef.current = autosave.flush
    // Tab closed or reloaded with pending changes: one last keepalive save (D215).
    pageHideRef.current = () => {
      const pending = editable ? autosave.pending() : undefined
      return pending !== undefined && saveOnUnload(plan.id, toContentInput(pending, contentVersion.current, serverNeedIds.current))
    }
  })
  useEffect(() => {
    if (autosave.status === 'saved') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [autosave.status])

  // Leaving in the app (D28, D215): pending changes are saved first; only
  // changes that cannot be saved (failed, stale) ask "Discard unsaved changes?".
  const blocker = useBlocker(({ currentLocation, nextLocation }) => editable && autosave.dirty && currentLocation.pathname !== nextLocation.pathname)
  const [askLeave, setAskLeave] = useState(false)
  const flushForLeave = autosave.flush
  const pendingForLeave = autosave.pending
  const blockerRef = useRef(blocker)
  useEffect(() => {
    blockerRef.current = blocker
  })
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    let cancelled = false
    void flushForLeave().then(() => {
      if (cancelled) return
      if (pendingForLeave() === undefined) blockerRef.current.proceed?.()
      else setAskLeave(true)
    })
    return () => {
      cancelled = true
    }
  }, [blocker.state, flushForLeave, pendingForLeave])

  /** Loads the stored content again (stale save, lock regained). */
  const reload = useCallback(async () => {
    const fresh = await queryClient.fetchQuery({ queryKey: getGetPlanContentQueryKey(plan.id), queryFn: () => getPlanContent(plan.id), staleTime: 0 })
    contentVersion.current = fresh.contentUpdatedAt
    remember(fresh.needs)
    setServer(fresh)
    setSaveErrors(new Map())
    const next = documentOf(fresh)
    dispatch({ type: 'load', document: next })
    autosave.reset(next)
  }, [queryClient, plan.id, autosave, dispatch])

  // Regaining the lock after someone else had it: their changes first.
  const hadOther = useRef(false)
  useEffect(() => {
    if (lock.state.status === 'held') hadOther.current = true
    if (lock.state.status === 'mine' && hadOther.current) {
      hadOther.current = false
      void reload()
    }
  }, [lock.state.status, reload])

  /** Duplicate, paste and alt-drag: one step; symbols a new need cannot have are skipped, the needs limit refuses it all. */
  const copy: CopyItems = (source, dx, dy) => {
    const result = copyItems(doc, source, dx, dy, plan.image, (n) => usableForNewNeed(n, needCatalog.functionTypeById, needCatalog.loadTypeById))
    if (result.action) dispatch({ type: 'change', action: result.action, select: [...result.placements.map((p) => p.id), ...result.needs.map((n) => n.id)] })
    if (result.overLimit) setNotice(t('needs.limit', { max: maxNeeds }))
    else if (result.skipped > 0) setNotice(t('notice.copySkipped', { count: result.skipped }))
    return result
  }

  useShortcuts({
    onCopy: copy,
    state,
    dispatch,
    editable,
    image: plan.image,
    onEscape: () => {
      setArmed(null)
      if (tool === 'placeNeed') setTool('select')
    },
    selectable: () => visibleIds(state.history.present, layers, variantsById),
  })

  const { viewport, setViewport, setStage, fit, zoomBy } = useViewport(plan.image)

  /** Placed by a click (armed product) or a drop (product id). */
  const place = async (point: Point, productId?: string) => {
    const product = products.find((p) => p.productId === (productId ?? armed))
    if (!product) return
    const variant = product.defaultVariant
    const size = defaultPlacementSize(product.productId, knownPlacements(queryClient, plan, doc), variantsById, await imageAspect(product.imageUrl))
    const placement = newPlacement(variant, point, size, plan.image)
    dispatch({ type: 'change', action: { type: 'addPlacements', placements: [placement] }, select: [placement.id] })
    setArmed(null)
  }

  const selectedPlacements = doc.placements.filter((p) => state.selection.includes(p.id))
  const selectedZones = doc.zones.filter((z) => state.selection.includes(z.id))
  const selectedNeeds = doc.needs.filter((n) => isSymbol(n) && state.selection.includes(n.id))

  /** "Place need": a load symbol of the chosen function type where the plan was clicked; back to Select. */
  const placeNeed = (point: Point) => {
    if (!placeFunction) return
    if (doc.needs.length + 1 > maxNeeds) {
      setNotice(t('needs.limit', { max: maxNeeds }))
      return
    }
    setNeedFunction(placeFunction)
    const need = newNeed(placeFunction, null, point, plan.image)
    dispatch({ type: 'change', action: { type: 'addNeeds', needs: [need] }, select: [need.id] })
    setTool('select')
    setTab('inspector')
  }

  const [exporting, setExporting] = useState(false)
  const exportPng = () => {
    const stage = stageRef.current
    if (!stage) return
    const name = exportFileName(project.number, plan.name)
    // Drawn with strokes and labels sized for the image, whatever the zoom (D217).
    flushSync(() => setExporting(true))
    let png: Promise<Blob>
    try {
      png = stageToPng(stage, plan.image)
    } finally {
      setExporting(false)
    }
    void png.then((blob) => download(blob, name))
  }
  const errorIds = useMemo(() => new Set(saveErrors.keys()), [saveErrors])
  const needText = useNeedText(needCatalog)
  const itemNames = {
    need: needText,
    placement: (p: PlanDocument['placements'][number]) => {
      const v = p.variantId ? variantsById.get(p.variantId) : undefined
      return p.label || (v && localize(v.productName)) || undefined
    },
  }

  const zoneBadges = new Map(doc.zones.map((z) => [z.id, zoneBadge(planWiring?.zoneStatus.get(z.id))] as const))
  const canvas = (
    <PlanCanvas
      plan={plan}
      document={doc}
      selection={state.selection}
      variants={variantsById}
      marked={markedPlacements}
      errorIds={errorIds}
      editable={editable}
      tool={wide ? tool : 'pan'}
      onToolChange={setTool}
      viewport={viewport}
      onViewportChange={setViewport}
      onSize={setStage}
      dispatch={dispatch}
      placing={armed !== null}
      onPlace={(point, productId) => void place(point, productId)}
      layers={layers}
      symbolLooks={symbolLooks}
      needWarningIds={needWarningIds}
      onPlaceNeed={placeNeed}
      onCopy={copy}
      resizeAll={resizeAll}
      activeVertex={activeVertex}
      onActiveVertex={setActiveVertex}
      onCalibrate={(a, b) => setCalibration([a, b])}
      measured={calibration}
      stageRef={stageRef}
      exportPixel={exporting ? exportPixel(plan.image) : undefined}
      zoneBadges={zoneBadges}
    />
  )
  const canvasArea = (
    <div className="relative h-full w-full">
      {canvas}
      {doc.scale !== null && <ScaleBar scale={doc.scale} viewport={viewport} />}
      {/* The tools' overlays only while the plan can be edited. */}
      {wide && editable && toolHint(tool, t, placeFunction !== '') && (
        <p aria-live="polite" className="pointer-events-none absolute top-2 left-1/2 max-w-[90%] -translate-x-1/2 rounded-control border border-line bg-surface/90 px-2 py-1 text-xs">
          {toolHint(tool, t, placeFunction !== '')}
        </p>
      )}
      {wide && editable && tool === 'placeNeed' && (
        // The function type is chosen first, then the spot.
        <div className="absolute top-12 left-1/2 w-72 max-w-[90%] -translate-x-1/2 rounded-control border border-line bg-surface p-2 shadow-sm">
          {activeFunctions.length > 0 ? (
            <SelectField
              label={t('needs.placeFunction')}
              value={placeFunction}
              placeholder={t('needs.functionType')}
              options={activeFunctions.map((f) => ({ value: f.id, label: localize(f.name) }))}
              onValueChange={setNeedFunction}
            />
          ) : (
            <p className="text-sm text-muted">{t('needs.noFunctionTypes')}</p>
          )}
        </div>
      )}
    </div>
  )

  const back = (
    <Button asChild variant="ghost" size="sm">
      <Link to={versionPath(project.id, plan.versionId)}>
        <ArrowLeft /> <span className="max-w-48 truncate">{`${project.number} ${project.name}`}</span>
      </Link>
    </Button>
  )
  const zoomControls = (
    <>
      <IconButton label={t('toolbar.zoomOut')} icon={<ZoomOut />} onClick={() => zoomBy(1 / 1.25)} />
      <span className="w-12 text-center text-sm tabular-nums text-muted" aria-label={t('toolbar.zoomLevel')}>
        {Math.round(viewport.scale * 100)} %
      </span>
      <IconButton label={t('toolbar.zoomIn')} icon={<ZoomIn />} onClick={() => zoomBy(1.25)} />
      <IconButton label={t('toolbar.fit')} icon={<Maximize />} onClick={fit} />
    </>
  )

  const banners = (
    <>
      <ConfirmDialog
        open={askLeave}
        onOpenChange={(open) => {
          if (open) return
          setAskLeave(false)
          blocker.reset?.()
        }}
        title={tc('unsaved.title')}
        message={tc('unsaved.message')}
        confirmLabel={tc('action.leave')}
        cancelLabel={tc('action.stay')}
        pending={false}
        onConfirm={() => {
          setAskLeave(false)
          blocker.proceed?.()
        }}
      />
      {project.status !== 'active' && <Notice tone="warning">{t('editor.readOnlyProject')}</Notice>}
      <LockBanner lock={lock.state} canTakeOver={plan.can.breakLock} onTakeOver={() => void lock.takeOver()} onRetry={() => void lock.retry()} />
      {autosave.status === 'stale' && (
        <ErrorMessage
          error={autosave.error}
          action={
            <Button size="sm" variant="secondary" onClick={() => void reload()}>
              {t('save.reload')}
            </Button>
          }
        />
      )}
      {notice && (
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <Notice tone="warning">{notice}</Notice>
          </div>
          <IconButton label={tc('action.close')} icon={<X />} onClick={() => setNotice(null)} />
        </div>
      )}
      {autosave.status === 'failed' && saveErrors.size === 0 && <ErrorMessage error={autosave.error} />}
      {saveErrors.size > 0 && (
        <div role="alert" className="rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <p>{t('save.itemErrors', { count: saveErrors.size })}</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {[...saveErrors.keys()].map((id, i) => (
              <li key={id}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    dispatch({ type: 'select', ids: [selectionFor(id, doc)] })
                    setTab('inspector')
                  }}
                >
                  {itemName(id, doc, itemNames) ?? t('save.item', { n: i + 1 })}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )

  if (!wide) {
    return (
      <div ref={fillRef} style={{ height: fillHeight }} className="flex flex-col">
        <div className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1">
          {/* The plan name gets a row of its own: beside the back link and zoom it was cut to a letter (D222). */}
          <div className="min-w-0 flex-1">{back}</div>
          {zoomControls}
          <h1 className="w-full truncate px-2 pb-1 font-semibold">{plan.name}</h1>
        </div>
        <div className="space-y-2 px-2 empty:hidden">{project.status !== 'active' && <Notice tone="warning">{t('editor.readOnlyProject')}</Notice>}</div>
        <div className="h-[55%] shrink-0 border-b border-line">{canvasArea}</div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <p className="text-sm text-muted">{t('editor.phoneHint')}</p>
          <ProductList doc={doc} variants={variantsById} />
          <section aria-label={t('panel.zones')} className="space-y-2">
            <h2 className="font-semibold">{t('panel.zones')}</h2>
            <ZonesPanel
              zones={doc.zones}
              saved={server.placements}
              placements={doc.placements}
              needs={doc.needs}
              selection={state.selection}
              layers={layers}
              onLayers={changeLayers}
              onSelect={(id) => dispatch({ type: 'select', ids: [id] })}
            />
          </section>
        </div>
      </div>
    )
  }

  const tabs: TabItem<PanelTab>[] = [
    { key: 'products', label: t('panel.products'), content: <Palette products={products} armed={armed} onArm={setArmed} editable={editable} empty={<PaletteEmpty project={project} kind="floorplan" />} /> },
    {
      key: 'zones',
      label: t('panel.zones'),
      content: (
        <ZonesPanel
          zones={doc.zones}
          saved={server.placements}
          placements={doc.placements}
          needs={doc.needs}
          selection={state.selection}
          layers={layers}
          onLayers={changeLayers}
          onSelect={(id) => {
            dispatch({ type: 'select', ids: [id] })
            setTab('inspector')
          }}
        />
      ),
    },
    {
      key: 'layers',
      label: t('panel.layers'),
      content: <LayersPanel placements={doc.placements} products={products} variants={variantsById} layers={layers} onLayers={changeLayers} />,
    },
    {
      key: 'inspector',
      label: t('panel.inspector'),
      content: (
        <Inspector
          placements={selectedPlacements}
          zones={selectedZones}
          needs={selectedNeeds}
          allNeeds={doc.needs}
          allZones={doc.zones}
          needCatalog={needCatalog}
          needWarnings={needWarnings}
          allPlacements={doc.placements}
          image={plan.image}
          resizeAll={resizeAll}
          onResizeAll={setResizeAll}
          activeVertex={activeVertex}
          onActiveVertex={setActiveVertex}
          variants={variantsById}
          allVariants={variants}
          products={products}
          warnings={warnings}
          errors={saveErrors}
          editable={editable}
          dispatch={dispatch}
        />
      ),
    },
    {
      key: 'findings',
      label: findings.length > 0 ? t('panel.findingsCount', { count: findings.length }) : t('panel.findings'),
      content: (
        <FindingsList
          findings={findings}
          names={planWiring ? (f) => planWiring.wiring.findingNames(f, plan.id) : undefined}
          onShow={(f) => {
            const id = f.refs.needId && f.refs.planId === plan.id ? f.refs.needId : f.refs.targetPlanId === plan.id ? f.refs.itemId : undefined
            if (!id || !(doc.placements.some((p) => p.id === id) || doc.needs.some((n) => n.id === id))) return
            dispatch({ type: 'select', ids: [selectionFor(id, doc)] })
            setTab('inspector')
          }}
          collapseUnconnected={false}
        />
      ),
    },
  ]

  return (
    <div ref={fillRef} style={{ height: fillHeight }} className="flex flex-col">
      <div role="toolbar" aria-label={t('toolbar.label')} className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1">
        {back}
        <h1 className="min-w-0 truncate px-2 font-semibold">{plan.name}</h1>
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        <IconButton label={t('toolbar.select')} icon={<MousePointer2 />} aria-pressed={tool === 'select'} className={cn(tool === 'select' && 'bg-canvas text-primary')} onClick={() => setTool('select')} />
        <IconButton label={t('toolbar.pan')} icon={<Hand />} aria-pressed={tool === 'pan'} className={cn(tool === 'pan' && 'bg-canvas text-primary')} onClick={() => setTool('pan')} />
        <IconButton label={t('toolbar.zoneRect')} icon={<Square />} aria-pressed={tool === 'zoneRect'} disabled={!editable} className={cn(tool === 'zoneRect' && 'bg-canvas text-primary')} onClick={() => setTool('zoneRect')} />
        <IconButton label={t('toolbar.zonePolygon')} icon={<Hexagon />} aria-pressed={tool === 'zonePolygon'} disabled={!editable} className={cn(tool === 'zonePolygon' && 'bg-canvas text-primary')} onClick={() => setTool('zonePolygon')} />
        <IconButton
          label={t('toolbar.placeNeed')}
          icon={<CircleDot />}
          aria-pressed={tool === 'placeNeed'}
          disabled={!editable}
          className={cn(tool === 'placeNeed' && 'bg-canvas text-primary')}
          onClick={() => {
            setTool('placeNeed')
            setArmed(null)
          }}
        />
        <IconButton label={t('toolbar.calibrate')} icon={<Ruler />} aria-pressed={tool === 'calibrate'} disabled={!editable} className={cn(tool === 'calibrate' && 'bg-canvas text-primary')} onClick={() => setTool('calibrate')} />
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        {zoomControls}
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        <IconButton label={t('toolbar.undo')} icon={<Undo2 />} disabled={!editable || !canUndo(state.history)} onClick={() => dispatch({ type: 'undo' })} />
        <IconButton label={t('toolbar.redo')} icon={<Redo2 />} disabled={!editable || !canRedo(state.history)} onClick={() => dispatch({ type: 'redo' })} />
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        <IconButton label={t('toolbar.export')} icon={<Download />} onClick={exportPng} />
        <span className="flex-1" />
        {editable ? <SaveIndicator status={autosave.status} onRetry={() => void autosave.retry()} /> : <span className="text-sm text-muted">{t('editor.viewOnly')}</span>}
      </div>
      <div className="space-y-2 px-2 pt-2 empty:hidden">{banners}</div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">{lock.state.status === 'acquiring' ? <Loading /> : canvasArea}</div>
        <aside ref={setPanel} aria-label={t('panel.label')} className="relative flex w-[21rem] shrink-0 flex-col border-l border-line bg-surface lg:w-96">
          <Tabs label={t('panel.label')} size="sm" tabs={tabs} value={tab} onValueChange={setTab} className="h-full" />
        </aside>
      </div>
      <CalibrateDialog
        container={panel}
        points={calibration}
        onClose={() => setCalibration(null)}
        onScale={(scale) => dispatch({ type: 'change', action: { type: 'setScale', scale } })}
      />
    </div>
  )
}

/** What the active drawing tool expects (announced, and shown over the canvas); Place need first asks for its function type. */
function toolHint(tool: Tool, t: (key: 'tools.zoneRect' | 'tools.zonePolygon' | 'tools.calibrate' | 'tools.placeNeed' | 'tools.placeNeedChoose') => string, hasFunction: boolean) {
  if (tool === 'placeNeed') return t(hasFunction ? 'tools.placeNeed' : 'tools.placeNeedChoose')
  return tool === 'zoneRect' || tool === 'zonePolygon' || tool === 'calibrate' ? t(`tools.${tool}`) : undefined
}

/** A scale bar over the canvas when the plan is calibrated (not part of the export). */
function ScaleBar({ scale, viewport }: { scale: number; viewport: Viewport }) {
  const { t, i18n } = useTranslation('plans')
  const bar = scaleBar(scale, viewport.scale)
  if (!bar) return null
  const label = `${new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 3 }).format(bar.metres)} m`
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 rounded-control border border-line bg-surface/90 px-2 py-1 text-xs" aria-label={t('scale.bar', { label })}>
      <div className="h-1.5 border-x-2 border-b-2 border-ink" style={{ width: bar.px }} />
      <span className="tabular-nums">{label}</span>
    </div>
  )
}

/** The placements of this plan plus those of the version's other plans already in the cache (default sizes). */
function knownPlacements(queryClient: ReturnType<typeof useQueryClient>, plan: Plan, doc: PlanDocument) {
  const others = queryClient
    .getQueriesData<PlanContent>({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].endsWith('/content') })
    .flatMap(([, data]) => (data && data.planId !== plan.id ? data.placements : []))
  return [...others, ...doc.placements]
}

/** Phones: the placed products with their counts. */
function ProductList({ doc, variants }: { doc: PlanDocument; variants: Map<string, VariantSearchItem> }) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()
  const counts = new Map<string, { name: string; count: number }>()
  for (const p of doc.placements) {
    const v = p.variantId ? variants.get(p.variantId) : undefined
    const key = v?.productId ?? 'deleted'
    const name = v ? localize(v.productName) : t('inspector.deleted')
    counts.set(key, { name, count: (counts.get(key)?.count ?? 0) + 1 })
  }
  return (
    <section aria-label={t('panel.products')} className="space-y-2">
      <h2 className="font-semibold">{t('panel.products')}</h2>
      {counts.size === 0 ? (
        <p className="text-sm text-muted">{t('editor.noProducts')}</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {[...counts.entries()].map(([key, { name, count }]) => (
            <li key={key} className="flex justify-between py-1.5">
              <span>{name}</span>
              <span className="tabular-nums text-muted">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
