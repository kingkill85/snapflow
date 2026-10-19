import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import type { ProductType, ProductTypeInput } from '@/api/generated/model'
import {
  getListProductTypesQueryKey,
  getListProductTypesQueryOptions,
  useCreateProductType,
  useUpdateProductType,
} from '@/api/generated/product-types/product-types'
import { invalidateProductQueries } from '@/catalog/invalidate'
import {
  apiFields,
  Button,
  ColorField,
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
  TypeBadge,
  useFieldError,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

/** Limits of the API. */
const limits = { key: 64, name: 100, abbreviation: 6 }

/**
 * The abbreviation as the server stores it (D101): Unicode NFC, trimmed,
 * upper case per character like Go's strings.ToUpper (a character whose
 * upper case is longer, such as "ß", stays as it is). For the preview only;
 * the form sends the text as typed (trimmed) and the server normalises it.
 */
const normalizedAbbreviation = (s: string) =>
  [...s.normalize('NFC').trim()]
    .map((c) => {
      const upper = c.toUpperCase()
      return [...upper].length === 1 ? upper : c
    })
    .join('')
/** Characters (code points), as the server counts them. */
const characters = (s: string) => [...s.normalize('NFC').trim()].length

/** An optional whole number in [min, max] as typed; empty for none. */
const optionalWhole = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((v) => v === '' || (/^\d+$/.test(v) && Number(v) >= min && Number(v) <= max), errorKey('validation.range', { min, max }))

const schema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, errorKey('product_type.key_format'))
    .max(limits.key, errorKey('validation.too_long', { max: limits.key })),
  name: translatableSchema({ max: limits.name, required: errorKey('validation.required') }),
  abbreviation: z
    .string()
    .trim()
    .refine((v) => characters(v) <= limits.abbreviation, errorKey('validation.too_long', { max: limits.abbreviation })),
  color: z
    .string()
    .trim()
    .regex(/^(#[0-9a-fA-F]{6})?$/, errorKey('product_type.color_format')),
  defaultBusCurrentMa: optionalWhole(1, 100000),
  reservePercent: z
    .string()
    .trim()
    .regex(/^\d+$/, errorKey('validation.range', { min: 0, max: 90 }))
    .refine((v) => Number(v) <= 90, errorKey('validation.range', { min: 0, max: 90 })),
  busDevicesMax: optionalWhole(1, 100000),
  nominalVoltage: z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1000, errorKey('validation.range', { min: 1, max: 1000 })),
  topology: z.enum(['bus', 'wireless', 'none']),
  addressing: z.enum(['knx_individual', 'hdl', 'eui64', 'none']),
  defaultWirelessPlacesUsed: optionalWhole(1, 1000),
  isActive: z.boolean(),
})
type FormValues = z.infer<typeof schema>

const fields = {
  ...apiFields<FormValues>(['key', 'abbreviation', 'color', 'defaultBusCurrentMa', 'reservePercent', 'busDevicesMax', 'nominalVoltage', 'topology', 'addressing', 'defaultWirelessPlacesUsed', 'isActive']),
  ...translatableApiFields('name'),
}

const toFormValues = (item: ProductType | null): FormValues => ({
  key: item?.key ?? '',
  name: toTranslatable(item?.name),
  abbreviation: item?.abbreviation ?? '',
  color: item?.color ?? '',
  defaultBusCurrentMa: item?.defaultBusCurrentMa?.toString() ?? '',
  reservePercent: (item?.reservePercent ?? 20).toString(),
  busDevicesMax: item?.busDevicesMax?.toString() ?? '',
  nominalVoltage: (item?.nominalVoltage ?? 230).toString(),
  topology: item?.topology ?? 'none',
  addressing: item?.addressing ?? 'none',
  defaultWirelessPlacesUsed: item?.defaultWirelessPlacesUsed?.toString() ?? '',
  isActive: item?.isActive ?? true,
})

