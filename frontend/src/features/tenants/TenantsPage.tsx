import { useQueryClient } from '@tanstack/react-query'
import { ArchiveRestore, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Tenant } from '@/api/generated/model'
import { getListTenantsQueryKey, useDeleteTenant, useListTenants, useRestoreTenant } from '@/api/generated/tenants/tenants'
import { getListUsersQueryKey } from '@/api/generated/users/users'
import { Badge, Button, CheckboxField, ConfirmDialog, DataTable, EmptyState, ErrorMessage, Loading, Page, RowAction } from '@/components/ui'

import { TenantFormDialog } from './TenantFormDialog'

export function TenantsPage() {
  const { t } = useTranslation('tenants')
  const { t: tCommon } = useTranslation()
  const queryClient = useQueryClient()
  // Archived tenants (deleted, kept for their projects; D13) only on request.
  const [showArchived, setShowArchived] = useState(false)
  const list = useListTenants(showArchived ? { includeArchived: true } : undefined)
  const remove = useDeleteTenant()
  const restore = useRestoreTenant()

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

  const doRestore = async (tenant: Tenant) => {
    try {
      await restore.mutateAsync({ id: tenant.id })
    } catch {
      return // shown by ErrorMessage via restore.error
    }
    await queryClient.invalidateQueries({ queryKey: getListTenantsQueryKey() })
  }

  const createButton = (
    <Button onClick={() => openForm(null)}>
      <Plus /> {t('new')}
    </Button>
  )

  return (
    <Page width="wide" title={t('title')} description={t('description')} actions={createButton}>
      <CheckboxField label={t('showArchived')} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
      <ErrorMessage error={restore.error} />
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
                <span className="inline-flex flex-wrap gap-1.5">
                  <Badge variant={tenant.isActive ? 'success' : 'neutral'}>
                    {tenant.isActive ? tCommon('status.active') : tCommon('status.inactive')}
                  </Badge>
                  {tenant.archivedAt && <Badge variant="warning">{t('archived')}</Badge>}
                </span>
              ),
            },
            {
              header: t('field.projects'),
              cell: (tenant) => tenant.projectCount,
              className: 'text-right tabular-nums',
            },
          ]}
          actions={(tenant) => (
            <>
              {tenant.can.update && (
                <RowAction onClick={() => openForm(tenant)} icon={<Pencil />} label={tCommon('action.edit')} />
              )}
              {tenant.can.update && tenant.archivedAt && (
                <RowAction onClick={() => void doRestore(tenant)} disabled={restore.isPending} icon={<ArchiveRestore />} label={t('restore')} />
              )}
              {/* An archived tenant with projects cannot be deleted (tenant.has_projects). */}
              {tenant.can.delete && !(tenant.archivedAt && tenant.projectCount > 0) && (
                <RowAction variant="danger-quiet" onClick={() => openDelete(tenant)} icon={<Trash2 />} label={tCommon('action.delete')} />
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
        title={deleting && deleting.projectCount > 0 ? t('archiveTitle') : t('deleteTitle')}
        message={
          deleting && deleting.projectCount > 0
            ? t('archiveMessage', { name: deleting.name, count: deleting.projectCount })
            : t('deleteMessage', { name: deleting?.name })
        }
        confirmLabel={deleting && deleting.projectCount > 0 ? t('archive') : tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Page>
  )
}
