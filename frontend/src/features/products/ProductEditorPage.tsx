import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams } from 'react-router'

import { ApiError } from '@/api/client'
import type { Product, ProductType } from '@/api/generated/model'
import {
  getGetProductQueryKey,
  getListProductsQueryKey,
  getSearchVariantsQueryKey,
  useCreateProduct,
  useGetProduct,
  useUpdateProduct,
} from '@/api/generated/products/products'
import { useCan } from '@/app/session'
import { definitionsFor, extraKeys, storedValueErrors } from '@/catalog/attribute-values'
import { AttributeValuesEditor, ExtraValues } from '@/catalog/AttributeValuesEditor'
import {
  type ApiFieldMap,
  Button,
  CheckboxField,
  EmptyState,
  ErrorMessage,
  errorKey,
  Field,
  Fieldset,
  focusFirstError,
  FormActions,
  LeaveLink,
  Loading,
  Notice,
  Page,
  Section,
  FormSelectField,
  setApiFieldErrors,
  TextareaField,
  toFieldErrors,
  TypeBadge,
  useFieldError,
  useUnsavedChanges,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import {
  editorFields,
  type ProductFormValues,
  productSchema,
  storedValues,
  toAttributes,
  toProductFormValues,
  toProductInput,
} from './form'
import {
  type EditorState,
  fresh,
  isNotFound,
  listHref,
  listPath,
  listSearchFrom,
  noticeFrom,
  productPath,
  type SaveNotice,
  useFreshProductTypes,
} from './paths'
import { VariantsSection } from './VariantsSection'

/** catalog/products/new and catalog/products/:id */
export function ProductEditorPage() {
  const { id } = useParams()
  if (id === undefined) return <NewProduct />
  return <ExistingProduct id={id} />
}

function BackToList() {
  return <LeaveLink to={listPath} dirty={false} />
}

/** A failed load: not found, or the error with a way back. */
function LoadFailed({ error }: { error: unknown }) {
  const { t } = useTranslation('products')
  const { t: tCommon } = useTranslation()
  if (isNotFound(error)) {
    return (
      <Page title={t('notFound.title')}>
        <EmptyState title={t('notFound.message')} action={<BackToList />} />
      </Page>
    )
  }
  return (
    <Page title={tCommon('state.errorTitle')}>
      <ErrorMessage error={error} />
      <BackToList />
    </Page>
  )
}

function NewProduct() {
  const { t } = useTranslation('products')
  const listSearch = listSearchFrom(useLocation().state)
  const types = useFreshProductTypes()
  const [dirty, setDirty] = useState(false)
  const unsaved = useUnsavedChanges(dirty)
  if (types.isError) return <LoadFailed error={types.error} />
  if (!types.isFetchedAfterMount || !types.data) return <Loading />
  return (
    <Page title={t('new')}>
      <ProductForm
        item={null}
        types={types.data.items}
        listSearch={listSearch}
        onDirtyChange={setDirty}
        onLeave={unsaved.allow}
      />
      {unsaved.dialog}
    </Page>
  )
}

function ExistingProduct({ id }: { id: string }) {
  const { t } = useTranslation('products')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const queryClient = useQueryClient()
  const location = useLocation()
  const listSearch = listSearchFrom(location.state)
  // The product and the schemas are fetched on every visit; the form edits
  // the version loaded then (D44), the variants below always show the
  // current one.
  const query = useGetProduct(id, { query: fresh })
  const types = useFreshProductTypes()
  // Increased to restart the form from a newer version (Reload, or after a save).
  const [generation, setGeneration] = useState(0)
  const [notice, setNotice] = useState<SaveNotice | null>(() => noticeFrom(location.state))
  const [dirty, setDirty] = useState(false)
  const unsaved = useUnsavedChanges(dirty)

  if (query.isError) return <LoadFailed error={query.error} />
  if (types.isError) return <LoadFailed error={types.error} />
  if (!query.isFetchedAfterMount || !query.data || !types.isFetchedAfterMount || !types.data) return <Loading />

  const product = query.data
  const readOnly = !product.can.update
  const reload = async () => {
    await Promise.all([query.refetch(), types.refetch()])
    setNotice(null)
    setGeneration((g) => g + 1)
  }
  const saved = (updated: Product) => {
    queryClient.setQueryData(getGetProductQueryKey(id), updated)
    setNotice('saved')
    setGeneration((g) => g + 1)
  }

  return (
    <Page
      title={readOnly ? localized(product.name) : t('edit')}
      description={readOnly ? t('readOnly') : `${product.modelNumber} · ${localized(product.name)}`}
    >
      {notice && <Notice>{notice === 'created' ? t('created') : tCommon('state.saved')}</Notice>}
      <ProductForm
        key={`${product.id}:${generation}`}
        item={product}
        types={types.data.items}
        listSearch={listSearch}
        onReload={reload}
        onSaved={saved}
        onDirtyChange={(changed) => {
          setDirty(changed)
          // A notice about the last save is over once something changes.
          if (changed) setNotice(null)
        }}
        onLeave={unsaved.allow}
      />
      <VariantsSection product={product} locked={dirty} linkState={{ listSearch }} />
      {unsaved.dialog}
    </Page>
  )
}

type ProductFormProps = {
  item: Product | null
  types: ProductType[]
  /** The product list's filters to return to. */
  listSearch: string
  onReload?: () => Promise<void>
  /** After an update: restart from the saved version. */
  onSaved?: (product: Product) => void
  onDirtyChange: (dirty: boolean) => void
  /** Lets the next navigation pass without asking (after a save). */
  onLeave: () => void
}

/** The product's own fields and attribute values; read-only for users who may not change it. */
function ProductForm({ item, types, listSearch, onReload, onSaved, onDirtyChange, onLeave }: ProductFormProps) {
  const { t } = useTranslation('products')
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
  const create = useCreateProduct()
  const update = useUpdateProduct()
  const mutation = loaded ? update : create

  const typeById = (id: string) => types.find((pt) => pt.id === id)
  const stored = storedValues(loaded)
  const [defaults] = useState(() => toProductFormValues(loaded, definitionsFor(typeById(loaded?.productTypeId ?? ''), 'product')))
  // Stored values that do not fit the current schema are marked from the start (D55).
  const [storedErrors] = useState(() =>
    loaded && loaded.attributeErrors.length > 0
      ? toFieldErrors<ProductFormValues>(
          storedValueErrors(loaded.attributeErrors),
          editorFields('product', definitionsFor(typeById(loaded.productTypeId), 'product'), defaults.values, stored),
        )
      : undefined,
  )
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: defaults,
    errors: storedErrors,
    // Focus goes to the first error in page order.
    shouldFocusError: false,
  })
  const { errors, isDirty } = form.formState
  const productTypeId = useWatch({ control: form.control, name: 'productTypeId' })
  const values = useWatch({ control: form.control, name: 'values' })
  const keep = useWatch({ control: form.control, name: 'keep' })
  const type = typeById(productTypeId)
  const definitions = definitionsFor(type, 'product')
  const extras = type ? extraKeys(definitions, stored) : []

  useEffect(() => onDirtyChange(isDirty), [isDirty, onDirtyChange])

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


  const errorAt = (name: `values.${string}` | `keep.${string}`) => fieldError(form.getFieldState(name, form.formState).error?.message)

  const save = async (v: ProductFormValues) => {
    const defs = definitionsFor(typeById(v.productTypeId), 'product')
    const fields = editorFields('product', defs, v.values, stored)
    const { attributes, errors: inputErrors } = toAttributes(defs, v.values, v.keep, stored)
    if (inputErrors.length > 0) {
      for (const e of inputErrors) form.setError(e.name, { type: 'input', message: e.message })
      failed()
      return
    }
    const data = toProductInput(v, attributes)
    let result: Product
    try {
      result = loaded
        ? await update.mutateAsync({ id: loaded.id, data: { ...data, expectedUpdatedAt: loaded.updatedAt } })
        : await create.mutateAsync({ data })
    } catch (error) {
      setErrorFields(fields)
      setApiFieldErrors(error, form.setError, fields)
      // A taken model number comes without a location (409), but belongs to its field.
      if (error instanceof ApiError && error.code === 'product.model_number_taken') {
        form.setError('modelNumber', { type: 'server', message: errorKey('product.model_number_taken', { modelNumber: data.modelNumber }) })
      }
      failed()
      return // the rest is shown by ErrorMessage via mutation.error
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getSearchVariantsQueryKey() }),
    ])
    if (loaded) {
      onSaved?.(result)
      return
    }
    // A new product continues on its page, where its variants are added (D84).
    onLeave()
    queryClient.setQueryData(getGetProductQueryKey(result.id), result)
    const state: EditorState = { notice: 'created', listSearch }
    void navigate(productPath(result.id), { replace: true, state })
  }

  const submit = async (e: FormEvent) => {
    let invalid = false
    await form.handleSubmit(save, () => {
      invalid = true
    })(e)
    if (invalid) failed()
  }

  const stale = mutation.error instanceof ApiError && mutation.error.code === 'product.stale'
  const typeOptions = [
    ...(loaded ? [] : [{ value: '', label: t('field.chooseType') }]),
    ...types
      .filter((pt) => pt.isActive || pt.id === loaded?.productTypeId)
      .map((pt) => {
        const label = pt.isActive ? localized(pt.name) : t('field.inactiveType', { name: localized(pt.name) })
        return { value: pt.id, label, content: <TypeBadge color={pt.color}>{label}</TypeBadge> }
      }),
  ]
  const typeChanged = loaded !== null && productTypeId !== loaded.productTypeId

  return (
    <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="space-y-6">
      <Fieldset disabled={readOnly}>
        <Section title={t('section.basics')}>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormSelectField
              control={form.control}
              name="productTypeId"
              label={t('field.productType')}
              options={typeOptions}
              error={fieldError(errors.productTypeId?.message)}
            />
            <Field
              label={t('field.modelNumber')}
              hint={t('field.modelNumberHint')}
              autoComplete="off"
              error={fieldError(errors.modelNumber?.message)}
              {...form.register('modelNumber')}
            />
            <div className="sm:pt-7">
              <CheckboxField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
            </div>
          </div>
          {typeChanged && <Notice tone="warning">{t('typeChange')}</Notice>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('field.nameEn')} error={fieldError(errors.name?.en?.message)} {...form.register('name.en')} />
            <Field label={t('field.nameDe')} error={fieldError(errors.name?.de?.message)} {...form.register('name.de')} />
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
        </Section>
        <Section title={t('section.attributes')} description={t('section.attributesHint')}>
          {loaded && !typeChanged && loaded.attributeErrors.length > 0 && <Notice tone="warning">{t('storedErrors')}</Notice>}
          {type ? (
            <>
              <AttributeValuesEditor
                definitions={definitions}
                values={values}
                onChange={(key, value) => form.setValue(`values.${key}`, value, { shouldDirty: true })}
                errors={Object.fromEntries(definitions.map((d) => [d.key, errorAt(`values.${d.key}`)]))}
                disabled={readOnly}
              />
              <ExtraValues
                entries={extras.map((key) => ({ key, value: stored[key], kept: keep[key] !== false, error: errorAt(`keep.${key}`) }))}
                onKeptChange={(key, kept) => form.setValue(`keep.${key}`, kept, { shouldDirty: true })}
                disabled={readOnly}
              />
            </>
          ) : (
            <p className="text-sm text-muted">{t('chooseTypeFirst')}</p>
          )}
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
        <LeaveLink to={listHref(listSearch)} dirty={isDirty && !readOnly} />
        {!readOnly && (
          <Button type="submit" disabled={mutation.isPending}>
            {loaded ? tCommon('action.update') : tCommon('action.create')}
          </Button>
        )}
      </FormActions>
    </form>
  )
}
