import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Tenant } from '@/api/generated/model'
import { getListTenantsQueryKey, useDeleteTenant, useListTenants } from '@/api/generated/tenants/tenants'
import { getListUsersQueryKey } from '@/api/generated/users/users'
import { Badge, Button, ConfirmDialog, DataTable, EmptyState, ErrorMessage, Loading, Page } from '@/components/ui'

import { TenantFormDialog } from './TenantFormDialog'

export function TenantsPage() {
  const { t } = useTranslation('tenants')
  const { t: tCommon } = useTranslation()
  const queryClient = useQueryClient()
  const list = useListTenants()
  const remove = useDeleteTenant()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Tenant | null>(null)
  const [deleting, setDeleting] = useState<Tenant | null>(null)

  const openForm = (tenant: Tenant | null) => {
    setEditing(tenant)
    setFormOpen(true)
  }

  // Each delete starts without the previous attempt's error.
  const openDelete = (tenant: Tenant | null) => {
    remove.reset()
    setDeleting(tenant)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ id: deleting.id })
    } catch {
      return // shown by ErrorMessage via remove.error
    }
    await queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() })
    // The tenant's users are gone too.
    await queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() })
    setDeleting(null)
  }

  const createButton = (
    <Button onClick={() => openForm(null)}>
      <Plus /> {t('new')}
    </Button>
  )

  return (
    <Page title={t('title')} description={t('description')} actions={createButton}>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorMessage error={list.error} />
      ) : (
        <DataTable
          rows={list.data.items}
          rowKey={(tenant) => tenant.id}
          columns={[
            { header: t('field.name'), cell: (tenant) => tenant.name },
            {
              header: t('field.type'),
              cell: (tenant) => <Badge variant={tenant.isDistributor ? 'primary' : 'neutral'}>{tenant.isDistributor ? t('distributor') : t('partner')}</Badge>,
            },
            {
              header: t('field.status'),
              cell: (tenant) => (
                <Badge variant={tenant.isActive ? 'success' : 'neutral'}>
                  {tenant.isActive ? tCommon('status.active') : tCommon('status.inactive')}
                </Badge>
              ),
            },
          ]}
          actions={(tenant) => (
            <>
              {tenant.can.update && (
                <Button size="sm" variant="secondary" onClick={() => openForm(tenant)}>
                  <Pencil /> {tCommon('action.edit')}
                </Button>
              )}
              {tenant.can.delete && (
                <Button size="sm" variant="danger" onClick={() => openDelete(tenant)}>
                  <Trash2 /> {tCommon('action.delete')}
                </Button>
              )}
            </>
          )}
          empty={<EmptyState title={t('empty')} action={createButton} />}
        />
      )}

      <TenantFormDialog open={formOpen} onOpenChange={setFormOpen} item={editing} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && openDelete(null)}
        title={t('deleteTitle')}
        message={t('deleteMessage', { name: deleting?.name })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Page>
  )
}
