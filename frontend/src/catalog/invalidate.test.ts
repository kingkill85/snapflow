import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'

import { getListCategoriesQueryKey } from '@/api/generated/categories/categories'
import { getGetProductQueryKey, getListProductsQueryKey, getSearchVariantsQueryKey } from '@/api/generated/products/products'

import { invalidateProductQueries } from './invalidate'

describe('invalidateProductQueries', () => {
  it('marks the product list, the variant search and every product as stale, nothing else', async () => {
    const client = new QueryClient()
    const keys = {
      list: getListProductsQueryKey({ productTypeId: 'x', limit: 50 }),
      bare: getListProductsQueryKey(),
      search: getSearchVariantsQueryKey({ search: 'grey' }),
      detail: getGetProductQueryKey('p1'),
      categories: getListCategoriesQueryKey(),
    }
    for (const key of Object.values(keys)) client.setQueryData(key, {})

    await invalidateProductQueries(client)

    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated
    expect(stale(keys.list)).toBe(true)
    expect(stale(keys.bare)).toBe(true)
    expect(stale(keys.search)).toBe(true)
    expect(stale(keys.detail)).toBe(true)
    expect(stale(keys.categories)).toBe(false)
  })
})
