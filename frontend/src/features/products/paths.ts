import { ApiError } from '@/api/client'
import { useListProductTypes } from '@/api/generated/product-types/product-types'

export const listPath = '/catalog/products'
export const productPath = (id: string) => `${listPath}/${id}`
export const newVariantPath = (productId: string) => `${productPath(productId)}/variants/new`
export const variantPath = (productId: string, variantId: string) => `${productPath(productId)}/variants/${variantId}`

/** Editors never start from cached data (D44): fetched on every visit, never refreshed underneath the form. */
export const fresh = { staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false } as const

/** Every product type with its current schema, fresh for an editor. */
export const useFreshProductTypes = () => useListProductTypes({ includeInactive: true }, { query: fresh })

/** A missing record, or an id that is not one (422 at path.*). */
export const isNotFound = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || (error.status === 422 && error.fields.some((f) => f.location.startsWith('path.'))))

/** Messages an editor shows after a save that stays on the page. */
export type SaveNotice = 'created' | 'saved'
export const noticeFrom = (state: unknown): SaveNotice | null =>
  typeof state === 'object' && state !== null && 'notice' in state && (state.notice === 'created' || state.notice === 'saved') ? state.notice : null
