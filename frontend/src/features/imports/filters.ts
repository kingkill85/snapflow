import { useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { lastPageOffset } from '@/components/ui'

import { pageSize } from './paths'

// The lists of a run page (diff, issues, change log) keep their filters and
// pages in the URL, each list under its own names, so a link or a reload
// shows the same thing. A change can name the section to show (the URL's
// hash), which is then scrolled into view.

/** The id of the issues section, for links to it. */
export const issuesSection = 'issues'
/** The id of the diff section, and of one item in it. */
export const changesSection = 'changes'
export const itemAnchor = (seq: number) => `item-${seq}`

type FilterOptions = {
  /** The page parameter to start over (default "offset"); '' keeps every page. */
  reset?: string
  /** The id of the section (or item) to scroll to. */
  section?: string
}

/** The search parameters with their values changed ('' or '0' removes one). */
function changed(search: string, changes: Record<string, string>, reset: string) {
  const next = new URLSearchParams(search)
  if (reset) next.delete(reset)
  for (const [name, value] of Object.entries(changes)) {
    if (value === '' || value === '0') next.delete(name)
    else next.set(name, value)
  }
  return next.toString()
}

export function useFilters() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useMemo(() => new URLSearchParams(location.search), [location.search])
  /** A link to the page with these filters, e.g. a counter's. */
  const href = (changes: Record<string, string>, { reset = 'offset', section }: FilterOptions = {}) => {
    const search = changed(location.search, changes, reset)
    return `${search ? `?${search}` : '?'}${section ? `#${section}` : ''}`
  }
  const setFilters = (changes: Record<string, string>, { reset = 'offset', section }: FilterOptions = {}) => {
    const search = changed(location.search, changes, reset)
    void navigate({ search: search ? `?${search}` : '', hash: section ? `#${section}` : '' }, { replace: true })
  }
  return { params, href, setFilters }
}

/** A page offset from the URL (0 if missing or invalid). */
export const offsetOf = (params: URLSearchParams, name: string) => Math.max(0, Math.floor(Number(params.get(name))) || 0)

/**
 * An offset past the end (the list got shorter, e.g. after "Preview again",
 * or the URL says so) moves to the last page.
 */
export function useClampOffset(total: number | undefined, offset: number, name: string, setFilters: ReturnType<typeof useFilters>['setFilters']) {
  useEffect(() => {
    if (total === undefined || offset === 0 || offset < total) return
    setFilters({ [name]: total > 0 ? String(lastPageOffset(total, pageSize)) : '' }, { reset: '' })
    // setFilters changes with every render; the numbers decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, offset, name])
}

/**
 * Scrolls the element the URL's hash names into view once it is there
 * (`ready`, e.g. the list loaded), once per navigation; `owns` says which
 * hashes this section handles.
 */
export function useScrollToHash(owns: (id: string) => boolean, ready: boolean) {
  const location = useLocation()
  const done = useRef<string | null>(null)
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1))
    if (!id || !ready || done.current === location.key || !owns(id)) return
    const target = document.getElementById(id)
    if (!target) return
    done.current = location.key
    target.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  })
}
