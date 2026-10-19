import { useMutation } from '@tanstack/react-query'
import { type FieldValues, type Path, type PathValue, type UseFormReturn, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { apiClient } from '@/api/client'
import type { File as StoredFile } from '@/api/generated/model'
import { errorKey, Field, ImageUpload, TextareaField, useErrorMessage, useFieldError } from '@/components/ui'
import { imageTypes } from '@/catalog/files'

import type { LetterheadValues } from './letterhead-values'

/** The API's limit for a logo (D261); checked here only to spare a long upload. */
const maxLogoMb = 5

/** POST /api/tenants/{id}/logo; the generated client types the multipart file as a string. */
function uploadLogo(tenantId: string, image: File) {
  const data = new FormData()
  data.append('image', image)
  return apiClient<StoredFile>({ url: `/api/tenants/${tenantId}/logo`, method: 'POST', data })
}

type LetterheadForm = { letterhead: LetterheadValues }

/**
 * Company name, address, phone, email, website and logo of a tenant's
 * letterhead, as fields of a form whose values hold them under `letterhead`.
 * A chosen logo is uploaded right away (POST /api/tenants/{id}/logo); saving
 * the form sets it.
 */
export function LetterheadFields<T extends FieldValues & LetterheadForm>({ form: anyForm, tenantId, disabled }: { form: UseFormReturn<T>; tenantId: string; disabled?: boolean }) {
  const { t } = useTranslation('tenants')
  const fieldError = useFieldError()
  const errorMessage = useErrorMessage()
  // The fields are typed on the letterhead part; the caller's form has more.
  const form = anyForm as unknown as UseFormReturn<LetterheadForm>
  const errors = form.formState.errors.letterhead
  const logoUrl = useWatch({ control: form.control, name: 'letterhead.logoUrl' })
  const upload = useMutation({ mutationFn: (image: File) => uploadLogo(tenantId, image) })

  const set = <P extends Path<LetterheadForm>>(name: P, value: PathValue<LetterheadForm, P>) => form.setValue(name, value, { shouldDirty: true })
  const choose = async (file: File) => {
    upload.reset()
    form.clearErrors('letterhead.logoFileId')
    if (!imageTypes.includes(file.type)) {
      form.setError('letterhead.logoFileId', { type: 'client', message: errorKey('file.type') })
      return
    }
    if (file.size > maxLogoMb * 1024 * 1024) {
      form.setError('letterhead.logoFileId', { type: 'client', message: errorKey('file.too_large', { maxMb: maxLogoMb }) })
      return
    }
    try {
      const stored = await upload.mutateAsync(file)
      set('letterhead.logoFileId', stored.id)
      set('letterhead.logoUrl', stored.url)
    } catch {
      // shown at the upload via upload.error
    }
  }
  const logoError = fieldError(errors?.logoFileId?.message) || (upload.error ? errorMessage(upload.error) : undefined)

  return (
    <>
      <Field label={t('letterhead.companyName')} autoComplete="off" disabled={disabled} error={fieldError(errors?.companyName?.message)} {...form.register('letterhead.companyName')} />
      <TextareaField label={t('letterhead.address')} rows={3} disabled={disabled} error={fieldError(errors?.address?.message)} {...form.register('letterhead.address')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('letterhead.phone')} type="tel" autoComplete="off" disabled={disabled} error={fieldError(errors?.phone?.message)} {...form.register('letterhead.phone')} />
        <Field label={t('letterhead.email')} type="email" autoComplete="off" disabled={disabled} error={fieldError(errors?.email?.message)} {...form.register('letterhead.email')} />
      </div>
      <Field label={t('letterhead.website')} autoComplete="off" disabled={disabled} error={fieldError(errors?.website?.message)} {...form.register('letterhead.website')} />
      <ImageUpload
        label={t('letterhead.logo')}
        src={logoUrl ?? undefined}
        accept={imageTypes.join(',')}
        hint={t('letterhead.logoHint')}
        error={logoError}
        pending={upload.isPending}
        disabled={disabled}
        onSelect={(file) => void choose(file)}
        onRemove={() => {
          set('letterhead.logoFileId', null)
          set('letterhead.logoUrl', null)
        }}
      />
    </>
  )
}
