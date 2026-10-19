import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect } from 'react'
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import { useListFunctionTypes } from '@/api/generated/function-types/function-types'
import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import type { RoomTemplate, RoomTemplateInput, RoomTemplateLine } from '@/api/generated/model'
import { getListRoomTemplatesQueryKey, useCreateRoomTemplate, useUpdateRoomTemplate } from '@/api/generated/room-templates/room-templates'
import { useDecimalSeparator } from '@/catalog/decimal'
import {
  apiFields,
  Button,
  errorKey,
  ErrorMessage,
  Field,
  FormDialog,
  FormSelectField,
  FormTranslatableField,
  fromTranslatable,
  RepeaterControls,
  RepeaterItem,
  SelectField,
  setApiFieldErrors,
  SwitchField,
  toTranslatable,
  translatableApiFields,
  translatableSchema,
  useFieldError,
  useRepeaterFocus,
} from '@/components/ui'
import { StaleReload } from '@/features/capabilities/StaleReload'
import { formatWatts, maxPowerW, parsePower } from '@/features/needs'
import { useLocalized } from '@/i18n/localized'

import { lineState } from './line-state'
import { functionTypeOptions, loadTypeOptions } from './options'

const maxLines = 100

const lineSchema = z.object({
  functionTypeId: z.string().min(1, errorKey('validation.required')),
  quantity: z
    .string()
    .refine((q) => /^\d+$/.test(q.trim()) && Number(q) >= 1 && Number(q) <= 100, errorKey('validation.range', { min: 1, max: 100 })),
  // The backend's rule: 0-100000 W with at most 2 decimals, empty = unknown.
  powerW: z.string().refine((p) => parsePower(p) !== undefined, errorKey('need.power_invalid', { max: maxPowerW })),
  loadTypeId: z.string(),
  label: z.string().max(100, errorKey('validation.too_long', { max: 100 })),
})

const schema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, errorKey('room_template.key_format'))
    .max(64, errorKey('validation.too_long', { max: 64 })),
  name: translatableSchema({ max: 100, required: errorKey('validation.required') }),
  equipmentLevel: translatableSchema({ max: 50 }),
  lines: z.array(lineSchema).max(maxLines),
  isActive: z.boolean(),
})
type FormValues = z.infer<typeof schema>
type LineValues = FormValues['lines'][number]

/** Line errors at body.lines[i].* land on the line's field. */
const lineFields = Object.fromEntries(
  Array.from({ length: maxLines }, (_, i) =>
    (['functionTypeId', 'quantity', 'powerW', 'loadTypeId', 'label'] as const).map((f) => [`lines[${i}].${f}`, `lines.${i}.${f}`]),
  ).flat(),
) as Record<string, never>

const fields = {
  ...apiFields<FormValues>(['key', 'isActive', 'lines'], lineFields),
  ...translatableApiFields('name'),
  ...translatableApiFields('equipmentLevel'),
}

const emptyLine = (): LineValues => ({ functionTypeId: '', quantity: '1', powerW: '', loadTypeId: '', label: '' })

const toLineValues = (l: RoomTemplateLine, separator: ',' | '.'): LineValues => ({
  functionTypeId: l.functionTypeId,
  quantity: String(l.quantity),
  powerW: l.powerW === null ? '' : formatWatts(l.powerW, separator),
  loadTypeId: l.loadTypeId ?? '',
  label: l.label,
})

const toFormValues = (item: RoomTemplate | null, separator: ',' | '.'): FormValues => ({
  key: item?.key ?? '',
  name: toTranslatable(item?.name),
  equipmentLevel: toTranslatable(item?.equipmentLevel),
  lines: (item?.lines ?? []).map((l) => toLineValues(l, separator)),
  isActive: item?.isActive ?? true,
})

const toInput = (v: FormValues): RoomTemplateInput => ({
  key: v.key,
  name: fromTranslatable(v.name),
  equipmentLevel: fromTranslatable(v.equipmentLevel),
  // Always sent: the update replaces the lines.
  lines: v.lines.map((l) => ({
    functionTypeId: l.functionTypeId,
    quantity: Number(l.quantity),
    powerW: parsePower(l.powerW) ?? null,
    loadTypeId: l.loadTypeId === '' ? null : l.loadTypeId,
    label: l.label.trim(),
  })),
  isActive: v.isActive,
})

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: RoomTemplate | null
  onSaved: () => Promise<unknown>
}

