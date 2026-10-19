import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Redo2, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useBlocker, useParams } from 'react-router'

import { ApiError } from '@/api/client'
import type { BoardContent, BoardWarning, Capabilities, Plan, Project, VariantSearchItem } from '@/api/generated/model'
import { getBoardContent, getGetBoardContentQueryKey, getListPlansQueryKey, saveBoardContent, useGetBoardContent, useGetPlan } from '@/api/generated/plans/plans'
import { useGetProject } from '@/api/generated/projects/projects'
import { isModKey, isTypingTarget } from '@/canvas'
import { formatDecimal, useDecimalSeparator } from '@/catalog/decimal'
import { Button, ConfirmDialog, EmptyState, ErrorMessage, IconButton, Loading, Notice, Page, type TabItem, Tabs, TextLink, useErrorMessage } from '@/components/ui'
import { fresh, isNotFound, versionPath } from '@/features/projects/paths'
import { useLocalized } from '@/i18n/localized'
import { cn } from '@/lib/cn'

import { saveOnUnload } from '../api'
import { useCatalogVariants } from '../editor/catalog'
import { canRedo, canUndo } from '../editor/history'
import { LockBanner } from '../editor/LockBanner'
import { Palette } from '../editor/Palette'
import { SaveIndicator } from '../editor/SaveIndicator'
import { shortcutOf } from '../editor/use-shortcuts'
import { useAutosave } from '../editor/use-autosave'
import { usePlanLock } from '../editor/use-plan-lock'
import {
  type BoardDocument,
  type BoardModuleDoc,
  boardCapacity,
  boardDocumentOf,
  boardPaletteProducts,
  boardUsed,
  copyModules,
  enclosureVariants,
  fittedBySave,
  moduleWidth,
  newModule,
  slotIn,
  toBoardInput,
} from './board'
import { type BoardEditorAction, boardReducer, initBoard } from './board-state'
import { boardErrorsByModule } from './board-errors'
import { BoardGrid } from './BoardGrid'
import { BoardSettings, ModuleInspector } from './BoardPanels'

/** /projects/:id/versions/:versionId/boards/:planId: loads what the board editor needs. */
export function BoardEditorPage() {
  const { t } = useTranslation('plans')
  const { id = '', versionId = '', planId = '' } = useParams()
  const plan = useGetPlan(planId, { query: fresh })
  const project = useGetProject(id, { query: fresh })
  const isBoard = plan.data?.kind === 'board'
  const content = useGetBoardContent(planId, { query: { ...fresh, enabled: isBoard } })
  const catalog = useCatalogVariants({ withCapabilities: true })

  const notFound = (
    <Page title={t('board.title')}>
      <EmptyState title={t('editor.notFound')} action={<TextLink to={versionPath(id, versionId)}>{t('editor.back')}</TextLink>} />
    </Page>
  )
  const failed = [plan, content, project, catalog].find((q) => q.isError)
  if (failed) return isNotFound(failed.error) ? notFound : <Page title={t('board.title')}>{<ErrorMessage error={failed.error} />}</Page>
  if (plan.data && !isBoard) return notFound
  // Never start from cached data (D44).
  if (!plan.isFetchedAfterMount || !content.isFetchedAfterMount || !project.isFetchedAfterMount) return <Loading />
  if (!plan.data || !content.data || !project.data || !catalog.data) return <Loading />
  return <BoardEditor key={plan.data.id} plan={plan.data} content={content.data} project={project.data} variants={catalog.data} />
}

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

