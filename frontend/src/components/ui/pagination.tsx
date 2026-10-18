import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from './button'

type PaginationProps = {
  /** Rows skipped before this page. */
  offset: number
  /** Rows per page. */
  limit: number
  /** Rows of all pages. */
  total: number
  onChange: (offset: number) => void
}

/** "1–50 of 120" with Previous / Next, below a paged list. */
export function Pagination({ offset, limit, total, onChange }: PaginationProps) {
  const { t } = useTranslation()
  if (total === 0) return null
  const from = Math.min(offset + 1, total)
  const to = Math.min(offset + limit, total)
  return (
    <nav aria-label={t('pagination.label')} className="flex flex-wrap items-center justify-end gap-3">
      <p className="text-sm text-muted tabular-nums" aria-live="polite">
        {t('pagination.range', { from, to, total })}
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          <ChevronLeft /> {t('pagination.previous')}
        </Button>
        <Button size="sm" variant="secondary" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
          {t('pagination.next')} <ChevronRight />
        </Button>
      </div>
    </nav>
  )
}
