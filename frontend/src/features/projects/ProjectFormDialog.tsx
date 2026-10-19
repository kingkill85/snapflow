import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import type { Project } from '@/api/generated/model'
import { useListProductTypes } from '@/api/generated/product-types/product-types'
import { getExchangeRate, getGetProjectQueryKey, getListProjectsQueryKey, useCreateProject, useUpdateProject } from '@/api/generated/projects/projects'
import { useListTenants } from '@/api/generated/tenants/tenants'
import { useCan, useMe } from '@/app/session'
import { decimalSeparator, formatDecimal, parseDecimal } from '@/catalog/decimal'
import {
  apiFields,
  Button,
  CheckboxGroupField,
  errorKey,
  ErrorMessage,
  Field,
  FormComboboxField,
  FormDialog,
  FormSelectField,
  Notice,
  setApiFieldErrors,
  TextareaField,
  TypeBadge,
  useFieldError,
} from '@/components/ui'
import { contentLocales } from '@/i18n/content-locales'
import { useLocalized } from '@/i18n/localized'

import { useCurrencyOptions, useFormatRateDate } from './currency'
import { fresh } from './paths'

const tooLong = (max: number) => errorKey('validation.too_long', { max })

const schema = z
  .object({
    name: z.string().trim().min(1, errorKey('validation.required')).max(200, tooLong(200)),
    tenantId: z.string(),
    status: z.enum(['active', 'completed', 'cancelled']),
    productTypeIds: z.array(z.string()).min(1, errorKey('project.product_types_required')),
    language: z.string(),
    currency: z.string().regex(/^[A-Z]{3}$/, errorKey('project.currency_format')),
    exchangeRate: z.string().refine((v) => v.trim() === '' || Number(parseDecimal(v) ?? 0) > 0, errorKey('project.exchange_rate')),
    customer: z.object({
      name: z.string().trim().max(200, tooLong(200)),
      company: z.string().trim().max(200, tooLong(200)),
      email: z.string().trim().pipe(z.union([z.literal(''), z.email(errorKey('validation.email'))])),
      phone: z.string().trim().max(50, tooLong(50)),
      address: z.string().trim().max(500, tooLong(500)),
    }),
    notes: z.string().trim().max(5000, tooLong(5000)),
  })
type FormValues = z.infer<typeof schema>

const customerFields = ['customer.name', 'customer.company', 'customer.email', 'customer.phone', 'customer.address'] as const

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: Project | null
  /** Preselected tenant of a new project (admins), e.g. the list's tenant filter. */
  defaultTenantId?: string
  /** After a successful save, with the saved project. */
  onSaved?: (project: Project) => void
}

/**
 * Where the rate field's value came from: the stored rate, the online
 * provider (fetched in the dialog), typed by hand, or none.
 */
type RateOrigin = { kind: 'stored' } | { kind: 'fetched'; rate: string; date: string } | { kind: 'typed' } | { kind: 'none' }

/**
 * Creates or edits a project: name, tenant (admins), status (edit), product types, language, currency, customer, notes.
 * A new project gets its currency only (no rate: set later on the BOM or Pricing tab); editing a non-USD
 * project shows its rate with its origin and "Fetch current rate". A rate typed in is never replaced.
 */