function useFillHeight() {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number>()
  useLayoutEffect(() => {
    const update = () => setHeight(Math.max(320, window.innerHeight - (ref.current?.getBoundingClientRect().top ?? 0)))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return { ref, height }
}

type PanelTab = 'products' | 'board' | 'inspector'
type Props = { plan: Plan; content: BoardContent; project: Project; variants: VariantSearchItem[] }

function BoardEditor({ plan, content, project, variants }: Props) {
  const { t } = useTranslation('plans')
  const { t: tc } = useTranslation()
  const localize = useLocalized()
  const separator = useDecimalSeparator()
  const errorMessage = useErrorMessage()
  const queryClient = useQueryClient()
  const wide = useWide()
  const { ref: fillRef, height: fillHeight } = useFillHeight()

  const mayEdit = plan.can.update && project.status === 'active' && wide
  const flushRef = useRef<() => Promise<void>>(async () => undefined)
  const pageHideRef = useRef<() => boolean>(() => false)
  const lock = usePlanLock(plan.id, mayEdit, { beforeRelease: () => flushRef.current(), onPageHide: () => pageHideRef.current() })
  const editable = lock.state.status === 'mine'

  const [state, dispatchEditor] = useReducer(boardReducer, boardDocumentOf(content), initBoard)
  const doc = state.history.present
  const [notice, setNotice] = useState<string | null>(null)
  const dispatch = useCallback((action: BoardEditorAction) => {
    if (action.type === 'change' || action.type === 'undo' || action.type === 'redo') setNotice(null)
    dispatchEditor(action)
  }, [])
  const [tab, setTab] = useState<PanelTab>('products')
  const [armed, setArmed] = useState<string | null>(null)

  const [server, setServer] = useState(content)
  const contentVersion = useRef(content.contentUpdatedAt)
  const [saveErrors, setSaveErrors] = useState<Map<string, string[]>>(new Map())

  const variantsById = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants])
  // Capabilities: the catalog's (current) or, for a variant no longer listed, the last response's.
  const caps = useCallback((variantId: string): Capabilities | undefined => variantsById.get(variantId)?.capabilities ?? server.capabilities[variantId], [variantsById, server.capabilities])
  const widthOf = useCallback((m: BoardModuleDoc) => moduleWidth(m.variantId, caps), [caps])
  const products = useMemo(() => boardPaletteProducts(variants, project.productTypeIds), [variants, project.productTypeIds])
  const enclosures = useMemo(() => enclosureVariants(variants, project.productTypeIds), [variants, project.productTypeIds])

  const warnings = useMemo(() => {
    const map = new Map<string, BoardWarning[]>()
    for (const w of server.warnings) if (w.moduleId) map.set(w.moduleId, [...(map.get(w.moduleId) ?? []), w])
    return map
  }, [server.warnings])

  const save = useCallback(
    async (snapshot: BoardDocument) => {
      try {
        const saved = await saveBoardContent(plan.id, toBoardInput(snapshot, contentVersion.current))
        contentVersion.current = saved.contentUpdatedAt
        setServer(saved)
        setSaveErrors(new Map())
        // The server fitted rows or modules to the enclosure (D357): show what it stored.
        const fitted = fittedBySave(snapshot, saved)
        if (fitted) dispatch({ type: 'adopt', from: snapshot, document: fitted })
        void queryClient.invalidateQueries({ queryKey: getListPlansQueryKey(plan.versionId) })
      } catch (e) {
        const byItem = boardErrorsByModule(e, snapshot, (f) => errorMessage(new ApiError({ status: 422, code: f.code, params: f.params })))
        setSaveErrors(byItem)
        const first = byItem.keys().next().value
        if (first) {
          dispatch({ type: 'select', ids: [first] })
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
    pageHideRef.current = () => {
      const pending = editable ? autosave.pending() : undefined
      return pending !== undefined && saveOnUnload(plan.id, toBoardInput(pending, contentVersion.current), 'board')
    }
  })
  useEffect(() => {
    if (autosave.status === 'saved') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [autosave.status])

  // Leaving in the app: save first; ask only when that fails (D215).
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

  const reload = useCallback(async () => {
    const next = await queryClient.fetchQuery({ queryKey: getGetBoardContentQueryKey(plan.id), queryFn: () => getBoardContent(plan.id), staleTime: 0 })
    contentVersion.current = next.contentUpdatedAt
    setServer(next)
    setSaveErrors(new Map())
    const document = boardDocumentOf(next)
    dispatch({ type: 'load', document })
    autosave.reset(document)
  }, [queryClient, plan.id, autosave, dispatch])

  const hadOther = useRef(false)
  useEffect(() => {
    if (lock.state.status === 'held') hadOther.current = true
    if (lock.state.status === 'mine' && hadOther.current) {
      hadOther.current = false
      void reload()
    }
  }, [lock.state.status, reload])

  const productWidth = useCallback((productId: string) => {
    const product = products.find((p) => p.productId === productId)
    return product ? moduleWidth(product.defaultVariant.id, caps) : 1
  }, [products, caps])

  /** A palette product dropped or placed on a row: the nearest free gap, refused with a notice when the row is full. */
  const place = (productId: string, rowId: string, desired: number) => {
    const product = products.find((p) => p.productId === productId)
    if (!product) return
    const offset = slotIn(doc, rowId, productWidth(productId), desired, widthOf)
    if (offset === null) {
      setNotice(t('board.noRoom'))
      return
    }
    const module = newModule(product.defaultVariant.id, rowId, offset)
    dispatch({ type: 'change', action: { type: 'addModules', modules: [module] }, select: [module.id] })
    setArmed(null)
  }

  const copy = (sources: BoardModuleDoc[]) => {
    const { modules, refused } = copyModules(doc, sources, widthOf)
    if (modules.length > 0) dispatch({ type: 'change', action: { type: 'addModules', modules }, select: modules.map((m) => m.id) })
    if (refused > 0) setNotice(t('board.copyRefused', { count: refused }))
    return modules
  }

  // Shortcuts beside the grid's own keys (arrows, Delete on a focused module): undo/redo, duplicate, copy/paste, select all, Esc.
  const clipboard = useRef<BoardModuleDoc[]>([])
  const latest = useRef({ state, editable, copy })
  useEffect(() => {
    latest.current = { state, editable, copy }
  })
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return
      const command = shortcutOf(e)
      if (!command || command === 'nudge' || command === 'delete') return
      const { state, editable, copy } = latest.current
      const selected = state.history.present.modules.filter((m) => state.selection.includes(m.id))
      switch (command) {
        case 'escape':
          setArmed(null)
          dispatch({ type: 'select', ids: [] })
          return
        case 'selectAll':
          e.preventDefault()
          dispatch({ type: 'select', ids: state.history.present.modules.map((m) => m.id) })
          return
        case 'copy':
          if (selected.length > 0) clipboard.current = selected
          return
      }
      if (!editable || !isModKey(e)) return
      e.preventDefault()
      if (command === 'undo' || command === 'redo') dispatch({ type: command })
      else if (command === 'duplicate' && selected.length > 0) copy(selected)
      else if (command === 'paste' && clipboard.current.length > 0) clipboard.current = copy(clipboard.current)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dispatch])

  const selected = doc.modules.filter((m) => state.selection.includes(m.id))
  const errorIds = useMemo(() => new Set(saveErrors.keys()), [saveErrors])
  const te = (n: number) => formatDecimal(n, separator)
  const used = boardUsed(doc, widthOf)
  const capacity = boardCapacity(doc)
  const totals = t('board.totals', { count: doc.modules.length, used: te(used), capacity: te(capacity) })
  const overfull = used > capacity

  const back = (
    <Button asChild variant="ghost" size="sm">
      <Link to={versionPath(project.id, plan.versionId)}>
        <ArrowLeft /> <span className="max-w-48 truncate">{`${project.number} ${project.name}`}</span>
      </Link>
    </Button>
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
            {[...saveErrors.keys()].map((id, i) => {
              const m = doc.modules.find((x) => x.id === id)
              const v = m?.variantId ? variantsById.get(m.variantId) : undefined
              return (
                <li key={id}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      dispatch({ type: 'select', ids: [id] })
                      setTab('inspector')
                    }}
                  >
                    {m?.label || (v && localize(v.productName)) || t('save.item', { n: i + 1 })}
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </>
  )

  const grid = (
    <BoardGrid
      doc={doc}
      selection={state.selection}
      variants={variantsById}
      widthOf={widthOf}
      warnings={warnings}
      errorIds={errorIds}
      editable={editable}
      dispatch={(action) => {
        dispatch(action)
        if (action.type === 'select' && action.ids.length > 0) setTab('inspector')
      }}
      onPlace={place}
      armed={armed}
      productWidth={productWidth}
    />
  )

  if (!wide) {
    return (
      <div ref={fillRef} style={{ height: fillHeight }} className="flex flex-col">
        <div className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1">
          <div className="min-w-0 flex-1">{back}</div>
          <h1 className="w-full truncate px-2 pb-1 font-semibold">{plan.name}</h1>
          <p className={cn('w-full px-2 pb-1 text-sm tabular-nums', overfull ? 'font-medium text-warning' : 'text-muted')}>
            {totals}
            {overfull && ` · ${t('board.overflow')}`}
          </p>
        </div>
        <div className="space-y-2 px-2 empty:hidden">{project.status !== 'active' && <Notice tone="warning">{t('editor.readOnlyProject')}</Notice>}</div>
        <p className="px-4 pt-2 text-sm text-muted">{t('board.phoneHint')}</p>
        <div className="min-h-0 flex-1">{grid}</div>
      </div>
    )
  }

  const tabs: TabItem<PanelTab>[] = [
    {
      key: 'products',
      label: t('panel.products'),
      content: <Palette products={products} armed={armed} onArm={setArmed} editable={editable} hints={{ hint: t('board.paletteHint'), armedHint: t('board.armedHint') }} />,
    },
    {
      key: 'board',
      label: t('board.tab'),
      content: <BoardSettings doc={doc} enclosures={enclosures} variants={variantsById} caps={caps} widthOf={widthOf} editable={editable} dispatch={dispatch} warnings={server.warnings} enclosureDeleted={server.enclosureDeleted} />,
    },
    {
      key: 'inspector',
      label: t('panel.inspector'),
      content: (
        <ModuleInspector
          doc={doc}
          modules={selected}
          variants={variantsById}
          allVariants={variants}
          products={products}
          caps={caps}
          widthOf={widthOf}
          warnings={warnings}
          errors={saveErrors}
          editable={editable}
          dispatch={dispatch}
          onNotice={setNotice}
        />
      ),
    },
  ]

  return (
    <div ref={fillRef} style={{ height: fillHeight }} className="flex flex-col">
      <div role="toolbar" aria-label={t('board.toolbar')} className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1">
        {back}
        <h1 className="min-w-0 truncate px-2 font-semibold">{plan.name}</h1>
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        <IconButton label={t('toolbar.undo')} icon={<Undo2 />} disabled={!editable || !canUndo(state.history)} onClick={() => dispatch({ type: 'undo' })} />
        <IconButton label={t('toolbar.redo')} icon={<Redo2 />} disabled={!editable || !canRedo(state.history)} onClick={() => dispatch({ type: 'redo' })} />
        <span className="mx-1 h-6 w-px bg-line" aria-hidden="true" />
        <span data-testid="board-totals" className={overfull ? 'text-sm font-medium text-warning tabular-nums' : 'text-sm text-muted tabular-nums'}>
          {totals}
          {overfull && ` · ${t('board.overflow')}`}
        </span>
        <span className="flex-1" />
        {editable ? <SaveIndicator status={autosave.status} onRetry={() => void autosave.retry()} /> : <span className="text-sm text-muted">{t('editor.viewOnly')}</span>}
      </div>
      <div className="space-y-2 px-2 pt-2 empty:hidden">{banners}</div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">{lock.state.status === 'acquiring' ? <Loading /> : grid}</div>
        <aside aria-label={t('panel.label')} className="relative flex w-[21rem] shrink-0 flex-col border-l border-line bg-surface lg:w-96">
          <Tabs label={t('panel.label')} tabs={tabs} value={tab} onValueChange={setTab} className="h-full" />
        </aside>
      </div>
    </div>
  )
}
