import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { Finding } from '@/api/generated/model'
import { Badge, Button, EmptyState, TextLink } from '@/components/ui'
import { cn } from '@/lib/cn'

import { findingPlanId, type Severity, severities } from './findings'
import { type FindingNames, useFindingText } from './format'

const icons: Record<Severity, ReactNode> = {
  error: <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />,
  warning: <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />,
  info: <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />,
}

type Props = {
  findings: Finding[]
  /** Names the texts need (`WiringModel.findingNames`); without, the params' labels are used. */
  names?: (f: Finding) => FindingNames
  /** A link per finding (the Checks tab: into the editor, selecting the item). */
  linkOf?: (f: Finding) => string | null
  /** In an editor: "Show" selects the finding's item on the open plan (instead of a link). */
  onShow?: (f: Finding) => void
  /** Groups: by plan (with its name), then severity; without, only by severity. */
  plans?: { id: string; name: string }[]
  /** Severity headings with counts; off for a short list (one item's findings). */
  headings?: boolean
  /** Unconnected needs listed elsewhere: one line per group instead of one per need (D417). */
  collapseUnconnected?: boolean
  empty?: ReactNode
}

/**
 * The one problem list (D454): severity icon and colour, the translated text, the refs as a link into the
 * editor or a "Show" that selects the item. Used by the Checks tab (all findings, by plan) and the floorplan
 * and board editors (the plan's findings, `?planId=`). Everything listed comes from the API (rule 1).
 */
export function FindingsList({ findings, names, linkOf, onShow, plans, headings = true, collapseUnconnected = false, empty }: Props) {
  const { t } = useTranslation('checks')
  if (findings.length === 0) return empty === undefined ? <EmptyState title={t('findings.none')} icon={<CircleCheck aria-hidden className="size-4 text-success" />} /> : <>{empty}</>
  if (!plans) return <BySeverity findings={findings} names={names} linkOf={linkOf} onShow={onShow} headings={headings} collapseUnconnected={collapseUnconnected} />
  const known = new Set(plans.map((p) => p.id))
  const groups = [
    ...plans.map((p) => ({ key: p.id, title: p.name, list: findings.filter((f) => findingPlanId(f) === p.id) })),
    { key: '', title: t('findings.version'), list: findings.filter((f) => !known.has(findingPlanId(f) ?? '')) },
  ].filter((g) => g.list.length > 0)
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.title} className="space-y-3">
          <h3 className="border-b border-line pb-1 text-sm font-semibold">{g.title}</h3>
          <BySeverity findings={g.list} names={names} linkOf={linkOf} onShow={onShow} headings={headings} collapseUnconnected={collapseUnconnected} />
        </section>
      ))}
    </div>
  )
}

function BySeverity({ findings, names, linkOf, onShow, headings, collapseUnconnected }: Omit<Props, 'plans' | 'empty'> & { findings: Finding[] }) {
  const { t } = useTranslation('checks')
  const text = useFindingText()
  return (
    <div className="space-y-4">
      {severities.map((sev) => {
        const all = findings.filter((f) => f.severity === sev)
        if (all.length === 0) return null
        const unconnected = collapseUnconnected ? all.filter((f) => f.code === 'need_unconnected').length : 0
        const list = collapseUnconnected ? all.filter((f) => f.code !== 'need_unconnected') : all
        return (
          <div key={sev} className="space-y-2">
            {headings && (
              <h4 className="flex items-center gap-2 text-xs font-semibold text-muted">
                <Badge variant={sev === 'error' ? 'danger' : sev === 'warning' ? 'warning' : 'neutral'}>{all.length}</Badge>
                {t(`severity.${sev}`)}
              </h4>
            )}
            <ul className="space-y-1.5 text-sm">
              {unconnected > 0 && (
                <li className="flex gap-2">
                  {icons[sev]}
                  <span>{t('findings.unconnected', { count: unconnected })}</span>
                </li>
              )}
              {list.map((f, i) => {
                const words = text(f, names?.(f))
                const link = linkOf?.(f) ?? null
                const showable = onShow && (f.refs.itemId || f.refs.needId)
                return (
                  <li key={i} className="flex gap-2">
                    {icons[sev]}
                    <span className="sr-only">{t(`severityOne.${sev}`)}: </span>
                    <span className={cn('min-w-0 flex-1', sev === 'error' && 'text-danger')}>{words}</span>
                    {link && (
                      <TextLink to={link} className="shrink-0" aria-label={t('findings.openFor', { text: words })}>
                        {t('findings.open')}
                      </TextLink>
                    )}
                    {showable && (
                      <Button size="sm" variant="ghost" className="-my-1 h-7 shrink-0 px-2 text-primary" aria-label={t('findings.showFor', { text: words })} onClick={() => onShow(f)}>
                        {t('findings.show')}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
