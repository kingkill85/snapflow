import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import type { Letterhead } from '@/api/generated/model'
import { getGetTenantLetterheadQueryKey, getListTenantsQueryKey, useGetTenantLetterhead, useUpdateTenantLetterhead } from '@/api/generated/tenants/tenants'
import { useMe } from '@/app/session'
import { Button, ErrorMessage, Loading, Notice, Page, Section, SectionActions, setApiFieldErrors } from '@/components/ui'
import { fresh } from '@/features/bom/format'

import { LetterheadFields } from './letterhead'
import { letterheadApiFields, letterheadSchema, toLetterheadInput, toLetterheadValues } from './letterhead-values'

const schema = z.object({ letterhead: letterheadSchema })
type FormValues = z.infer<typeof schema>
const fields = letterheadApiFields('letterhead.')

/**
 * Administration → Company profile (tenants.profile): the letterhead of the
 * user's own tenant, printed on its proposals (D261). Loaded on every visit (D44).
 */
export function CompanyProfilePage() {
  const { t } = useTranslation('tenants')
  const me = useMe()
  const query = useGetTenantLetterhead(me.tenantId, { query: fresh })
  return (
    <Page width="narrow" title={t('profile.title')} description={me.tenantName}>
      {query.isError ? (
        <ErrorMessage error={query.error} />
      ) : query.isPending || !query.isFetchedAfterMount ? (
        <Loading />
      ) : (
        <LetterheadForm tenantId={me.tenantId} letterhead={query.data} />
      )}
    </Page>
  )
}

function LetterheadForm({ tenantId, letterhead }: { tenantId: string; letterhead: Letterhead }) {
  const { t } = useTranslation('tenants')
  const { t: tCommon } = useTranslation()
  const queryClient = useQueryClient()
  const save = useUpdateTenantLetterhead()
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { letterhead: toLetterheadValues(letterhead) } })

  const submit = form.handleSubmit(async (v) => {
    let saved: Letterhead
    try {
      saved = await save.mutateAsync({ id: tenantId, data: toLetterheadInput(v.letterhead) })
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
      return // shown by ErrorMessage via save.error
    }
    form.reset({ letterhead: toLetterheadValues(saved) })
    queryClient.setQueryData(getGetTenantLetterheadQueryKey(tenantId), saved)
    await queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() })
  })

  return (
    <Section title={t('letterhead.title')} description={t('letterhead.description')}>
      <form className="space-y-4" noValidate onSubmit={(e) => void submit(e)}>
        <ErrorMessage error={save.error} fields={fields} />
        {save.isSuccess && !form.formState.isDirty && <Notice>{t('letterhead.saved')}</Notice>}
        <LetterheadFields form={form} tenantId={tenantId} />
        <SectionActions>
          <Button type="submit" disabled={save.isPending}>
            {tCommon('action.save')}
          </Button>
        </SectionActions>
      </form>
    </Section>
  )
}
