import { afterEach, describe, expect, it, vi } from 'vitest'

import { downloadGap, startDownloads } from './format'

describe('startDownloads', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts several downloads one after another', () => {
    vi.useFakeTimers()
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute('href') ?? '')
    })
    startDownloads(['/a', '/b', '/c'])
    expect(clicked).toEqual(['/a'])
    vi.advanceTimersByTime(downloadGap)
    expect(clicked).toEqual(['/a', '/b'])
    vi.advanceTimersByTime(downloadGap)
    expect(clicked).toEqual(['/a', '/b', '/c'])
  })
})
