import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect } from 'react'
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'
import {
  getListCatalogFieldsQueryKey,
  useCreateCatalogField,
  useListCatalogFieldMeanings,
  useUpdateCatalogField,
} from '@/api/generated/catalog-fields/catalog-fields'
import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import { type CatalogField, CatalogFieldInputMeaning, CatalogFieldInputType } from '@/api/generated/model'
import { useListOutputKinds } from '@/api/generated/output-kinds/output-kinds'
import { useListProductTypes } from '@/api/generated/product-types/product-types'
import {
  Button,
  CheckboxGroupField,
  emptyTranslatable,
  errorKey,
  ErrorMessage,
  Field,
  FormDialog,
  FormSelectField,
  FormTranslatableField,
  RepeaterControls,
  RepeaterItem,
  setApiFieldErrors,
  toTranslatable,
  useFieldError,
  useRepeaterFocus,
} from '@/components/ui'
import { useFixedOptionLabel, useMeaningLabel } from '@/catalog/meaning-labels'
import { useLocalized } from '@/i18n/localized'

import {
  catalogFieldApiFields,
  type CatalogFieldFormValues,
  catalogFieldSchema,
  toCatalogFieldFormValues,
  toCatalogFieldInput,
} from './field-form'
import { StaleReload } from './StaleReload'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: CatalogField | null
  onSaved: () => Promise<unknown>
}

/**
 * Creates or edits a catalog field (D187/D188): key, label, value type,
 * unit, choices of an enum, ETIM feature, and what the value means for the
 * checks (with its output kind / load type and the product types it is
 * limited to), or "just information".
 */
export function CatalogFieldFormDialog({ open, onOpenChange, item, onSaved }: Props) {
  const { t } = useTranslation('capabilities')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const localized = useLocalized()
  const meaningLabel = useMeaningLabel()
  const fixedText = useFixedOptionLabel().text
  const queryClient = useQueryClient()
  const create = useCreateCatalogField()
  const update = useUpdateCatalogField()
  const mutation = item ? update : create
  const meanings = useListCatalogFieldMeanings({ query: { enabled: open } })
  const kinds = useListOutputKinds({ includeInactive: true }, { query: { enabled: open } })
  const loadTypes = useListLoadTypes({ includeInactive: true }, { query: { enabled: open } })
  const productTypes = useListProductTypes({ includeInactive: true }, { query: { enabled: open } })
  const form = useForm<CatalogFieldFormValues>({
    resolver: zodResolver(catalogFieldSchema),
    defaultValues: toCatalogFieldFormValues(item),
  })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  useEffect(() => {
    if (!open) return
    reset(toCatalogFieldFormValues(item))
    resetCreate()
    resetUpdate()
  }, [open, item, reset, resetCreate, resetUpdate])

  const [type, meaning] = useWatch({
    control: form.control,
    name: ['type', 'meaning'],
  })
  const spec = meanings.data?.items.find((m) => m.meaning === meaning)
  // A meaning with fixed choices (motor_type: ac, dc) sets them when it is chosen.
  const fixedOptions = spec && spec.options.length > 0 ? spec.options : undefined
  const fixedKey = fixedOptions?.join(',')
  const { getValues, setValue } = form
  useEffect(() => {
    if (!fixedKey) return
    const keys = fixedKey.split(',')
    if (getValues('type') !== 'enum') setValue('type', 'enum', { shouldDirty: true })
    const current = getValues('options')
    if (current.map((o) => o.key).join(',') === fixedKey) return
    setValue(
      'options',
      keys.map((key) => current.find((o) => o.key === key) ?? { key, label: toTranslatable(fixedText(key)) }),
      { shouldDirty: true },
    )
  }, [fixedKey, getValues, setValue, fixedText])
  // A field categories link keeps its key and type (catalog_field.in_use).
  const inUse = (item?.inUse ?? 0) > 0
  const usedByNames = (item?.usedBy ?? []).map((c) => localized(c.name) || c.key).join(', ')

  const submit = form.handleSubmit(async (values) => {
    const data = toCatalogFieldInput(values, spec)
    try {
      if (item)
        await update.mutateAsync({
          id: item.id,
          data: { ...data, expectedUpdatedAt: item.updatedAt },
        })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, catalogFieldApiFields)
      if (error instanceof ApiError && error.code === 'catalog_field.key_taken') {
        form.setError('key', {
          type: 'server',
          message: errorKey('catalog_field.key_taken', { key: values.key }),
        })
      }
      return
    }
    await onSaved()
    onOpenChange(false)
  })

  const typeOptions = Object.values(CatalogFieldInputType).map((v) => ({
    value: v,
    label: t(`type.${v}`),
  }))
  const meaningOptions = [
    { value: '', label: meaningLabel() },
    ...Object.values(CatalogFieldInputMeaning).map((m) => ({
      value: m,
      label: meaningLabel(m),
    })),
  ]
  const meaningHint =
    spec && !spec.types.includes(type)
      ? t('fields.meaningTypes', {
          types: spec.types.map((v) => t(`type.${v}` as 'type.text')).join(', '),
        })
      : t('fields.meaningHint')

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('fields.edit') : t('fields.new')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={
        <ErrorMessage
          error={mutation.error}
          fields={catalogFieldApiFields}
          action={
            <StaleReload
              error={mutation.error}
              code="catalog_field.stale"
              onReload={async () => {
                await queryClient.invalidateQueries({
                  queryKey: getListCatalogFieldsQueryKey(),
                })
                onOpenChange(false)
              }}
            />
          }
        />
      }
    >
      {inUse && (
        <p className="text-sm text-muted" data-testid="field-in-use">
          {t('fields.inUseHint', { count: item?.inUse ?? 0, categories: usedByNames })}
        </p>
      )}
      <Field
        label={t('field.key')}
        hint={inUse ? t('fields.lockedHint') : t('fields.keyHint')}
        required
        readOnly={inUse}
        autoComplete="off"
        error={fieldError(errors.key?.message)}
        {...form.register('key')}
      />
      <FormTranslatableField control={form.control} name="label" label={t('fields.label')} required />
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <FormSelectField
          control={form.control}
          name="type"
          label={t('fields.type')}
          options={typeOptions}
          required
          disabled={inUse || !!fixedOptions}
          hint={inUse ? t('fields.lockedHint') : undefined}
          error={fieldError(errors.type?.message)}
        />
        <Field
          label={t('fields.unit')}
          hint={t('fields.unitHint')}
          autoComplete="off"
          error={fieldError(errors.unit?.message)}
          {...form.register('unit')}
        />
      </div>
      {type === 'enum' && <OptionsEditor form={form} fixed={!!fixedOptions} />}
      <Field
        label={t('fields.etimFeature')}
        hint={t('fields.etimFeatureHint')}
        autoComplete="off"
        error={fieldError(errors.etimFeature?.message)}
        {...form.register('etimFeature')}
      />
      <FormSelectField
        control={form.control}
        name="meaning"
        label={t('fields.meaning')}
        hint={meaningHint}
        options={meaningOptions}
        error={fieldError(errors.meaning?.message)}
      />
      {(spec?.outputKind || spec?.loadType) && (
        <div className="grid items-start gap-4 sm:grid-cols-2">
          {spec.outputKind && (
            <FormSelectField
              control={form.control}
              name="outputKindId"
              label={t('fields.outputKind')}
              required
              placeholder={t('fields.choose')}
              options={(kinds.data?.items ?? []).map((k) => ({
                value: k.id,
                label: localized(k.name),
              }))}
              error={fieldError(errors.outputKindId?.message)}
            />
          )}
          {spec.loadType && (
            <FormSelectField
              control={form.control}
              name="loadTypeId"
              label={t('fields.loadType')}
              required={spec.loadTypeRequired}
              hint={spec.loadTypeRequired ? undefined : t('fields.loadTypeOptionalHint')}
              placeholder={t('fields.choose')}
              options={[
                ...(spec.loadTypeRequired ? [] : [{ value: '', label: t('fields.anyLoadType') }]),
                ...(loadTypes.data?.items ?? []).map((l) => ({
                  value: l.id,
                  label: localized(l.name),
                })),
              ]}
              error={fieldError(errors.loadTypeId?.message)}
            />
          )}
        </div>
      )}
      {meaning && (
        <Controller
          control={form.control}
          name="productTypeIds"
          render={({ field }) => (
            <CheckboxGroupField
              label={t('fields.productTypes')}
              hint={t('fields.productTypesHint')}
              options={(productTypes.data?.items ?? []).map((p) => ({
                value: p.id,
                label: localized(p.name),
              }))}
              value={field.value}
              onChange={field.onChange}
              error={fieldError(errors.productTypeIds?.message)}
            />
          )}
        />
      )}
    </FormDialog>
  )
}

