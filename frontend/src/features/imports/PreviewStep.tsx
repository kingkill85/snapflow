import { keepPreviousData, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, RotateCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'

import { ApiError } from '@/api/client'
import { getListCategoriesQueryKey } from '@/api/generated/categories/categories'
import { getGetImportQueryKey, useApplyImport, useListImportItems, useListImportTargets, usePreviewImport } from '@/api/generated/imports/imports'
import type { ImportItem, ImportRun, ListImportItemsEntity, ListImportItemsParams, ListImportItemsStatus } from '@/api/generated/model'
import { invalidateProductQueries } from '@/catalog/invalidate'
import { cn } from '@/lib/cn'
import {
  Badge,
  Button,
  CheckboxField,
  EmptyState,
  ErrorMessage,
  Field,
  FormActions,
  Loading,
  Notice,
  Pagination,
  Section,
  SelectField,
  SwitchField,
  TextLink,
  TypeBadge,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { Counters } from './Counters'
import { compactRows } from './diff'
import { changesSection, issuesSection, itemAnchor, offsetOf, useClampOffset, useFilters, useScrollToHash } from './filters'
import { IssuesSection } from './IssuesSection'
import { attributeLabels, useFieldLabel } from './labels'
import { categoryHref, invalidateRunDetails, listPath, pageSize, productHref, useFormatDateTime, variantHref } from './paths'
import { useRunReload } from './run-reload'
import { DiffList, ItemStatusBadge } from './values'

const entities = ['category', 'product', 'variant'] as const
const statuses = ['new', 'changed', 'unchanged', 'deactivate'] as const
/** The change filter's value showing every item (the default leaves out the unchanged ones). */
const allStatuses = 'all'

/** How long typing pauses before the search runs. */
const searchDelayMs = 300
/** The API's limit of the search text. */
const searchMaxLength = 200

type Props = {
  run: ImportRun
  /** Back to the mapping, with "All or nothing" as chosen here. */
  onEditMapping: (allOrNothing: boolean) => void
  /** The apply ran (applied or failed). */
  onApplied: () => void
}

/** Step 3: what the import will do, the rows' problems, and Apply. */
export function PreviewStep({ run, onEditMapping, onApplied }: Props) {
  const { t } = useTranslation('imports')
  const queryClient = useQueryClient()
  const formatDate = useFormatDateTime()
  const { href } = useFilters()
  const runReload = useRunReload(run.id)
  const counts = run.counts!

  const [allOrNothing, setAllOrNothing] = useState(run.allOrNothing)
  const apply = useApplyImport()
  const preview = usePreviewImport()

  const submit = async () => {
    try {
      const result = await apply.mutateAsync({ id: run.id, data: { allOrNothing } })
      queryClient.setQueryData(getGetImportQueryKey(run.id), result)
      await Promise.all([
        invalidateRunDetails(queryClient, run.id),
        invalidateProductQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() }),
      ])
      onApplied()
    } catch (e) {
      runReload.check(e)
    }
  }

  /** After import.stale: the same mapping against the catalog as it is now. */
  const previewAgain = async () => {
    apply.reset()
    try {
      const data = run.mapping ? { mapping: run.mapping } : { profileId: run.profileId }
      const result = await preview.mutateAsync({ id: run.id, data })
      queryClient.setQueryData(getGetImportQueryKey(run.id), result)
      await invalidateRunDetails(queryClient, run.id)
    } catch (e) {
      runReload.check(e)
    }
  }

  const stale = apply.error instanceof ApiError && apply.error.code === 'import.stale'
  const blocked = allOrNothing && counts.errors > 0

  /** A counter's link: the diff filtered by it ("skipped": the items of rows with errors). */
  const itemsHref = (entity: string, status: string) =>
    href(
      status === 'skipped'
        ? { entity, status: allStatuses, skipped: '1', row: '', q: '' }
        : { entity, status, skipped: '', row: '', q: '' },
      { section: changesSection },
    )
  const issuesHref = (severity: string) => href({ severity }, { reset: 'issues', section: issuesSection })

  return (
    <div className="space-y-6">
      <Section
        title={t('preview.title')}
        description={t('preview.description', { rows: counts.rows, date: formatDate(run.previewedAt) })}
        actions={
          run.can.preview && (
            <Button size="sm" variant="secondary" onClick={() => onEditMapping(allOrNothing)}>
              <Pencil /> {t('preview.editMapping')}
            </Button>
          )
        }
      >
        <Counters counts={counts} filterHref={itemsHref} issuesHref={issuesHref} />
      </Section>

      <IssuesSection run={run} counts={counts} linkItems />

      <Section title={t('preview.applyTitle')} description={t('preview.applyDescription')}>
        <SwitchField
          className="border-t-0 pt-0"
          label={t('allOrNothing')}
          hint={t('allOrNothingHint')}
          checked={allOrNothing}
          onChange={(e) => {
            apply.reset()
            setAllOrNothing(e.target.checked)
          }}
        />
        {blocked && <Notice tone="warning">{t('preview.blocked', { count: counts.rowsSkipped })}</Notice>}
        {!allOrNothing && counts.rowsSkipped > 0 && <Notice tone="warning">{t('preview.skipping', { count: counts.rowsSkipped })}</Notice>}
      </Section>

      <ItemsSection run={run} />

      <FormActions
        error={
          apply.error || preview.error ? (
            <>
              <ErrorMessage
                error={apply.error}
                action={
                  stale ? (
                    <Button size="sm" variant="secondary" onClick={() => void previewAgain()} disabled={preview.isPending}>
                      <RotateCw /> {t('preview.again')}
                    </Button>
                  ) : (
                    runReload.action(apply.error)
                  )
                }
              />
              <ErrorMessage error={preview.error} action={runReload.action(preview.error)} />
            </>
          ) : blocked ? (
            // Why Apply is disabled, next to it.
            <p id="apply-blocked" className="text-sm text-muted">
              {t('preview.blockedShort')}
            </p>
          ) : undefined
        }
      >
        <Button asChild variant="secondary">
          <Link to={listPath}>{t('backToList')}</Link>
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={apply.isPending || !run.can.apply || blocked}
          aria-describedby={blocked ? 'apply-blocked' : undefined}
        >
          <Check /> {apply.isPending ? t('preview.applying') : t('preview.apply')}
        </Button>
      </FormActions>
    </div>
  )
}

