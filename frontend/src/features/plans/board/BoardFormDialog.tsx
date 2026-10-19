import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import type { Plan } from '@/api/generated/model'
import { createBoard } from '@/api/generated/plans/plans'
import { formatDecimal, useDecimalSeparator } from '@/catalog/decimal'
import { apiFields, Button, errorKey, ErrorMessage, Field, FormDialog, IconButton, SelectField, setApiFieldErrors, useFieldError } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { updatePlanWithImage } from '../api'
import { useCatalogVariants } from '../editor/catalog'
import { enclosureSize, enclosureVariants } from './board'
import { CapacityField } from './BoardPanels'

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, errorKey('validation.required'))
    .max(100, errorKey('validation.too_long', { max: 100 })),
})
type FormValues = z.infer<typeof schema>

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  versionId: string
  productTypeIds: string[]
  /** null = a new board; a board = rename it (rows and enclosure are edited in the board editor). */
  item: Plan | null
  onSaved: (plan: Plan) => void
}

const none = '-'

/** Add a board (name, enclosure or rows × TE) or rename one. */
export function BoardFormDialog({ open, onOpenChange, versionId, productTypeIds, item, onSaved }: Props) {
  const { t } = useTranslation('plans')
  const { t: tc } = useTranslation()
  const localize = useLocalized()
  const separator = useDecimalSeparator()
  const fieldError = useFieldError()
  const fields = apiFields<FormValues>(['name'])
  // The enclosures are only offered when creating a board.
  const catalog = useCatalogVariants({ enabled: open && !item, withCapabilities: true })
  const enclosures = useMemo(() => enclosureVariants(catalog.data ?? [], productTypeIds), [catalog.data, productTypeIds])
  const [enclosure, setEnclosure] = useState(none)
  const [rows, setRows] = useState<number[]>([12])
  // A dialog opened again starts over (adjusted while rendering, not in an effect).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setEnclosure(none)
      setRows([12])
    }
  }

  const mutation = useMutation({
    mutationFn: (name: string) =>
      item
        ? updatePlanWithImage(item, name, undefined)
        : createBoard(versionId, enclosure === none ? { name, rows: rows.map((capacityTe) => ({ capacityTe })) } : { name, enclosureVariantId: enclosure }),
  })
  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { reset } = form
  const { reset: resetMutation } = mutation
  useEffect(() => {
    if (!open) return
    reset({ name: item?.name ?? '' })
    resetMutation()
  }, [open, item, reset, resetMutation])

  const submit = form.handleSubmit(async ({ name }) => {
    let saved: Plan
    try {
      saved = await mutation.mutateAsync(name)
    } catch (e) {
      setApiFieldErrors(e, form.setError, fields)
      return
    }
    onOpenChange(false)
    onSaved(saved)
  })

  const size = enclosure === none ? null : enclosureSize(enclosures.find((v) => v.id === enclosure)?.capabilities)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('boardDialog.editTitle') : t('boardDialog.addTitle')}
      submitLabel={item ? tc('action.update') : tc('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={mutation.error} fields={fields} />}
    >
      <div className="space-y-4">
        <Field label={t('boardDialog.name')} autoComplete="off" required hint={t('boardDialog.nameHint')} error={fieldError(form.formState.errors.name?.message)} {...form.register('name')} />
        {!item && (
          <>
            <SelectField
              label={t('boardDialog.enclosure')}
              value={enclosure}
              hint={size ? t('boardDialog.enclosureSize', { rows: size.rows, te: formatDecimal(size.te, separator) }) : t('boardDialog.enclosureHint')}
              options={[{ value: none, label: t('boardDialog.noEnclosure') }, ...enclosures.map((v) => ({ value: v.id, label: `${localize(v.productName)} – ${localize(v.name)}` }))]}
              onValueChange={setEnclosure}
            />
            {enclosure === none && (
              <fieldset className="space-y-2">
                <legend className="mb-1 text-sm font-medium">{t('boardDialog.rows')}</legend>
                <ul className="space-y-2">
                  {rows.map((capacity, i) => (
                    // Rows have no identity before they are saved: the index is the key.
                    // eslint-disable-next-line react/no-array-index-key
                    <li key={i} className="flex items-end gap-2">
                      <div className="min-w-0 flex-1">
                        <CapacityField label={t('boardDialog.rowCapacity', { n: i + 1 })} value={capacity} onCommit={(n) => setRows(rows.map((c, j) => (j === i ? n : c)))} />
                      </div>
                      <IconButton label={t('boardDialog.removeRow', { n: i + 1 })} icon={<Trash2 />} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
                    </li>
                  ))}
                </ul>
                <Button variant="secondary" size="sm" disabled={rows.length >= 50} onClick={() => setRows([...rows, rows[rows.length - 1] ?? 12])}>
                  <Plus /> {t('boardDialog.addRow')}
                </Button>
              </fieldset>
            )}
          </>
        )}
      </div>
    </FormDialog>
  )
}