const toInput = (v: FormValues): ProductTypeInput => {
  const abbreviation = v.abbreviation.trim()
  const color = v.color.trim().toLowerCase()
  return {
    key: v.key,
    name: fromTranslatable(v.name),
    ...(abbreviation ? { abbreviation } : {}),
    ...(color ? { color } : {}),
    // Always sent (D294): 0 clears an optional setting.
    defaultBusCurrentMa: Number(v.defaultBusCurrentMa.trim() || 0),
    reservePercent: Number(v.reservePercent.trim()),
    busDevicesMax: Number(v.busDevicesMax.trim() || 0),
    nominalVoltage: Number(v.nominalVoltage.trim()),
    topology: v.topology,
    addressing: v.addressing,
    defaultWirelessPlacesUsed: Number(v.defaultWirelessPlacesUsed.trim() || 0),
    isActive: v.isActive,
  }
}

const addressingByTopology: Record<FormValues['topology'], readonly FormValues['addressing'][]> = {
  none: ['none'],
  bus: ['none', 'knx_individual', 'hdl'],
  wireless: ['none', 'eui64'],
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: ProductType | null
}

/**
 * Creates or edits a product type (a system or product line such as Zigbee):
 * key, name, badge abbreviation and colour with a preview, active flag. An
 * update sends the version it was opened with as expectedUpdatedAt (D37); on
 * product_type.stale, Reload starts over from the current version.
 */
