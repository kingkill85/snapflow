import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import { useListFunctionTypes } from '@/api/generated/function-types/function-types'
import type { OutputKind, OutputKindInput } from '@/api/generated/model'
import {
  getListOutputKindsQueryKey,
  useCreateOutputKind,
  useListOutputKinds,
  useUpdateOutputKind,
} from '@/api/generated/output-kinds/output-kinds'
import {
  apiFields,
  CheckboxGroupField,
  errorKey,
  ErrorMessage,
  Field,
  FormDialog,
  FormSelectField,
  FormTranslatableField,
  fromTranslatable,
  setApiFieldErrors,
  SwitchField,
  toTranslatable,
  translatableApiFields,
  translatableSchema,
  useFieldError,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { StaleReload } from './StaleReload'

const schema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, errorKey('output_kind.key_format'))
      .max(64, errorKey('validation.too_long', { max: 64 })),
    name: translatableSchema({
      max: 100,
      required: errorKey('validation.required'),
    }),
    functionTypeIds: z.array(z.string()),
    alternativeKindId: z.string(),
    alternativeCount: z.string(),
    isActive: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (!v.alternativeKindId) return
    const n = Number(v.alternativeCount)
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      ctx.addIssue({
        code: 'custom',
        path: ['alternativeCount'],
        message: errorKey('validation.range', { min: 1, max: 16 }),
      })
    }
  })
type FormValues = z.infer<typeof schema>

const fields = {
  ...apiFields<FormValues>(['key', 'functionTypeIds', 'isActive'], {
    alternative: 'alternativeKindId',
    'alternative.outputKindId': 'alternativeKindId',
    'alternative.count': 'alternativeCount',
  }),
  ...translatableApiFields('name'),
}

const toFormValues = (item: OutputKind | null): FormValues => ({
  key: item?.key ?? '',
  name: toTranslatable(item?.name),
  functionTypeIds: item?.functionTypeIds ?? [],
  alternativeKindId: item?.alternative?.outputKindId ?? '',
  alternativeCount: String(item?.alternative?.count ?? 2),
  isActive: item?.isActive ?? true,
})

const toInput = (v: FormValues): OutputKindInput => ({
  key: v.key,
  name: fromTranslatable(v.name),
  functionTypeIds: v.functionTypeIds,
  ...(v.alternativeKindId
    ? {
        alternative: {
          outputKindId: v.alternativeKindId,
          count: Number(v.alternativeCount),
        },
      }
    : {}),
  isActive: v.isActive,
})

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: OutputKind | null
  onSaved: () => Promise<unknown>
}

/**
 * Creates or edits an output kind (dimmer output, relay output, …): the
 * function types its channels serve and an optional alternative ("2 relay
 * outputs act as 1 blind output").
 */
export function OutputKindFormDialog({ open, onOpenChange, item, onSaved }: Props) {
  const { t } = useTranslation('capabilities')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const localized = useLocalized()
  const queryClient = useQueryClient()
  const create = useCreateOutputKind()
  const update = useUpdateOutputKind()
  const mutation = item ? update : create
  const functionTypes = useListFunctionTypes({ query: { enabled: open } })
  const kinds = useListOutputKinds({ includeInactive: true }, { query: { enabled: open } })
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: toFormValues(item),
  })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  useEffect(() => {
    if (!open) return
    reset(toFormValues(item))
    resetCreate()
    resetUpdate()
  }, [open, item, reset, resetCreate, resetUpdate])

  const alternativeKindId = useWatch({
    control: form.control,
    name: 'alternativeKindId',
  })

  const submit = form.handleSubmit(async (values) => {
    const data = toInput(values)
    try {
      if (item)
        await update.mutateAsync({
          id: item.id,
          data: { ...data, expectedUpdatedAt: item.updatedAt },
        })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      if (error instanceof ApiError && error.code === 'output_kind.key_taken') {
        form.setError('key', {
          type: 'server',
          message: errorKey('output_kind.key_taken', { key: values.key }),
        })
      }
      return
    }
    await onSaved()
    onOpenChange(false)
  })

  const functionTypeOptions = (functionTypes.data?.items ?? []).map((f) => ({
    value: f.id,
    label: localized(f.name),
  }))
  const kindOptions = [
    { value: '', label: t('outputKinds.noAlternative') },
    ...(kinds.data?.items ?? []).filter((k) => k.id !== item?.id).map((k) => ({ value: k.id, label: localized(k.name) })),
  ]

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('outputKinds.edit') : t('outputKinds.new')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={
        <ErrorMessage
          error={mutation.error}
          fields={fields}
          action={
            <StaleReload
              error={mutation.error}
              code="output_kind.stale"
              onReload={async () => {
                await queryClient.invalidateQueries({
                  queryKey: getListOutputKindsQueryKey(),
                })
                onOpenChange(false)
              }}
            />
          }
        />
      }
    >
      <Field
        label={t('field.key')}
        hint={t('outputKinds.keyHint')}
        required
        autoComplete="off"
        error={fieldError(errors.key?.message)}
        {...form.register('key')}
      />
      <FormTranslatableField control={form.control} name="name" label={t('field.name')} required />
      <Controller
        control={form.control}
        name="functionTypeIds"
        render={({ field }) => (
          <CheckboxGroupField
            label={t('outputKinds.functionTypes')}
            hint={t('outputKinds.functionTypesHint')}
            options={functionTypeOptions}
            value={field.value}
            onChange={field.onChange}
            error={fieldError(errors.functionTypeIds?.message)}
          />
        )}
      />
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <FormSelectField
          control={form.control}
          name="alternativeKindId"
          label={t('outputKinds.alternative')}
          hint={t('outputKinds.alternativeHint')}
          options={kindOptions}
          error={fieldError(errors.alternativeKindId?.message)}
        />
        {alternativeKindId && (
          <Field
            label={t('outputKinds.alternativeCount')}
            hint={t('outputKinds.alternativeCountHint')}
            type="number"
            min={1}
            max={16}
            required
            error={fieldError(errors.alternativeCount?.message)}
            {...form.register('alternativeCount')}
          />
        )}
      </div>
      <SwitchField label={t('field.active')} hint={t('outputKinds.activeHint')} {...form.register('isActive')} />
    </FormDialog>
  )
}
