import { keepPreviousData, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'

import { ApiError } from '@/api/client'
import { getListCategoriesQueryKey } from '@/api/generated/categories/categories'
import {
  getGetImportQueryKey,
  useApplyImport,
  useListImportIssues,
  useListImportItems,
  useListImportTargets,
  usePreviewImport,
} from '@/api/generated/imports/imports'
import type { ImportItem, ImportIssue, ImportRun, ListImportItemsEntity, ListImportItemsStatus } from '@/api/generated/model'
import { invalidateProductQueries } from '@/catalog/invalidate'
import {
  Badge,
  Button,
  CheckboxField,
  EmptyState,
  ErrorMessage,
  FormActions,
  Loading,
  Notice,
  Pagination,
  Section,
  SelectField,
  TextLink,
  TypeBadge,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { Counters } from './Counters'
import { compactRows } from './diff'
import { attributeLabels, useCodeMessage, useFieldLabel, useTargetLabel } from './labels'
import { DiffList, ItemStatusBadge } from './values'
import { categoryHref, invalidateRunDetails, listPath, pageSize, productHref, variantHref } from './paths'

const entities = ['category', 'product', 'variant'] as const
const statuses = ['new', 'changed', 'unchanged', 'deactivate'] as const

type Props = {
  run: ImportRun
  /** Back to the mapping. */
  onEditMapping: () => void
  /** The apply ran (applied or failed). */
  onApplied: () => void
}

/** Step 3: what the import will do, the rows' problems, and Apply. */
export function PreviewStep({ run, onEditMapping, onApplied }: Props) {
  const { t } = useTranslation('imports')
  const queryClient = useQueryClient()
  const [params, setParams] = useSearchParams()
  const counts = run.counts!

  const setFilters = (changes: Record<string, string>, resetKey = 'offset') =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete(resetKey)
        for (const [name, value] of Object.entries(changes)) {
          if (value === '' || value === '0') next.delete(name)
          else next.set(name, value)
        }
        return next
      },
      { replace: true },
    )

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
    } catch {
      // shown below
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
    } catch {
      // shown below
    }
  }

  const stale = apply.error instanceof ApiError && apply.error.code === 'import.stale'
  const blocked = allOrNothing && counts.errors > 0

  const query = (entity: string, status: string) => {
    const next = new URLSearchParams(params)
    next.delete('offset')
    next.delete('entity')
    next.delete('status')
    next.delete('skipped')
    if (entity) next.set('entity', entity)
    if (status === 'skipped') next.set('skipped', '1')
    else if (status) next.set('status', status)
    return `?${next.toString()}#changes`
  }
  const issuesQuery = (severity: string) => {
    const next = new URLSearchParams(params)
    next.delete('issues')
    next.set('severity', severity)
    return `?${next.toString()}#issues`
  }

  return (
    <div className="space-y-6">
      <Section
        title={t('preview.title')}
        description={t('preview.description', { rows: counts.rows })}
        actions={
          run.can.preview && (
            <Button size="sm" variant="secondary" onClick={onEditMapping}>
              <Pencil /> {t('preview.editMapping')}
            </Button>
          )
        }
      >
        <Counters counts={counts} filterHref={query} issuesHref={issuesQuery} />
      </Section>

      <IssuesSection run={run} params={params} setFilters={setFilters} />

      <Section title={t('preview.applyTitle')} description={t('preview.applyDescription')}>
        <CheckboxField
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

      <ItemsSection run={run} params={params} setFilters={setFilters} />

      <FormActions
        error={
          <>
            <ErrorMessage
              error={apply.error}
              action={
                stale ? (
                  <Button size="sm" variant="secondary" onClick={() => void previewAgain()} disabled={preview.isPending}>
                    <RotateCw /> {t('preview.again')}
                  </Button>
                ) : undefined
              }
            />
            <ErrorMessage error={preview.error} />
          </>
        }
      >
        <Button asChild variant="secondary">
          <Link to={listPath}>{t('backToList')}</Link>
        </Button>
        <Button onClick={() => void submit()} disabled={apply.isPending || !run.can.apply}>
          <Check /> {apply.isPending ? t('preview.applying') : t('preview.apply')}
        </Button>
      </FormActions>
    </div>
  )
}

type ListProps = {
  run: ImportRun
  params: URLSearchParams
  setFilters: (changes: Record<string, string>, resetKey?: string) => void
}

const offsetOf = (params: URLSearchParams, name: string) => Math.max(0, Math.floor(Number(params.get(name))) || 0)

