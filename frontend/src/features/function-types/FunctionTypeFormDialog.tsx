import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { useLocalized } from '@/i18n/localized'
import {
  getListFunctionTypesQueryKey,
  useCreateFunctionType,
  useUpdateFunctionType,
} from '@/api/generated/function-types/function-types'
import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import type { FunctionType, FunctionTypeInput } from '@/api/generated/model'
import { useListOutputKinds } from '@/api/generated/output-kinds/output-kinds'
import { useListProductTypes } from '@/api/generated/product-types/product-types'
import {
  apiFields,
  Button,
  CheckboxGroupField,
  Disclosure,
  errorKey,
  emptyTranslatable,
  ErrorMessage,
  Field,
  FormDialog,
  FormTranslatableField,
  fromTranslatable,
  RepeaterControls,
  RepeaterItem,
  setApiFieldErrors,
  SwitchField,
  toTranslatable,
  translatableApiFields,
  translatableSchema,
  useFieldError,
  useRepeaterFocus,
} from '@/components/ui'

const schema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, errorKey('function_type.key_format')).max(64, errorKey('validation.too_long', { max: 64 })),
  name: translatableSchema({ required: errorKey('validation.required') }),
  allowsCircuit: z.boolean(),
  loadTypeIds: z.array(z.string()),
  outputKindIds: z.array(z.string()),
  isActive: z.boolean(),
  knxObjects: z.array(
    z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]*$/, errorKey('function_type.key_format')).max(64, errorKey('validation.too_long', { max: 64 })),
      name: translatableSchema({ required: errorKey('validation.required') }),
      dpst: z.string().trim().regex(/^DPST-\d{1,3}-\d{1,5}$/, errorKey('function_type.dpst_format')),
    }),
  ),
})
type FormValues = z.infer<typeof schema>

const fields = { ...apiFields<FormValues>(['key', 'loadTypeIds', 'outputKindIds', 'isActive']), ...translatableApiFields('name') }

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id))

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  functionType: FunctionType | null
}

/**
 * Creates or edits a function (D444): key, name, the channel kinds that serve
 * it and whether needs share a circuit; then Details (allowed load types, KNX
 * objects only when a KNX system exists); then Active.
 */
