import '@testing-library/jest-dom/vitest'
import '@/i18n'

import { cleanup, configure } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'

import i18n from '@/i18n'

import { server } from './server'

// `make check` runs the Go tests alongside: under that load the first render
// of a page (lazy chunks, MSW) can take longer than the default 1 s that
// findBy and waitFor wait (seen with PreviewStep.test.tsx).
configure({ asyncUtilTimeout: 5_000 })

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