export function ProjectFormDialog({ open, onOpenChange, item, defaultTenantId, onSaved }: Props) {
  const { t, i18n } = useTranslation('projects')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const localized = useLocalized()
  const me = useMe()
  const can = useCan()
  const queryClient = useQueryClient()
  const create = useCreateProject()
  const update = useUpdateProject()
  const mutation = item ? update : create

  // Only callers who see and manage every tenant choose the tenant (the tenant
  // list needs tenants.manage); everyone else works in their own.
  const chooseTenant = can('tenants.access_all') && can('tenants.manage')
  const tenants = useListTenants(undefined, { query: { enabled: open && chooseTenant } })
  const types = useListProductTypes({ includeInactive: true }, { query: { ...fresh, enabled: open } })

  const fields = apiFields<FormValues>([
    'name',
    chooseTenant && 'tenantId',
    !!item && 'status',
    'productTypeIds',
    'language',
    'currency',
    'exchangeRate',
    ...customerFields,
    'notes',
  ])

  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { errors } = form.formState
  const { reset, setValue } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  // New projects use every active product type, which arrive after the dialog opened.
  const activeTypeIds = types.data?.items.filter((pt) => pt.isActive).map((pt) => pt.id)
  const uiLanguage = i18n.resolvedLanguage ?? 'en'

  // Reset only when the dialog opens or switches record.
  useEffect(() => {
    if (!open) return
    const sep = decimalSeparator(uiLanguage)
    setOrigin({ kind: 'stored' })
    setFetchError(null)
    setConfirmRate(null)
    typedRates.current = {}
    reset({
      name: item?.name ?? '',
      tenantId: item?.tenantId ?? defaultTenantId ?? me.tenantId,
      status: item?.status ?? 'active',
      productTypeIds: item?.productTypeIds ?? [],
      // A new project's proposals are in the user's language when it is a content language.
      language: item?.language ?? ((contentLocales as readonly string[]).includes(uiLanguage) ? uiLanguage : 'en'),
      currency: item?.currency ?? 'USD',
      exchangeRate: formatDecimal(item?.exchangeRate ?? '', sep),
      customer: {
        name: item?.customer.name ?? '',
        company: item?.customer.company ?? '',
        email: item?.customer.email ?? '',
        phone: item?.customer.phone ?? '',
        address: item?.customer.address ?? '',
      },
      notes: item?.notes ?? '',
    })
    resetCreate()
    resetUpdate()
    // The UI language only matters when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item, defaultTenantId, me.tenantId, reset, resetCreate, resetUpdate])

  const activeKey = activeTypeIds?.join(',')
  useEffect(() => {
    if (!open || item || activeKey === undefined) return
    if (form.getValues('productTypeIds').length === 0) setValue('productTypeIds', activeKey ? activeKey.split(',') : [])
  }, [open, item, activeKey, form, setValue])

  // Catalog prices are USD: USD has no rate to set.
  const currency = useWatch({ control: form.control, name: 'currency' }) ?? ''
  const isUsd = currency === 'USD'
  const tenantId = useWatch({ control: form.control, name: 'tenantId' })
  const currencies = useCurrencyOptions(open, item?.currency, chooseTenant ? tenantId : item?.tenantId)
  const formatDate = useFormatRateDate()
  const [origin, setOrigin] = useState<RateOrigin>({ kind: 'stored' })
  const [fetchError, setFetchError] = useState<unknown>(null)
  const [fetching, setFetching] = useState(false)
  // A rate the server found far off the online rate (project.exchange_rate_implausible): saving it again confirms it.
  const [confirmRate, setConfirmRate] = useState<string | null>(null)
  // Rates typed by hand per currency, restored when the currency comes back.
  const typedRates = useRef<Record<string, string>>({})

  const fetchRate = async (code: string) => {
    setFetching(true)
    setFetchError(null)
    try {
      const r = await getExchangeRate(code)
      if (form.getValues('currency') !== code) return // changed again meanwhile
      setValue('exchangeRate', formatDecimal(r.rate, decimalSeparator(uiLanguage)), { shouldValidate: true })
      setOrigin({ kind: 'fetched', rate: r.rate, date: r.date })
    } catch (error) {
      if (form.getValues('currency') === code) setFetchError(error) // not for a currency left meanwhile
    } finally {
      setFetching(false)
    }
  }

  // Editing: a rate belongs to its currency. A new currency clears the field and
  // fetches its online rate, whatever was there (a rate typed for EUR must never
  // be saved as PKR's); back to a currency, the rate typed for it or else the
  // stored rate returns.
  const lastCurrency = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!open) {
      lastCurrency.current = undefined
      return
    }
    const previous = lastCurrency.current
    lastCurrency.current = currency
    if (!item || previous === undefined || previous === currency) return
    if (origin.kind === 'typed') typedRates.current[previous] = form.getValues('exchangeRate')
    setFetchError(null)
    form.clearErrors('exchangeRate')
    const typed = typedRates.current[currency]
    if (typed !== undefined) {
      setValue('exchangeRate', typed)
      setOrigin({ kind: 'typed' })
    } else if (currency === item.currency) {
      setValue('exchangeRate', formatDecimal(item.exchangeRate ?? '', decimalSeparator(uiLanguage)))
      setOrigin({ kind: 'stored' })
    } else {
      setValue('exchangeRate', '')
      setOrigin({ kind: 'none' })
      if (currency !== 'USD' && !currencies.noOnlineRate(currency)) void fetchRate(currency)
    }
    // Only a change of the currency triggers this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currency])

  const rateRegister = form.register('exchangeRate', { onChange: () => setOrigin({ kind: 'typed' }) })
  const rateOrigin = (() => {
    if (origin.kind === 'typed') return t('rate.originTyped')
    if (origin.kind === 'fetched') return t('rate.originOnline', { date: formatDate(origin.date) })
    if (origin.kind === 'stored' && item?.exchangeRate != null && item.exchangeRateDate) {
      if (item.exchangeRateSource === 'online') return t('rate.originOnline', { date: formatDate(item.exchangeRateDate) })
      if (item.exchangeRateSource === 'manual') return t('rate.originManual', { date: formatDate(item.exchangeRateDate) })
    }
    return t('rate.originNone')
  })()

  /** The rate fields of an update: online (the server fetches it again), typed, kept or none. */
  const rateData = (values: FormValues) => {
    if (values.currency === 'USD') return { exchangeRate: '1' }
    const typed = parseDecimal(values.exchangeRate) ?? values.exchangeRate.trim()
    if (origin.kind === 'fetched' && typed === origin.rate) return { exchangeRate: '', exchangeRateSource: 'online' }
    return { exchangeRate: typed, ...(confirmRate !== null && typed !== '' && confirmRate === `${values.currency} ${typed}` ? { exchangeRateConfirmed: true } : {}) }
  }

  const submit = form.handleSubmit(async (values) => {
    const data = {
      name: values.name,
      ...(chooseTenant ? { tenantId: values.tenantId } : {}),
      productTypeIds: values.productTypeIds,
      language: values.language,
      currency: values.currency,
      customer: values.customer,
      notes: values.notes,
    }
    let saved: Project
    try {
      saved = item
        ? await update.mutateAsync({ id: item.id, data: { ...data, ...rateData(values), status: values.status, expectedUpdatedAt: item.updatedAt } })
        : await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      if (error instanceof ApiError && error.fields.some((f) => f.code === 'project.exchange_rate_implausible')) {
        setConfirmRate(`${values.currency} ${parseDecimal(values.exchangeRate) ?? values.exchangeRate.trim()}`)
      }
      return // shown by ErrorMessage via mutation.error
    }
    queryClient.setQueryData(getGetProjectQueryKey(saved.id), saved)
    await queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() })
    onOpenChange(false)
    onSaved?.(saved)
  })

  // Active types to choose; inactive ones only while the project uses them (shown as inactive).
  const chosen = new Set(item?.productTypeIds ?? [])
  const typeOptions = (types.data?.items ?? [])
    .filter((pt) => pt.isActive || chosen.has(pt.id))
    .map((pt) => {
      const label = pt.isActive ? localized(pt.name) : t('field.inactiveType', { name: localized(pt.name) })
      return {
        value: pt.id,
        label,
        content: (
          // Wraps: on a phone the long names would run out of the dialog.
          <TypeBadge color={pt.color} abbreviation={pt.abbreviation} wrap>
            {label}
          </TypeBadge>
        ),
      }
    })

  // Archived tenants are not offered; a project of one keeps showing its tenant.
  const tenantOptions = (tenants.data?.items ?? []).map((tenant) => ({ value: tenant.id, label: tenant.name }))
  if (item?.tenant && !tenantOptions.some((o) => o.value === item.tenantId)) tenantOptions.push({ value: item.tenantId, label: item.tenant.name })

  const languageName = (lng: string) => {
    try {
      const name = new Intl.DisplayNames([uiLanguage], { type: 'language' }).of(lng) ?? lng
      return name.charAt(0).toLocaleUpperCase(uiLanguage) + name.slice(1)
    } catch {
      return lng.toUpperCase()
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('edit') : t('new')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={
        <>
          <ErrorMessage error={mutation.error} fields={fields} />
          <ErrorMessage error={types.error} />
        </>
      }
    >
      <Field label={t('field.name')} hint={t('field.nameHint')} autoComplete="off" required error={fieldError(errors.name?.message)} {...form.register('name')} />
      {chooseTenant && (
        <FormSelectField control={form.control} name="tenantId" label={t('field.tenant')} options={tenantOptions} error={fieldError(errors.tenantId?.message)} />
      )}
      {item && (
        <FormSelectField
          control={form.control}
          name="status"
          label={t('field.status')}
          options={(['active', 'completed', 'cancelled'] as const).map((s) => ({ value: s, label: t(`status.${s}`) }))}
          error={fieldError(errors.status?.message)}
        />
      )}
      <Controller
        control={form.control}
        name="productTypeIds"
        render={({ field }) => (
          <CheckboxGroupField
            label={t('field.productTypes')}
            hint={t('field.productTypesHint')}
            required
            options={typeOptions}
            value={field.value ?? []}
            onChange={field.onChange}
            error={fieldError(errors.productTypeIds?.message)}
          />
        )}
      />

      <Heading>{t('section.pricing')}</Heading>
      <FormSelectField
        control={form.control}
        name="language"
        label={t('field.language')}
        hint={t('field.languageHint')}
        options={contentLocales.map((l) => ({ value: l, label: languageName(l) }))}
        error={fieldError(errors.language?.message)}
      />
      <FormComboboxField
        control={form.control}
        name="currency"
        label={t('field.currency')}
        hint={item ? undefined : t('field.currencyHint')}
        required
        options={currencies.options}
        emptyText={t('field.currencyNoMatch')}
        error={fieldError(errors.currency?.message)}
      />
      <ErrorMessage error={currencies.error} />
      {item && !isUsd && (
        <div className="space-y-2">
          <Field
            label={t('field.exchangeRate')}
            hint={`${t('field.exchangeRateHint', { currency })} · ${rateOrigin}`}
            inputMode="decimal"
            autoComplete="off"
            error={fieldError(errors.exchangeRate?.message)}
            {...rateRegister}
          />
          <Button variant="secondary" size="sm" disabled={fetching || currencies.noOnlineRate(currency)} onClick={() => void fetchRate(currency)}>
            <RefreshCw aria-hidden="true" />
            {t('rate.fetch')}
          </Button>
          {currencies.noOnlineRate(currency) && <Notice>{t('rate.noOnline', { currency })}</Notice>}
          <ErrorMessage error={fetchError} />
        </div>
      )}

      <Heading>{t('section.customer')}</Heading>
      <Field label={t('field.customerName')} autoComplete="off" error={fieldError(errors.customer?.name?.message)} {...form.register('customer.name')} />
      <Field label={t('field.customerCompany')} autoComplete="off" error={fieldError(errors.customer?.company?.message)} {...form.register('customer.company')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('field.customerEmail')} type="email" autoComplete="off" error={fieldError(errors.customer?.email?.message)} {...form.register('customer.email')} />
        <Field label={t('field.customerPhone')} type="tel" autoComplete="off" error={fieldError(errors.customer?.phone?.message)} {...form.register('customer.phone')} />
      </div>
      <TextareaField label={t('field.customerAddress')} error={fieldError(errors.customer?.address?.message)} {...form.register('customer.address')} />
      <TextareaField label={t('field.notes')} rows={4} error={fieldError(errors.notes?.message)} {...form.register('notes')} />
    </FormDialog>
  )
}

/** A heading between groups of fields in the dialog. */
function Heading({ children }: { children: ReactNode }) {
  return <h3 className="border-t border-line pt-4 text-sm font-semibold">{children}</h3>
}
