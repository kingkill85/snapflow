import { zodResolver } from '@hookform/resolvers/zod'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import { getGetBomQueryKey, previewPricing, useGetPricing, useUpdatePricing } from '@/api/generated/bom/bom'
import type { BOMTotals, Pricing, PricingInput } from '@/api/generated/model'
import { contentLocales } from '@/i18n/content-locales'
import type { LocalizedText } from '@/i18n/localized'
import { formatDecimal, parseDecimal, useDecimalSeparator } from '@/catalog/decimal'
import {
  apiFields,
  Button,
  errorKey,
  ErrorMessage,
  Field,
  Fieldset,
  FormSelectField,
  FormTranslatableField,
  Loading,
  Notice,
  optionalTranslatable,
  Section,
  setApiFieldErrors,
  toTranslatable,
  translatableApiFields,
  translatableSchema,
  useFieldError,
} from '@/components/ui'

import { fresh } from './format'
import { TotalsBlock } from './TotalsBlock'

const kinds = ['none', 'percent', 'amount'] as const
type Kind = (typeof kinds)[number]

/** A percent or amount with at most 2 decimals, typed with "," or "." (D144); ranges are the API's (field errors). */
const valuePattern = /^\d{1,10}(\.\d{1,2})?$/
const value = z.string().trim()
const schema = z
  .object({
    discountKind: z.enum(kinds),
    discountValue: value,
    servicesKind: z.enum(kinds),
    servicesValue: value,
    servicesLabel: translatableSchema({ max: 200, checkDefault: false }),
    introText: translatableSchema({ max: 5000 }),
    closingText: translatableSchema({ max: 5000 }),
  })
  .superRefine((v, ctx) => {
    for (const [kind, field] of [
      [v.discountKind, 'discountValue'],
      [v.servicesKind, 'servicesValue'],
    ] as const) {
      if (kind === 'none') continue
      const parsed = parseDecimal(v[field])
      if (v[field] === '') ctx.addIssue({ code: 'custom', path: [field], message: errorKey('validation.required') })
      else if (parsed === undefined || !valuePattern.test(parsed)) ctx.addIssue({ code: 'custom', path: [field], message: errorKey('pricing.value_invalid') })
    }
  })
type FormValues = z.infer<typeof schema>

const fields = apiFields<FormValues>(['discountKind', 'discountValue', 'servicesKind', 'servicesValue', 'servicesLabel', 'introText', 'closingText'])
const allFields = { ...fields, ...translatableApiFields('servicesLabel'), ...translatableApiFields('introText'), ...translatableApiFields('closingText') }

/** Whether two texts are the same in every content language. */
const sameText = (a: LocalizedText, b: LocalizedText) => contentLocales.every((l) => (a[l] ?? '').trim() === (b[l] ?? '').trim())

/**
 * The API body of the form values; undefined while a value cannot be sent.
 * A services label equal to the API's default (servicesLabelDefault) is sent
 * as {} (= no label of its own), so the version keeps following the default,
 * also after it was saved once or when a label of its own is typed back to it.
 */
function toInput(v: FormValues, defaultLabel: LocalizedText): PricingInput | undefined {
  const parse = (kind: Kind, text: string) => (kind === 'none' ? '0' : parseDecimal(text))
  const discountValue = parse(v.discountKind, v.discountValue)
  const servicesValue = parse(v.servicesKind, v.servicesValue)
  if (discountValue === undefined || servicesValue === undefined) return undefined
  const label = optionalTranslatable(v.servicesLabel)
  return {
    discountKind: v.discountKind,
    discountValue,
    servicesKind: v.servicesKind,
    servicesValue,
    servicesLabel: label && !sameText(label, defaultLabel) ? label : {},
    // Blank texts are sent as {} (none, D262).
    introText: optionalTranslatable(v.introText) ?? {},
    closingText: optionalTranslatable(v.closingText) ?? {},
  }
}

/** "5.00" → "5", "12.50" stays: the form shows a whole percent or amount without zero decimals. */
const wholeNumber = (value: string) => value.replace(/\.0+$/, '')

type Props = {
  versionId: string
  canWrite: boolean
}

/**
 * The Pricing tab: discount and services (none / percent / amount) with the
 * services label; beside the form the totals for the values as typed, from
 * the preview endpoint (debounced; no client maths, rule 1).
 */
export function PricingTab({ versionId, canWrite }: Props) {
  const query = useGetPricing(versionId, { query: fresh })
  if (query.isError) return <ErrorMessage error={query.error} />
  // Never start the form from a cached copy (D44): its updatedAt may be old, and the first save would be stale.
  if (query.isPending || !query.isFetchedAfterMount) return <Loading />
  return <PricingForm versionId={versionId} canWrite={canWrite} pricing={query.data} refetch={() => void query.refetch()} />
}