/**
 * The diff, paged, filtered in the URL: kind ("entity"), change ("status";
 * none = everything but unchanged items, "all"), rows with errors
 * ("skipped"), a search ("q") and one file row ("row", from an issue).
 */
function ItemsSection({ run }: { run: ImportRun }) {
  const { t } = useTranslation('imports')
  const location = useLocation()
  const { params, setFilters } = useFilters()
  const entity = (entities as readonly string[]).includes(params.get('entity') ?? '') ? (params.get('entity') as ListImportItemsEntity) : undefined
  const rawStatus = params.get('status') ?? ''
  const status = (statuses as readonly string[]).includes(rawStatus) ? (rawStatus as ListImportItemsStatus) : undefined
  const everything = rawStatus === allStatuses
  const skipped = params.get('skipped') === '1'
  const search = params.get('q') ?? ''
  const row = Math.floor(Number(params.get('row'))) || 0
  const offset = offsetOf(params, 'offset')

  // The search runs once typing pauses; the box follows the URL when it changes from outside (a link).
  const [draft, setDraft] = useState(search)
  const [searched, setSearched] = useState(search)
  if (searched !== search) {
    setSearched(search)
    if (draft.trim() !== search) setDraft(search)
  }
  useEffect(() => {
    if (draft.trim() === search) return
    const timer = setTimeout(() => setFilters({ q: draft.trim() }), searchDelayMs)
    return () => clearTimeout(timer)
    // setFilters changes with every render; the texts decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, search])

  const query: ListImportItemsParams = {
    ...(entity ? { entity } : {}),
    ...(status ? { status } : !everything ? { changedOnly: true } : {}),
    ...(skipped ? { skipped: true } : {}),
    ...(search ? { search } : {}),
    ...(row > 0 ? { row } : {}),
    limit: pageSize,
    offset,
  }
  const items = useListImportItems(run.id, query, { query: { placeholderData: keepPreviousData } })
  useClampOffset(items.data?.total, offset, 'offset', setFilters)
  useScrollToHash((id) => id === changesSection || id.startsWith('item-'), !items.isPending && !items.isPlaceholderData)
  const targets = useListImportTargets(undefined, { query: { staleTime: 60_000 } })
  const labels = attributeLabels(targets.data)
  const highlighted = location.hash.slice(1)

  return (
    <section
      id={changesSection}
      aria-labelledby="changes-title"
      className="scroll-mt-4 space-y-4 rounded-control border border-line bg-surface p-4 sm:p-6"
    >
      <div className="space-y-1">
        <h2 id="changes-title" className="text-base font-semibold">
          {t('items.title')}
        </h2>
        <p className="text-sm text-muted">{t('items.description')}</p>
      </div>
      <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          type="search"
          label={t('items.search')}
          placeholder={t('items.searchHint')}
          maxLength={searchMaxLength}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <SelectField
          label={t('items.entity')}
          value={entity ?? ''}
          onValueChange={(v) => setFilters({ entity: v })}
          options={[{ value: '', label: t('items.allEntities') }, ...entities.map((e) => ({ value: e, label: t(`entity.${e}`) }))]}
        />
        <SelectField
          label={t('items.status')}
          value={status ?? (everything ? allStatuses : '')}
          onValueChange={(v) => setFilters({ status: v })}
          options={[
            { value: '', label: t('items.changedOnly') },
            { value: allStatuses, label: t('items.allStatuses') },
            ...statuses.map((s) => ({ value: s, label: t(`status.${s}`) })),
          ]}
        />
        <div className="sm:pb-2">
          <CheckboxField label={t('items.onlySkipped')} checked={skipped} onChange={(e) => setFilters({ skipped: e.target.checked ? '1' : '' })} />
        </div>
      </div>
      {row > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">{t('items.rowShown', { row })}</span>
          <Button size="sm" variant="secondary" onClick={() => setFilters({ row: '' })}>
            <X /> {t('items.allRows')}
          </Button>
        </div>
      )}
      {items.isPending ? (
        <Loading />
      ) : items.isError ? (
        <ErrorMessage error={items.error} />
      ) : items.data.items.length === 0 ? (
        <EmptyState
          title={!status && !everything && !entity && !skipped && !search && row === 0 ? t('items.noChanges') : t('items.empty')}
          action={
            !status && !everything ? (
              <Button size="sm" variant="secondary" onClick={() => setFilters({ status: allStatuses })}>
                {t('items.showAll')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="space-y-3">
            {items.data.items.map((item) => (
              <ItemCard key={item.seq} item={item} labels={labels} highlighted={highlighted === itemAnchor(item.seq)} />
            ))}
          </ul>
          <Pagination
            offset={offset}
            limit={pageSize}
            total={items.data.total}
            onChange={(o) => setFilters({ offset: String(o) }, { reset: '', section: changesSection })}
          />
        </>
      )}
    </section>
  )
}

/** One entry of the diff: what it is, its rows, and its fields before and after. */
function ItemCard({ item, labels, highlighted }: { item: ImportItem; labels: ReturnType<typeof attributeLabels>; highlighted: boolean }) {
  const { t } = useTranslation('imports')
  const localized = useLocalized()
  const fieldLabel = useFieldLabel(labels)
  const name = localized(item.name)
  const href =
    item.entity === 'category' && item.id
      ? categoryHref(item.id)
      : item.entity === 'product' && item.id
        ? productHref(item.id)
        : item.entity === 'variant' && item.id && item.productId
          ? variantHref(item.productId, item.id)
          : undefined
  const title =
    item.entity === 'category'
      ? `${name} (${item.key ?? ''})`
      : item.entity === 'product'
        ? [item.modelNumber, name].filter(Boolean).join(' · ')
        : [item.modelNumber, name, item.sku && t('items.sku', { sku: item.sku })].filter(Boolean).join(' · ')
  const showBefore = item.status !== 'new'
  const changes = item.status === 'unchanged' ? [] : item.changes

  return (
    <li
      id={itemAnchor(item.seq)}
      className={cn('scroll-mt-4 space-y-2 rounded-control border p-3', highlighted ? 'border-primary ring-2 ring-primary/30' : 'border-line')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ItemStatusBadge status={item.status} />
        <Badge>{t(`entity.${item.entity}`)}</Badge>
        {item.skipped && <Badge variant="danger">{t('items.skipped')}</Badge>}
        <span className="min-w-0 font-medium break-words">{href ? <TextLink to={href}>{title}</TextLink> : title}</span>
        {item.rows.length > 0 && <span className="text-sm text-muted">{t('items.rows', { count: item.rows.length, rows: compactRows(item.rows) })}</span>}
      </div>
      {item.entity === 'product' && (item.productType || item.category) && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {item.productType && (
            <TypeBadge color={item.productType.color} abbreviation={item.productType.abbreviation}>
              {localized(item.productType.name)}
            </TypeBadge>
          )}
          {item.category && <span className="text-muted">{localized(item.category.name)}</span>}
        </div>
      )}
      {changes.length > 0 && (
        <DiffList
          showBefore={showBefore}
          rows={changes.map((c) => ({ key: c.field, label: fieldLabel(c.field), before: { field: c.field, value: c.before }, after: { field: c.field, value: c.after } }))}
        />
      )}
    </li>
  )
}
