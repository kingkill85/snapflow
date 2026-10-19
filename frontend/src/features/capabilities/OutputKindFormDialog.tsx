import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { Controller, useFieldArray, useForm } from 'react-hook-form'
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
  Button,
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
    // Alternatives: `count` channels of another kind act as one of this kind.
    alternatives: z.array(
      z.object({
        outputKindId: z.string().min(1, errorKey('validation.required')),
        count: z.string().refine((c) => /^\d+$/.test(c.trim()) && Number(c) >= 1 && Number(c) <= 16, errorKey('validation.range', { min: 1, max: 16 })),
      }),
    ),
    isActive: z.boolean(),
  })
  .superRefine((v, ctx) => {
    v.alternatives.forEach((a, i) => {
      if (a.outputKindId && v.alternatives.findIndex((b) => b.outputKindId === a.outputKindId) < i) {
        ctx.addIssue({ code: 'custom', path: ['alternatives', i, 'outputKindId'], message: errorKey('output_kind.alternative_duplicate') })
      }
    })
  })
type FormValues = z.infer<typeof schema>

/** Rows of alternatives the API reports errors at (body.alternatives[i].*). */
const maxAlternatives = 20
const alternativeFields = Object.fromEntries(
  Array.from({ length: maxAlternatives }, (_, i) => [
    [`alternatives[${i}].outputKindId`, `alternatives.${i}.outputKindId`],
    [`alternatives[${i}].count`, `alternatives.${i}.count`],
  ]).flat(),
) as Record<string, never>

const fields = {
  ...apiFields<FormValues>(['key', 'functionTypeIds', 'isActive'], alternativeFields),
  ...translatableApiFields('name'),
}

const toFormValues = (item: OutputKind | null): FormValues => ({
  key: item?.key ?? '',
  name: toTranslatable(item?.name),
  functionTypeIds: item?.functionTypeIds ?? [],
  alternatives: (item?.alternatives ?? []).map((a) => ({ outputKindId: a.outputKindId, count: String(a.count) })),
  isActive: item?.isActive ?? true,
})

const toInput = (v: FormValues): OutputKindInput => ({
  key: v.key,
  name: fromTranslatable(v.name),
  functionTypeIds: v.functionTypeIds,
  // Always sent: left out would clear them (new endpoints, D294 note).
  alternatives: v.alternatives.map((a) => ({ outputKindId: a.outputKindId, count: Number(a.count) })),
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

  const alternatives = useFieldArray({ control: form.control, name: 'alternatives' })

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
  const kindOptions = (kinds.data?.items ?? []).filter((k) => k.id !== item?.id).map((k) => ({ value: k.id, label: localized(k.name) }))

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
      <div className="space-y-3" role="group" aria-label={t('outputKinds.alternatives')}>
        <div>
          <p className="text-sm font-medium">{t('outputKinds.alternatives')}</p>
          <p className="text-sm text-muted">{t('outputKinds.alternativeHint')}</p>
        </div>
        {alternatives.fields.map((row, i) => (
          <div key={row.id} className="grid items-start gap-4 sm:grid-cols-[1fr_10rem_auto]" role="group" aria-label={t('outputKinds.alternativeN', { n: i + 1 })}>
            <FormSelectField
              control={form.control}
              name={`alternatives.${i}.outputKindId`}
              label={t('outputKinds.alternative')}
              placeholder={t('fields.choose')}
              required
              options={kindOptions}
              error={fieldError(errors.alternatives?.[i]?.outputKindId?.message)}
            />
            <Field
              label={t('outputKinds.alternativeCount')}
              hint={t('outputKinds.alternativeCountHint')}
              inputMode="numeric"
              required
              error={fieldError(errors.alternatives?.[i]?.count?.message)}
              {...form.register(`alternatives.${i}.count`)}
            />
            <Button
              variant="danger-quiet"
              className="sm:mt-6"
              aria-label={tCommon('action.removeItem', { item: t('outputKinds.alternativeN', { n: i + 1 }) })}
              onClick={() => alternatives.remove(i)}
            >
              <Trash2 /> {tCommon('action.remove')}
            </Button>
          </div>
        ))}
        {alternatives.fields.length < maxAlternatives && (
          <Button variant="secondary" size="sm" onClick={() => alternatives.append({ outputKindId: '', count: '2' })}>
            <Plus /> {t('outputKinds.addAlternative')}
          </Button>
        )}
      </div>
      <SwitchField label={t('field.active')} hint={t('outputKinds.activeHint')} {...form.register('isActive')} />
    </FormDialog>
  )
}
