import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Hand, Maximize, MousePointer2, Redo2, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import { ApiError } from '@/api/client'
import type { Plan, PlanContent, PlanWarning, Project, VariantSearchItem } from '@/api/generated/model'
import { getGetPlanContentQueryKey, getListPlansQueryKey, getPlanContent, savePlanContent, useGetPlan, useGetPlanContent } from '@/api/generated/plans/plans'
import { useGetProject } from '@/api/generated/projects/projects'
import { type Point, useViewport } from '@/canvas'
import { Button, EmptyState, ErrorMessage, IconButton, Loading, Notice, Page, type TabItem, Tabs, TextLink, useErrorMessage } from '@/components/ui'
import { fresh, isNotFound, versionPath } from '@/features/projects/paths'
import { useLocalized } from '@/i18n/localized'
import { cn } from '@/lib/cn'

import { defaultPlacementSize, imageAspect, paletteProducts, useCatalogVariants } from './catalog'
import { documentOf, type PlanDocument, toContentInput } from './document'
import { editorReducer, initEditor } from './editor-state'
import { canRedo, canUndo } from './history'
import { Inspector } from './Inspector'
import { LockBanner } from './LockBanner'
import { Palette } from './Palette'
import { PlanCanvas, type Tool } from './PlanCanvas'
import { newPlacement } from './placements'
import { SaveIndicator } from './SaveIndicator'
import { saveErrorsByItem } from './save-errors'
import { useAutosave } from './use-autosave'
import { usePlanLock } from './use-plan-lock'
import { useShortcuts } from './use-shortcuts'