function PricingForm({ versionId, canWrite, pricing, refetch }: Props & { pricing: Pricing; refetch: () => void }) {
  const { t } = useTranslation('bom')
  const fieldError = useFieldError()
  const separator = useDecimalSeparator()
  const queryClient = useQueryClient()
  const save = useUpdatePricing()
  const [saved, setSaved] = useState(false)
  // The pricing the next save expects: the loaded one, or the one a stale error made us reload.
  const base = useRef(pricing)
  base.current = pricing
  const toForm = (p: Pricing): FormValues => ({
    discountKind: p.discountKind,
    discountValue: p.discountKind === 'none' ? '' : formatDecimal(wholeNumber(p.discountValue), separator),
    servicesKind: p.servicesKind,
    servicesValue: p.servicesKind === 'none' ? '' : formatDecimal(wholeNumber(p.servicesValue), separator),
    servicesLabel: toTranslatable(p.servicesLabel),
    introText: toTranslatable(p.introText),
    closingText: toTranslatable(p.closingText),
  })
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: toForm(pricing) })
  const { errors } = form.formState
  const values = useWatch({ control: form.control }) as FormValues

  // Debounced preview of the totals for the values as typed.
  // The texts do not change the totals: typing them does not refresh the preview.
  const full = toInput(values, pricing.servicesLabelDefault)
  const input = full && { ...full, introText: undefined, closingText: undefined }
  const [debounced, setDebounced] = useState(input)
  const inputKey = JSON.stringify(input)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input), 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey])
  const preview = useQuery({
    queryKey: ['pricing-preview', versionId, debounced],
    queryFn: ({ signal }) => previewPricing(versionId, debounced!, signal),
    enabled: debounced !== undefined,
    placeholderData: keepPreviousData,
    retry: false,
  })

  const submit = form.handleSubmit(async (v) => {
    setSaved(false)
    const body = toInput(v, base.current.servicesLabelDefault)!
    try {
      const bom = await save.mutateAsync({ versionId, data: { ...body, expectedUpdatedAt: base.current.updatedAt } })
      queryClient.setQueryData(getGetBomQueryKey(versionId), bom)
      form.reset(toForm(bom.pricing))
      refetch()
      setSaved(true)
    } catch (error) {
      setApiFieldErrors(error, form.setError, allFields)
      // Someone else saved meanwhile: load theirs, so saving again overwrites it knowingly.
      if (error instanceof ApiError && error.code === 'pricing.stale') refetch()
    }
  })

  const kindOptions = kinds.map((k) => ({ value: k, label: t(`pricing.kinds.${k}`) }))
  const valueField = (kindName: 'discountKind' | 'servicesKind', name: 'discountValue' | 'servicesValue', label: string) => {
    const kind = values[kindName]
    if (kind === 'none') return null
    return (
      <Field
        label={label}
        inputMode="decimal"
        autoComplete="off"
        required
        suffix={kind === 'percent' ? '%' : 'USD'}
        hint={kind === 'percent' ? t('pricing.percentHint') : t('pricing.amountHint')}
        error={fieldError(errors[name]?.message)}
        {...form.register(name)}
      />
    )
  }
  // The last totals the preview computed: shown dimmed while the values are invalid (the field says why).
  const lastTotals = useRef<BOMTotals | undefined>(undefined)
  if (preview.data) lastTotals.current = preview.data
  const invalid = (preview.isError && preview.error instanceof ApiError && preview.error.status === 422) || (input === undefined && !!lastTotals.current)
  const previewTotals = preview.isError ? (invalid ? lastTotals.current : undefined) : preview.data

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
      <Section title={t('pricing.title')}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
          className="space-y-6"
        >
          <ErrorMessage error={save.error} fields={allFields} />
          {saved && !form.formState.isDirty && <Notice>{t('pricing.saved')}</Notice>}
          <Fieldset disabled={!canWrite}>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormSelectField control={form.control} name="discountKind" label={t('pricing.discount')} options={kindOptions} disabled={!canWrite} />
              {valueField('discountKind', 'discountValue', t('pricing.discountValue'))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormSelectField control={form.control} name="servicesKind" label={t('pricing.services')} options={kindOptions} disabled={!canWrite} />
              {valueField('servicesKind', 'servicesValue', t('pricing.servicesValue'))}
            </div>
            <FormTranslatableField control={form.control} name="servicesLabel" label={t('pricing.servicesLabel')} hint={t('pricing.servicesLabelHint')} />
            <FormTranslatableField control={form.control} name="introText" label={t('pricing.introText')} hint={t('pricing.introTextHint')} multiline rows={4} />
            <FormTranslatableField control={form.control} name="closingText" label={t('pricing.closingText')} hint={t('pricing.closingTextHint')} multiline rows={4} />
          </Fieldset>
          {canWrite && (
            <div className="flex justify-end">
              <Button type="submit" disabled={save.isPending}>
                {t('pricing.save')}
              </Button>
            </div>
          )}
        </form>
      </Section>
      <div className="space-y-2">
        {previewTotals ? (
          <TotalsBlock
            totals={previewTotals}
            servicesLabel={optionalTranslatable(values.servicesLabel) ?? pricing.servicesLabel}
            title={canWrite ? t('pricing.preview') : undefined}
            pending={invalid || preview.isFetching || JSON.stringify(debounced) !== inputKey}
          />
        ) : preview.isError ? null : (
          <Loading />
        )}
        {invalid ? <p className="ml-auto w-full max-w-md text-xs text-muted">{t('pricing.previewInvalid')}</p> : preview.isError && <ErrorMessage error={preview.error} />}
      </div>
    </div>
  )
}
