import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams } from 'react-router'

import { ApiError } from '@/api/client'
import type { Category, Product, Variant } from '@/api/generated/model'
import {
  getGetProductQueryKey,
  getListProductsQueryKey,
  getSearchVariantsQueryKey,
  useCreateVariant,
  useGetProduct,
  useUpdateVariant,
} from '@/api/generated/products/products'
import { definitionsFor, extraKeys, storedValueErrors } from '@/catalog/attribute-values'
import { AttributeValuesEditor, ExtraValues } from '@/catalog/AttributeValuesEditor'
import { fileUrl, imageTypes, useImageUpload } from '@/catalog/files'
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
  ImageUpload,
  LeaveLink,
  Loading,
  Notice,
  Page,
  Section,
  setApiFieldErrors,
  SwitchField,
  toFieldErrors,
  useErrorMessage,
  useFieldError,
  useUnsavedChanges,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { AddonsEditor } from './AddonsEditor'
import { editorFields, storedValues, toAttributes, toVariantFormValues, toVariantInput, type VariantFormValues, variantSchema } from './form'
import {
  type EditorState,
  fresh,
  isNotFound,
  listPath,
  listSearchFrom,
  productPath,
  useFreshCategories,
  useSaveNotice,
  useFreshProductTypes,
  variantPath,
} from './paths'

/** catalog/products/:id/variants/new and catalog/products/:id/variants/:variantId */
export function VariantEditorPage() {
  const { id = '', variantId } = useParams()
  return <VariantPage key={variantId ?? 'new'} productId={id} variantId={variantId} />
}

function BackTo({ to, label, state }: { to: string; label: string; state?: EditorState }) {
  return <LeaveLink to={to} state={state} dirty={false} backLabel={label} />
}

function VariantPage({ productId, variantId }: { productId: string; variantId?: string }) {
  const { t } = useTranslation('products')
  const { t: tCommon } = useTranslation()
  const localized = useLocalized()
  const queryClient = useQueryClient()
  const location = useLocation()
  // The product list's filters, passed along to return to them (D86).
  const listState: EditorState = { listSearch: listSearchFrom(location.state) }
  // Fetched on every visit; the form edits the version loaded then (D44).
  const query = useGetProduct(productId, { query: fresh })
  const types = useFreshProductTypes()
  const categories = useFreshCategories()
  const [generation, setGeneration] = useState(0)
  const [notice, setNotice] = useSaveNotice()
  const [formDirty, setFormDirty] = useState(false)
  const [addonsDirty, setAddonsDirty] = useState(false)
  const unsaved = useUnsavedChanges(formDirty || addonsDirty)

  const failed = query.error ?? types.error ?? categories.error
  if (failed) {
    if (isNotFound(failed)) {
      return (
        <Page title={t('notFound.title')}>
          <EmptyState title={t('notFound.message')} action={<BackTo to={listPath} label={tCommon('action.backToList')} />} />
        </Page>
      )
    }
    return (
      <Page title={tCommon('state.errorTitle')}>
        <ErrorMessage error={failed} />
        <BackTo to={listPath} label={tCommon('action.backToList')} />
      </Page>
    )
  }
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
  const variant = variantId === undefined ? null : product.variants.find((v) => v.id === variantId)
  if (variant === undefined) {
    return (
      <Page title={t('variant.notFound.title')}>
        <EmptyState
          title={t('variant.notFound.message')}
          action={<BackTo to={productPath(product.id)} state={listState} label={t('variant.backToProduct')} />}
        />
      </Page>
    )
  }

  const readOnly = variant ? !variant.can.update : !product.can.update
  const reload = async () => {
    await Promise.all([query.refetch(), types.refetch(), categories.refetch()])
    setNotice(null)
    setGeneration((g) => g + 1)
  }
  const saved = (updated: Variant) => {
    queryClient.setQueryData(getGetProductQueryKey(product.id), (p: Product | undefined) =>
      p ? { ...p, variants: p.variants.map((v) => (v.id === updated.id ? updated : v)) } : p,
    )
    setNotice('saved')
    setGeneration((g) => g + 1)
  }
  const title = variant ? (readOnly ? localized(variant.name) : t('variant.edit')) : t('variant.new')

  return (
    <Page title={title} description={t('variant.of', { product: `${product.modelNumber} · ${localized(product.name)}` })}>
      {notice && <Notice>{notice === 'created' ? t('variant.created') : tCommon('state.saved')}</Notice>}
      {/* An update saves the variant only: unsaved add-ons stay as edited (D89). */}
      {notice === 'saved' && addonsDirty && <Notice tone="warning">{t('addons.unsaved')}</Notice>}
      {readOnly && variant && <p className="text-sm text-muted">{t('variant.readOnly')}</p>}
      <VariantForm
        key={`${variant?.id ?? 'new'}:${generation}`}
        product={product}
        item={variant}
        category={categories.data.items.find((c) => c.id === product.categoryId)}
        readOnly={readOnly}
        dirty={formDirty || addonsDirty}
        listState={listState}
        onReload={reload}
        onSaved={saved}
        onDirtyChange={(changed) => {
          setFormDirty(changed)
          if (changed) setNotice(null)
        }}
        onLeave={unsaved.allow}
      />
      {variant ? (
        <AddonsEditor
          product={product}
          variant={variant}
          types={types.data.items}
          categories={categories.data.items}
          readOnly={readOnly}
          linkState={listState}
          onDirtyChange={setAddonsDirty}
        />
      ) : (
        <Section title={t('addons.title')} description={t('addons.description')}>
          <p className="text-sm text-muted">{t('addons.afterCreate')}</p>
        </Section>
      )}
      {unsaved.dialog}
    </Page>
  )
}

