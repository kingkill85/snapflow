import { keepPreviousData, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Image as ImageIcon, Plus, RotateCw, Save, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router'

import { ApiError } from '@/api/client'
import { useListCategories } from '@/api/generated/categories/categories'
import {
  getGetImportQueryKey,
  getListImportProfilesQueryKey,
  useCreateImportProfile,
  useDeleteImportProfile,
  useGetImportProfile,
  useGetImportSource,
  useListImportProfiles,
  useListImportTargets,
  usePreviewImport,
  useUpdateImportProfile,
} from '@/api/generated/imports/imports'
import type { ImportMapping, ImportProfile, ImportRun, ImportSourceColumn, ImportTarget } from '@/api/generated/model'
import { useListProductTypes } from '@/api/generated/product-types/product-types'
import {
  Badge,
  Button,
  type Column,
  ConfirmDialog,
  DataTable,
  ErrorMessage,
  Field,
  focusFirstError,
  FormActions,
  FormDialog,
  GroupedSelect,
  Input,
  Loading,
  Notice,
  RowAction,
  Section,
  type SelectGroup,
  SelectField,
  type SelectOption,
  setApiFieldErrors,
  SwitchField,
  TypeBadge,
  useFieldError,
} from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { attributeLabels, useTargetLabel } from './labels'
import {
  type Built,
  customAttribute,
  emptyForm,
  formFromMapping,
  fromColumn,
  fromConstant,
  mappingError,
  type MappingForm,
  mappingFromForm,
  sameMapping,
} from './mapping'
import { invalidateRunDetails, listPath } from './paths'

/** Rows of the source preview. */
const previewRows = 5

type Props = {
  run: ImportRun
  /** A profile chosen with the upload: loaded and previewed at once. */
  autoProfileId?: string
  /** The preview succeeded. */
  onPreviewed: () => void
  /** Back to the preview without previewing again (editing an existing preview). */
  onCancel?: () => void
}

/** A mapping being loaded into the form once the file's columns for its sheet and header row are known. */
type PendingLoad = { mapping: ImportMapping; preview?: boolean }

/** Step 2: which column (or constant) feeds which target, with the file's first rows to look at. */
export function MappingStep({ run, autoProfileId, onPreviewed, onCancel }: Props) {
  const { t } = useTranslation('imports')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const localized = useLocalized()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const formRef = useRef<HTMLFormElement>(null)

  const form = useForm<MappingForm>({ defaultValues: emptyForm() })
  const { errors } = form.formState
  const values = form.watch()

  const profiles = useListImportProfiles()
  const types = useListProductTypes({ includeInactive: true })
  const categories = useListCategories({ includeInactive: true })
  const fixedCategory = values.category !== '' && values.category !== fromColumn && values.category !== fromConstant ? values.category : undefined
  const targets = useListImportTargets(fixedCategory ? { categoryId: [fixedCategory] } : undefined, { query: { placeholderData: keepPreviousData } })
  const attributes = useMemo(() => attributeLabels(targets.data), [targets.data])
  const targetLabel = useTargetLabel(attributes)

  // The source preview follows the sheet and header row in the form.
  const headerRow = Number.isInteger(values.headerRow) && values.headerRow >= 0 ? values.headerRow : undefined
  const source = useGetImportSource(
    run.id,
    { ...(values.sheet ? { sheet: values.sheet } : {}), headerRow: headerRow ?? 1, rows: previewRows },
    { query: { enabled: headerRow !== undefined, placeholderData: keepPreviousData, staleTime: Infinity } },
  )
  const columns = source.data?.columns ?? []

  // The profile the form started from (for Update), and a mapping waiting for its columns.
  const [profile, setProfile] = useState<ImportProfile | null>(null)
  const [loading, setLoading] = useState<PendingLoad | null>(() => (autoProfileId ? null : { mapping: run.mapping ?? { ...emptyMapping(run), headerRow: 1, dataStartRow: 2 } }))
  const [preparing, setPreparing] = useState(true)

  const load = (mapping: ImportMapping, preview = false) => {
    form.setValue('sheet', mapping.sheet ?? '')
    form.setValue('headerRow', mapping.headerRow)
    setLoading({ mapping, preview })
  }

  // The run's profile, if it still exists, is the one the form starts from.
  const runProfile = profiles.data?.find((p) => p.id === run.profileId)
  useEffect(() => {
    if (runProfile && profile === null && !autoProfileId) setProfile(runProfile)
  }, [runProfile, profile, autoProfileId])

  // A profile chosen with the upload: load it, then preview with it.
  const auto = useGetImportProfile(autoProfileId ?? '', { query: { enabled: autoProfileId !== undefined, staleTime: 0 } })
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!auto.data || autoStarted.current) return
    autoStarted.current = true
    setProfile(auto.data)
    load(auto.data.mapping, true)
    // Done once: a reload of the page shows the result, not another preview.
    void navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto.data])
  useEffect(() => {
    if (auto.isError) {
      setLoading({ mapping: run.mapping ?? emptyMapping(run) })
    }
  }, [auto.isError, run])

  // Once the source shows the sheet and header row of the mapping being loaded, it becomes the form.
  useEffect(() => {
    if (!loading) return
    const m = loading.mapping
    if (source.isError && !source.isFetching) {
      form.reset({ ...formFromMapping(m, []) })
      setLoading(null)
      setPreparing(false)
      return
    }
    const data = source.data
    if (!data || source.isPlaceholderData || source.isFetching) return
    if (data.headerRow !== m.headerRow || (m.sheet && data.sheet !== m.sheet)) return
    form.reset(formFromMapping(m, data.columns))
    setLoading(null)
    setPreparing(false)
    if (loading.preview) void submitPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, source.data, source.isPlaceholderData, source.isFetching, source.isError])

  // The data start follows the header row while it is right below it.
  const lastHeader = useRef(values.headerRow)
  useEffect(() => {
    // While the field is being retyped (empty), the last header row counts.
    if (!Number.isInteger(values.headerRow)) return
    const previous = lastHeader.current
    lastHeader.current = values.headerRow
    if (previous !== values.headerRow && form.getValues('dataStartRow') === previous + 1) {
      form.setValue('dataStartRow', values.headerRow + 1)
    }
  }, [values.headerRow, form])

  const build = (): Built => mappingFromForm(form.getValues(), columns, run.sourceKind)

  /** Shows a mapping error at the form's fields; returns the error with locations the ErrorMessage understands. */
  const showErrors = (e: unknown, built: Built) => {
    const moved = mappingError(e)
    form.clearErrors()
    setApiFieldErrors(moved, form.setError, built.fields)
    requestAnimationFrame(() => focusFirstError(formRef.current))
    return moved
  }

  // ---------------------------------------------------------------- preview

  const preview = usePreviewImport()
  const [previewError, setPreviewError] = useState<{ error: unknown; fields: Built['fields'] } | null>(null)
  const submitPreview = async () => {
    const built = build()
    setPreviewError(null)
    form.clearErrors()
    const data = profile && sameMapping(profile.mapping, built.mapping) ? { profileId: profile.id } : { mapping: built.mapping }
    try {
      const result = await preview.mutateAsync({ id: run.id, data })
      queryClient.setQueryData(getGetImportQueryKey(run.id), result)
      await invalidateRunDetails(queryClient, run.id)
      onPreviewed()
    } catch (e) {
      setPreviewError({ error: showErrors(e, built), fields: built.fields })
    }
  }

  // ---------------------------------------------------------------- profiles

  const createProfile = useCreateImportProfile()
  const updateProfile = useUpdateImportProfile()
  const deleteProfile = useDeleteImportProfile()
  const [saveOpen, setSaveOpen] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [saveError, setSaveError] = useState<{ error: unknown; fields: Built['fields'] } | null>(null)
  const [updateError, setUpdateError] = useState<{ error: unknown; fields: Built['fields'] } | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [notice, setNotice] = useState<'saved' | 'created' | null>(null)

  const refreshProfiles = () => queryClient.invalidateQueries({ queryKey: getListImportProfilesQueryKey() })

  const openSave = () => {
    setSaveError(null)
    setProfileName(profile ? t('mapping.copyName', { name: profile.name }) : run.fileName.replace(/\.[^.]+$/, ''))
    setSaveOpen(true)
  }
  const saveNew = async () => {
    const built = build()
    setSaveError(null)
    try {
      const created = await createProfile.mutateAsync({ data: { name: profileName.trim(), mapping: built.mapping } })
      setProfile(created)
      setSaveOpen(false)
      setNotice('created')
      await refreshProfiles()
    } catch (e) {
      setSaveError({ error: showErrors(e, built), fields: { ...built.fields, name: 'profileName' } })
    }
  }
  const saveExisting = async () => {
    if (!profile) return
    const built = build()
    setUpdateError(null)
    setNotice(null)
    try {
      const saved = await updateProfile.mutateAsync({
        id: profile.id,
        data: { name: profile.name, mapping: built.mapping, expectedUpdatedAt: profile.updatedAt },
      })
      setProfile(saved)
      setNotice('saved')
      await refreshProfiles()
    } catch (e) {
      setUpdateError({ error: showErrors(e, built), fields: built.fields })
    }
  }
  /** After import_profile.stale: the profile as it is now, replacing the form. */
  const reloadProfile = async () => {
    if (!profile) return
    setUpdateError(null)
    await refreshProfiles()
    const fresh = (await queryClient.fetchQuery({ queryKey: getListImportProfilesQueryKey(), staleTime: 0 })) as ImportProfile[] | undefined
    const current = fresh?.find((p) => p.id === profile.id)
    if (current) {
      setProfile(current)
      load(current.mapping)
    } else {
      setProfile(null)
    }
  }
  const confirmDelete = async () => {
    if (!profile) return
    try {
      await deleteProfile.mutateAsync({ id: profile.id })
    } catch {
      return
    }
    setProfile(null)
    setDeleteOpen(false)
    await refreshProfiles()
  }
  const chooseProfile = (id: string) => {
    setNotice(null)
    setUpdateError(null)
    setPreviewError(null)
    const chosen = profiles.data?.find((p) => p.id === id)
    if (!chosen) {
      setProfile(null)
      return
    }
    setProfile(chosen)
    load(chosen.mapping)
  }

  // ---------------------------------------------------------------- options

  const usedTargets = Object.entries(values.targets).filter(([, v]) => v !== '' && v !== customAttribute)
  const usedElsewhere = (letter: string, target: string) => usedTargets.some(([l, v]) => l !== letter && v === target)
  const known = new Set((targets.data ?? []).map((x) => x.target))

  /** Grouped targets; `filter` narrows them, `letter` disables single targets another column has. */
  const targetGroups = (filter: (x: ImportTarget) => boolean, letter?: string, current?: string): SelectGroup[] => {
    const list = (targets.data ?? []).filter(filter)
    const option = (x: ImportTarget): SelectOption => ({
      value: x.target,
      label: x.required ? t('mapping.requiredTarget', { name: targetLabel(x.target) }) : targetLabel(x.target),
      disabled: letter !== undefined && !x.repeatable && usedElsewhere(letter, x.target),
    })
    const groups: SelectGroup[] = (['product', 'variant', 'addon', 'attribute'] as const).map((g) => ({
      label: t(`targetGroup.${g}`),
      options: list.filter((x) => x.group === g).map(option),
    }))
    // A target the list does not know (an attribute no category has yet) stays choosable while chosen.
    if (current && current !== customAttribute && !known.has(current)) groups[3].options.unshift({ value: current, label: targetLabel(current) })
    return groups
  }

  /** A column's targets, with an attribute key to type in. */
  const columnGroups = (letter: string, value: string) => {
    const groups = targetGroups(() => true, letter, value)
    groups[3] = { ...groups[3], options: [...groups[3].options, { value: customAttribute, label: t('mapping.customAttribute') }] }
    return groups
  }
  const constantTarget = (x: ImportTarget) => x.constant && x.target !== 'product.productType' && x.target !== 'product.category'

  const typeOptions: SelectOption[] = [
    { value: '', label: t('mapping.choose') },
    ...(types.data?.items ?? []).map((pt) => ({
      value: pt.id,
      label: localized(pt.name),
      content: (
        <TypeBadge color={pt.color} abbreviation={pt.abbreviation}>
          {localized(pt.name)}
        </TypeBadge>
      ),
    })),
    { value: fromColumn, label: t('mapping.fromColumn') },
    { value: fromConstant, label: t('mapping.fromText') },
  ]
  const categoryOptions: SelectOption[] = [
    { value: '', label: t('mapping.choose') },
    ...(categories.data?.items ?? []).map((c) => ({ value: c.id, label: localized(c.name) })),
    { value: fromColumn, label: t('mapping.fromColumn') },
    { value: fromConstant, label: t('mapping.fromText') },
  ]

  /** Choosing a fixed product type or category frees the column that fed it, and the other way round. */
  const chooseMode = (name: 'productType' | 'category', value: string) => {
    form.setValue(name, value, { shouldDirty: true })
    form.clearErrors(name)
    const target = name === 'productType' ? 'product.productType' : 'product.category'
    if (value !== fromColumn) {
      for (const [letter, v] of Object.entries(form.getValues('targets'))) if (v === target) form.setValue(`targets.${letter}`, '')
    }
  }
  const chooseTarget = (letter: string, target: string) => {
    form.setValue(`targets.${letter}`, target, { shouldDirty: true })
    form.clearErrors(`targets.${letter}`)
    if (target === 'product.productType') form.setValue('productType', fromColumn)
    if (target === 'product.category') form.setValue('category', fromColumn)
  }

  // ---------------------------------------------------------------- render

  if (preparing && (loading !== null || auto.isPending)) {
    return (
      <>
        <Loading />
        {source.isError && <ErrorMessage error={source.error} />}
      </>
    )
  }

  const sample = (index: number) =>
    (source.data?.rows ?? [])
      .map((r) => r.cells[index] ?? '')
      .filter((c) => c.trim() !== '')
      .slice(0, 2)

  /** The file's columns: header, examples from the first rows, and what each is imported as (a card per column on phones). */
  const mappingColumns: Column<ImportSourceColumn>[] = [
    {
      header: t('mapping.column'),
      mobile: 'title',
      cell: (c) => (
        <span className="flex items-baseline gap-2">
          <Badge>{c.letter}</Badge>
          <span className="font-medium break-words">{c.header || <span className="font-normal text-muted">{t('mapping.noHeader')}</span>}</span>
        </span>
      ),
      className: 'md:min-w-40 md:max-w-56',
    },
    {
      header: t('mapping.example'),
      cell: (c) => {
        const examples = sample(columns.indexOf(c))
        return <span className="line-clamp-2 break-words text-muted">{examples.length > 0 ? examples.join(' · ') : '–'}</span>
      },
      className: 'md:min-w-40',
    },
    {
      header: t('mapping.target'),
      mobile: 'block',
      cell: (c) => {
        const value = values.targets[c.letter] ?? ''
        const error = fieldError(errors.targets?.[c.letter]?.message)
        const errorId = `target-${c.letter}-error`
        return (
          <div className="space-y-1.5">
            <GroupedSelect
              aria-label={t('mapping.targetOf', { column: c.header || c.letter })}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              value={value}
              onValueChange={(v) => chooseTarget(c.letter, v)}
              options={[{ value: '', label: t('mapping.notImported') }]}
              groups={columnGroups(c.letter, value)}
            />
            {value === customAttribute && (
              <Input
                aria-label={t('mapping.customKey', { column: c.header || c.letter })}
                placeholder={t('mapping.customKeyHint')}
                {...form.register(`customKeys.${c.letter}`)}
              />
            )}
            {error && (
              <p id={errorId} className="text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        )
      },
      className: 'md:w-80 md:min-w-64',
    },
  ]

  const sourceColumns: Column<{ number: number; cells: string[]; images: number }>[] = [
    {
      header: t('mapping.row'),
      mobile: 'title',
      cell: (r) => (
        <>
          {/* A phone's card is titled "Row 3"; the table has the column header. */}
          <span className="md:hidden">{t('issues.atRow', { row: r.number })}</span>
          <span className="text-muted tabular-nums max-md:hidden">{r.number}</span>
        </>
      ),
      className: 'md:w-px',
    },
    {
      header: t('mapping.pictures'),
      cell: (r) =>
        r.images > 0 ? (
          <Badge variant="primary" title={t('mapping.picturesInRow', { count: r.images })}>
            <ImageIcon /> {r.images}
          </Badge>
        ) : (
          // An empty line would look like a missing value in a phone's card.
          <span className="text-muted md:hidden">0</span>
        ),
      className: 'w-px',
    },
    ...columns.map((c, i) => ({
      header: c.header ? `${c.letter} · ${c.header}` : c.letter,
      cell: (r: { cells: string[] }) => <span className="line-clamp-3 max-w-64 break-words">{r.cells[i]}</span>,
      className: 'md:min-w-28',
    })),
  ]

  const profileOptions = [{ value: '', label: t('mapping.noProfile') }, ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))]
  const sheetOptions = (source.data?.sheets ?? []).filter((s) => s !== '').map((s) => ({ value: s, label: s }))
  const nameField = saveError?.error instanceof ApiError ? saveError.error.fields.find((f) => f.location === 'body.name') : undefined
  const nameError = nameField
    ? fieldError(nameField.params && Object.keys(nameField.params).length > 0 ? `${nameField.code} ${JSON.stringify(nameField.params)}` : nameField.code)
    : undefined
  const imageColumn = Object.values(values.targets).includes('variant.image')
  const busy = preview.isPending || loading !== null

  return (
    <form
      ref={formRef}
      noValidate
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        // The profile dialog's form is rendered in a portal, but its submit bubbles here through React.
        if (e.target !== e.currentTarget) return
        void submitPreview()
      }}
    >
      {run.state === 'failed' && run.error && <FailedNotice run={run} />}

      <Section title={t('mapping.profileTitle')} description={t('mapping.profileDescription')}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full max-w-sm">
            <SelectField label={t('mapping.profile')} value={profile?.id ?? ''} onValueChange={chooseProfile} options={profileOptions} disabled={busy} />
          </div>
          {profile && (
            <Button variant="secondary" onClick={() => void saveExisting()} disabled={updateProfile.isPending || busy}>
              <Save /> {t('mapping.updateProfile')}
            </Button>
          )}
          <Button variant="secondary" onClick={openSave} disabled={busy}>
            <Plus /> {t('mapping.saveProfile')}
          </Button>
          {profile && (
            <Button
              variant="danger-quiet"
              onClick={() => {
                deleteProfile.reset()
                setDeleteOpen(true)
              }}
              disabled={busy}
            >
              <Trash2 /> {t('mapping.deleteProfile')}
            </Button>
          )}
        </div>
        {notice && <Notice>{notice === 'created' ? t('mapping.profileCreated', { name: profile?.name ?? '' }) : t('mapping.profileSaved')}</Notice>}
        {updateError && (
          <ErrorMessage
            error={updateError.error}
            fields={updateError.fields}
            action={
              updateError.error instanceof ApiError && updateError.error.code === 'import_profile.stale' ? (
                <Button size="sm" variant="secondary" onClick={() => void reloadProfile()}>
                  <RotateCw /> {t('mapping.reloadProfile')}
                </Button>
              ) : undefined
            }
          />
        )}
      </Section>

      <Section title={t('mapping.sourceTitle')} description={t('mapping.sourceDescription')}>
        <div className="grid gap-4 sm:grid-cols-3">
          {sheetOptions.length > 0 && (
            <SelectField
              label={t('mapping.sheet')}
              required
              value={values.sheet || source.data?.sheet || ''}
              onValueChange={(v) => form.setValue('sheet', v, { shouldDirty: true })}
              options={sheetOptions}
              error={fieldError(errors.sheet?.message)}
            />
          )}
          <Field
            label={t('mapping.headerRow')}
            required
            hint={t('mapping.headerRowHint')}
            type="number"
            min={0}
            inputMode="numeric"
            error={fieldError(errors.headerRow?.message)}
            {...form.register('headerRow', { valueAsNumber: true })}
          />
          <Field
            label={t('mapping.dataStartRow')}
            required
            type="number"
            min={1}
            inputMode="numeric"
            error={fieldError(errors.dataStartRow?.message)}
            {...form.register('dataStartRow', { valueAsNumber: true })}
          />
        </div>
        {source.isError ? (
          <ErrorMessage error={source.error} />
        ) : source.data ? (
          <>
            <p className="text-sm text-muted">
              {t('mapping.sourceSummary', { rows: source.data.dataRows, columns: columns.length, pictures: source.data.images })}
            </p>
            <DataTable
              rows={source.data.rows}
              rowKey={(r) => String(r.number)}
              columns={sourceColumns}
              empty={<p className="text-sm text-muted">{t('mapping.noRows')}</p>}
            />
          </>
        ) : (
          <Loading />
        )}
      </Section>

      <Section title={t('mapping.kindTitle')} description={t('mapping.kindDescription')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-3">
            <SelectField
              label={t('mapping.productType')}
              required
              hint={t('mapping.productTypeHint')}
              value={values.productType}
              onValueChange={(v) => chooseMode('productType', v)}
              options={typeOptions}
              error={fieldError(errors.productType?.message)}
            />
            {values.productType === fromConstant && (
              <Field
                label={t('mapping.productTypeValue')}
                required
                hint={t('mapping.productTypeValueHint')}
                error={fieldError(errors.productTypeValue?.message)}
                {...form.register('productTypeValue')}
              />
            )}
          </div>
          <div className="space-y-3">
            <SelectField
              label={t('mapping.category')}
              required
              hint={t('mapping.categoryHint')}
              value={values.category}
              onValueChange={(v) => chooseMode('category', v)}
              options={categoryOptions}
              error={fieldError(errors.category?.message)}
            />
            {values.category === fromConstant && (
              <Field
                label={t('mapping.categoryValue')}
                required
                hint={t('mapping.categoryValueHint')}
                error={fieldError(errors.categoryValue?.message)}
                {...form.register('categoryValue')}
              />
            )}
          </div>
        </div>
        <SwitchField
          label={t('mapping.createMissingCategories')}
          hint={t('mapping.createMissingCategoriesHint')}
          {...form.register('createMissingCategories')}
        />
      </Section>

      <Section title={t('mapping.columnsTitle')} description={t('mapping.columnsDescription')}>
        {errors.fieldsRoot?.message && (
          <p role="alert" data-field-error tabIndex={-1} className="text-sm text-danger">
            {fieldError(errors.fieldsRoot.message)}
          </p>
        )}
        {targets.isError && <ErrorMessage error={targets.error} />}
        <DataTable
          label={t('mapping.columnsTitle')}
          rows={columns}
          rowKey={(c) => c.letter}
          columns={mappingColumns}
          empty={<p className="text-sm text-muted">{t('mapping.noColumns')}</p>}
        />
        {imageColumn ? (
          // A disabled switch hides its hint, which is all there is to say while a column feeds the picture.
          <p className="border-t border-line pt-4 text-sm text-muted">{t('mapping.imageColumnChosen')}</p>
        ) : (
          <SwitchField
            label={t('mapping.imageAnyColumn')}
            hint={t('mapping.imageAnyColumnHint')}
            checked={values.imageAnyColumn}
            error={fieldError(errors.imageAnyColumn?.message)}
            onChange={(e) => form.setValue('imageAnyColumn', e.target.checked, { shouldDirty: true })}
          />
        )}
      </Section>

      <Section
        title={t('mapping.constantsTitle')}
        description={t('mapping.constantsDescription')}
        actions={
          <Button size="sm" variant="secondary" onClick={() => form.setValue('constants', [...values.constants, { target: '', value: '' }], { shouldDirty: true })}>
            <Plus /> {t('mapping.addConstant')}
          </Button>
        }
      >
        {values.constants.length === 0 ? (
          <p className="text-sm text-muted">{t('mapping.noConstants')}</p>
        ) : (
          <ul className="space-y-3">
            {values.constants.map((row, i) => {
              const error = fieldError(errors.constants?.[i]?.value?.message ?? errors.constants?.[i]?.target?.message)
              return (
                <li key={i} className="space-y-1">
                  <div className="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <GroupedSelect
                      aria-label={t('mapping.constantTarget', { n: i + 1 })}
                      aria-invalid={error ? true : undefined}
                      placeholder={t('mapping.chooseTarget')}
                      value={row.target}
                      onValueChange={(v) => form.setValue(`constants.${i}.target`, v, { shouldDirty: true })}
                      groups={targetGroups(constantTarget, undefined, row.target)}
                    />
                    <Input
                      aria-label={t('mapping.constantValue', { n: i + 1 })}
                      aria-invalid={error ? true : undefined}
                      placeholder={t('mapping.constantValueHint')}
                      {...form.register(`constants.${i}.value`)}
                    />
                    <RowAction
                      variant="danger-quiet"
                      icon={<Trash2 />}
                      label={tCommon('action.remove')}
                      onClick={() =>
                        form.setValue(
                          'constants',
                          values.constants.filter((_, j) => j !== i),
                          { shouldDirty: true },
                        )
                      }
                    />
                  </div>
                  {error && <p className="text-xs text-danger">{error}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      {values.extras.length > 0 && (
        <Section title={t('mapping.extrasTitle')} description={t('mapping.extrasDescription')}>
          <ul className="space-y-2">
            {values.extras.map((row, i) => {
              const error = fieldError(errors.extras?.[i]?.target?.message)
              return (
                <li key={i} className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{targetLabel(row.target)}</span>
                    <span className="text-muted">←</span>
                    <span>{[row.column, row.columnLetter && t('mapping.letter', { letter: row.columnLetter })].filter(Boolean).join(' ')}</span>
                    <RowAction
                      variant="danger-quiet"
                      icon={<Trash2 />}
                      label={tCommon('action.remove')}
                      onClick={() =>
                        form.setValue(
                          'extras',
                          values.extras.filter((_, j) => j !== i),
                          { shouldDirty: true },
                        )
                      }
                    />
                  </div>
                  {error && (
                    <p data-field-error tabIndex={-1} className="text-xs text-danger">
                      {error}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      <Section title={t('mapping.optionsTitle')}>
        <SwitchField className="border-t-0 pt-0" label={t('allOrNothing')} hint={t('allOrNothingHint')} {...form.register('allOrNothing')} />
      </Section>

      <FormActions error={previewError && <ErrorMessage error={previewError.error} fields={previewError.fields} />}>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            {tCommon('action.cancel')}
          </Button>
        ) : (
          <Button asChild variant="secondary">
            <Link to={listPath}>{t('backToList')}</Link>
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {preview.isPending ? t('mapping.previewing') : t('mapping.preview')} <ArrowRight />
        </Button>
      </FormActions>

      <FormDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title={t('mapping.saveProfileTitle')}
        submitLabel={tCommon('action.create')}
        submitting={createProfile.isPending}
        onSubmit={() => void saveNew()}
        error={saveError && <ErrorMessage error={saveError.error} fields={saveError.fields} />}
      >
        <Field
          label={t('mapping.profileName')}
          required
          value={profileName}
          maxLength={100}
          onChange={(e) => setProfileName(e.target.value)}
          error={nameError}
        />
      </FormDialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('mapping.deleteProfileTitle')}
        message={t('mapping.deleteProfileMessage', { name: profile?.name ?? '' })}
        confirmLabel={tCommon('action.delete')}
        pending={deleteProfile.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={deleteProfile.error} />}
      />
    </form>
  )
}

/** A mapping for a run without one: the first sheet, header in row 1, data from row 2. */
function emptyMapping(run: ImportRun): ImportMapping {
  return { sourceKind: run.sourceKind, headerRow: 1, dataStartRow: 2, allOrNothing: true, fields: [] }
}

/** The apply of a run failed and was rolled back: why, and at which rows. */
export function FailedNotice({ run }: { run: ImportRun }) {
  const { t } = useTranslation('imports')
  const { t: tErrors, i18n } = useTranslation('errors')
  if (!run.error) return null
  const { code, params, rows } = run.error
  const text = i18n.exists(code, { ns: 'errors' }) ? String(tErrors(code as 'validation.invalid', (params ?? {}) as never)) : tErrors('validation.invalid')
  return (
    <div role="alert" className="space-y-1 rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      <p className="font-medium">{t('failed.title')}</p>
      <p>
        {text}
        {rows && rows.length > 0 && ` ${t('failed.rows', { rows: rows.join(', ') })}`}
      </p>
      <p className="text-ink">{t('failed.hint')}</p>
    </div>
  )
}
