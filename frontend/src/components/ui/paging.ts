/** The offset of the last page of `total` rows of `limit` each (0 without rows). */
export const lastPageOffset = (total: number, limit: number) => Math.max(0, Math.ceil(total / limit) - 1) * limit
