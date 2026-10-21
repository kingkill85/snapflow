import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { formatDecimal, useDecimalSeparator } from '@/catalog/decimal'

import type { Plan } from '@/api/generated/model'
import { getListPlansQueryKey, useDeletePlan, useListPlans, useReorderPlans } from '@/api/generated/plans/plans'
import { Badge, Button, ConfirmDialog, EmptyState, ErrorMessage, IconButton, Loading, RowAction, Section } from '@/components/ui'
import { cn } from '@/lib/cn'

import { BoardFormDialog } from './board/BoardFormDialog'
import { BoardThumbnail } from './board/BoardThumbnail'
import { boardPath, editorPath } from './paths'
import { PlanFormDialog } from './PlanFormDialog'

type Props = {
  projectId: string
  versionId: string
  /** The project may be changed (active, projects.write). */
  canWrite: boolean
  /** The project's product types: the enclosures offered for a new board. */
  productTypeIds?: string[]
}

/** The plans of a version on the project page: cards with thumbnail and counts, add, edit, reorder, delete (D204). */
export function PlansSection({ projectId, versionId, canWrite, productTypeIds = [] }: Props) {
  const { t } = useTranslation('plans')
  const { t: tCommon } = useTranslation()
  const queryClient = useQueryClient()
  const separator = useDecimalSeparator()
  const te = (n: number) => formatDecimal(n, separator)
  // Counts and locks change in the editor: fetched on every visit.
  const query = useListPlans(versionId, { query: { staleTime: 0, refetchOnMount: 'always' } })
  const reorder = useReorderPlans()
  const remove = useDeletePlan()
  // undefined: closed; null: a new plan; a plan: edit it.
  const [editing, setEditing] = useState<Plan | null | undefined>(undefined)
  const [deleting, setDeleting] = useState<Plan | null>(null)
  // The same for boards (their own dialog: no image, an enclosure or rows).
  const [editingBoard, setEditingBoard] = useState<Plan | null | undefined>(undefined)

  const key = getListPlansQueryKey(versionId)
  const refresh = () => queryClient.invalidateQueries({ queryKey: key })

  const move = async (plans: Plan[], index: number, by: -1 | 1) => {
    const ids = plans.map((p) => p.id)
    const [id] = ids.splice(index, 1)
    ids.splice(index + by, 0, id)
    // Show the new order at once; the server's answer follows.
    queryClient.setQueryData<Plan[]>(key, ids.map((i) => plans.find((p) => p.id === i)!))
    try {
      await reorder.mutateAsync({ versionId, data: { ids } })
    } finally {
      await refresh()
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ id: deleting.id })
    } catch {
      return // shown by ErrorMessage via remove.error
    }
    setDeleting(null)
    await refresh()
  }

  const plans = query.data ?? []
  // In the header once there are plans; before, in the empty state as the next step (D448).
  const addButtons = (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onClick={() => setEditingBoard(null)}>
        <Plus /> {t('addBoard')}
      </Button>
      <Button onClick={() => setEditing(null)}>
        <Plus /> {t('add')}
      </Button>
    </div>
  )
  return (
    <Section
      title={t('title')}
      actions={canWrite && (query.isError || plans.length > 0) ? addButtons : undefined}
    >
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorMessage error={query.error} />
      ) : plans.length === 0 ? (
        <EmptyState title={t('empty')} action={canWrite && addButtons} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label={t('title')}>
          {plans.map((plan, index) => (
            <li key={plan.id} className="flex flex-col overflow-hidden rounded-control border border-line bg-surface">
              <Link
                to={plan.kind === 'board' ? boardPath(projectId, versionId, plan.id) : editorPath(projectId, versionId, plan.id)}
                className="group block focus-visible:outline-2 focus-visible:outline-focus"
              >
                <span className="block aspect-[4/3] border-b border-line bg-canvas">
                  {plan.kind === 'board' ? plan.board && <BoardThumbnail sketch={plan.board.sketch} /> : plan.image && <img src={plan.image.url} alt="" loading="lazy" className="size-full object-contain" />}
                </span>
                <span className="flex items-center gap-2 px-3 pt-2 font-medium group-hover:underline">
                  {plan.name}
                  {plan.kind === 'board' && <Badge>{t('boardBadge')}</Badge>}
                </span>
              </Link>
              <p className={cn('px-3 text-sm', plan.board && plan.board.usedTe > plan.board.capacityTe ? 'text-warning' : 'text-muted')}>
                {plan.board
                  ? t('boardCounts', { modules: t('moduleCount', { count: plan.board.moduleCount }), used: te(plan.board.usedTe), capacity: te(plan.board.capacityTe) }) +
                    (plan.board.usedTe > plan.board.capacityTe ? ` · ${t('board.overflow')}` : '')
                  : t('counts', { products: plan.placementCount, zones: plan.zoneCount, needs: t('needUnits', { count: plan.needCount }) })}
              </p>
              {plan.lock && !plan.lock.mine && <p className="px-3 text-sm text-warning">{t('lockedBy', { name: plan.lock.name })}</p>}
              {canWrite && plan.can.update && (
                <div className="mt-auto flex flex-wrap items-center gap-1 p-3 pt-2">
                  <IconButton
                    label={t('moveLeft', { name: plan.name })}
                    icon={<ChevronLeft />}
                    disabled={index === 0 || reorder.isPending}
                    onClick={() => void move(plans, index, -1)}
                  />
                  <IconButton
                    label={t('moveRight', { name: plan.name })}
                    icon={<ChevronRight />}
                    disabled={index === plans.length - 1 || reorder.isPending}
                    onClick={() => void move(plans, index, 1)}
                  />
                  <span className="flex-1" />
                  <RowAction compact icon={<Pencil />} label={tCommon('action.edit')} aria-label={t('editItem', { name: plan.name })} onClick={() => (plan.kind === 'board' ? setEditingBoard(plan) : setEditing(plan))} />
                  <RowAction
                    compact
                    icon={<Trash2 />}
                    variant="danger-quiet"
                    label={tCommon('action.delete')}
                    aria-label={t('deleteItem', { name: plan.name })}
                    onClick={() => {
                      remove.reset()
                      setDeleting(plan)
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorMessage error={reorder.error} />

      <PlanFormDialog
        open={editing !== undefined}
        onOpenChange={(open) => !open && setEditing(undefined)}
        versionId={versionId}
        item={editing ?? null}
        onSaved={() => void refresh()}
      />
      <BoardFormDialog
        open={editingBoard !== undefined}
        onOpenChange={(open) => !open && setEditingBoard(undefined)}
        versionId={versionId}
        productTypeIds={productTypeIds}
        item={editingBoard ?? null}
        onSaved={() => void refresh()}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('deleteTitle')}
        message={t('deleteMessage', { name: deleting?.name ?? '' })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Section>
  )
}
