import { keepPreviousData } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'

import { useListImports } from '@/api/generated/imports/imports'
import type { ImportCounts, ImportRun } from '@/api/generated/model'
import { Badge, Button, type Column, DataTable, EmptyState, ErrorMessage, lastPageOffset, Loading, Page, Pagination, TextLink } from '@/components/ui'

import { RunStateBadge } from './values'
import { newPath, pageSize, runPath, useFormatDateTime } from './paths'

/** "Products: 3 new, 2 changed, 1 to deactivate" and the same for variants, or nothing without changes. */
function useCountsSummary() {
  const { t } = useTranslation('imports')
  return (counts?: ImportCounts) => {
    if (!counts) return []
    const parts: string[] = []
    for (const entity of ['products', 'variants'] as const) {
      const c = counts[entity]
      const changes = [
        c.new > 0 ? t('summary.new', { count: c.new }) : '',
        c.changed > 0 ? t('summary.changed', { count: c.changed }) : '',
        c.deactivate > 0 ? t('summary.deactivate', { count: c.deactivate }) : '',
      ].filter(Boolean)
      parts.push(t(`summary.${entity}`, { changes: changes.length > 0 ? changes.join(', ') : t('summary.unchanged') }))
    }
    return parts
  }
}

/** catalog/imports: every import run, newest first. */
export function ImportsPage() {
  const { t } = useTranslation('imports')
  const formatDate = useFormatDateTime()
  const summary = useCountsSummary()
  const [params, setParams] = useSearchParams()
  const offset = Math.max(0, Math.floor(Number(params.get('offset'))) || 0)
  const setOffset = (o: number) => setParams(o > 0 ? { offset: String(o) } : {}, { replace: true })

  const list = useListImports({ limit: pageSize, offset }, { query: { placeholderData: keepPreviousData } })
  const total = list.data?.total
  useEffect(() => {
    if (total !== undefined && total > 0 && offset >= total) setParams({ offset: String(lastPageOffset(total, pageSize)) }, { replace: true })
  }, [total, offset, setParams])

  const columns: Column<ImportRun>[] = [
    {
      header: t('column.file'),
      cell: (r) => (
        <TextLink to={runPath(r.id)} className="break-all">
          {r.fileName || t('noFileName')}
        </TextLink>
      ),
      className: 'min-w-48',
    },
    { header: t('column.state'), cell: (r) => <RunStateBadge state={r.state} />, className: 'whitespace-nowrap' },
    {
      header: t('column.profile'),
      cell: (r) => r.profileName || <span className="text-muted">{r.mapping ? t('noProfile') : '–'}</span>,
      className: 'min-w-32',
    },
    {
      header: t('column.result'),
      cell: (r) => {
        const counts = r.applied ?? r.counts
        if (!counts) return <span className="text-muted">{t('notPreviewed')}</span>
        return (
          <div className="space-y-0.5">
            {summary(counts).map((line) => (
              <p key={line}>{line}</p>
            ))}
            {counts.errors > 0 && <Badge variant="danger">{t('summary.errors', { count: counts.errors })}</Badge>}
          </div>
        )
      },
      className: 'min-w-56',
    },
    { header: t('column.user'), cell: (r) => r.userName, className: 'min-w-32' },
    {
      header: t('column.date'),
      cell: (r) => (
        <div className="space-y-0.5 md:whitespace-nowrap">
          <p>{formatDate(r.createdAt)}</p>
          {r.appliedAt && <p className="text-muted">{t('appliedAt', { date: formatDate(r.appliedAt) })}</p>}
          {r.undoneAt && <p className="text-muted">{t('undoneAt', { date: formatDate(r.undoneAt) })}</p>}
        </div>
      ),
    },
  ]

  const newButton = (
    <Button asChild>
      <Link to={newPath}>
        <Plus /> {t('new')}
      </Link>
    </Button>
  )

  return (
    <Page width="wide" title={t('title')} description={t('description')} actions={newButton}>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorMessage error={list.error} />
      ) : (
        <>
          <DataTable rows={list.data.items} rowKey={(r) => r.id} columns={columns} empty={<EmptyState title={t('empty')} action={newButton} />} />
          <Pagination offset={offset} limit={pageSize} total={list.data.total} onChange={setOffset} />
        </>
      )}
    </Page>
  )
}
