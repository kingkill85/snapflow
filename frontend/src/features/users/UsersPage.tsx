import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Tenant, User } from '@/api/generated/model'
import { useListTenants } from '@/api/generated/tenants/tenants'
import { getListUsersQueryKey, useDeleteUser, useListUsers } from '@/api/generated/users/users'
import { useCan, useMe } from '@/app/session'
import { Badge, Button, type Column, ConfirmDialog, DataTable, EmptyState, ErrorMessage, Loading, Page, RowAction, Select } from '@/components/ui'

import { UserFormDialog } from './UserFormDialog'

const noTenants: Tenant[] = []

export function UsersPage() {
  const { t } = useTranslation('users')
  const { t: tCommon } = useTranslation()
  const me = useMe()
  const can = useCan()
  const queryClient = useQueryClient()

  // Only callers who see and manage every tenant choose tenants (the tenant
  // list needs tenants.manage); everyone else works in their own.
  const allTenants = can('tenants.access_all') && can('tenants.manage')
  const [tenantFilter, setTenantFilter] = useState('')
  const tenants = useListTenants({ query: { enabled: allTenants } })
  const tenantList = allTenants ? (tenants.data?.items ?? noTenants) : noTenants
  const list = useListUsers(tenantFilter ? { tenantId: tenantFilter } : undefined)
  const remove = useDeleteUser()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [deleting, setDeleting] = useState<User | null>(null)

  const openForm = (user: User | null) => {
    setEditing(user)
    setFormOpen(true)
  }

  // Each delete starts without the previous attempt's error.
  const openDelete = (user: User | null) => {
    remove.reset()
    setDeleting(user)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ id: deleting.id })
    } catch {
      return // shown by ErrorMessage via remove.error
    }
    await queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() })
    setDeleting(null)
  }

  const tenantName = (id: string) => tenantList.find((tenant) => tenant.id === id)?.name ?? ''
  const columns: Column<User>[] = [
    { header: t('field.name'), cell: (u) => u.fullName || '—' },
    { header: t('field.email'), cell: (u) => u.email },
    ...(allTenants ? [{ header: t('field.tenant'), cell: (u: User) => tenantName(u.tenantId) }] : []),
    { header: t('field.role'), cell: (u) => <Badge variant={u.role === 'user' ? 'neutral' : 'primary'}>{tCommon(`role.${u.role}`)}</Badge> },
    {
      header: t('field.status'),
      cell: (u) => (
        <Badge variant={u.isActive ? 'success' : 'neutral'}>{u.isActive ? tCommon('status.active') : tCommon('status.inactive')}</Badge>
      ),
    },
  ]

  const createButton = (
    <Button onClick={() => openForm(null)}>
      <Plus /> {t('new')}
    </Button>
  )

  return (
    <Page width="wide" title={t('title')} description={t('description')} actions={createButton}>
      {allTenants && (
        <Select
          aria-label={t('field.tenant')}
          className="max-w-xs"
          value={tenantFilter}
          onValueChange={setTenantFilter}
          options={[{ value: '', label: t('allTenants') }, ...tenantList.map((tenant) => ({ value: tenant.id, label: tenant.name }))]}
        />
      )}
      {tenants.isError && <ErrorMessage error={tenants.error} />}
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorMessage error={list.error} />
      ) : (
        <DataTable
          rows={list.data.items}
          rowKey={(u) => u.id}
          columns={columns}
          actions={(u) => (
            <>
              {u.can.update && (
                <RowAction onClick={() => openForm(u)} icon={<Pencil />} label={tCommon('action.edit')} />
              )}
              {u.can.delete && (
                <RowAction variant="danger-quiet" onClick={() => openDelete(u)} icon={<Trash2 />} label={tCommon('action.delete')} />
              )}
            </>
          )}
          empty={<EmptyState title={t('empty')} action={createButton} />}
        />
      )}

      <UserFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        item={editing}
        tenants={tenantList}
        defaultTenantId={tenantFilter || me.tenantId}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && openDelete(null)}
        title={t('deleteTitle')}
        message={t('deleteMessage', { name: deleting?.fullName || deleting?.email })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Page>
  )
}