/** Creates or edits a room template: key, name, equipment level, lines, active. */
export function RoomTemplateFormDialog({ open, onOpenChange, item, onSaved }: Props) {
  const { t } = useTranslation('roomTemplates')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const localized = useLocalized()
  const separator = useDecimalSeparator()
  const queryClient = useQueryClient()
  const create = useCreateRoomTemplate()
  const update = useUpdateRoomTemplate()
  const mutation = item ? update : create
  const functionTypes = useListFunctionTypes({ query: { enabled: open } })
  const loadTypes = useListLoadTypes({ includeInactive: true }, { query: { enabled: open } })
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: toFormValues(item, separator) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  useEffect(() => {
    if (!open) return
    reset(toFormValues(item, separator))
    resetCreate()
    resetUpdate()
    // The separator is read when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item, reset, resetCreate, resetUpdate])

  const lines = useFieldArray({ control: form.control, name: 'lines' })
  const focus = useRepeaterFocus(lines.fields)
  const values = useWatch({ control: form.control, name: 'lines' }) ?? []

  const fts = functionTypes.data?.items ?? []
  const lts = loadTypes.data?.items ?? []
  const inactive = (name: string) => t('line.inactiveOption', { name })

  const submit = form.handleSubmit(async (v) => {
    const data = toInput(v)
    try {
      if (item) await update.mutateAsync({ id: item.id, data: { ...data, expectedUpdatedAt: item.updatedAt } })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      if (error instanceof ApiError && error.code === 'room_template.key_taken') {
        form.setError('key', { type: 'server', message: errorKey('room_template.key_taken', { key: v.key }) })
      }
      return
    }
    await onSaved()
    onOpenChange(false)
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('edit') : t('new')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      submitDisabled={functionTypes.isPending || loadTypes.isPending}
      onSubmit={() => void submit()}
      error={
        <ErrorMessage
          error={mutation.error}
          fields={fields}
          action={
            <StaleReload
              error={mutation.error}
              code="room_template.stale"
              onReload={async () => {
                await queryClient.invalidateQueries({ queryKey: getListRoomTemplatesQueryKey() })
                onOpenChange(false)
              }}
            />
          }
        />
      }
    >
      <Field
        label={t('field.key')}
        hint={t('field.keyHint')}
        required
        autoComplete="off"
        error={fieldError(errors.key?.message)}
        {...form.register('key')}
      />
      <FormTranslatableField control={form.control} name="name" label={t('field.name')} required />
      <FormTranslatableField control={form.control} name="equipmentLevel" label={t('field.equipmentLevel')} hint={t('field.equipmentLevelHint')} />

      <div role="group" aria-label={t('field.lines')} className="space-y-2">
        <div>
          <p className="text-sm font-medium">{t('field.lines')}</p>
          <p className="text-sm text-muted">{t('field.linesHint')}</p>
        </div>
        {lines.fields.map((row, i) => {
          const v = values[i] ?? row
          const ft = fts.find((f) => f.id === v.functionTypeId)
                    const state = lineState(v, item?.lines ?? [], fts, lts)
          const title = t('line.title', { n: i + 1 })
          const lineErrors = errors.lines?.[i]
          return (
            <RepeaterItem
              key={row.id}
              itemId={row.id}
              compact
              title={title}
              subtitle={ft ? localized(ft.name) : undefined}
              invalid={!!lineErrors || state.blocked}
              controls={
                <RepeaterControls
                  index={i}
                  count={lines.fields.length}
                  name={title}
                  onMove={(from, to, action) => {
                    lines.move(from, to)
                    focus.moved(to, action)
                  }}
                  onRemove={(j) => {
                    lines.remove(j)
                    focus.removed(j)
                  }}
                />
              }
            >
              {state.blocked ? (
                <p className="text-sm text-danger">{t('line.inactiveReference')}</p>
              ) : (
                state.warnings.map((w) => (
                  <p key={w} className="text-sm text-warning">
                    {t(`line.warning.${w}`)}
                  </p>
                ))
              )}
              <div className="grid items-start gap-3 sm:grid-cols-2">
                <Controller
                  control={form.control}
                  name={`lines.${i}.functionTypeId`}
                  render={({ field }) => (
                    <SelectField
                      ref={field.ref}
                      label={t('line.functionType')}
                      placeholder={t('line.choose')}
                      required
                      options={functionTypeOptions(fts, field.value, (f) => localized(f.name), inactive)}
                      error={fieldError(lineErrors?.functionTypeId?.message)}
                      value={field.value}
                      onBlur={field.onBlur}
                      onValueChange={(id) => {
                        field.onChange(id)
                        // A load type the new function type does not allow is cleared.
                        const allowed = fts.find((f) => f.id === id)?.loadTypeIds ?? []
                        if (v.loadTypeId && allowed.length > 0 && !allowed.includes(v.loadTypeId)) form.setValue(`lines.${i}.loadTypeId`, '')
                      }}
                    />
                  )}
                />
                <FormSelectField
                  control={form.control}
                  name={`lines.${i}.loadTypeId`}
                  label={t('line.loadType')}
                  options={[{ value: '', label: t('line.noLoadType') }, ...loadTypeOptions(lts, ft, v.loadTypeId, (l) => localized(l.name), inactive)]}
                  error={fieldError(lineErrors?.loadTypeId?.message)}
                />
                <Field
                  label={t('line.quantity')}
                  inputMode="numeric"
                  required
                  error={fieldError(lineErrors?.quantity?.message)}
                  {...form.register(`lines.${i}.quantity`)}
                />
                <Field
                  label={t('line.powerW')}
                  hint={t('line.powerWHint')}
                  inputMode="decimal"
                  error={fieldError(lineErrors?.powerW?.message)}
                  {...form.register(`lines.${i}.powerW`)}
                />
                <div className="sm:col-span-2">
                  <Field
                    label={t('line.label')}
                    hint={t('line.labelHint')}
                    autoComplete="off"
                    error={fieldError(lineErrors?.label?.message)}
                    {...form.register(`lines.${i}.label`)}
                  />
                </div>
              </div>
            </RepeaterItem>
          )
        })}
        {lines.fields.length < maxLines && (
          <Button
            data-repeater-add={focus.listId}
            variant="secondary"
            size="sm"
            onClick={() => {
              lines.append(emptyLine())
              focus.added(lines.fields.length)
            }}
          >
            <Plus /> {t('line.add')}
          </Button>
        )}
      </div>
      <SwitchField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
    </FormDialog>
  )
}
