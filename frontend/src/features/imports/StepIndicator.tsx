import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

const steps = ['upload', 'mapping', 'preview', 'result'] as const
export type Step = (typeof steps)[number]

/** Where the import stands: Upload → Mapping → Preview → Result. */
export function StepIndicator({ current }: { current: Step }) {
  const { t } = useTranslation('imports')
  const index = steps.indexOf(current)
  return (
    <ol aria-label={t('steps.label')} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {steps.map((step, i) => {
        const done = i < index
        const active = i === index
        return (
          <li key={step} aria-current={active ? 'step' : undefined} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden="true" className={cn('h-px w-4 sm:w-8', i <= index ? 'bg-primary' : 'bg-line')} />}
            <span
              aria-hidden="true"
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums [&_svg]:size-3.5',
                done ? 'border-primary bg-primary text-primary-ink' : active ? 'border-primary text-primary' : 'border-line text-muted',
              )}
            >
              {done ? <Check /> : i + 1}
            </span>
            {/* On phones only the current step is named, so the steps stay on one line. */}
            <span className={cn(active ? 'font-semibold' : 'sr-only text-muted sm:not-sr-only')}>
              {t(`steps.${step}`)}
              {done && <span className="sr-only"> ({t('steps.done')})</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
