import '@testing-library/jest-dom/vitest'
import '@/i18n'

import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'

import i18n from '@/i18n'

import { server } from './server'

// jsdom lacks what Radix Select and DropdownMenu call while opening.
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.scrollIntoView ??= () => {}

beforeAll(async () => {
  server.listen({ onUnhandledFrame: 'error' })
  await i18n.changeLanguage('en')
})
afterEach(() => {
  cleanup()
  server.resetHandlers()
})
afterAll(() => server.close())
