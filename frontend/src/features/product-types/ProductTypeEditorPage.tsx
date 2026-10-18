import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'

import type { ProductType } from '@/api/generated/model'
import {
  getGetProductTypeQueryKey,
  getListProductTypesQueryKey,
  useCreateProductType,
  useGetProductType,
  useUpdateProductType,
} from '@/api/generated/product-types/product-types'
import { useCan } from '@/app/session'
import {
  Button,
  CheckboxField,
  ErrorMessage,
  Field,
  Fieldset,
  FormActions,
  Loading,
  Page,
  Section,
  setApiFieldErrors,
  TextareaField,
  useFieldError,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { editorFields, formSchema, type FormValues, toFormValues, toInput } from './form'
import { SchemaEditor } from './SchemaEditor'

export const listPath = '/catalog/product-types'

/** catalog/product-types/new and catalog/product-types/:id */
export function ProductTypeEditorPage() {
  const { t } = useTranslation('productTypes')
  const { t: tCommon } = useTranslation()
  const { id } = useParams()
  const query = useGetProductType(id ?? '', { query: { enabled: id !== undefined } })

  if (id === undefined) return <ProductTypeEditor item={null} />
  if (query.isPending) return <Loading />
  if (query.isError) {
    return (
      <Page title={t('edit')}>
        <ErrorMessage error={query.error} />
        <Button asChild variant="secondary">
          <Link to={listPath}>
            <ArrowLeft /> {tCommon('action.back')}
          </Link>
        </Button>
      </Page>
    )
  }
  // Keyed by record: the form starts from the loaded values and is not
  // overwritten by background refetches while editing.
  return <ProductTypeEditor key={query.data.id} item={query.data} />
}

/** The editor itself; read-only for users who may not change product types. */
function ProductTypeEditor({ item }: { item: ProductType | null }) {
  const { t } = useTranslation('productTypes')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const fieldError = useFieldError()
  const canWrite = useCan()('catalog.write')
  const readOnly = item ? !item.can.update : !canWrite
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const create = useCreateProductType()
  const update = useUpdateProductType()
  const mutation = item ? update : create

  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: toFormValues(item ?? undefined) })
  const { errors } = form.formState

  const submit = form.handleSubmit(async (values) => {
    const data = toInput(values)
    try {
      if (item) await update.mutateAsync({ id: item.id, data })
      else await create.mutateAsync({ data })
    } catch (error) {
      setApiFieldErrors(error, form.setError, editorFields)
      return // shown by ErrorMessage via mutation.error
    }
    await queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() })
    if (item) await queryClient.invalidateQueries({ queryKey: getGetProductTypeQueryKey(item.id) })
    void navigate(listPath)
  })

  const title = readOnly && item ? localized(item.name) : item ? t('edit') : t('new')

  return (
    <Page title={title} description={readOnly ? t('readOnly') : undefined}>
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-6">
        <Fieldset disabled={readOnly}>
          <Section title={t('section.basics')}>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('field.key')} hint={t('field.keyHint')} error={fieldError(errors.key?.message)} {...form.register('key')} />
              <Field label={t('field.nameEn')} error={fieldError(errors.name?.en?.message)} {...form.register('name.en')} />
              <Field label={t('field.nameDe')} error={fieldError(errors.name?.de?.message)} {...form.register('name.de')} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextareaField
                label={t('field.descriptionEn')}
                error={fieldError(errors.description?.en?.message)}
                {...form.register('description.en')}
              />
              <TextareaField
                label={t('field.descriptionDe')}
                error={fieldError(errors.description?.de?.message)}
                {...form.register('description.de')}
              />
            </div>
            <CheckboxField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
          </Section>
          <Section title={t('section.attributes')} description={t('section.attributesHint')}>
            <SchemaEditor form={form} name="attributes" readOnly={readOnly} />
          </Section>
          <Section title={t('section.instanceAttributes')} description={t('section.instanceAttributesHint')}>
            <SchemaEditor form={form} name="instanceAttributes" readOnly={readOnly} />
          </Section>
        </Fieldset>
        <FormActions error={<ErrorMessage error={mutation.error} fields={editorFields} />}>
          {readOnly ? (
            <Button asChild variant="secondary">
              <Link to={listPath}>
                <ArrowLeft /> {tCommon('action.back')}
              </Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="secondary">
                <Link to={listPath}>{tCommon('action.cancel')}</Link>
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {item ? tCommon('action.update') : tCommon('action.create')}
              </Button>
            </>
          )}
        </FormActions>
      </form>
    </Page>
  )
}
