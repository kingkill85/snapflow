import { keepPreviousData, useQueryClient } from '@tanstack/react-query'
import { Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'

import { ApiError } from '@/api/client'
import { getListCategoriesQueryKey, useListCategories } from '@/api/generated/categories/categories'
import { getGetImportQueryKey, useListImportChanges, useListImportTargets, useUndoImport } from '@/api/generated/imports/imports'
import type { ImportRun } from '@/api/generated/model'
import { useListProductTypes } from '@/api/generated/product-types/product-types'
import { invalidateProductQueries } from '@/catalog/invalidate'
import { Badge, Button, ConfirmDialog, EmptyState, ErrorMessage, Loading, Notice, Pagination, Section, SectionActions, TextLink } from '@/components/ui'

import { Counters } from './Counters'
import { changedFields, isObject } from './diff'
import { attributeLabels, useFieldLabel } from './labels'
import { DiffList } from './values'
import { categoryHref, invalidateRunDetails, newPath, pageSize, productHref, useFormatDateTime, variantHref } from './paths'

type Conflict = { entity: string; id: string; label: string; productId?: string }

const hrefOf = (entity: string, id: string, productId?: string) => {
  if (entity === 'category') return categoryHref(id)
  if (entity === 'product') return productHref(id)
  return productId ? variantHref(productId, id) : undefined
}

/** Step 4: what the apply wrote, the change log, and Undo. */
export function ResultStep({ run }: { run: ImportRun }) {
  const { t } = useTranslation('imports')
  const { t: tCommon } = useTranslation()
  const formatDate = useFormatDateTime()
  const queryClient = useQueryClient()
  const undo = useUndoImport()
  const [confirm, setConfirm] = useState(false)

  const submitUndo = async () => {
    try {
      const result = await undo.mutateAsync({ id: run.id })
      queryClient.setQueryData(getGetImportQueryKey(run.id), result)
      setConfirm(false)
      await Promise.all([
        invalidateRunDetails(queryClient, run.id),
        invalidateProductQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() }),
      ])
    } catch {
      // shown in the dialog
    }
  }
  const conflicts =
    undo.error instanceof ApiError && undo.error.code === 'import.undo_conflict' && Array.isArray(undo.error.params.entities)
      ? (undo.error.params.entities as Conflict[])
      : []
  const more = undo.error instanceof ApiError ? Number(undo.error.params.count ?? 0) - conflicts.length : 0

  return (
    <div className="space-y-6">
      {run.state === 'applied' ? (
        <Notice>{t('result.applied', { date: formatDate(run.appliedAt) })}</Notice>
      ) : (
        <Notice tone="warning">{t('result.undone', { date: formatDate(run.undoneAt) })}</Notice>
      )}
      <Section title={t('result.title')} description={run.state === 'undone' ? t('result.undoneDescription') : t('result.description')}>
        <Counters counts={run.applied ?? run.counts!} applied />
        {/* Not a form: the actions close the result (the page header leads back to the list). */}
        <SectionActions>
          <Button asChild variant="secondary">
            <Link to={newPath}>{t('result.another')}</Link>
          </Button>
          {run.can.undo && (
            <Button
              variant="danger-quiet"
              onClick={() => {
                undo.reset()
                setConfirm(true)
              }}
            >
              <Undo2 /> {t('result.undo')}
            </Button>
          )}
        </SectionActions>
      </Section>
      <ChangeLog run={run} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('result.undoTitle')}
        message={t('result.undoMessage')}
        confirmLabel={tCommon('action.undo')}
        pending={undo.isPending}
        onConfirm={() => void submitUndo()}
        error={
          undo.error ? (
            <div className="space-y-2">
              <ErrorMessage error={undo.error} />
              {conflicts.length > 0 && (
                <ul aria-label={t('result.conflicts')} className="max-h-48 space-y-1 overflow-y-auto text-sm">
                  {conflicts.map((c) => {
                    const href = hrefOf(c.entity === 'addons' ? 'variant' : c.entity, c.id, c.productId)
                    return (
                      <li key={`${c.entity}-${c.id}`} className="flex flex-wrap items-center gap-2">
                        <Badge>{t(`changeEntity.${c.entity as 'product'}`)}</Badge>
                        {href ? (
                          <TextLink to={href} target="_blank">
                            {c.label}
                          </TextLink>
                        ) : (
                          c.label
                        )}
                      </li>
                    )
                  })}
                  {more > 0 && <li className="text-muted">{t('result.moreConflicts', { count: more })}</li>}
                </ul>
              )}
            </div>
          ) : undefined
        }
      />
    </div>
  )
}

function ChangeLog({ run }: { run: ImportRun }) {
  const { t } = useTranslation('imports')
  const [params, setParams] = useSearchParams()
  const offset = Math.max(0, Math.floor(Number(params.get('offset'))) || 0)
  const changes = useListImportChanges(run.id, { limit: pageSize, offset }, { query: { placeholderData: keepPreviousData } })
  const targets = useListImportTargets(undefined, { query: { staleTime: 60_000 } })
  const types = useListProductTypes({ includeInactive: true })
  const categories = useListCategories({ includeInactive: true })
  const fieldLabel = useFieldLabel(attributeLabels(targets.data))

  /** Ids in the stored state, shown as the product type's badge or the category's name. */
  const display = (field: string, value: unknown): { field: string; value: unknown } => {
    if (field === 'productTypeId') return { field: 'productType', value: types.data?.items.find((x) => x.id === value) ?? value }
    if (field === 'categoryId') return { field: 'category', value: categories.data?.items.find((x) => x.id === value) ?? value }
    if (field === 'imageFileId') return { field: 'image', value }
    return { field, value }
  }

  return (
    <Section title={t('changes.title')} description={t('changes.description', { count: changes.data?.total ?? 0 })}>
      {changes.isPending ? (
        <Loading />
      ) : changes.isError ? (
        <ErrorMessage error={changes.error} />
      ) : changes.data.items.length === 0 ? (
        <EmptyState title={t('changes.empty')} />
      ) : (
        <>
          <ul className="space-y-3">
            {changes.data.items.map((c) => {
              const productId = isObject(c.after) && typeof c.after.productId === 'string' ? c.after.productId : undefined
              // Undone, the entities the run created are gone.
              const href = run.state === 'undone' && c.action === 'create' ? undefined : hrefOf(c.entity === 'addons' ? 'variant' : c.entity, c.entityId, productId)
              const fields = changedFields(c)
              const showBefore = c.action !== 'create'
              return (
                <li key={c.seq} className="space-y-2 rounded-control border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={c.action === 'create' ? 'success' : c.action === 'deactivate' ? 'warning' : 'primary'}>{t(`action.${c.action}`)}</Badge>
                    <Badge>{t(`changeEntity.${c.entity}`)}</Badge>
                    <span className="min-w-0 font-medium break-all">{href ? <TextLink to={href}>{c.label}</TextLink> : c.label}</span>
                  </div>
                  {fields.length > 0 && (
                    <DiffList
                      showBefore={showBefore}
                      rows={fields.map((f) => {
                        const after = display(f.field, f.after)
                        return { key: f.field, label: fieldLabel(after.field), before: display(f.field, f.before), after }
                      })}
                    />
                  )}
                </li>
              )
            })}
          </ul>
          <Pagination
            offset={offset}
            limit={pageSize}
            total={changes.data.total}
            onChange={(o) => setParams(o > 0 ? { offset: String(o) } : {}, { replace: true })}
          />
        </>
      )}
    </Section>
  )
}