export function ProductTypeFormDialog({ open, onOpenChange, item }: Props) {
  const { t } = useTranslation('productTypes')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const localized = useLocalized()
  const queryClient = useQueryClient()
  const create = useCreateProductType()
  const update = useUpdateProductType()
  // The version being edited: the item the dialog was opened with, until
  // Reload replaces it with the current one.
  const [base, setBase] = useState<ProductType | null>(item)
  const [openedWith, setOpenedWith] = useState({ open, item })
  if (openedWith.open !== open || openedWith.item !== item) {
    setOpenedWith({ open, item })
    if (open) setBase(item)
  }
  const mutation = base ? update : create

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: toFormValues(item) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  // Reset only when the dialog opens or switches record.
  useEffect(() => {
    if (!open) return
    reset(toFormValues(item))
    resetCreate()
    resetUpdate()
  }, [open, item, reset, resetCreate, resetUpdate])

  const [name, abbreviation, color, topology] = useWatch({ control: form.control, name: ['name', 'abbreviation', 'color', 'topology'] })
  const topologyOptions = (['none', 'bus', 'wireless'] as const).map((v) => ({ value: v, label: t(`topology.${v}`) }))
  // The schemes the topology allows (the API refuses the others).
  const allowedAddressing = addressingByTopology[topology]
  const addressingOptions = allowedAddressing.map((v) => ({ value: v, label: t(`addressing.${v}`) }))
  const addressing = useWatch({ control: form.control, name: 'addressing' })
  const { setValue } = form
  useEffect(() => {
    if (!allowedAddressing.includes(addressing)) setValue('addressing', 'none')
  }, [allowedAddressing, addressing, setValue])
  const previewColor = /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim() : undefined

  const submit = form.handleSubmit(async (values) => {
    const data = toInput(values)
    try {
      if (base) await update.mutateAsync({ id: base.id, data: { ...data, expectedUpdatedAt: base.updatedAt } })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      // A taken key comes without a location (409), but belongs to the Key field.
      if (error instanceof ApiError && error.code === 'product_type.key_taken') {
        form.setError('key', { type: 'server', message: errorKey('product_type.key_taken', { key: values.key }) })
      }
      return // shown by ErrorMessage via mutation.error
    }
    await Promise.all([queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() }), invalidateProductQueries(queryClient)])
    onOpenChange(false)
  })

  // Starts over from the current version; the edits are discarded (the
  // message says to make them again).
  const reload = async () => {
    if (!base) return
    const all = await queryClient.fetchQuery({ ...getListProductTypesQueryOptions({ includeInactive: true }), staleTime: 0 })
    await queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() })
    const current = all.items.find((p) => p.id === base.id)
    if (!current) {
      onOpenChange(false)
      return
    }
    setBase(current)
    reset(toFormValues(current))
    resetUpdate()
  }
  const stale = mutation.error instanceof ApiError && mutation.error.code === 'product_type.stale'

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('edit') : t('new')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={
        <ErrorMessage
          error={mutation.error}
          fields={fields}
          action={
            stale && (
              <Button size="sm" variant="secondary" onClick={() => void reload()}>
                <RotateCw /> {tCommon('action.reload')}
              </Button>
            )
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
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field
          label={t('field.abbreviation')}
          hint={t('field.abbreviationHint')}
          error={fieldError(errors.abbreviation?.message)}
          autoComplete="off"
          spellCheck={false}
          {...form.register('abbreviation')}
        />
        <Controller
          control={form.control}
          name="color"
          render={({ field, fieldState }) => (
            <ColorField
              label={t('field.color')}
              hint={t('field.colorHint')}
              error={fieldError(fieldState.error?.message)}
              name={field.name}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              ref={field.ref}
            />
          )}
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t('field.preview')}</p>
        <div data-testid="badge-preview" className="rounded-control border border-line bg-canvas px-3 py-2 text-sm">
          <TypeBadge color={previewColor} abbreviation={normalizedAbbreviation(abbreviation)}>
            {localized(name).trim() || t('field.previewName')}
          </TypeBadge>
        </div>
      </div>
      <div className="space-y-3">
        <p className="text-sm font-medium">{t('field.systemSettings')}</p>
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <FormSelectField
            control={form.control}
            name="topology"
            label={t('field.topology')}
            hint={t('field.topologyHint')}
            options={topologyOptions}
            error={fieldError(errors.topology?.message)}
          />
          <FormSelectField
            control={form.control}
            name="addressing"
            label={t('field.addressing')}
            hint={t('field.addressingHint')}
            options={addressingOptions}
            error={fieldError(errors.addressing?.message)}
          />
        </div>
        {/* The defaults of the other topologies stay in the form and are sent as they are (D294). */}
        <div className="grid items-start gap-4 sm:grid-cols-3">
          {topology === 'bus' && (
            <Field
              label={t('field.defaultBusCurrentMa')}
              hint={t('field.defaultBusCurrentMaHint')}
              suffix="mA"
              inputMode="numeric"
              error={fieldError(errors.defaultBusCurrentMa?.message)}
              {...form.register('defaultBusCurrentMa')}
            />
          )}
          {topology === 'wireless' && (
            <Field
              label={t('field.defaultWirelessPlacesUsed')}
              hint={t('field.defaultWirelessPlacesUsedHint')}
              inputMode="numeric"
              error={fieldError(errors.defaultWirelessPlacesUsed?.message)}
              {...form.register('defaultWirelessPlacesUsed')}
            />
          )}
          <Field
            label={t('field.reservePercent')}
            hint={t('field.reservePercentHint')}
            suffix="%"
            inputMode="numeric"
            required
            error={fieldError(errors.reservePercent?.message)}
            {...form.register('reservePercent')}
          />
          <Field
            label={t('field.nominalVoltage')}
            hint={t('field.nominalVoltageHint')}
            suffix="V"
            inputMode="numeric"
            required
            error={fieldError(errors.nominalVoltage?.message)}
            {...form.register('nominalVoltage')}
          />
          {topology === 'bus' && (
            <Field
              label={t('field.busDevicesMax')}
              hint={t('field.busDevicesMaxHint')}
              inputMode="numeric"
              error={fieldError(errors.busDevicesMax?.message)}
              {...form.register('busDevicesMax')}
            />
          )}
        </div>
      </div>
      <SwitchField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
    </FormDialog>
  )
}