function ItemsSection({ run, params, setFilters }: ListProps) {
  const { t } = useTranslation('imports')
  const entity = (entities as readonly string[]).includes(params.get('entity') ?? '') ? (params.get('entity') as ListImportItemsEntity) : undefined
  const status = (statuses as readonly string[]).includes(params.get('status') ?? '') ? (params.get('status') as ListImportItemsStatus) : undefined
  const skipped = params.get('skipped') === '1'
  const offset = offsetOf(params, 'offset')
  const items = useListImportItems(
    run.id,
    { ...(entity ? { entity } : {}), ...(status ? { status } : {}), ...(skipped ? { skipped: true } : {}), limit: pageSize, offset },
    { query: { placeholderData: keepPreviousData } },
  )
  const targets = useListImportTargets(undefined, { query: { staleTime: 60_000 } })
  const labels = attributeLabels(targets.data)

  return (
    <section id="changes" aria-labelledby="changes-title" className="space-y-4 rounded-control border border-line bg-surface p-4 sm:p-6">
      <div className="space-y-1">
        <h2 id="changes-title" className="text-base font-semibold">
          {t('items.title')}
        </h2>
        <p className="text-sm text-muted">{t('items.description')}</p>
      </div>
      <div className="grid items-end gap-4 sm:grid-cols-3">
        <SelectField
          label={t('items.entity')}
          value={entity ?? ''}
          onValueChange={(v) => setFilters({ entity: v })}
          options={[{ value: '', label: t('items.allEntities') }, ...entities.map((e) => ({ value: e, label: t(`entity.${e}`) }))]}
        />
        <SelectField
          label={t('items.status')}
          value={status ?? ''}
          onValueChange={(v) => setFilters({ status: v })}
          options={[{ value: '', label: t('items.allStatuses') }, ...statuses.map((s) => ({ value: s, label: t(`status.${s}`) }))]}
        />
        <div className="sm:pb-2">
          <CheckboxField label={t('items.onlySkipped')} checked={skipped} onChange={(e) => setFilters({ skipped: e.target.checked ? '1' : '' })} />
        </div>
      </div>
      {items.isPending ? (
        <Loading />
      ) : items.isError ? (
        <ErrorMessage error={items.error} />
      ) : items.data.items.length === 0 ? (
        <EmptyState title={t('items.empty')} />
      ) : (
        <>
          <ul className="space-y-3">
            {items.data.items.map((item) => (
              <ItemCard key={item.seq} item={item} labels={labels} />
            ))}
          </ul>
          <Pagination offset={offset} limit={pageSize} total={items.data.total} onChange={(o) => setFilters({ offset: String(o) }, '')} />
        </>
      )}
    </section>
  )
}

/** One entry of the diff: what it is, its rows, and its fields before and after. */
function ItemCard({ item, labels }: { item: ImportItem; labels: ReturnType<typeof attributeLabels> }) {
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
    <li className="space-y-2 rounded-control border border-line p-3">
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

function IssuesSection({ run, params, setFilters }: ListProps) {
  const { t } = useTranslation('imports')
  const counts = run.counts!
  const severity = params.get('severity') === 'error' || params.get('severity') === 'warning' ? (params.get('severity') as 'error' | 'warning') : undefined
  const offset = offsetOf(params, 'issues')
  const issues = useListImportIssues(
    run.id,
    { ...(severity ? { severity } : {}), limit: pageSize, offset },
    { query: { placeholderData: keepPreviousData, enabled: counts.errors + counts.warnings > 0 } },
  )
  const targets = useListImportTargets(undefined, { query: { staleTime: 60_000 } })
  const labels = attributeLabels(targets.data)
  const targetLabel = useTargetLabel(labels)
  const fieldLabel = useFieldLabel(labels)
  const message = useCodeMessage()

  if (counts.errors + counts.warnings === 0) {
    return (
      <Notice>
        {t('issues.none')}
      </Notice>
    )
  }

  const text = (i: ImportIssue) => {
    // A field name in the params ("name.en") reads better as its label.
    const params = i.params && typeof i.params.field === 'string' ? { ...i.params, field: fieldLabel(i.params.field) } : i.params
    return message(i.code, params)
  }
  /** Where: "Row 5 · D · Price (Price (USD)) · GW-1". */
  const where = (i: ImportIssue) =>
    [
      i.row > 0 ? t('issues.atRow', { row: i.row }) : t('issues.file'),
      [i.column, i.header].filter(Boolean).join(' · '),
      i.target && !(i.header && targetLabel(i.target) === i.header) ? targetLabel(i.target) : '',
      i.modelNumber ?? '',
    ]
      .filter(Boolean)
      .join(' · ')

  return (
    <section id="issues" aria-labelledby="issues-title" className="space-y-4 rounded-control border border-line bg-surface p-4 sm:p-6">
      <div className="space-y-1">
        <h2 id="issues-title" className="text-base font-semibold">
          {t('issues.title')}
        </h2>
        <p className="text-sm text-muted">{t('issues.description', { errors: counts.errors, warnings: counts.warnings })}</p>
      </div>
      <div className="max-w-xs">
        <SelectField
          label={t('issues.filter')}
          value={severity ?? ''}
          onValueChange={(v) => setFilters({ severity: v }, 'issues')}
          options={[
            { value: '', label: t('issues.all') },
            { value: 'error', label: t('issues.onlyErrors') },
            { value: 'warning', label: t('issues.onlyWarnings') },
          ]}
        />
      </div>
      {issues.isPending ? (
        <Loading />
      ) : issues.isError ? (
        <ErrorMessage error={issues.error} />
      ) : (
        <>
          {issues.data.items.length === 0 ? (
            <EmptyState title={t('issues.empty')} />
          ) : (
            <ul aria-label={t('issues.title')} className="divide-y divide-line rounded-control border border-line">
              {issues.data.items.map((i, n) => (
                <li key={offset + n} className="flex flex-col gap-1 px-3 py-2.5 text-sm sm:flex-row sm:items-baseline sm:gap-3">
                  <span className="shrink-0">
                    <Badge variant={i.severity === 'error' ? 'danger' : 'warning'}>{t(`issues.${i.severity}`)}</Badge>
                  </span>
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block">{text(i)}</span>
                    <span className="block text-xs break-words text-muted">{where(i)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Pagination offset={offset} limit={pageSize} total={issues.data.total} onChange={(o) => setFilters({ issues: String(o) }, '')} />
        </>
      )}
    </section>
  )
}
