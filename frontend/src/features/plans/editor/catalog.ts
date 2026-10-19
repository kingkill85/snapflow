import { useQuery } from '@tanstack/react-query'

import type { CategoryRef, PlanPlacement, ProductTypeRef, VariantSearchItem } from '@/api/generated/model'
import { searchVariants } from '@/api/generated/products/products'
import type { Size } from '@/canvas'
import { fileUrl } from '@/catalog/files'
import type { LocalizedText } from '@/i18n/localized'

/** The drag data type of a palette product (floorplan canvas, board rails). */
export const productDragType = 'application/x-snapflow-product'

/** The palette product being dragged: drag data is only readable on drop, the board's drop preview needs its width before. */
export const paletteDrag: { productId: string | null } = { productId: null }

const pageSize = 200

/**
 * Every catalog variant, active or not (the canvas resolves placed variants,
 * the palette offers the available ones of the project's product types).
 * Loaded once per editor in pages of 200 (D203).
 */
export function useCatalogVariants() {
  return useQuery({
    queryKey: ['/api/variants', 'plan-editor'],
    queryFn: async ({ signal }) => {
      const items: VariantSearchItem[] = []
      for (;;) {
        const page = await searchVariants({ limit: pageSize, offset: items.length }, signal)
        items.push(...page.items)
        if (page.items.length < pageSize || items.length >= page.total) return items
      }
    },
    staleTime: 5 * 60_000,
  })
}

/** A product of the palette with its variants. */
export type PaletteProduct = {
  productId: string
  name: LocalizedText
  modelNumber: string
  productType: ProductTypeRef
  category: CategoryRef
  variants: VariantSearchItem[]
  /** The first available variant: placed by default. */
  defaultVariant: VariantSearchItem
  imageUrl?: string
}

export type PaletteGroup = { category: CategoryRef; products: PaletteProduct[] }

/** The products to offer: available variants of the project's product types, by product, in catalog order. */
export function paletteProducts(variants: VariantSearchItem[], productTypeIds: string[]): PaletteProduct[] {
  const types = new Set(productTypeIds)
  const products = new Map<string, PaletteProduct>()
  for (const v of variants) {
    if (!v.available || !types.has(v.productTypeId)) continue
    const product = products.get(v.productId)
    if (product) {
      product.variants.push(v)
      product.imageUrl ??= fileUrl(v.imageFileId)
    } else {
      products.set(v.productId, {
        productId: v.productId,
        name: v.productName,
        modelNumber: v.modelNumber,
        productType: v.productType,
        category: v.category,
        variants: [v],
        defaultVariant: v,
        imageUrl: fileUrl(v.imageFileId),
      })
    }
  }
  return [...products.values()]
}

/** Products grouped by category (first appearance order), filtered by a search over names, model number and SKU. */
export function groupPalette(products: PaletteProduct[], search: string, localize: (t: LocalizedText | undefined) => string): PaletteGroup[] {
  const q = search.trim().toLocaleLowerCase()
  const matches = (p: PaletteProduct) =>
    !q ||
    [localize(p.name), p.modelNumber, ...p.variants.flatMap((v) => [localize(v.name), v.sku ?? ''])].some((s) => s.toLocaleLowerCase().includes(q))
  const groups = new Map<string, PaletteGroup>()
  for (const p of products) {
    if (!matches(p)) continue
    const group = groups.get(p.category.id) ?? { category: p.category, products: [] }
    group.products.push(p)
    groups.set(p.category.id, group)
  }
  return [...groups.values()]
}

/** Height of a product placed for the first time, in image pixels. */
export const defaultPlacementHeight = 60

/**
 * The size of a new placement of a product: the size its last placement in
 * the loaded plans had (array order = last drawn), else 60 px high at the
 * aspect ratio of the variant image (square without one).
 */
export function defaultPlacementSize(
  productId: string,
  placements: PlanPlacement[],
  variantsById: Map<string, VariantSearchItem>,
  imageAspect: number | undefined,
): Size {
  for (let i = placements.length - 1; i >= 0; i--) {
    const p = placements[i]
    if (p.variantId && variantsById.get(p.variantId)?.productId === productId) return { width: p.width, height: p.height }
  }
  const aspect = imageAspect && Number.isFinite(imageAspect) && imageAspect > 0 ? imageAspect : 1
  return { width: Math.round(defaultPlacementHeight * aspect), height: defaultPlacementHeight }
}

const aspects = new Map<string, Promise<number | undefined>>()

/** The width:height ratio of an image (cached per URL); undefined if it does not load. */
export function imageAspect(url: string | undefined): Promise<number | undefined> {
  if (!url) return Promise.resolve(undefined)
  let pending = aspects.get(url)
  if (!pending) {
    pending = new Promise((resolve) => {
      const image = new window.Image()
      image.onload = () => resolve(image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : undefined)
      image.onerror = () => resolve(undefined)
      image.src = url
    })
    aspects.set(url, pending)
  }
  return pending
}
