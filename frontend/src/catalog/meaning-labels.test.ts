import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CatalogFieldMeaning } from '@/api/generated/model'
import i18n from '@/i18n'
import { languages } from '@/i18n/resources'

import { useDescribeMeaning } from './meaning-labels'

describe('useDescribeMeaning', () => {
  const meanings = ['', ...Object.values(CatalogFieldMeaning)]

  it.each(languages)('every meaning the API knows has a title, a line and an example in %s', async (lng) => {
    await i18n.changeLanguage(lng)
    const { result } = renderHook(() => useDescribeMeaning())
    for (const m of meanings) {
      const d = result.current(m)
      expect(d.title, `${lng} ${m} title`).not.toBe(m || 'none')
      expect(d.description, `${lng} ${m} description`).not.toBe('')
      expect(d.example, `${lng} ${m} example`).not.toBe('')
    }
    await i18n.changeLanguage('en')
  })

  it('reads plain words', () => {
    const { result } = renderHook(() => useDescribeMeaning())
    expect(result.current('rail_width_te')).toEqual({ title: 'Width on the rail (TE)', description: 'In TE (17.5 mm); used for the board\'s capacity', example: '4 TE' })
    expect(result.current(undefined).title).toBe('Just information')
  })
})
