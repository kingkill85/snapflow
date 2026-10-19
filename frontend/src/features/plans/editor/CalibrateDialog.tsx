import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { distance, type Point } from '@/canvas'
import { Field, FormDialog } from '@/components/ui'

import { parseMetres, scaleFrom } from './calibration'

type Props = {
  /** The two picked points; null = closed. */
  points: [Point, Point] | null
  onClose: () => void
  onScale: (scale: number) => void
}

/** Asks for the real distance between the two picked points (metres, "3,5" or "3.5", D144). */
export function CalibrateDialog({ points, onClose, onScale }: Props) {
  const { t } = useTranslation('plans')
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const close = () => {
    setText('')
    setError(undefined)
    onClose()
  }
  const submit = () => {
    const metres = parseMetres(text)
    const scale = points && metres !== undefined ? scaleFrom(points[0], points[1], metres) : undefined
    if (scale === undefined) {
      setError(t('calibrate.invalid'))
      return
    }
    onScale(scale)
    close()
  }
  return (
    <FormDialog open={points !== null} onOpenChange={(open) => !open && close()} title={t('calibrate.title')} submitLabel={t('calibrate.apply')} submitting={false} onSubmit={submit}>
      <p className="text-sm text-muted">{t('calibrate.pixels', { px: points ? Math.round(distance(points[0], points[1])) : 0 })}</p>
      <Field
        label={t('calibrate.distance')}
        required
        inputMode="decimal"
        autoFocus
        suffix="m"
        value={text}
        error={error}
        hint={t('calibrate.hint')}
        onChange={(e) => setText(e.target.value)}
      />
    </FormDialog>
  )
}
