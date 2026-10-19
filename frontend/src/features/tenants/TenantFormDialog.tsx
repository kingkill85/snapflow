import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useForm, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { getGetMeQueryKey } from '@/api/generated/auth/auth'
import type { Tenant } from '@/api/generated/model'
import {
  getGetTenantLetterheadQueryKey,
  getListTenantsQueryKey,
  updateTenantLetterhead,
  useCreateTenant,
  useGetTenantLetterhead,
  useUpdateTenant,
} from '@/api/generated/tenants/tenants'
import { useCan, useMe } from '@/app/session'
import {
  apiFields,
  errorKey,
  ErrorMessage,
  Field,
  FormDialog,
  Loading,
  setApiFieldErrors,
  SwitchField,
  useFieldError,
} from '@/components/ui'
import { fresh } from '@/features/bom/format'

import { LetterheadFields } from './letterhead'
import { letterheadApiFields, letterheadSchema, toLetterheadInput, toLetterheadValues } from './letterhead-values'

const schema = z.object({
  name: z.string().trim().min(1, errorKey('validation.required')).max(200, errorKey('validation.too_long', { max: 200 })),
  isActive: z.boolean(),
  // Edit mode with tenants.profile only; loaded when the dialog opens (D44).
  letterhead: letterheadSchema,
})
type FormValues = z.infer<typeof schema>

const fields = apiFields<FormValues>(['name'])
const letterheadFields = letterheadApiFields('letterhead.')
const emptyLetterhead = { companyName: '', address: '', phone: '', email: '', website: '', logoFileId: null, logoUrl: null }

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = create mode, object = edit mode. */
  item: Tenant | null
}

export function TenantFormDialog({ open, onOpenChange, item }: Props) {
  const { t } = useTranslation('tenants')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const me = useMe()
  const queryClient = useQueryClient()
  const create = useCreateTenant()
  const update = useUpdateTenant()
  const can = useCan()
  // Admins edit the letterhead of an existing tenant here too (D261); it is saved after the tenant.
  const withLetterhead = !!item && can('tenants.profile')
  // Set once the letterhead has loaded (LetterheadSection): saving waits for it; cleared on closing.
  const [letterheadReady, setLetterheadReady] = useState(false)
  const changeOpen = (next: boolean) => {
    if (!next) setLetterheadReady(false)
    onOpenChange(next)
  }
  const saveLetterhead = useMutation({ mutationFn: (v: FormValues) => updateTenantLetterhead(item!.id, toLetterheadInput(v.letterhead)) })
  const mutation = item ? update : create

  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { errors } = form.formState
  const { reset } = form
  const { reset: resetCreate } = create
  const { reset: resetUpdate } = update
  const { reset: resetLetterhead } = saveLetterhead

  // Reset only when the dialog opens or switches record.
  useEffect(() => {
    if (!open) return
    reset({ name: item?.name ?? '', isActive: item?.isActive ?? true, letterhead: emptyLetterhead })
    resetCreate()
    resetUpdate()
    resetLetterhead()
  }, [open, item, reset, resetCreate, resetUpdate, resetLetterhead])

  const submit = form.handleSubmit(async (data) => {
    // Never save a letterhead that has not loaded yet: PUT replaces every field.
    if (withLetterhead && !letterheadReady) return
    const { letterhead: _letterhead, ...tenant } = data
    try {
      if (item) await update.mutateAsync({ id: item.id, data: tenant })
      else await create.mutateAsync({ data: tenant })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      return // shown by ErrorMessage via mutation.error
    }
    if (withLetterhead) {
      try {
        await saveLetterhead.mutateAsync(data)
      } catch (error) {
        setApiFieldErrors(error, form.setError, letterheadFields)
        await queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() })
        return // shown by ErrorMessage via saveLetterhead.error
      }
      await queryClient.invalidateQueries({ queryKey: getGetTenantLetterheadQueryKey(item.id) })
    }
    await queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() })
    // The session shows the user's own tenant name.
    if (item?.id === me.tenantId) await queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() })
    changeOpen(false)
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={changeOpen}
      title={item ? t('edit') : t('new')}
      submitLabel={item ? tCommon('action.update') : tCommon('action.create')}
      submitting={mutation.isPending || saveLetterhead.isPending}
      onSubmit={() => void submit()}
      error={
        <>
          <ErrorMessage error={mutation.error} fields={fields} />
          <ErrorMessage error={saveLetterhead.error} fields={letterheadFields} />
        </>
      }
    >
      <Field label={t('field.name')} required autoComplete="off" error={fieldError(errors.name?.message)} {...form.register('name')} />
      {item?.isDistributor ? (
        <p className="text-sm text-muted">{t('field.distributorHint')}</p>
      ) : (
        <>
          {/* An archived tenant cannot be activated: restore it first (D182); the hint says so, at the switch (D183). */}
          <SwitchField
            label={t('field.active')}
            hint={item?.archivedAt ? t('field.archivedHint') : t('field.activeHint')}
            disabled={!!item?.archivedAt}
            {...form.register('isActive')}
          />
        </>
      )}
      {withLetterhead && <LetterheadSection form={form} tenantId={item.id} onReady={() => setLetterheadReady(true)} />}
    </FormDialog>
  )
}

/** The letterhead part of the tenant dialog, loaded fresh when it opens (D44): until then a spinner, and saving waits. */
function LetterheadSection({ form, tenantId, onReady }: { form: UseFormReturn<FormValues>; tenantId: string; onReady: () => void }) {
  const { t } = useTranslation('tenants')
  const query = useGetTenantLetterhead(tenantId, { query: fresh })
  const applied = useRef(false)
  const loaded = query.isFetchedAfterMount && query.data !== undefined
  useEffect(() => {
    if (!loaded || applied.current || !query.data) return
    applied.current = true
    form.setValue('letterhead', toLetterheadValues(query.data))
    onReady()
  }, [loaded, query.data, form, onReady])
  return (
    <section aria-labelledby="letterhead-title" className="space-y-4 border-t border-line pt-4">
      <div className="space-y-1">
        <h3 id="letterhead-title" className="text-sm font-semibold">
          {t('letterhead.title')}
        </h3>
        <p className="text-sm text-muted">{t('letterhead.description')}</p>
      </div>
      {query.isError ? <ErrorMessage error={query.error} /> : !loaded ? <Loading /> : <LetterheadFields form={form} tenantId={tenantId} />}
    </section>
  )
}
