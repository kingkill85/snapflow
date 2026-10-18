import { afterEach, describe, expect, it } from 'vitest'

import i18n from '@/i18n'

describe('document language', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('follows the UI language', async () => {
    await i18n.changeLanguage('de')
    expect(document.documentElement.lang).toBe('de')
    await i18n.changeLanguage('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
