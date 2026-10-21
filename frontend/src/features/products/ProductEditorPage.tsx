import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams } from 'react-router'

import { ApiError } from '@/api/client'
import type { Category, Product, ProductType } from '@/api/generated/model'
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
import { useDecimalSeparator } from '@/catalog/decimal'
import { catalogCurrency } from '@/catalog/money'
import {
  type ApiFieldMap,
  Button,
  EmptyState,
  ErrorMessage,
  errorKey,
  Field,
  Fieldset,
  focusFirstError,
  FormActions,
  FormTranslatableField,
  LeaveLink,
  Loading,
  Notice,
  Page,
  Section,
  FormSelectField,
  setApiFieldErrors,
  SwitchField,
  toFieldErrors,
  TypeBadge,
  useFieldError,
  useUnsavedChanges,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import {
  editorFields,
  type ProductFormValues,
  productCreateSchema,
  productSchema,
  storedValues,
  toAttributes,
  toFirstVariantAttributes,
  toProductCreate,
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
  productPath,
  useFreshCategories,
  useSaveNotice,
  useFreshProductTypes,
} from './paths'
import { CapabilitiesSection } from './CapabilitiesSection'
import { SingleVariantSection } from './SingleVariantSection'
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
  const categories = useFreshCategories()
  const [dirty, setDirty] = useState(false)
  const unsaved = useUnsavedChanges(dirty)
  if (types.isError) return <LoadFailed error={types.error} />
  if (categories.isError) return <LoadFailed error={categories.error} />
  if (!types.isFetchedAfterMount || !types.data || !categories.isFetchedAfterMount || !categories.data) return <Loading />
  return (
    <Page title={t('new')}>
      <ProductForm
        item={null}
        types={types.data.items}
        categories={categories.data.items}
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
  const categories = useFreshCategories()
  // Increased to restart the form from a newer version (Reload, or after a save).
  const [generation, setGeneration] = useState(0)
  const [notice, setNotice] = useSaveNotice()
  const [dirty, setDirty] = useState(false)
  const [variantDirty, setVariantDirty] = useState(false)
  const unsaved = useUnsavedChanges(dirty || variantDirty)

  if (query.isError) return <LoadFailed error={query.error} />
  if (types.isError) return <LoadFailed error={types.error} />
  if (categories.isError) return <LoadFailed error={categories.error} />
  if (
    !query.isFetchedAfterMount ||
    !query.data ||
    !types.isFetchedAfterMount ||
    !types.data ||
    !categories.isFetchedAfterMount ||
    !categories.data
  ) {
    return <Loading />
  }

  const product = query.data
  const readOnly = !product.can.update
  const reload = async () => {
    await Promise.all([query.refetch(), types.refetch(), categories.refetch()])
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
        categories={categories.data.items}
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
      {/* One variant: its price and values right here; the list from two on (D449). */}
      {product.variants.length === 1 ? (
        <SingleVariantSection
          product={product}
          variant={product.variants[0]}
          category={categories.data.items.find((c) => c.id === product.categoryId)}
          locked={dirty}
          linkState={{ listSearch }}
          onDirtyChange={(changed) => {
            setVariantDirty(changed)
            if (changed) setNotice(null)
          }}
          onSaved={() => setNotice('saved')}
          onLeave={unsaved.allow}
        />
      ) : (
        <VariantsSection product={product} locked={dirty} linkState={{ listSearch }} />
      )}
      <CapabilitiesSection product={product} />
      {unsaved.dialog}
    </Page>
  )
}

type ProductFormProps = {
  item: Product | null
  types: ProductType[]
  /** The categories with their schemas. */
  categories: Category[]
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
function ProductForm({ item, types, categories, listSearch, onReload, onSaved, onDirtyChange, onLeave }: ProductFormProps) {
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

  const categoryById = (id: string) => categories.find((c) => c.id === id)
  const stored = storedValues(loaded)
  const separator = useDecimalSeparator()
  const [defaults] = useState(() => toProductFormValues(loaded, definitionsFor(categoryById(loaded?.categoryId ?? ''), 'product'), separator))
  // Stored values that do not fit the current schema are marked from the start (D55).
  const [storedErrors] = useState(() =>
    loaded && loaded.attributeErrors.length > 0
      ? toFieldErrors<ProductFormValues>(
          storedValueErrors(loaded.attributeErrors),
          editorFields('product', definitionsFor(categoryById(loaded.categoryId), 'product'), defaults.values, stored),
        )
      : undefined,
  )
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(loaded ? productSchema : productCreateSchema),
    defaultValues: defaults,
    errors: storedErrors,
    // Focus goes to the first error in page order.
    shouldFocusError: false,
  })
  const { errors, isDirty } = form.formState
  const categoryId = useWatch({ control: form.control, name: 'categoryId' })
  const values = useWatch({ control: form.control, name: 'values' })
  const keep = useWatch({ control: form.control, name: 'keep' })
  const category = categoryById(categoryId)
  const definitions = definitionsFor(category, 'product')
  const extras = category ? extraKeys(definitions, stored) : []
  // A new product asks its first variant's attribute values too (D449).
  const variantValues = useWatch({ control: form.control, name: 'variantValues' })
  const variantDefinitions = loaded ? [] : definitionsFor(category, 'variant')

  // Only a change of isDirty is reported: callers pass inline callbacks, which must not re-fire it every render.
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange
  })
  useEffect(() => onDirtyChangeRef.current(isDirty), [isDirty])

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

  const errorAt = (name: `values.${string}` | `keep.${string}` | `variantValues.${string}`) => fieldError(form.getFieldState(name, form.formState).error?.message)

  const save = async (v: ProductFormValues) => {
    const defs = definitionsFor(categoryById(v.categoryId), 'product')
    const variantDefs = loaded ? [] : definitionsFor(categoryById(v.categoryId), 'variant')
    const fields = editorFields('product', defs, v.values, stored, loaded ? undefined : { defs: variantDefs, values: v.variantValues })
    const { attributes, errors: productErrors } = toAttributes(defs, v.values, v.keep, stored)
    const firstVariant = toFirstVariantAttributes(variantDefs, v.variantValues)
    const inputErrors = [...productErrors, ...firstVariant.errors]
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
        : await create.mutateAsync({ data: toProductCreate(v, attributes, firstVariant.attributes) })
    } catch (error) {
      setErrorFields(fields)
      setApiFieldErrors(error, form.setError, fields)
      // A taken model number comes without a location (409), but belongs to its field.
      if (error instanceof ApiError && error.code === 'product.model_number_taken') {
        form.setError('modelNumber', { type: 'server', message: errorKey('product.model_number_taken', { modelNumber: data.modelNumber }) })
      }
      if (!loaded && error instanceof ApiError && error.code === 'variant.sku_taken') {
        form.setError('sku', { type: 'server', message: errorKey('variant.sku_taken', { sku: v.sku.trim() }) })
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
        return {
          value: pt.id,
          label,
          content: (
            <TypeBadge color={pt.color} abbreviation={pt.abbreviation}>
              {label}
            </TypeBadge>
          ),
        }
      }),
  ]
  const categoryOptions = [
    ...(loaded ? [] : [{ value: '', label: t('field.chooseCategory') }]),
    ...categories
      .filter((c) => c.isActive || c.id === loaded?.categoryId)
      .map((c) => ({ value: c.id, label: c.isActive ? localized(c.name) : t('field.inactiveType', { name: localized(c.name) }) })),
  ]
  const categoryChanged = loaded !== null && categoryId !== loaded.categoryId
  const mountingOptions = [
    {
      value: '',
      label: category ? t('mounting.asCategoryNamed', { mounting: t(`mounting.${category.mounting}`) }) : t('mounting.asCategory'),
    },
    ...(['floorplan', 'board', 'both'] as const).map((v) => ({ value: v, label: t(`mounting.${v}`) })),
  ]

  return (
    <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="space-y-6">
      <Fieldset disabled={readOnly}>
        <Section title={t('section.basics')}>
          <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormSelectField
              control={form.control}
              name="productTypeId"
              label={t('field.productType')}
              hint={t('field.productTypeHint')}
              required
              options={typeOptions}
              error={fieldError(errors.productTypeId?.message)}
            />
            <FormSelectField
              control={form.control}
              name="categoryId"
              label={t('field.category')}
              hint={t('field.categoryHint')}
              required
              options={categoryOptions}
              error={fieldError(errors.categoryId?.message)}
            />
            <Field
              label={t('field.modelNumber')}
              hint={t('field.modelNumberHint')}
              required
              autoComplete="off"
              error={fieldError(errors.modelNumber?.message)}
              {...form.register('modelNumber')}
            />
          </div>
          {categoryChanged && <Notice tone="warning">{t('categoryChange')}</Notice>}
          {!loaded && (
            <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field
                label={t('field.price')}
                hint={t('field.priceHint')}
                required
                suffix={catalogCurrency}
                inputMode="decimal"
                autoComplete="off"
                error={fieldError(errors.price?.message)}
                {...form.register('price')}
              />
              <Field
                label={t('variant.field.sku')}
                hint={t('field.skuHint')}
                autoComplete="off"
                error={fieldError(errors.sku?.message)}
                {...form.register('sku')}
              />
            </div>
          )}
          <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormSelectField
              control={form.control}
              name="mounting"
              label={t('field.mounting')}
              hint={t('field.mountingHint')}
              options={mountingOptions}
              error={fieldError(errors.mounting?.message)}
            />
          </div>
          <FormTranslatableField control={form.control} name="name" label={t('field.name')} required />
          <FormTranslatableField control={form.control} name="description" label={t('field.description')} multiline />
          <SwitchField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
        </Section>
        <Section title={t('section.attributes')} description={t('section.attributesHint')}>
          {loaded && !categoryChanged && loaded.attributeErrors.length > 0 && <Notice tone="warning">{t('storedErrors')}</Notice>}
          {category ? (
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
            <p className="text-sm text-muted">{t('chooseCategoryFirst')}</p>
          )}
        </Section>
        {variantDefinitions.length > 0 && (
          <Section title={t('section.variant')} description={t('section.variantHint')}>
            <AttributeValuesEditor
              definitions={variantDefinitions}
              values={variantValues}
              onChange={(key, value) => form.setValue(`variantValues.${key}`, value, { shouldDirty: true })}
              errors={Object.fromEntries(variantDefinitions.map((d) => [d.key, errorAt(`variantValues.${d.key}`)]))}
              disabled={readOnly}
            />
          </Section>
        )}
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
