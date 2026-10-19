import { Eye, EyeOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { PlanPlacement, PlanZone } from '@/api/generated/model'
import { Button, IconButton } from '@/components/ui'
import { cn } from '@/lib/cn'

import type { Layers } from './layers'
import { zoneCounts } from './zones'

type Props = {
  zones: PlanZone[]
  /** The placements as last saved (with the backend's zone assignment). */
  saved: PlanPlacement[]
  /** The placements now (live estimate). */
  placements: PlanPlacement[]
  selection: string[]
  layers: Layers
  onLayers: (layers: Layers) => void
  onSelect: (id: string) => void
}

/** The Zones tab: every zone with colour, name and device count; show/hide per zone and all; a click selects. */
export function ZonesPanel({ zones, saved, placements, selection, layers, onLayers, onSelect }: Props) {
  const { t } = useTranslation('plans')
  if (zones.length === 0) return <p className="text-sm text-muted">{t('zones.empty')}</p>
  const counts = zoneCounts(saved, placements, zones)
  const anyHidden = layers.zonesHidden || layers.hiddenZones.size > 0
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">{t('zones.countHint')}</p>
        <Button size="sm" variant="secondary" onClick={() => onLayers({ ...layers, zonesHidden: !anyHidden, hiddenZones: new Set() })}>
          {anyHidden ? <Eye /> : <EyeOff />} {anyHidden ? t('zones.showAll') : t('zones.hideAll')}
        </Button>
      </div>
      <ul className="divide-y divide-line" aria-label={t('panel.zones')}>
        {zones.map((z) => {
          const hidden = layers.zonesHidden || layers.hiddenZones.has(z.id)
          const savedCount = counts.saved.get(z.id) ?? 0
          const estimate = counts.estimate.get(z.id) ?? 0
          return (
            <li key={z.id} className={cn('flex items-center gap-2 py-1', selection.includes(z.id) && 'bg-canvas')}>
              <span className="size-4 shrink-0 rounded-sm border border-line" style={{ backgroundColor: z.color }} aria-hidden="true" />
              <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" disabled={hidden} onClick={() => onSelect(z.id)}>
                <span className="truncate">{z.name}</span>
              </Button>
              <span className="text-sm tabular-nums text-muted" title={t('zones.countTitle')} data-testid={`zone-count-${z.id}`}>
                {t('zones.count', { count: savedCount })}
                {estimate !== savedCount && <span className="ml-1">{t('zones.estimate', { count: estimate })}</span>}
              </span>
              <IconButton
                label={hidden ? t('zones.show', { name: z.name }) : t('zones.hide', { name: z.name })}
                icon={hidden ? <EyeOff /> : <Eye />}
                aria-pressed={!hidden}
                onClick={() => {
                  if (layers.zonesHidden) {
                    // From "all hidden" to only the others hidden.
                    onLayers({ ...layers, zonesHidden: false, hiddenZones: new Set(zones.filter((x) => x.id !== z.id).map((x) => x.id)) })
                    return
                  }
                  const next = new Set(layers.hiddenZones)
                  if (hidden) next.delete(z.id)
                  else next.add(z.id)
                  onLayers({ ...layers, hiddenZones: next })
                }}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
