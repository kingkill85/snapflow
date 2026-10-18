import { describe, expect, it } from 'vitest'

import { languages, resources } from './resources'

function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key))
}

describe('locales', () => {
  it.each(Object.keys(resources.en))('%s has the same keys in every language', (namespace) => {
    const reference = keys(resources.en[namespace as keyof typeof resources.en]).sort()
    for (const lng of languages) {
      expect(keys(resources[lng][namespace as keyof (typeof resources)[typeof lng]]).sort(), lng).toEqual(reference)
    }
  })

  it('every language has every namespace', () => {
    for (const lng of languages) expect(Object.keys(resources[lng]).sort()).toEqual(Object.keys(resources.en).sort())
  })
})
