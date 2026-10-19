import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useRef } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { useListCatalogFieldMeanings, useListCatalogFields } from '@/api/generated/catalog-fields/catalog-fields'
import { useAnswerImportColumns } from '@/api/generated/imports/imports'
import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import type { CatalogFieldInput, CatalogFieldInputMeaning, CatalogFieldInputType, ImportColumn, ImportColumnAnswer, ImportColumns, ImportMapping } from '@/api/generated/model'
import { useListOutputKinds } from '@/api/generated/output-kinds/output-kinds'
import { useListProductTypes } from '@/api/generated/product-types/product-types'
import {
  type ApiFieldMap,
  Button,
  CheckboxGroupField,
  ErrorMessage,
  Field,
  Fieldset,
  focusFirstError,
  FormActions,
  FormSelectField,
  FormTranslatableField,
  Section,
  SelectField,
  setApiFieldErrors,
  TagsField,
  toTranslatable,
  fromTranslatable,
  type TranslatableValue,
  useFieldError,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

// The mapping's "New columns – what do they mean?" step (D188): every
// attribute column that matches no catalog field is answered as "just
// information" or as a new catalog field (with its meaning for the checks);
// the answered mapping is previewed next.

const fieldTypes = ['text', 'number', 'integer', 'boolean', 'enum'] as const

type Answer = {
  target: string
  mode: 'information' | 'field'
  key: string
  label: TranslatableValue
  type: CatalogFieldInputType
  unit: string
  /** Option texts of an enum field (keys are derived). */
  options: string[]
  meaning: string
  outputKindId: string
  loadTypeId: string
  productTypeIds: string[]
}

type AnswersForm = { answers: Answer[] }

/** A lower snake case key from a text, e.g. "Dimmer W (LED)" → "dimmer_w_led". */
const snakeKey = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f_$1')

const firstAnswer = (c: ImportColumn): Answer => ({
  target: c.target,
  mode: 'field',
  key: c.key,
  label: toTranslatable({ en: c.column || c.key }),
  type: 'text',
  unit: '',
  options: [],
  meaning: '',
  outputKindId: '',
  loadTypeId: '',
  productTypeIds: [],
})

/** Where the server's errors of answer i are shown. */
function answerFields(count: number): ApiFieldMap {
  const map: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    const at = `answers[${i}]`
    const to = `answers.${i}`
    map[at] = `${to}.mode`
    map[`${at}.target`] = `${to}.mode`
    map[`${at}.field`] = `${to}.key`
    for (const f of ['key', 'type', 'unit', 'meaning', 'outputKindId', 'loadTypeId', 'productTypeIds', 'options', 'etimFeature']) map[`${at}.field.${f}`] = `${to}.${f === 'etimFeature' ? 'key' : f}`
    map[`${at}.field.label`] = `${to}.label`
    for (const l of ['en', 'de']) map[`${at}.field.label.${l}`] = `${to}.label.${l}`
    for (let j = 0; j < 50; j++) for (const s of ['', '.key', '.label', '.label.en']) map[`${at}.field.options[${j}]${s}`] = `${to}.options`
  }
  return map
}

function toInput(a: Answer): CatalogFieldInput {
  return {
    key: a.key.trim(),
    label: fromTranslatable(a.label) as CatalogFieldInput['label'],
    type: a.type,
    ...(a.unit.trim() ? { unit: a.unit.trim() } : {}),
    ...(a.type === 'enum' ? { options: a.options.map((o) => ({ key: snakeKey(o), label: { en: o } })) } : {}),
    ...(a.meaning ? { meaning: a.meaning as CatalogFieldInputMeaning } : {}),
    ...(a.meaning && a.outputKindId ? { outputKindId: a.outputKindId } : {}),
    ...(a.meaning && a.loadTypeId ? { loadTypeId: a.loadTypeId } : {}),
    ...(a.meaning && a.productTypeIds.length > 0 ? { productTypeIds: a.productTypeIds } : {}),
  }
}

type Props = {
  /** The mapping that was checked. */
  mapping: ImportMapping
  check: ImportColumns
  /** The answers are saved: preview with this mapping (the columns linked). */
  onAnswered: (mapping: ImportMapping) => void
  onBack: () => void
}

