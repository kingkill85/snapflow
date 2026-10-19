import { useTranslation } from 'react-i18next'

import type { PlanPlacement, VariantSearchItem } from '@/api/generated/model'
import { SwitchField } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { type Layers, layerGroups, toggled } from './layers'
import type { PaletteProduct } from './catalog'

type Props = {
  placements: PlanPlacement[]
  products: PaletteProduct[]
  variants: Map<string, VariantSearchItem>
  layers: Layers
  onLayers: (layers: Layers) => void
}

/** The Layers tab: what the canvas shows (view only, not saved). */
export function LayersPanel({ placements, products, variants, layers, onLayers }: Props) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()
  const { types, categories } = layerGroups(placements, products, variants)
  return (
    <div className="space-y-5">
      <p className="text-xs text-muted">{t('layers.hint')}</p>
      <SwitchField label={t('layers.zones')} checked={!layers.zonesHidden} onChange={(e) => onLayers({ ...layers, zonesHidden: !e.target.checked })} />
      <SwitchField label={t('layers.needs')} hint={t('layers.needsHint')} checked={!layers.needsHidden} onChange={(e) => onLayers({ ...layers, needsHidden: !e.target.checked })} />
      {types.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">{t('layers.productTypes')}</legend>
          {types.map((pt) => (
            <SwitchField
              key={pt.id}
              label={localize(pt.name)}
              checked={!layers.hiddenProductTypes.has(pt.id)}
              onChange={(e) => onLayers({ ...layers, hiddenProductTypes: toggled(layers.hiddenProductTypes, pt.id, !e.target.checked) })}
            />
          ))}
        </fieldset>
      )}
      {categories.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-semibold">{t('layers.categories')}</legend>
          {categories.map((c) => (
            <SwitchField
              key={c.id}
              label={localize(c.name)}
              checked={!layers.hiddenCategories.has(c.id)}
              onChange={(e) => onLayers({ ...layers, hiddenCategories: toggled(layers.hiddenCategories, c.id, !e.target.checked) })}
            />
          ))}
        </fieldset>
      )}
    </div>
  )
}
