import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams } from 'react-router'

import { ApiError } from '@/api/client'
import type { Category } from '@/api/generated/model'
import {
  getGetCategoryQueryKey,
  getListCategoriesQueryKey,
  useCreateCategory,
  useGetCategory,
  useUpdateCategory,
} from '@/api/generated/categories/categories'
import { useCan } from '@/app/session'
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
  setApiFieldErrors,
  TextareaField,
  useFieldError,
  useUnsavedChanges,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { editorFields, formSchema, type FormValues, toFormValues, toInput } from './form'
import { SchemaEditor } from './SchemaEditor'

export const listPath = '/catalog/categories'

/** catalog/categories/new and catalog/categories/:id */
export function CategoryEditorPage() {
  const { id } = useParams()
  if (id === undefined) return <CategoryEditor item={null} />
  return <ExistingCategory key={id} id={id} />
}

/** Shown after a save that stays in the editor (D84). */
type SaveNotice = 'created' | 'saved'
const noticeFrom = (state: unknown): SaveNotice | null =>
  typeof state === 'object' && state !== null && 'notice' in state && (state.notice === 'created' || state.notice === 'saved') ? state.notice : null

/** A missing category, or an id that is not one (422 at path.id). */
const isNotFound = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || (error.status === 422 && error.fields.some((f) => f.location.startsWith('path.'))))

function BackToList() {
  return <LeaveLink to={listPath} dirty={false} />
}

function ExistingCategory({ id }: { id: string }) {
  const { t } = useTranslation('categories')
  const { t: tCommon } = useTranslation()
  // The editor never starts from cached data: it is fetched on every visit,
  // and the form shows only once that fetch is done (D44). With
  // expectedUpdatedAt (D37) no one overwrites a newer version unknowingly.
  const query = useGetCategory(id, { query: { staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false } })
  const queryClient = useQueryClient()
  // Increased to restart the form from a newer version (Reload, or after a save).
  const [generation, setGeneration] = useState(0)
  const location = useLocation()
  const [notice, setNotice] = useState<SaveNotice | null>(() => noticeFrom(location.state))

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
    setNotice(null)
    setGeneration((g) => g + 1)
  }
  // An update stays in the editor and restarts it from the saved version (D84).
  const saved = (updated: Category) => {
    queryClient.setQueryData(getGetCategoryQueryKey(id), updated)
    setNotice('saved')
    setGeneration((g) => g + 1)
  }
  return (
    <CategoryEditor
      key={`${query.data.id}:${generation}`}
      item={query.data}
      notice={notice}
      onReload={reload}
      onSaved={saved}
      onChanged={() => setNotice(null)}
    />
  )
}

type CategoryEditorProps = {
  item: Category | null
  /** The message about the last save. */
  notice?: SaveNotice | null
  onReload?: () => Promise<void>
  /** After an update: restart from the saved version. */
  onSaved?: (updated: Category) => void
  /** Something was changed after the last save (its notice is over). */
  onChanged?: () => void
}

/** The editor itself; read-only for users who may not change categories. */
function CategoryEditor({ item, notice, onReload, onSaved, onChanged }: CategoryEditorProps) {
  const { t } = useTranslation('categories')
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
  const create = useCreateCategory()
  const update = useUpdateCategory()
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
  const unsaved = useUnsavedChanges(isDirty)
  useEffect(() => {
    if (isDirty) onChanged?.()
  }, [isDirty, onChanged])

  const save = async (values: FormValues) => {
    const data = toInput(values)
    const fields = editorFields(values)
    let result: Category
    try {
      result = loaded
        ? await update.mutateAsync({ id: loaded.id, data: { ...data, expectedUpdatedAt: loaded.updatedAt } })
        : await create.mutateAsync({ data })
    } catch (error) {
      setErrorFields(fields)
      setApiFieldErrors(error, form.setError, fields)
      // A taken key comes without a location (409), but belongs to the Key field.
      if (error instanceof ApiError && error.code === 'category.key_taken') {
        form.setError('key', { type: 'server', message: errorKey('category.key_taken', { key: values.key }) })
      }
      failed()
      return // the rest is shown by ErrorMessage via mutation.error
    }
    await queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey() })
    if (loaded) {
      onSaved?.(result)
      return
    }
    // A new type continues on its edit page (D84).
    unsaved.allow()
    queryClient.setQueryData(getGetCategoryQueryKey(result.id), result)
    void navigate(`${listPath}/${result.id}`, { replace: true, state: { notice: 'created' } })
  }

  const submit = async (e: FormEvent) => {
    let invalid = false
    await form.handleSubmit(save, () => {
      invalid = true
    })(e)
    // After handleSubmit, so the errors are in the form state when rows open.
    if (invalid) failed()
  }

  const stale = mutation.error instanceof ApiError && mutation.error.code === 'category.stale'
  const title = readOnly && loaded ? localized(loaded.name) : loaded ? t('edit') : t('new')

  return (
    <Page title={title} description={readOnly ? t('readOnly') : undefined}>
      {notice && <Notice>{notice === 'created' ? t('created') : tCommon('state.saved')}</Notice>}
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
            <CheckboxField label={t('field.active')} hint={t('field.activeHint')} {...form.register('isActive')} />
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
          <LeaveLink to={listPath} dirty={isDirty && !readOnly} />
          {!readOnly && (
            <Button type="submit" disabled={mutation.isPending}>
              {loaded ? tCommon('action.update') : tCommon('action.create')}
            </Button>
          )}
        </FormActions>
      </form>

      {unsaved.dialog}
    </Page>
  )
}
