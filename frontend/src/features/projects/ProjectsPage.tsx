import { keepPreviousData, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'

import { ListProjectsStatus, type ProjectListItem } from '@/api/generated/model'
import { getGetProjectQueryKey, getListProjectsQueryKey, useDeleteProject, useGetProject, useListProjects } from '@/api/generated/projects/projects'
import { useListTenants } from '@/api/generated/tenants/tenants'
import { useCan } from '@/app/session'
import {
  Button,
  type Column,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorMessage,
  Field,
  lastPageOffset,
  Loading,
  Page,
  Pagination,
  RowAction,
  SelectField,
  TextLink,
} from '@/components/ui'

import { fresh, projectPath, useFormatDate } from './paths'
import { ProjectFormDialog } from './ProjectFormDialog'
import { ProjectStatusBadge } from './StatusBadge'
import { TenantName } from './TenantName'

/** Rows per page. */
export const pageSize = 50
/** How long typing pauses before the search runs. */
const searchDelayMs = 300
/** The API's limit of the search text. */
const searchMaxLength = 200

const statuses = Object.values(ListProjectsStatus)
const isStatus = (value: string | null): value is ListProjectsStatus => statuses.includes(value as ListProjectsStatus)

/** /projects: the filtered, paged project list. Filters live in the URL, so Back returns to them. */
export function ProjectsPage() {
  const { t } = useTranslation('projects')
  const { t: tCommon } = useTranslation()
  const can = useCan()
  const formatDate = useFormatDate()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const canCreate = can('projects.write')
  // Callers who see every tenant filter by tenant (the tenant list needs tenants.manage).
  const allTenants = can('tenants.access_all') && can('tenants.manage')

  const [params, setParams] = useSearchParams()
  const search = params.get('search') ?? ''
  // Active unless the URL says otherwise.
  const rawStatus = params.get('status')
  const status: ListProjectsStatus = isStatus(rawStatus) ? rawStatus : 'active'
  const tenantId = allTenants ? (params.get('tenant') ?? '') : ''
  const offset = Math.max(0, Math.floor(Number(params.get('offset'))) || 0)

  /** Changes filters; any change but paging starts again at the first page (see the product list). */
  const setFilters = useCallback(
    (changes: Record<string, string>, { sync = true } = {}) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (!('offset' in changes)) next.delete('offset')
          for (const [name, value] of Object.entries(changes)) {
            if (value === '' || value === '0' || (name === 'status' && value === 'active')) next.delete(name)
            else next.set(name, value)
          }
          return next
        },
        { replace: true, flushSync: sync },
      ),
    [setParams],
  )

  // The search runs once typing pauses.
  const [draft, setDraft] = useState(search)
  const [searched, setSearched] = useState(search)
  if (searched !== search) {
    setSearched(search)
    if (draft.trim() !== search) setDraft(search)
  }
  useEffect(() => {
    if (draft.trim() === search) return
    const timer = setTimeout(() => setFilters({ search: draft.trim() }), searchDelayMs)
    return () => clearTimeout(timer)
  }, [draft, search, setFilters])

  const tenants = useListTenants({ includeArchived: true }, { query: { enabled: allTenants } })
  const list = useListProjects(
    { ...(search ? { search } : {}), status, ...(tenantId ? { tenantId } : {}), limit: pageSize, offset },
    { query: { placeholderData: keepPreviousData } },
  )
  // An offset past the end moves to the last page.
  const total = list.data?.total
  useEffect(() => {
    if (total !== undefined && total > 0 && offset >= total) setFilters({ offset: String(lastPageOffset(total, pageSize)) }, { sync: false })
  }, [total, offset, setFilters])

  // Create: the dialog opens empty. Edit: the project is loaded fresh first (D44).
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = useGetProject(editingId ?? '', { query: { ...fresh, enabled: editingId !== null } })

  const remove = useDeleteProject()
  const [deleting, setDeleting] = useState<ProjectListItem | null>(null)
  const openDelete = (item: ProjectListItem | null) => {
    remove.reset()
    setDeleting(item)
  }
  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ id: deleting.id })
    } catch {
      return // shown by ErrorMessage via remove.error
    }
    queryClient.removeQueries({ queryKey: getGetProjectQueryKey(deleting.id) })
    await queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() })
    setDeleting(null)
  }

  const statusOptions = statuses.map((s) => ({ value: s, label: t(`status.${s}`) }))
  const tenantOptions = [{ value: '', label: t('allTenants') }, ...(tenants.data?.items ?? []).map((tenant) => ({
      value: tenant.id,
      label: tenant.archivedAt ? t('archivedTenant', { name: tenant.name }) : tenant.name,
    }))]

  const columns: Column<ProjectListItem>[] = [
    { header: t('column.number'), cell: (p) => p.number, className: 'whitespace-nowrap tabular-nums' },
    // The name opens the project.
    { header: t('column.name'), cell: (p) => <TextLink to={projectPath(p.id)}>{p.name}</TextLink>, className: 'min-w-48', mobile: 'title' },
    {
      header: t('column.customer'),
      cell: (p) => (
        <div className="space-y-0.5">
          <p>{p.customerName || (p.customerCompany ? '' : '—')}</p>
          {p.customerCompany && <p className="text-muted">{p.customerCompany}</p>}
        </div>
      ),
      className: 'min-w-40',
    },
    ...(allTenants ? [{ header: t('column.tenant'), cell: (p: ProjectListItem) => (p.tenant ? <TenantName tenant={p.tenant} /> : '') }] : []),
    { header: t('column.status'), cell: (p) => <ProjectStatusBadge status={p.status} /> },
    { header: t('column.versions'), cell: (p) => p.versionCount, className: 'text-right tabular-nums' },
    { header: t('column.updated'), cell: (p) => formatDate(p.updatedAt), className: 'whitespace-nowrap' },
  ]

  const rowActions = (p: ProjectListItem) => (
    <>
      {p.can.update && <RowAction onClick={() => setEditingId(p.id)} icon={<Pencil />} label={tCommon('action.edit')} />}
      {p.can.delete && <RowAction variant="danger-quiet" onClick={() => openDelete(p)} icon={<Trash2 />} label={tCommon('action.delete')} />}
    </>
  )

  const createButton = canCreate ? (
    <Button onClick={() => setCreating(true)}>
      <Plus /> {t('new')}
    </Button>
  ) : undefined
  const filtered = search !== '' || status !== 'active' || tenantId !== ''

  return (
    <Page width="wide" title={t('title')} description={t('description')} actions={createButton}>
      <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field
          type="search"
          label={t('search')}
          placeholder={t('searchHint')}
          maxLength={searchMaxLength}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <SelectField label={t('statusFilter')} value={status} options={statusOptions} onValueChange={(v) => setFilters({ status: v })} />
        {allTenants && <SelectField label={t('tenantFilter')} value={tenantId} options={tenantOptions} onValueChange={(v) => setFilters({ tenant: v })} />}
      </div>
      {tenants.isError && <ErrorMessage error={tenants.error} />}
      {editing.isError && <ErrorMessage error={editing.error} />}
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <ErrorMessage error={list.error} />
      ) : (
        <>
          <DataTable
            rows={list.data.items}
            rowKey={(p) => p.id}
            columns={columns}
            actions={list.data.items.some((p) => p.can.update || p.can.delete) ? rowActions : undefined}
            empty={filtered ? <EmptyState title={t('emptyFiltered')} /> : <EmptyState title={t('empty')} action={createButton} />}
          />
          <Pagination offset={offset} limit={pageSize} total={list.data.total} onChange={(o) => setFilters({ offset: String(o) })} />
        </>
      )}

      <ProjectFormDialog
        open={creating}
        onOpenChange={setCreating}
        item={null}
        // An archived tenant cannot get new projects: no preselection then.
        defaultTenantId={tenantId && !tenants.data?.items.find((x) => x.id === tenantId)?.archivedAt ? tenantId : undefined}
        onSaved={(project) => void navigate(projectPath(project.id))}
      />
      <ProjectFormDialog
        open={editingId !== null && editing.data !== undefined && !editing.isFetching}
        onOpenChange={(open) => !open && setEditingId(null)}
        item={editing.data ?? null}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && openDelete(null)}
        title={t('deleteTitle')}
        message={t('deleteMessage', { name: deleting ? `${deleting.number} ${deleting.name}` : '' })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Page>
  )
}
