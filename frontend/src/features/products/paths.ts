import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { ApiError } from '@/api/client'
import { useListCategories } from '@/api/generated/categories/categories'
import { useListProductTypes } from '@/api/generated/product-types/product-types'

export const listPath = '/catalog/products'
export const productPath = (id: string) => `${listPath}/${id}`
export const newVariantPath = (productId: string) => `${productPath(productId)}/variants/new`
export const variantPath = (productId: string, variantId: string) => `${productPath(productId)}/variants/${variantId}`

/** Editors never start from cached data (D44): fetched on every visit, never refreshed underneath the form. */
export const fresh = { staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false } as const

/** Every product type, fresh for an editor. */
export const useFreshProductTypes = () => useListProductTypes({ includeInactive: true }, { query: fresh })

/** Every category with its current schema, fresh for an editor. */
export const useFreshCategories = () => useListCategories({ includeInactive: true }, { query: fresh })

/** A missing record, or an id that is not one (422 at path.*). */
export const isNotFound = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || (error.status === 422 && error.fields.some((f) => f.location.startsWith('path.'))))

/** Messages an editor shows after a save that stays on the page. */
export type SaveNotice = 'created' | 'saved'

/**
 * Navigation state of the product and variant pages: the product list's
 * query string ("?search=…&type=…") to return to (D86), and a notice after a
 * save that continues on another page.
 */
export type EditorState = { listSearch?: string; notice?: SaveNotice }

const stateOf = (state: unknown): Record<string, unknown> => (typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {})

export const noticeFrom = (state: unknown): SaveNotice | null => {
  const { notice } = stateOf(state)
  return notice === 'created' || notice === 'saved' ? notice : null
}

/** The list's query string passed along in the navigation state, or "" for the bare list. */
export const listSearchFrom = (state: unknown): string => {
  const { listSearch } = stateOf(state)
  return typeof listSearch === 'string' && listSearch.startsWith('?') ? listSearch : ''
}

/** The product list with the filters it was left with. */
export const listHref = (listSearch: string) => `${listPath}${listSearch}`

/**
 * The notice an editor shows after a save that continued on its page (from
 * the navigation state), with a setter to end it. The notice is removed from
 * the history entry once read, so a reload of the page does not show it again.
 */
export function useSaveNotice() {
  const location = useLocation()
  const navigate = useNavigate()
  const [notice, setNotice] = useState<SaveNotice | null>(() => noticeFrom(location.state))
  useEffect(() => {
    if (noticeFrom(location.state) === null) return
    const { notice: _read, ...rest } = stateOf(location.state)
    void navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: rest })
  }, [location, navigate])
  return [notice, setNotice] as const
}