export function NewColumnsStep({ mapping, check, onAnswered, onBack }: Props) {
  const { t } = useTranslation('imports')
  const fieldError = useFieldError()
  const localized = useLocalized()
  const formRef = useRef<HTMLFormElement>(null)
  const unknown = check.columns.filter((c) => c.status === 'unknown')
  const known = check.columns.filter((c) => c.status !== 'unknown')
  const form = useForm<AnswersForm>({ defaultValues: { answers: unknown.map(firstAnswer) } })
  const answers = useWatch({ control: form.control, name: 'answers' })
  const meanings = useListCatalogFieldMeanings()
  const outputKinds = useListOutputKinds()
  const loadTypes = useListLoadTypes()
  const productTypes = useListProductTypes()
  const answer = useAnswerImportColumns()

  const meaningLabel = (m: string) => t(`meaning.${m}` as 'meaning.channels_supplied', { defaultValue: m })
  const meaningOptions = [{ value: '', label: t('columns.noMeaning') }, ...(meanings.data?.items ?? []).map((m) => ({ value: m.meaning, label: meaningLabel(m.meaning) }))]
  const typeOptions = fieldTypes.map((v) => ({ value: v, label: t(`columns.type.${v}`) }))
  const modeOptions = [
    { value: 'field', label: t('columns.modeField') },
    { value: 'information', label: t('columns.modeInformation') },
  ]
  const outputKindOptions = (outputKinds.data?.items ?? []).map((k) => ({ value: k.id, label: localized(k.name) }))
  const loadTypeOptions = (loadTypes.data?.items ?? []).map((k) => ({ value: k.id, label: localized(k.name) }))
  const productTypeOptions = (productTypes.data?.items ?? []).map((p) => ({ value: p.id, label: localized(p.name) }))

  const chooseMeaning = (i: number, meaning: string) => {
    const spec = meanings.data?.items.find((m) => m.meaning === meaning)
    const type = form.getValues(`answers.${i}.type`)
    if (spec && spec.types.length > 0 && !spec.types.includes(type)) form.setValue(`answers.${i}.type`, spec.types[0] as CatalogFieldInputType)
    if (!spec?.outputKind) form.setValue(`answers.${i}.outputKindId`, '')
    if (!spec?.loadType) form.setValue(`answers.${i}.loadTypeId`, '')
  }

  const submit = async (values: AnswersForm) => {
    form.clearErrors()
    const body: ImportColumnAnswer[] = values.answers.map((a) => (a.mode === 'information' ? { target: a.target, information: true } : { target: a.target, field: toInput(a) }))
    try {
      const result = await answer.mutateAsync({ data: { mapping, answers: body } })
      onAnswered(result.mapping)
    } catch (e) {
      setApiFieldErrors(e, form.setError, answerFields(values.answers.length))
      requestAnimationFrame(() => focusFirstError(formRef.current))
    }
  }

  const columnName = (c: ImportColumn) => (c.column ? t('columns.columnNamed', { column: c.column, letter: c.columnLetter ?? '' }) : t('columns.columnLetter', { letter: c.columnLetter ?? '' }))

  return (
    <form ref={formRef} noValidate className="space-y-6" onSubmit={(e) => void form.handleSubmit(submit)(e)}>
      <Fieldset disabled={answer.isPending}>
        <Section title={t('columns.title')} description={t('columns.description', { count: unknown.length })}>
          <ul className="space-y-4">
            {unknown.map((c, i) => {
              const a = answers[i]
              const errors = form.formState.errors.answers?.[i]
              const spec = meanings.data?.items.find((m) => m.meaning === a?.meaning)
              return (
                <li key={c.target} aria-label={columnName(c)} className="space-y-3 rounded-control border border-line p-3">
                  <p className="text-sm font-medium">
                    {columnName(c)} <span className="font-normal text-muted">{t('columns.attributeKey', { key: c.key })}</span>
                  </p>
                  <div className="max-w-sm">
                    <FormSelectField control={form.control} name={`answers.${i}.mode`} label={t('columns.mode')} options={modeOptions} />
                  </div>
                  {a?.mode === 'field' && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label={t('columns.key')} required {...form.register(`answers.${i}.key`)} error={fieldError(errors?.key?.message)} />
                      <FormTranslatableField control={form.control} name={`answers.${i}.label`} label={t('columns.label')} required />
                      <FormSelectField control={form.control} name={`answers.${i}.type`} label={t('columns.typeLabel')} options={typeOptions} required />
                      <Field label={t('columns.unit')} {...form.register(`answers.${i}.unit`)} error={fieldError(errors?.unit?.message)} />
                      {a.type === 'enum' && (
                        <Controller
                          control={form.control}
                          name={`answers.${i}.options`}
                          render={({ field, fieldState }) => (
                            <TagsField label={t('columns.options')} hint={t('columns.optionsHint')} required value={field.value} onChange={field.onChange} error={fieldError(fieldState.error?.message)} />
                          )}
                        />
                      )}
                      <Controller
                        control={form.control}
                        name={`answers.${i}.meaning`}
                        render={({ field, fieldState }) => (
                          // Choosing a meaning also adjusts the type and the parameters.
                          <SelectField
                            label={t('columns.meaning')}
                            hint={t('columns.meaningHint')}
                            value={field.value}
                            options={meaningOptions}
                            error={fieldError(fieldState.error?.message)}
                            onValueChange={(v) => {
                              field.onChange(v)
                              chooseMeaning(i, v)
                            }}
                          />
                        )}
                      />
                      {spec?.outputKind && (
                        <FormSelectField control={form.control} name={`answers.${i}.outputKindId`} label={t('columns.outputKind')} options={outputKindOptions} required />
                      )}
                      {spec?.loadType && <FormSelectField control={form.control} name={`answers.${i}.loadTypeId`} label={t('columns.loadType')} options={loadTypeOptions} required />}
                      {a.meaning && (
                        <Controller
                          control={form.control}
                          name={`answers.${i}.productTypeIds`}
                          render={({ field, fieldState }) => (
                            <CheckboxGroupField
                              label={t('columns.productTypes')}
                              hint={t('columns.productTypesHint')}
                              options={productTypeOptions}
                              value={field.value}
                              onChange={field.onChange}
                              error={fieldError(fieldState.error?.message)}
                            />
                          )}
                        />
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
        {known.length > 0 && <KnownColumns columns={known} />}
      </Fieldset>
      <FormActions error={<ErrorMessage error={answer.error} fields={answerFields(answers.length)} />}>
        <Button variant="secondary" onClick={onBack} disabled={answer.isPending}>
          <ArrowLeft /> {t('columns.back')}
        </Button>
        <Button type="submit" disabled={answer.isPending}>
          {t('columns.save')} <ArrowRight />
        </Button>
      </FormActions>
    </form>
  )
}

/** The attribute columns that are known: linked to a catalog field, defined by a category, or answered as just information. */
export function KnownColumns({ columns }: { columns: (ImportColumn & { fieldKey?: string })[] }) {
  const { t } = useTranslation('imports')
  const localized = useLocalized()
  return (
    <Section title={t('columns.knownTitle')} description={t('columns.knownDescription')}>
      <ul className="divide-y divide-line text-sm">
        {columns.map((c) => (
          <li key={c.target} className="flex flex-wrap justify-between gap-2 py-2">
            <span>{c.column || c.columnLetter}</span>
            <span className="text-muted">
              {c.status === 'field' && c.field
                ? t('columns.knownField', {
                    field: localized(c.field.label),
                    meaning: c.field.meaning ? t(`meaning.${c.field.meaning}` as 'meaning.channels_supplied') : t('columns.noMeaning'),
                  })
                : c.status === 'field' && c.fieldKey
                  ? t('columns.knownFieldKey', { key: c.fieldKey })
                  : t(`columns.status.${c.status}` as 'columns.status.category')}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** The columns of a previewed mapping linked to catalog fields or answered as just information. */
export function LinkedColumns({ mapping }: { mapping?: ImportMapping }) {
  const linked = (mapping?.fields ?? []).filter((f) => f.fieldKey || f.information)
  const fields = useListCatalogFields(undefined, { query: { enabled: linked.some((f) => f.fieldKey) } })
  if (linked.length === 0) return null
  const columns = linked.map((f, i) => ({
    fieldIndex: i,
    target: f.target,
    key: f.target.slice('attribute.'.length),
    column: f.column,
    columnLetter: f.columnLetter,
    status: f.information ? ('information' as const) : ('field' as const),
    field: fields.data?.items.find((x) => x.key === f.fieldKey),
    fieldKey: f.fieldKey,
  }))
  return <KnownColumns columns={columns} />
}
