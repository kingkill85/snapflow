import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react'

import { cn } from '@/lib/cn'

export type TabItem<K extends string> = { key: K; label: string; content: ReactNode }

type TabsProps<K extends string> = {
  /** Accessible name of the tab list. */
  label: string
  tabs: TabItem<K>[]
  value: K
  onValueChange: (key: K) => void
  className?: string
  /** Replaces the panel's padding, e.g. for page-level tabs (default `p-3`). */
  panelClassName?: string
}

/**
 * Tabs with panels (WAI-ARIA tabs pattern): arrow keys, Home and End move
 * between tabs; only the active panel is rendered. Used e.g. by the plan
 * editor's side panel.
 */
export function Tabs<K extends string>({ label, tabs, value, onValueChange, className, panelClassName }: TabsProps<K>) {
  const id = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const active = tabs.find((t) => t.key === value) ?? tabs[0]
  const activeIndex = active ? tabs.indexOf(active) : -1

  // On narrow screens the tab list scrolls inside its own box: keep the
  // selected tab in view (e.g. opened by a ?tab= link).
  useEffect(() => {
    const el = refs.current[activeIndex]
    const list = el?.parentElement
    if (!el || !list || list.scrollWidth <= list.clientWidth) return
    const left = el.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft
    if (left < list.scrollLeft) list.scrollLeft = left
    else if (left + el.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + el.offsetWidth - list.clientWidth
  }, [activeIndex])

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const last = tabs.length - 1
    const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[e.key]
    if (next === undefined) return
    e.preventDefault()
    onValueChange(tabs[next].key)
    refs.current[next]?.focus()
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div role="tablist" aria-label={label} className="flex shrink-0 overflow-x-auto border-b border-line px-1">
        {tabs.map((tab, index) => {
          const selected = tab.key === active?.key
          return (
            <button
              key={tab.key}
              ref={(el) => {
                refs.current[index] = el
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`${id}-panel-${tab.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onValueChange(tab.key)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                '-mb-px shrink-0 border-b-2 px-2 py-2 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                selected ? 'border-primary text-ink' : 'border-transparent text-muted hover:text-ink',
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {active && (
        <div role="tabpanel" id={`${id}-panel-${active.key}`} aria-labelledby={`${id}-tab-${active.key}`} className={cn('min-h-0 flex-1 overflow-y-auto', panelClassName ?? 'p-3')}>
          {active.content}
        </div>
      )}
    </div>
  )
}
