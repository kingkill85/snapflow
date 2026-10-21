import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import type { Category, Product, Variant } from '@/api/generated/model'
import { getGetProductQueryKey } from '@/api/generated/products/products'
import { Button } from '@/components/ui'

import { type EditorState, newVariantPath, variantPath } from './paths'
import { VariantForm } from './VariantEditorPage'

type SingleVariantSectionProps = {
  product: Product
  /** The product's one variant. */
  variant: Variant
  category: Category | undefined
  /** The product form has unsaved changes: adding a variant waits for the save (D88). */
  locked: boolean
  linkState: EditorState
  onDirtyChange: (dirty: boolean) => void
  /** After a save: the page shows its "Saved." notice. */
  onSaved: () => void
  onLeave: () => void
}

/**
 * A product with exactly one variant shows that variant's price, SKU, image
 * and attribute values on the product page itself; "Add variant" leads to the
 * variant list (D449).
 */
export function SingleVariantSection({ product, variant, category, locked, linkState, onDirtyChange, onSaved, onLeave }: SingleVariantSectionProps) {
  const { t } = useTranslation('products')
  const queryClient = useQueryClient()
  const [generation, setGeneration] = useState(0)
  const [dirty, setDirty] = useState(false)
  const productKey = getGetProductQueryKey(product.id)
  const blocked = locked || dirty

  const saved = (updated: Variant) => {
    queryClient.setQueryData(productKey, (p: Product | undefined) =>
      p ? { ...p, variants: p.variants.map((v) => (v.id === updated.id ? updated : v)) } : p,
    )
    // Capabilities and the "Still missing" lines are computed from the variant: fetched again.
    void queryClient.invalidateQueries({ queryKey: productKey })
    onSaved()
    setGeneration((g) => g + 1)
  }
  // Gone (e.g. a second variant turned the section into the list): its unsaved state goes with it.
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange
  })
  useEffect(() => () => onDirtyChangeRef.current(false), [])
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: productKey })
    setGeneration((g) => g + 1)
  }

  const actions = (
    <>
      <Button asChild size="sm" variant="secondary">
        <Link to={variantPath(product.id, variant.id)} state={linkState}>
          <Pencil /> {t('single.open')}
        </Link>
      </Button>
      {product.can.update &&
        (blocked ? (
          <Button size="sm" disabled title={t('variants.saveFirst')}>
            <Plus /> {t('variants.add')}
          </Button>
        ) : (
          <Button asChild size="sm">
            <Link to={newVariantPath(product.id)} state={linkState}>
              <Plus /> {t('variants.add')}
            </Link>
          </Button>
        ))}
    </>
  )

  return (
    <VariantForm
      key={`${variant.id}:${generation}`}
      product={product}
      item={variant}
      category={category}
      readOnly={!variant.can.update}
      dirty={dirty}
      listState={linkState}
      onReload={reload}
      onSaved={saved}
      onDirtyChange={(changed) => {
        setDirty(changed)
        onDirtyChange(changed)
      }}
      onLeave={onLeave}
      embedded={{ actions }}
    />
  )
}
