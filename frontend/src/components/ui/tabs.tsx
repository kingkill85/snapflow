import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react'

import { cn } from '@/lib/cn'

export type TabItem<K extends string> = { key: K; label: string; content: ReactNode }

type TabsProps<K extends string> = {
  /** Accessible name of the tab list. */
  label: string
  tabs: TabItem<K>[]
  value: K
  onValueChange: (key: K) => void
  className?: string
}

/**
 * Tabs with panels (WAI-ARIA tabs pattern): arrow keys, Home and End move
 * between tabs; only the active panel is rendered. Used e.g. by the plan
 * editor's side panel.
 */
export function Tabs<K extends string>({ label, tabs, value, onValueChange, className }: TabsProps<K>) {
  const id = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const active = tabs.find((t) => t.key === value) ?? tabs[0]

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
      <div role="tablist" aria-label={label} className="flex shrink-0 gap-1 border-b border-line px-2">
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
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                selected ? 'border-primary text-ink' : 'border-transparent text-muted hover:text-ink',
              )}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {active && (
        <div role="tabpanel" id={`${id}-panel-${active.key}`} aria-labelledby={`${id}-tab-${active.key}`} className="min-h-0 flex-1 overflow-y-auto p-3">
          {active.content}
        </div>
      )}
    </div>
  )
}