type VariantFormProps = {
  product: Product
  item: Variant | null
  /** The product's category, whose schema the variant's values follow. */
  category: Category | undefined
  readOnly: boolean
  /** Whether the page (form or add-ons) has unsaved changes: Cancel instead of Back to product. */
  dirty: boolean
  /** Navigation state passed back to the product page (the list's filters). */
  listState: EditorState
  onReload: () => Promise<void>
  onSaved: (variant: Variant) => void
  onDirtyChange: (dirty: boolean) => void
  onLeave: () => void
}

/** A variant's own fields, image and attribute values (add-ons are saved separately). */
function VariantForm({ product, item, category, readOnly, dirty, listState, onReload, onSaved, onDirtyChange, onLeave }: VariantFormProps) {
  const { t } = useTranslation('products')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const errorMessage = useErrorMessage()
  const [loaded] = useState(item)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const create = useCreateVariant()
  const update = useUpdateVariant()
  const mutation = loaded ? update : create
  const image = useImageUpload()

  const definitions = definitionsFor(category, 'variant')
  const stored = storedValues(loaded)
  const extras = extraKeys(definitions, stored)
  const [defaults] = useState(() => toVariantFormValues(loaded, definitions))
  // Stored values that do not fit the current schema are marked from the start (D55).
  const [storedErrors] = useState(() =>
    loaded && loaded.attributeErrors.length > 0
      ? toFieldErrors<VariantFormValues>(
          storedValueErrors(loaded.attributeErrors),
          editorFields('variant', definitions, defaults.values, stored),
        )
      : undefined,
  )
  const form = useForm<VariantFormValues>({
    resolver: zodResolver(variantSchema),
    defaultValues: defaults,
    errors: storedErrors,
    shouldFocusError: false,
  })
  const { errors, isDirty } = form.formState
  const values = useWatch({ control: form.control, name: 'values' })
  const keep = useWatch({ control: form.control, name: 'keep' })
  const imageFileId = useWatch({ control: form.control, name: 'imageFileId' })

  useEffect(() => onDirtyChange(isDirty), [isDirty, onDirtyChange])

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

  const chooseImage = async (file: File) => {
    form.clearErrors('imageFileId')
    const id = await image.upload(file)
    if (id) form.setValue('imageFileId', id, { shouldDirty: true })
  }
  const removeImage = () => {
    image.reset()
    form.clearErrors('imageFileId')
    form.setValue('imageFileId', '', { shouldDirty: true })
  }

  const save = async (v: VariantFormValues) => {
    const fields = editorFields('variant', definitions, v.values, stored)
    const { attributes, errors: inputErrors } = toAttributes(definitions, v.values, v.keep, stored)
    if (inputErrors.length > 0) {
      for (const e of inputErrors) form.setError(e.name, { type: 'input', message: e.message })
      failed()
      return
    }
    const data = toVariantInput(v, attributes)
    let result: Variant
    try {
      result = loaded
        ? await update.mutateAsync({ id: product.id, variantId: loaded.id, data: { ...data, expectedUpdatedAt: loaded.updatedAt } })
        : await create.mutateAsync({ id: product.id, data })
    } catch (error) {
      setErrorFields(fields)
      setApiFieldErrors(error, form.setError, fields)
      // Taken names and SKUs come without a location (409), but belong to their fields.
      if (error instanceof ApiError && error.code === 'variant.name_taken') {
        form.setError('name.en', { type: 'server', message: errorKey('variant.name_taken', { name: data.name.en }) })
      }
      if (error instanceof ApiError && error.code === 'variant.sku_taken') {
        form.setError('sku', { type: 'server', message: errorKey('variant.sku_taken', { sku: data.sku ?? '' }) })
      }
      failed()
      return
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getSearchVariantsQueryKey() }),
    ])
    if (loaded) {
      onSaved(result)
      return
    }
    // A new variant continues on its page, where its add-ons are added (D84).
    onLeave()
    await queryClient.invalidateQueries({ queryKey: getGetProductQueryKey(product.id) })
    const state: EditorState = { ...listState, notice: 'created' }
    void navigate(variantPath(product.id, result.id), { replace: true, state })
  }

  const submit = async (e: FormEvent) => {
    let invalid = false
    await form.handleSubmit(save, () => {
      invalid = true
    })(e)
    if (invalid) failed()
  }

  const stale = mutation.error instanceof ApiError && mutation.error.code === 'variant.stale'
  const imageError = image.error ? errorMessage(image.error) : fieldError(errors.imageFileId?.message)

  return (
    <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="space-y-6">
      {loaded && loaded.isActive && !loaded.available && <Notice tone="warning">{t('variant.productInactive')}</Notice>}
      <Fieldset disabled={readOnly}>
        <Section title={t('variant.section.basics')}>
          <FormTranslatableField
            control={form.control}
            name="name"
            label={t('variant.field.name')}
            hint={t('variant.field.nameHint')}
            required
          />
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Field
              label={t('variant.field.sku')}
              hint={t('variant.field.skuHint')}
              autoComplete="off"
              error={fieldError(errors.sku?.message)}
              {...form.register('sku')}
            />
            <Field
              label={t('variant.field.price')}
              hint={t('variant.field.priceHint')}
              required
              suffix={catalogCurrency}
              inputMode="decimal"
              autoComplete="off"
              error={fieldError(errors.price?.message)}
              {...form.register('price')}
            />
          </div>
          <ImageUpload
            label={t('variant.field.image')}
            hint={t('variant.field.imageHint')}
            src={fileUrl(imageFileId || undefined)}
            accept={imageTypes.join(',')}
            pending={image.pending}
            progress={image.progress}
            error={imageError}
            disabled={readOnly}
            onSelect={(file) => void chooseImage(file)}
            onRemove={removeImage}
          />
          <SwitchField label={t('variant.field.active')} hint={t('variant.field.activeHint')} {...form.register('isActive')} />
        </Section>
        <Section title={t('variant.section.attributes')} description={t('variant.section.attributesHint')}>
          {loaded && loaded.attributeErrors.length > 0 && <Notice tone="warning">{t('storedErrors')}</Notice>}
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
        </Section>
      </Fieldset>
      <FormActions
        error={
          <ErrorMessage
            error={mutation.error}
            fields={errorFields}
            action={
              stale && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    // The form restarts: an upload still running is dropped.
                    image.cancel()
                    void onReload()
                  }}
                >
                  <RotateCw /> {tCommon('action.reload')}
                </Button>
              )
            }
          />
        }
      >
        <LeaveLink to={productPath(product.id)} state={listState} dirty={dirty && !readOnly} backLabel={t('variant.backToProduct')} />
        {!readOnly && (
          <Button type="submit" disabled={mutation.isPending || image.pending}>
            {loaded ? tCommon('action.update') : tCommon('action.create')}
          </Button>
        )}
      </FormActions>
    </form>
  )
}
