import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import type { Project, ProjectVersion } from '@/api/generated/model'
import {
  getGetProjectQueryKey,
  getListProjectsQueryKey,
  useCreateProjectVersion,
  useUpdateProjectVersion,
} from '@/api/generated/projects/projects'
import { apiFields, errorKey, ErrorMessage, Field, FormDialog, FormSelectField, setApiFieldErrors, TextareaField, useFieldError } from '@/components/ui'

/** The "Start from" choice of an empty version. */
const emptySource = 'empty'

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, errorKey('validation.required'))
    .max(100, errorKey('validation.too_long', { max: 100 })),
  source: z.string(),
  notes: z.string().trim().max(2000, errorKey('validation.too_long', { max: 2000 })),
})
type FormValues = z.infer<typeof schema>

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: Project
  /** null = a new version, object = rename it (and its notes). */
  item: ProjectVersion | null
  /** The version a new one copies by default: the one on screen. */
  currentVersionId: string
  /** After a successful save, with the saved version. */
  onSaved?: (version: ProjectVersion) => void
}

/**
 * A new version (a copy of a chosen version, the default, or empty; D166),
 * or renaming one. The name of a new one is pre-filled with the next free V<n>.
 */
export function VersionFormDialog({ open, onOpenChange, project, item, currentVersionId, onSaved }: Props) {
  const { t } = useTranslation('projects')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const queryClient = useQueryClient()
  const create = useCreateProjectVersion()
  const update = useUpdateProjectVersion()
  const mutation = item ? update : create
  const fields = apiFields<FormValues>(['name', item ? 'notes' : 'source'], { sourceVersionId: 'source' })

  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update

  useEffect(() => {
    if (!open) return
    reset({ name: item?.name ?? project.nextVersionName, source: currentVersionId, notes: item?.notes ?? '' })
    resetCreate()
    resetUpdate()
    // Only when the dialog opens or switches version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item, reset, resetCreate, resetUpdate])

  const source = useWatch({ control: form.control, name: 'source' })
  const sourceName = project.versions.find((v) => v.id === source)?.name

  const submit = form.handleSubmit(async ({ name, source, notes }) => {
    let saved: ProjectVersion
    try {
      saved = item
        ? await update.mutateAsync({ id: project.id, versionId: item.id, data: { name, notes, expectedUpdatedAt: item.updatedAt } })
        : await create.mutateAsync({ id: project.id, data: { name, ...(source !== emptySource ? { sourceVersionId: source } : {}) } })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      return // shown by ErrorMessage via mutation.error
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(project.id) }),
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() }),
    ])
    onOpenChange(false)
    onSaved?.(saved)
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('version.renameTitle') : t('version.newTitle')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={mutation.error} fields={fields} />}
    >
      {!item && (
        <FormSelectField
          control={form.control}
          name="source"
          label={t('version.start')}
          hint={sourceName ? t('version.copyHint', { name: sourceName }) : t('version.emptyHint')}
          options={[
            ...project.versions.map((v) => ({ value: v.id, label: t('version.copyOf', { name: v.name }) })),
            { value: emptySource, label: t('version.emptyOption') },
          ]}
          error={fieldError(errors.source?.message)}
        />
      )}
      <Field label={t('version.name')} autoComplete="off" required error={fieldError(errors.name?.message)} {...form.register('name')} />
      {item && <TextareaField label={t('version.notes')} error={fieldError(errors.notes?.message)} {...form.register('notes')} />}
    </FormDialog>
  )
}
