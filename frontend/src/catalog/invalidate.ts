import type { QueryClient } from '@tanstack/react-query'

import { getListProductsQueryKey, getSearchVariantsQueryKey } from '@/api/generated/products/products'

/**
 * After a product type or category changed (renamed, badge, (de)activated,
 * reordered, deleted): products embed both (name, badge, availability, catalog
 * order), so the product list, the variant search (add-on picker) and every
 * loaded product refetch. Editors open on a product keep their form (D44).
 */
export async function invalidateProductQueries(queryClient: QueryClient) {
  const products = getListProductsQueryKey()[0]
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getSearchVariantsQueryKey() }),
    // Product details: `/api/products/{id}`.
    queryClient.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith(`${products}/`),
    }),
  ])
}
