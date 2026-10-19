import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { type ClipboardEvent, useEffect, useMemo, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import type { Plan } from '@/api/generated/model'
import { apiFields, errorKey, ErrorMessage, Field, FormDialog, ImageUpload, setApiFieldErrors, useFieldError } from '@/components/ui'

import { checkPlanImage, createPlanWithImage, maxPlanImageMb, planImageTypes, updatePlanWithImage } from './api'

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, errorKey('validation.required'))
    .max(100, errorKey('validation.too_long', { max: 100 })),
  image: z.custom<File>((v) => v instanceof File).optional(),
})
type FormValues = z.infer<typeof schema>

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  versionId: string
  /** null = a new plan; a plan = rename it and/or replace its image. */
  item: Plan | null
  onSaved: (plan: Plan) => void
}

/** The URL of a chosen file for the preview, revoked when it changes. */
function useObjectUrl(file: File | undefined) {
  const url = useMemo(() => (file && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined), [file])
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url)
  }, [url])
  return url
}

/** Add a plan (name + image; drop, pick or paste) or rename one and replace its image. */
export function PlanFormDialog({ open, onOpenChange, versionId, item, onSaved }: Props) {
  const { t } = useTranslation('plans')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const fields = apiFields<FormValues>(['name', 'image'])
  const [progress, setProgress] = useState<number>()
  const mutation = useMutation({
    mutationFn: ({ name, image }: { name: string; image?: File }) =>
      item ? updatePlanWithImage(item, name, image, setProgress) : createPlanWithImage(versionId, name, image as File, setProgress),
  })
  const pending = mutation.isPending

  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetMutation } = mutation
  useEffect(() => {
    if (!open) return
    reset({ name: item?.name ?? '', image: undefined })
    resetMutation()
  }, [open, item, reset, resetMutation])

  const image = useWatch({ control: form.control, name: 'image' })
  const preview = useObjectUrl(image)

  const choose = (file: File) => {
    const invalid = checkPlanImage(file)
    if (invalid) {
      const key = invalid.code === 'file.type' ? errorKey('file.type') : errorKey('file.too_large', { maxMb: maxPlanImageMb })
      form.setError('image', { type: 'client', message: key })
      return
    }
    form.clearErrors('image')
    form.setValue('image', file)
  }
  const paste = (e: ClipboardEvent) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'))
    if (!file) return
    e.preventDefault()
    choose(file)
  }

  const submit = form.handleSubmit(async ({ name, image }) => {
    if (!item && !image) {
      form.setError('image', { type: 'client', message: errorKey('validation.required') })
      return
    }
    setProgress(undefined)
    let saved: Plan
    try {
      saved = await mutation.mutateAsync({ name, image })
    } catch (e) {
      setApiFieldErrors(e, form.setError, fields)
      return // shown by ErrorMessage via mutation.error
    }
    onOpenChange(false)
    onSaved(saved)
  })

  const imageError = fieldError(errors.image?.message)

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('dialog.editTitle') : t('dialog.addTitle')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={pending}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={mutation.error} fields={fields} />}
    >
      <div className="space-y-4" onPaste={paste}>
        <Field label={t('dialog.name')} autoComplete="off" required hint={t('dialog.nameHint')} error={fieldError(errors.name?.message)} {...form.register('name')} />
        <ImageUpload
          label={item ? t('dialog.replaceImage') : t('dialog.image')}
          src={preview ?? item?.image.url}
          accept={planImageTypes.join(',')}
          hint={item ? t('dialog.replaceHint') : t('dialog.imageHint')}
          error={imageError}
          pending={pending && image !== undefined}
          progress={progress}
          onSelect={choose}
          onRemove={() => form.setValue('image', undefined)}
        />
      </div>
    </FormDialog>
  )
}
