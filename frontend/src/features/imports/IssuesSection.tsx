import { keepPreviousData } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { useListImportIssues, useListImportTargets } from '@/api/generated/imports/imports'
import type { ImportCounts, ImportIssue, ImportRun } from '@/api/generated/model'
import { Badge, type Column, DataTable, EmptyState, ErrorMessage, Loading, Notice, Pagination, SelectField, TextLink } from '@/components/ui'

import { changesSection, issuesSection, itemAnchor, offsetOf, useClampOffset, useFilters, useScrollToHash } from './filters'
import { attributeLabels, useCodeMessage, useFieldLabel, useTargetLabel } from './labels'
import { pageSize } from './paths'

type Props = {
  run: ImportRun
  /** The counts whose errors and warnings are listed (the preview's, or what the apply wrote). */
  counts: ImportCounts
  /** The diff is on the page: each row links to its changes. */
  linkItems?: boolean
}

/** The rows' errors and warnings, paged, filtered by severity in the URL ("severity", page "issues"). */
export function IssuesSection({ run, counts, linkItems }: Props) {
  const { t } = useTranslation('imports')
  const { params, href, setFilters } = useFilters()
  const severity = params.get('severity') === 'error' || params.get('severity') === 'warning' ? (params.get('severity') as 'error' | 'warning') : undefined
  const offset = offsetOf(params, 'issues')
  const any = counts.errors + counts.warnings > 0
  const issues = useListImportIssues(
    run.id,
    { ...(severity ? { severity } : {}), limit: pageSize, offset },
    { query: { placeholderData: keepPreviousData, enabled: any } },
  )
  useClampOffset(issues.data?.total, offset, 'issues', setFilters)
  useScrollToHash((id) => id === issuesSection, !issues.isPending || !any)
  const targets = useListImportTargets(undefined, { query: { staleTime: 60_000 } })
  const labels = attributeLabels(targets.data)
  const targetLabel = useTargetLabel(labels)
  const fieldLabel = useFieldLabel(labels)
  const message = useCodeMessage()

  if (!any) {
    return (
      <div id={issuesSection} className="scroll-mt-4">
        <Notice>{t('issues.none')}</Notice>
      </div>
    )
  }

  const text = (i: ImportIssue) => {
    // A field name in the params ("name.en") reads better as its label.
    const p = i.params && typeof i.params.field === 'string' ? { ...i.params, field: fieldLabel(i.params.field) } : i.params
    return message(i.code, p)
  }
  /** The diff of the issue's row: every item of the row, its own item in view. */
  const rowHref = (i: ImportIssue) =>
    href(
      { row: String(i.row), status: 'all', entity: '', skipped: '', q: '' },
      { section: i.itemSeq ? itemAnchor(i.itemSeq) : changesSection },
    )
  const none = <span className="text-muted">–</span>
  const issueColumns: Column<ImportIssue>[] = [
    {
      header: t('issues.severity'),
      cell: (i) => <Badge variant={i.severity === 'error' ? 'danger' : 'warning'}>{t(`issues.${i.severity}`)}</Badge>,
      className: 'w-px whitespace-nowrap',
    },
    { header: t('issues.message'), mobile: 'title', cell: (i) => <span className="break-words">{text(i)}</span>, className: 'md:min-w-64' },
    {
      header: t('issues.row'),
      cell: (i) =>
        i.row <= 0 ? (
          <span className="text-muted">{t('issues.file')}</span>
        ) : linkItems ? (
          // At least 24 px to tap, though only a number.
          <TextLink to={rowHref(i)} aria-label={t('issues.showRow', { row: i.row })} className="inline-flex min-h-6 min-w-6 items-center tabular-nums">
            {i.row}
          </TextLink>
        ) : (
          <span className="tabular-nums">{i.row}</span>
        ),
      className: 'whitespace-nowrap',
    },
    {
      header: t('issues.column'),
      cell: (i) => (i.column || i.header ? <span className="break-words">{[i.column, i.header].filter(Boolean).join(' · ')}</span> : none),
      className: 'md:min-w-32',
    },
    { header: t('issues.target'), cell: (i) => (i.target ? targetLabel(i.target) : none), className: 'md:min-w-32' },
    { header: t('issues.modelNumber'), cell: (i) => (i.modelNumber ? <span className="break-all">{i.modelNumber}</span> : none), className: 'md:min-w-32' },
  ]

  return (
    <section
      id={issuesSection}
      aria-labelledby="issues-title"
      className="scroll-mt-4 space-y-4 rounded-control border border-line bg-surface p-4 sm:p-6"
    >
      <div className="space-y-1">
        <h2 id="issues-title" className="text-base font-semibold">
          {t('issues.title')}
        </h2>
        <p className="text-sm text-muted">{t('issues.description', {
            errors: t('issues.errors', { count: counts.errors }),
            warnings: t('issues.warnings', { count: counts.warnings }),
          })}</p>
      </div>
      <div className="max-w-xs">
        <SelectField
          label={t('issues.filter')}
          value={severity ?? ''}
          onValueChange={(v) => setFilters({ severity: v }, { reset: 'issues' })}
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
            <DataTable
              label={t('issues.title')}
              rows={issues.data.items.map((issue, n) => ({ ...issue, n: offset + n }))}
              rowKey={(i) => String(i.n)}
              columns={issueColumns}
              empty={null}
            />
          )}
          <Pagination
            offset={offset}
            limit={pageSize}
            total={issues.data.total}
            onChange={(o) => setFilters({ issues: String(o) }, { reset: '', section: issuesSection })}
          />
        </>
      )}
    </section>
  )
}