type Form = ReturnType<typeof useForm<CatalogFieldFormValues>>

/** The choices of an enum field. */
function OptionsEditor({ form, fixed }: { form: Form; fixed: boolean }) {
  const { t } = useTranslation('capabilities')
  const fieldError = useFieldError()
  const { fields, append, remove, move } = useFieldArray({
    control: form.control,
    name: 'options',
  })
  const focus = useRepeaterFocus(fields)
  const errors = form.formState.errors.options

  return (
    <div role="group" aria-label={t('fields.options')} className="space-y-2">
      <p className="text-sm font-medium">{t('fields.options')}</p>
      {fixed && <p className="text-sm text-muted">{t('fields.optionsFixed')}</p>}
      {errors?.root?.message && <p className="text-sm text-danger">{fieldError(errors.root.message)}</p>}
      {fields.map((field, j) => (
        <RepeaterItem
          key={field.id}
          itemId={field.id}
          compact
          title={t('fields.option', { n: j + 1 })}
          invalid={!!errors?.[j]}
          controls={
            !fixed && (
              <RepeaterControls
                index={j}
                count={fields.length}
                name={t('fields.option', { n: j + 1 })}
                onMove={(from, to, action) => {
                  move(from, to)
                  focus.moved(to, action)
                }}
                onRemove={(i) => {
                  remove(i)
                  focus.removed(i)
                }}
              />
            )
          }
        >
          <div className="grid items-start gap-3 sm:grid-cols-3">
            <Field
              label={t('field.key')}
              required
              readOnly={fixed}
              autoComplete="off"
              error={fieldError(errors?.[j]?.key?.message)}
              {...form.register(`options.${j}.key`)}
            />
            <div className="sm:col-span-2">
              <FormTranslatableField control={form.control} name={`options.${j}.label`} label={t('fields.label')} required />
            </div>
          </div>
        </RepeaterItem>
      ))}
      {!fixed && (
        <Button
          data-repeater-add={focus.listId}
          variant="secondary"
          size="sm"
          onClick={() => {
            append({ key: '', label: emptyTranslatable() })
            focus.added(fields.length)
          }}
        >
          <Plus /> {t('fields.addOption')}
        </Button>
      )}
    </div>
  )
}
