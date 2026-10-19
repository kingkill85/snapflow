import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import type { BusLineNetwork } from '@/api/generated/model'
import { useCreateBusLine, useUpdateBusLine } from '@/api/generated/networks/networks'
import { apiFields, errorKey, ErrorMessage, Field, FormDialog, setApiFieldErrors, useFieldError } from '@/components/ui'

import { useRefreshNetworks } from './refresh'

const schema = z.object({
  name: z.string().trim().min(1, errorKey('validation.required')).max(100, errorKey('validation.too_long', { max: 100 })),
  address: z.string().trim().max(50, errorKey('validation.too_long', { max: 50 })),
  // Empty = the system's default (busDevicesMax); else a whole number 1-10000.
  devicesMax: z
    .string()
    .trim()
    .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 10000), errorKey('validation.range', { min: 1, max: 10000 })),
})
type FormValues = z.infer<typeof schema>

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  versionId: string
  /** The bus system a new line belongs to. */
  productTypeId: string
  /** null = a new line. */
  item: BusLineNetwork | null
}

/** Name (unique per system), optional address and device limit of a bus line. */
export function LineDialog({ open, onOpenChange, versionId, productTypeId, item }: Props) {
  const { t } = useTranslation('networks')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const refresh = useRefreshNetworks(versionId)
  const create = useCreateBusLine()
  const update = useUpdateBusLine()
  const mutation = item ? update : create
  const fields = apiFields<FormValues>(['name', 'address', 'devicesMax'])
  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  useEffect(() => {
    if (!open) return
    reset({ name: item?.name ?? '', address: item?.address ?? '', devicesMax: item?.devicesMax == null ? '' : String(item.devicesMax) })
    resetCreate()
    resetUpdate()
    // Only when the dialog opens or switches line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id, reset, resetCreate, resetUpdate])

  const submit = form.handleSubmit(async (v) => {
    try {
      const devicesMax = v.devicesMax === '' ? null : Number(v.devicesMax)
      if (item) await update.mutateAsync({ versionId, id: item.id, data: { name: v.name, address: v.address, devicesMax } })
      else await create.mutateAsync({ versionId, data: { productTypeId, name: v.name, ...(v.address ? { address: v.address } : {}), devicesMax } })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      return // shown by ErrorMessage via mutation.error
    }
    await refresh()
    onOpenChange(false)
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('lineDialog.editTitle') : t('lineDialog.newTitle')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={mutation.error} fields={fields} />}
    >
      <Field label={t('lineDialog.name')} autoComplete="off" required error={fieldError(errors.name?.message)} {...form.register('name')} />
      <Field
        label={t('lineDialog.address')}
        autoComplete="off"
        hint={t('lineDialog.addressHint')}
        error={fieldError(errors.address?.message)}
        {...form.register('address')}
      />
      <Field
        label={t('lineDialog.devicesMax')}
        autoComplete="off"
        inputMode="numeric"
        hint={t('lineDialog.devicesMaxHint')}
        error={fieldError(errors.devicesMax?.message)}
        {...form.register('devicesMax')}
      />
    </FormDialog>
  )
}
