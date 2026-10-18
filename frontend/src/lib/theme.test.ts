import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { initTheme, setTheme, useTheme } from './theme'

afterEach(() => {
  setTheme('system')
  vi.restoreAllMocks()
})

describe('theme', () => {
  it('applies the choice on <html data-theme> and remembers it', () => {
    const { result } = renderHook(() => useTheme())
    expect(result.current[0]).toBe('system')
    expect(document.documentElement).not.toHaveAttribute('data-theme')

    act(() => result.current[1]('dark'))
    expect(result.current[0]).toBe('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(localStorage.getItem('theme')).toBe('dark')

    // System follows prefers-color-scheme: no attribute, nothing stored.
    act(() => result.current[1]('system'))
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(localStorage.getItem('theme')).toBeNull()
  })

  it('restores the remembered theme and ignores unknown values', () => {
    localStorage.setItem('theme', 'light')
    initTheme()
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')

    localStorage.setItem('theme', 'neon')
    initTheme()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })

  it('still switches when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    setTheme('dark')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    initTheme()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })
})
