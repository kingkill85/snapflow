import type { ImportChange } from '@/api/generated/model'

// Pure helpers of the diff and the change log.

/** "4–6, 9" for rows 4, 5, 6 and 9. */
export function compactRows(rows: number[]): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]))
    i = j
  }
  return parts.join(', ')
}

type FieldDiff = { field: string; before: unknown; after: unknown }

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
/** Bookkeeping fields of the stored state: not shown. */
const hidden = new Set(['id', 'updatedAt', 'addonsUpdatedAt', 'productId', 'sortOrder', 'variants', 'addons', 'refs'])
/** Fields stored as objects whose keys are shown one by one. */
const nested = new Set(['name', 'description', 'attributes'])

/** The fields a change log entry changed, from the stored states before and after. */
export function changedFields(change: ImportChange): FieldDiff[] {
  const before = isObject(change.before) ? change.before : {}
  const after = isObject(change.after) ? change.after : {}
  if (change.entity === 'addons') {
    const refs = (s: Record<string, unknown>) => (Array.isArray(s.refs) ? s.refs : [])
    return [{ field: 'addons', before: change.before ? refs(before) : undefined, after: refs(after) }]
  }
  const out: FieldDiff[] = []
  const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])]
  for (const key of keys) {
    if (hidden.has(key)) continue
    if (nested.has(key)) {
      const b = isObject(before[key]) ? before[key] : {}
      const a = isObject(after[key]) ? after[key] : {}
      for (const sub of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const field = `${key === 'attributes' ? 'attributes' : key}.${sub}`
        if (!same(b[sub], a[sub])) out.push({ field, before: b[sub], after: a[sub] })
      }
      continue
    }
    if (!same(before[key], after[key])) out.push({ field: key, before: before[key], after: after[key] })
  }
  return out.sort((a, b) => rank(a.field) - rank(b.field))
}

/** Fields in the order the editors show them; attributes after the basics, the status last. */
const order = ['key', 'modelNumber', 'productTypeId', 'categoryId', 'name', 'description', 'sku', 'price', 'imageFileId', 'attributes', 'isActive']
const rank = (field: string) => {
  const i = order.indexOf(field.split('.')[0])
  return i < 0 ? order.length - 1 : i
}

