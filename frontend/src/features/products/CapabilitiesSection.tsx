import { useTranslation } from 'react-i18next'

import type { Product } from '@/api/generated/model'
import { Section } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { useDescribeCapabilities } from './describe-capabilities'

/**
 * "What SnapFlow knows about this product": the capabilities the backend
 * computes from the attribute values linked to catalog field meanings, for
 * the product and each variant, in plain words (spec 3a). Read-only.
 */
export function CapabilitiesSection({ product }: { product: Product }) {
  const { t } = useTranslation('products')
  const localized = useLocalized()
  const describe = useDescribeCapabilities()
  const rows = [
    { key: 'product', title: t('capabilities.product'), text: describe(product.capabilities) },
    ...product.variants.map((v) => ({ key: v.id, title: localized(v.name), text: describe(v.capabilities) })),
  ]
  return (
    <Section title={t('capabilities.title')} description={t('capabilities.hint')}>
      <dl className="space-y-3" data-testid="capabilities">
        {rows.map((r) => (
          <div key={r.key} className="space-y-0.5">
            <dt className="text-sm font-medium">{r.title}</dt>
            <dd className="text-sm text-muted">{r.text}</dd>
          </div>
        ))}
      </dl>
    </Section>
  )
}
