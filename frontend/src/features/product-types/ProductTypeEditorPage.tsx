import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, RotateCw } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, useBlocker, useNavigate, useParams } from 'react-router'

import { ApiError } from '@/api/client'
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
  type ApiFieldMap,
  Button,
  CheckboxField,
  ColorField,
  ConfirmDialog,
  EmptyState,
  ErrorMessage,
  errorKey,
  Field,
  Fieldset,
  focusFirstError,
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
  const { id } = useParams()
  if (id === undefined) return <ProductTypeEditor item={null} />
  return <ExistingProductType id={id} />
}

/** A missing product type, or an id that is not one (422 at path.id). */
const isNotFound = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || (error.status === 422 && error.fields.some((f) => f.location.startsWith('path.'))))

function BackToList() {
  const { t } = useTranslation()
  return (
    <Button asChild variant="secondary">
      <Link to={listPath}>
        <ArrowLeft /> {t('action.backToList')}
      </Link>
    </Button>
  )
}

function ExistingProductType({ id }: { id: string }) {
  const { t } = useTranslation('productTypes')
  const { t: tCommon } = useTranslation()
  // The editor never starts from cached data: it is fetched on every visit,
  // and the form shows only once that fetch is done (D44). With
  // expectedUpdatedAt (D37) no one overwrites a newer version unknowingly.
  const query = useGetProductType(id, { query: { staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false } })
  // Increased by "Reload" to restart the form from the reloaded version.
  const [generation, setGeneration] = useState(0)

  if (query.isError) {
    if (isNotFound(query.error)) {
      return (
        <Page title={t('notFound.title')}>
          <EmptyState title={t('notFound.message')} action={<BackToList />} />
        </Page>
      )
    }
    return (
      <Page title={tCommon('state.errorTitle')}>
        <ErrorMessage error={query.error} />
        <BackToList />
      </Page>
    )
  }
  if (!query.isFetchedAfterMount || !query.data) return <Loading />

  const reload = async () => {
    await query.refetch()
    setGeneration((g) => g + 1)
  }
  return <ProductTypeEditor key={`${query.data.id}:${generation}`} item={query.data} onReload={reload} />
}

/** The editor itself; read-only for users who may not change product types. */
function ProductTypeEditor({ item, onReload }: { item: ProductType | null; onReload?: () => Promise<void> }) {
  const { t } = useTranslation('productTypes')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const fieldError = useFieldError()
  const canWrite = useCan()('catalog.write')
  // The version being edited; background refetches must not change what is
  // sent as expectedUpdatedAt.
  const [loaded] = useState(item)
  const readOnly = loaded ? !loaded.can.update : !canWrite
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const create = useCreateProductType()
  const update = useUpdateProductType()
  const mutation = loaded ? update : create

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: toFormValues(loaded),
    // Focus goes to the first error in page order, after rows with errors opened.
    shouldFocusError: false,
  })
  const { errors, isDirty } = form.formState

  // The fields the last failed save showed its errors at (see editorFields).
  const [errorFields, setErrorFields] = useState<ApiFieldMap>()
  const [errorRevision, setErrorRevision] = useState(0)
  const formRef = useRef<HTMLFormElement>(null)
  const focusPending = useRef(false)
  useEffect(() => {
    if (!focusPending.current) return
    focusPending.current = false
    focusFirstError(formRef.current)
  }, [errorRevision])
  const failed = () => {
    focusPending.current = true
    setErrorRevision((r) => r + 1)
  }

  // Unsaved changes: ask before leaving the page in the app, and let the
  // browser ask before closing or reloading the tab (D28).
  const saved = useRef(false)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => isDirty && !saved.current && currentLocation.pathname !== nextLocation.pathname,
  )
  useEffect(() => {
    if (!isDirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [isDirty])

  const save = async (values: FormValues) => {
    const data = toInput(values)
    const fields = editorFields(values)
    try {
      if (loaded) await update.mutateAsync({ id: loaded.id, data: { ...data, expectedUpdatedAt: loaded.updatedAt } })
      else await create.mutateAsync({ data })
    } catch (error) {
      setErrorFields(fields)
      setApiFieldErrors(error, form.setError, fields)
      // A taken key comes without a location (409), but belongs to the Key field.
      if (error instanceof ApiError && error.code === 'product_type.key_taken') {
        form.setError('key', { type: 'server', message: errorKey('product_type.key_taken', { key: values.key }) })
      }
      failed()
      return // the rest is shown by ErrorMessage via mutation.error
    }
    saved.current = true
    await queryClient.invalidateQueries({ queryKey: getListProductTypesQueryKey() })
    if (loaded) await queryClient.invalidateQueries({ queryKey: getGetProductTypeQueryKey(loaded.id) })
    void navigate(listPath)
  }

  const submit = async (e: FormEvent) => {
    let invalid = false
    await form.handleSubmit(save, () => {
      invalid = true
    })(e)
    // After handleSubmit, so the errors are in the form state when rows open.
    if (invalid) failed()
  }

  const stale = mutation.error instanceof ApiError && mutation.error.code === 'product_type.stale'
  const title = readOnly && loaded ? localized(loaded.name) : loaded ? t('edit') : t('new')

  return (
    <Page title={title} description={readOnly ? t('readOnly') : undefined}>
      <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="space-y-6">
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
            <div className="grid items-start gap-4 sm:grid-cols-3">
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
              <div className="sm:col-span-2 sm:pt-7">
                <CheckboxField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
              </div>
            </div>
          </Section>
          <Section title={t('section.attributes')} description={t('section.attributesHint')}>
            <SchemaEditor form={form} name="attributes" readOnly={readOnly} startCollapsed={loaded !== null} errorRevision={errorRevision} />
          </Section>
          <Section title={t('section.instanceAttributes')} description={t('section.instanceAttributesHint')}>
            <SchemaEditor
              form={form}
              name="instanceAttributes"
              readOnly={readOnly}
              startCollapsed={loaded !== null}
              errorRevision={errorRevision}
            />
          </Section>
        </Fieldset>
        <FormActions
          error={
            <ErrorMessage
              error={mutation.error}
              fields={errorFields}
              action={
                stale &&
                onReload && (
                  <Button size="sm" variant="secondary" onClick={() => void onReload()}>
                    <RotateCw /> {tCommon('action.reload')}
                  </Button>
                )
              }
            />
          }
        >
          {readOnly ? (
            <BackToList />
          ) : (
            <>
              <Button asChild variant="secondary">
                <Link to={listPath}>{tCommon('action.cancel')}</Link>
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {loaded ? tCommon('action.update') : tCommon('action.create')}
              </Button>
            </>
          )}
        </FormActions>
      </form>

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
        title={tCommon('unsaved.title')}
        message={tCommon('unsaved.message')}
        confirmLabel={tCommon('action.leave')}
        cancelLabel={tCommon('action.stay')}
        pending={false}
        onConfirm={() => blocker.proceed?.()}
      />
    </Page>
  )
}