export function FunctionTypeFormDialog({ open, onOpenChange, functionType }: Props) {
  const { t } = useTranslation('functionTypes')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const queryClient = useQueryClient()
  const create = useCreateFunctionType()
  const update = useUpdateFunctionType()
  const mutation = functionType ? update : create
  const localized = useLocalized()
  // Inactive load types stay listed: a function type may still allow one.
  const loadTypes = useListLoadTypes({ includeInactive: true }, { query: { enabled: open } })
  const loadTypeOptions = (loadTypes.data?.items ?? []).map((l) => ({ value: l.id, label: localized(l.name) }))
  // Active channel kinds in their order; a linked inactive one shows as an extra box (unknownLabel).
  const kinds = useListOutputKinds({ includeInactive: true }, { query: { enabled: open } })
  const kindOptions = (kinds.data?.items ?? []).filter((k) => k.isActive).map((k) => ({ value: k.id, label: localized(k.name) }))
  const kindName = (id: string) => {
    const k = kinds.data?.items.find((x) => x.id === id)
    return k ? localized(k.name) : id
  }
  // KNX objects only matter with a KNX system (addressing knx_individual).
  const systems = useListProductTypes({ includeInactive: true }, { query: { enabled: open } })
  const knx = (systems.data?.items ?? []).some((p) => p.addressing === 'knx_individual')

  // Details start collapsed when empty and open on an error inside.
  // Until the user toggles it, Details is open when it shows something: load
  // types, or KNX objects while their editor is shown.
  const [detailsToggled, setDetailsOpen] = useState<boolean | null>(null)
  const hasDetails = (functionType?.loadTypeIds.length ?? 0) > 0 || (knx && (functionType?.knxObjects.length ?? 0) > 0)
  const detailsOpen = detailsToggled ?? hasDetails
  const [openedWith, setOpenedWith] = useState({ open, functionType })
  if (openedWith.open !== open || openedWith.functionType !== functionType) {
    setOpenedWith({ open, functionType })
    if (open) setDetailsOpen(null)
  }
  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  // Reset only when the dialog opens or switches record.
  useEffect(() => {
    if (!open) return
    reset({
      key: functionType?.key ?? '',
      name: toTranslatable(functionType?.name),
      allowsCircuit: functionType?.allowsCircuit ?? false,
      loadTypeIds: functionType?.loadTypeIds ?? [],
      outputKindIds: functionType?.outputKindIds ?? [],
      isActive: functionType?.isActive ?? true,
      knxObjects: (functionType?.knxObjects ?? []).map((o) => ({ key: o.key, name: toTranslatable(o.name), dpst: o.dpst })),
    })
    resetCreate()
    resetUpdate()
  }, [open, functionType, reset, resetCreate, resetUpdate])
  const detailsError = !!(errors.loadTypeIds || errors.knxObjects)
  const outputKindIds = useWatch({ control: form.control, name: 'outputKindIds' }) ?? []

  const submit = form.handleSubmit(async (values) => {
    const data: FunctionTypeInput = {
      key: values.key,
      name: fromTranslatable(values.name),
      allowsCircuit: values.allowsCircuit,
      loadTypeIds: values.loadTypeIds,
      // On update only when changed: function types have no stale check, so
      // an unchanged list must not revert links made on the Channel kinds page
      // meanwhile (left out keeps them).
      ...(!functionType || !sameIds(values.outputKindIds, functionType.outputKindIds) ? { outputKindIds: values.outputKindIds } : {}),
      isActive: values.isActive,
      // Hidden without a KNX system: left out, so the API keeps them (D294).
      ...(knx ? { knxObjects: values.knxObjects.map((o) => ({ key: o.key, name: fromTranslatable(o.name), dpst: o.dpst.trim() })) } : {}),
    }
    try {
      if (functionType) await update.mutateAsync({ id: functionType.id, data })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      return // shown by ErrorMessage via mutation.error
    }
    await queryClient.invalidateQueries({ queryKey: getListFunctionTypesQueryKey() })
    onOpenChange(false)
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={functionType ? t('edit') : t('new')}
      submitLabel={functionType ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={mutation.error} fields={fields} />}
    >
      <Field label={t('field.key')} hint={t('field.keyHint')} required autoComplete="off" error={fieldError(errors.key?.message)} {...form.register('key')} />
      <FormTranslatableField control={form.control} name="name" label={t('field.name')} required />
      <Controller
        control={form.control}
        name="outputKindIds"
        render={({ field }) => (
          <CheckboxGroupField
            label={t('field.servedBy')}
            hint={outputKindIds.length === 0 ? t('field.servedByNone') : t('field.servedByHint')}
            options={kindOptions}
            value={field.value ?? []}
            onChange={field.onChange}
            unknownLabel={kindName}
            error={fieldError(errors.outputKindIds?.message)}
          />
        )}
      />
      <SwitchField label={t('field.allowsCircuit')} hint={t('field.allowsCircuitHint')} {...form.register('allowsCircuit')} />
      <Disclosure title={t('field.details')} description={knx ? t('field.detailsHint') : t('field.detailsHintNoKnx')} open={detailsOpen || detailsError} onOpenChange={setDetailsOpen}>
        <Controller
          control={form.control}
          name="loadTypeIds"
          render={({ field }) => (
            <CheckboxGroupField
              label={t('field.loadTypes')}
              hint={t('field.loadTypesHint')}
              options={loadTypeOptions}
              value={field.value}
              onChange={field.onChange}
              error={fieldError(errors.loadTypeIds?.message)}
            />
          )}
        />
        {knx && <KnxObjectsEditor form={form} />}
      </Disclosure>
      <SwitchField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
    </FormDialog>
  )
}

type Form = ReturnType<typeof useForm<FormValues>>

/** The KNX communication objects of the function: a group address each per need (D422). */
function KnxObjectsEditor({ form }: { form: Form }) {
  const { t } = useTranslation('functionTypes')
  const fieldError = useFieldError()
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name: 'knxObjects' })
  const focus = useRepeaterFocus(fields)
  const errors = form.formState.errors.knxObjects

  return (
    <div role="group" aria-label={t('field.knxObjects')} className="space-y-2">
      <p className="text-sm font-medium">{t('field.knxObjects')}</p>
      <p className="text-sm text-muted">{t('field.knxObjectsHint')}</p>
      {fields.map((field, j) => (
        <RepeaterItem
          key={field.id}
          itemId={field.id}
          compact
          title={t('field.knxObject', { n: j + 1 })}
          invalid={!!errors?.[j]}
          controls={
            <RepeaterControls
              index={j}
              count={fields.length}
              name={t('field.knxObject', { n: j + 1 })}
              onMove={(from, to, action) => {
                move(from, to)
                focus.moved(to, action)
              }}
              onRemove={(i) => {
                remove(i)
                focus.removed(i)
              }}
            />
          }
        >
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field
              label={t('field.knxObjectKey')}
              required
              autoComplete="off"
              error={fieldError(errors?.[j]?.key?.message)}
              {...form.register(`knxObjects.${j}.key`)}
            />
            <Field
              label={t('field.knxObjectDpst')}
              hint={t('field.knxObjectDpstHint')}
              required
              autoComplete="off"
              error={fieldError(errors?.[j]?.dpst?.message)}
              {...form.register(`knxObjects.${j}.dpst`)}
            />
            <div className="sm:col-span-2">
              <FormTranslatableField control={form.control} name={`knxObjects.${j}.name`} label={t('field.knxObjectName')} required />
            </div>
          </div>
        </RepeaterItem>
      ))}
      <Button
        data-repeater-add={focus.listId}
        variant="secondary"
        size="sm"
        onClick={() => {
          append({ key: '', name: emptyTranslatable(), dpst: 'DPST-1-1' })
          focus.added(fields.length)
        }}
      >
        <Plus /> {t('field.addKnxObject')}
      </Button>
    </div>
  )
}