/** /projects/:id/versions/:versionId/plans/:planId: loads what the editor needs. */
export function PlanEditorPage() {
  const { t } = useTranslation('plans')
  const { id = '', versionId = '', planId = '' } = useParams()
  const plan = useGetPlan(planId, { query: fresh })
  const content = useGetPlanContent(planId, { query: fresh })
  const project = useGetProject(id, { query: fresh })
  const catalog = useCatalogVariants()

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
  if (!plan.data || !content.data || !project.data || !catalog.data) return <Loading />
  return <PlanEditor key={plan.data.id} plan={plan.data} content={content.data} project={project.data} variants={catalog.data} />
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

type PanelTab = 'products' | 'zones' | 'inspector'

type Props = { plan: Plan; content: PlanContent; project: Project; variants: VariantSearchItem[] }

function PlanEditor({ plan, content, project, variants }: Props) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const wide = useWide()
  const { ref: fillRef, height: fillHeight } = useFillHeight()

  // The lock is wanted where editing is possible at all; phones only view.
  const mayEdit = plan.can.update && project.status === 'active' && wide
  // Leaving saves what is pending, then releases the lock.
  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  const lock = usePlanLock(plan.id, mayEdit, () => flushRef.current())
  const editable = lock.state.status === 'mine'

  const [state, dispatch] = useReducer(editorReducer, documentOf(content), initEditor)
  const doc = state.history.present
  const [tool, setTool] = useState<Tool>('select')
  const [tab, setTab] = useState<PanelTab>('products')
  const [armed, setArmed] = useState<string | null>(null)

  // What the last load or save returned: the content version to send back, warnings and zone assignments.
  const [server, setServer] = useState(content)
  const contentVersion = useRef(content.contentUpdatedAt)
  const [saveErrors, setSaveErrors] = useState<Map<string, string[]>>(new Map())

  const variantsById = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants])
  const products = useMemo(() => paletteProducts(variants, project.productTypeIds), [variants, project.productTypeIds])
  const warnings = useMemo(() => {
    const map = new Map<string, PlanWarning[]>()
    for (const w of server.warnings) map.set(w.placementId, [...(map.get(w.placementId) ?? []), w])
    return map
  }, [server.warnings])

  const save = useCallback(
    async (snapshot: PlanDocument) => {
      try {
        const saved = await savePlanContent(plan.id, toContentInput(snapshot, contentVersion.current))
        contentVersion.current = saved.contentUpdatedAt
        setServer(saved)
        setSaveErrors(new Map())
        // The plan cards show counts: refreshed when the project page shows them again (also after a save on leave).
        void queryClient.invalidateQueries({ queryKey: getListPlansQueryKey(plan.versionId) })
      } catch (e) {
        const byItem = saveErrorsByItem(e, snapshot, (f) => errorMessage(new ApiError({ status: 422, code: f.code, params: f.params })))
        setSaveErrors(byItem)
        const first = byItem.keys().next().value
        if (first) {
          dispatch({ type: 'select', ids: [first] })
          setTab('inspector')
        }
        throw e
      }
    },
    [plan.id, plan.versionId, errorMessage, queryClient],
  )
  const autosave = useAutosave({ document: doc, save, enabled: editable })

  useEffect(() => {
    flushRef.current = autosave.flush
  })
  useEffect(() => {
    if (autosave.status === 'saved') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [autosave.status])

  /** Loads the stored content again (stale save, lock regained). */
  const reload = useCallback(async () => {
    const fresh = await queryClient.fetchQuery({ queryKey: getGetPlanContentQueryKey(plan.id), queryFn: () => getPlanContent(plan.id), staleTime: 0 })
    contentVersion.current = fresh.contentUpdatedAt
    setServer(fresh)
    setSaveErrors(new Map())
    const next = documentOf(fresh)
    dispatch({ type: 'load', document: next })
    autosave.reset(next)
  }, [queryClient, plan.id, autosave])

  // Regaining the lock after someone else had it: their changes first.
  const hadOther = useRef(false)
  useEffect(() => {
    if (lock.state.status === 'held') hadOther.current = true
    if (lock.state.status === 'mine' && hadOther.current) {
      hadOther.current = false
      void reload()
    }
  }, [lock.state.status, reload])

  useShortcuts({ state, dispatch, editable, onEscape: () => setArmed(null) })

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
  const errorIds = useMemo(() => new Set(saveErrors.keys()), [saveErrors])

  const canvas = (
    <PlanCanvas
      plan={plan}
      document={doc}
      selection={state.selection}
      variants={variantsById}
      warnings={warnings}
      errorIds={errorIds}
      editable={editable}
      tool={wide ? tool : 'pan'}
      viewport={viewport}
      onViewportChange={setViewport}
      onSize={setStage}
      dispatch={dispatch}
      placing={armed !== null}
      onPlace={(point, productId) => void place(point, productId)}
    />
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
                    dispatch({ type: 'select', ids: [id] })
                    setTab('inspector')
                  }}
                >
                  {itemName(id, doc, variantsById, localize) ?? t('save.item', { n: i + 1 })}
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
          {back}
          <h1 className="min-w-0 flex-1 truncate font-semibold">{plan.name}</h1>
          {zoomControls}
        </div>
        <div className="space-y-2 px-2 empty:hidden">{project.status !== 'active' && <Notice tone="warning">{t('editor.readOnlyProject')}</Notice>}</div>
        <div className="h-[55%] shrink-0 border-b border-line">{canvas}</div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <p className="text-sm text-muted">{t('editor.phoneHint')}</p>
          <ProductList doc={doc} variants={variantsById} />
        </div>
      </div>
    )
  }

  const tabs: TabItem<PanelTab>[] = [
    { key: 'products', label: t('panel.products'), content: <Palette products={products} armed={armed} onArm={setArmed} editable={editable} /> },
    // Part B: the zone list (show/hide, counts) and zone tools.
    { key: 'zones', label: t('panel.zones'), content: <p className="text-sm text-muted">{t('zones.empty')}</p> },
    {
      key: 'inspector',
      label: t('panel.inspector'),
      content: (
        <Inspector
          placements={selectedPlacements}
          variants={variantsById}
          allVariants={variants}
          warnings={warnings}
          errors={saveErrors}
          editable={editable}
          dispatch={dispatch}
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
        {/* Part B: zone rectangle / polygon tools, calibrate, export PNG. */}
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        {zoomControls}
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        <IconButton label={t('toolbar.undo')} icon={<Undo2 />} disabled={!editable || !canUndo(state.history)} onClick={() => dispatch({ type: 'undo' })} />
        <IconButton label={t('toolbar.redo')} icon={<Redo2 />} disabled={!editable || !canRedo(state.history)} onClick={() => dispatch({ type: 'redo' })} />
        <span className="flex-1" />
        {editable ? <SaveIndicator status={autosave.status} onRetry={() => void autosave.retry()} /> : <span className="text-sm text-muted">{t('editor.viewOnly')}</span>}
      </div>
      <div className="space-y-2 px-2 pt-2 empty:hidden">{banners}</div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">{lock.state.status === 'acquiring' ? <Loading /> : canvas}</div>
        <aside aria-label={t('panel.label')} className="flex w-80 shrink-0 flex-col border-l border-line bg-surface lg:w-96">
          <Tabs label={t('panel.label')} tabs={tabs} value={tab} onValueChange={setTab} className="h-full" />
        </aside>
      </div>
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

function itemName(id: string, doc: PlanDocument, variants: Map<string, VariantSearchItem>, localize: ReturnType<typeof useLocalized>) {
  const p = doc.placements.find((x) => x.id === id)
  if (p) {
    const v = p.variantId ? variants.get(p.variantId) : undefined
    return p.label || (v && localize(v.productName)) || undefined
  }
  return doc.zones.find((z) => z.id === id)?.name
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
