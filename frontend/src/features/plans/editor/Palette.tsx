import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Field, Thumbnail, TypeBadge } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'
import { cn } from '@/lib/cn'

import { groupPalette, type PaletteProduct, paletteDrag, productDragType } from './catalog'

type Props = {
  products: PaletteProduct[]
  /** The armed product (click, then click on the canvas). */
  armed: string | null
  onArm: (productId: string | null) => void
  editable: boolean
  /** The hints above the list (the board editor has its own). */
  hints?: { hint: string; armedHint: string }
}

/**
 * The Products tab: the project's products by category with a search. Drag
 * one onto the canvas, or click it and then click the spot.
 */
export function Palette({ products, armed, onArm, editable, hints }: Props) {
  const { t } = useTranslation('plans')
  const localize = useLocalized()
  const [search, setSearch] = useState('')
  const groups = groupPalette(products, search, localize)

  return (
    <div className="space-y-3">
      <Field label={t('palette.search')} type="search" value={search} onChange={(e) => setSearch(e.target.value)} hint={t('palette.searchHint')} />
      {editable && <p className="text-xs text-muted">{hints ? (armed ? hints.armedHint : hints.hint) : t(armed ? 'palette.armedHint' : 'palette.hint')}</p>}
      {products.length === 0 ? (
        <p className="text-sm text-muted">{t('palette.empty')}</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted">{t('palette.noMatch')}</p>
      ) : (
        groups.map((group) => (
          <section key={group.category.id} aria-label={localize(group.category.name)} className="space-y-1">
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{localize(group.category.name)}</h3>
            <ul className="space-y-1">
              {group.products.map((p) => (
                <li key={p.productId}>
                  <Button
                    variant="ghost"
                    disabled={!editable}
                    aria-pressed={armed === p.productId}
                    draggable={editable}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(productDragType, p.productId)
                      e.dataTransfer.effectAllowed = 'copy'
                      paletteDrag.productId = p.productId
                    }}
                    onDragEnd={() => {
                      paletteDrag.productId = null
                    }}
                    onClick={() => onArm(armed === p.productId ? null : p.productId)}
                    className={cn('h-auto w-full justify-start px-2 py-1.5 text-left font-normal whitespace-normal', armed === p.productId && 'bg-primary/10 ring-1 ring-primary')}
                  >
                    <Thumbnail src={p.imageUrl} />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="block truncate font-medium">{localize(p.name)}</span>
                      <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
                        <TypeBadge color={p.productType.color} abbreviation={p.productType.abbreviation}>
                          {p.modelNumber}
                        </TypeBadge>
                      </span>
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}
