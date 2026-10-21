import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useGetCatalogReadiness } from '@/api/generated/catalog-readiness/catalog-readiness'
import type { ReadinessItem, ReadinessItemSeverity, ReadinessRef } from '@/api/generated/model'
import { useReadinessText } from '@/catalog/readiness'
import { ErrorMessage, Loading, Section, TextLink, TypeBadge } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

const severities: ReadinessItemSeverity[] = ['error', 'warning', 'info']

const icons: Record<ReadinessItemSeverity, ReactNode> = {
  error: <CircleX aria-hidden="true" className="size-4 shrink-0 text-danger" />,
  warning: <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />,
  info: <Info aria-hidden="true" className="size-4 shrink-0 text-muted" />,
}

/** Where a ref leads: the product or category editor, the Functions or Channel kinds page. */
const refPath = (r: ReadinessRef) => {
  switch (r.kind) {
    case 'product':
      return `/catalog/products/${r.id}`
    case 'category':
      return `/catalog/categories/${r.id}`
    case 'function':
      return '/catalog/function-types'
    case 'channel_kind':
      return '/catalog/output-kinds'
    default:
      return '/catalog/product-types'
  }
}

/**
 * The Systems page's Readiness section (D446): per active system, and for
 * the whole catalog, what SnapFlow still needs before a project works,
 * grouped by severity, with links to what to fix. The API computes it.
 */
export function ReadinessSection() {
  const { t } = useTranslation('productTypes')
  const localized = useLocalized()
  // Fresh on every visit: products and fields change elsewhere.
  const readiness = useGetCatalogReadiness({ query: { staleTime: 0, refetchOnMount: 'always' } })
  const cards = readiness.data
    ? [
        ...readiness.data.systems.map((s) => ({
          key: s.productTypeId,
          title: (
            <TypeBadge color={s.color} abbreviation={s.abbreviation} wrap>
              {localized(s.name)}
            </TypeBadge>
          ),
          name: localized(s.name),
          subtitle: t(`topology.${s.topology}`),
          items: s.items,
        })),
        { key: 'general', title: t('readiness.general'), name: t('readiness.general'), subtitle: t('readiness.generalHint'), items: readiness.data.global },
      ]
    : []
  return (
    <Section title={t('readiness.title')} description={t('readiness.description')}>
      {readiness.isPending ? (
        <Loading />
      ) : readiness.isError ? (
        <ErrorMessage error={readiness.error} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="readiness">
          {cards.map((c) => (
            <li key={c.key} aria-label={c.name} className="min-w-0 space-y-3 rounded-control border border-line bg-surface p-4">
              <div className="space-y-0.5">
                <div className="text-sm font-semibold">{c.title}</div>
                <p className="text-xs text-muted">{c.subtitle}</p>
              </div>
              <ReadinessItems items={c.items} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function ReadinessItems({ items }: { items: ReadinessItem[] }) {
  const { t } = useTranslation('productTypes')
  const { t: tCatalog } = useTranslation('catalog')
  const text = useReadinessText()
  const localized = useLocalized()
  if (items.length === 0)
    return (
      <p className="flex items-center gap-2 text-sm text-success">
        <CircleCheck aria-hidden="true" className="size-4 shrink-0" /> {t('readiness.ready')}
      </p>
    )
  return (
    <div className="space-y-3">
      {severities.map((sev) => {
        const group = items.filter((i) => i.severity === sev)
        if (group.length === 0) return null
        return (
          <div key={sev} className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted uppercase">{tCatalog(`readiness.severity.${sev}`)}</h3>
            <ul className="space-y-2">
              {group.map((it) => (
                <li key={it.code} className="space-y-1 text-sm" data-code={it.code}>
                  <p className="flex items-start gap-2">
                    <span className="mt-0.5">{icons[sev]}</span>
                    <span className="min-w-0">
                      {text(it.code)}
                      {it.refs.length > 0 || it.count > 1 ? <span className="text-muted"> ({it.count})</span> : null}
                    </span>
                  </p>
                  {it.refs.length > 0 && (
                    <p className="flex flex-wrap gap-x-3 gap-y-1 pl-6 text-sm">
                      {it.refs.map((r) => (
                        <TextLink key={r.id} to={refPath(r)}>
                          {localized(r.label)}
                        </TextLink>
                      ))}
                      {it.count > it.refs.length && <span className="text-muted">{t('readiness.more', { count: it.count - it.refs.length })}</span>}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
