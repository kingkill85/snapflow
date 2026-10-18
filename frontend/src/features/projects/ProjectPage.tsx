import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'

import type { Project, ProjectVersion } from '@/api/generated/model'
import {
  getGetProjectQueryKey,
  getListProjectsQueryKey,
  useDeleteProjectVersion,
  useGetProject,
  useUpdateProject,
} from '@/api/generated/projects/projects'
import { Button, ConfirmDialog, EmptyState, ErrorMessage, Loading, Notice, Page, SelectField, TextLink } from '@/components/ui'

import { fresh, isNotFound, listPath, projectPath, versionPath } from './paths'
import { ProjectFormDialog } from './ProjectFormDialog'
import { ProjectStatusBadge } from './StatusBadge'
import { VersionFormDialog } from './VersionFormDialog'

/** /projects/:id and /projects/:id/versions/:versionId: a project with its versions (2a: the shell for plans). */
export function ProjectPage() {
  const { t } = useTranslation('projects')
  const { id = '', versionId } = useParams()
  const query = useGetProject(id, { query: fresh })

  if (query.isPending) return <Loading />
  if (query.isError) {
    return (
      <Page title={t('title')}>
        {isNotFound(query.error) ? <EmptyState title={t('page.notFound')} action={<TextLink to={listPath}>{t('page.backToList')}</TextLink>} /> : <ErrorMessage error={query.error} />}
      </Page>
    )
  }
  const project = query.data
  // The URL's version, else the first.
  const version = project.versions.find((v) => v.id === versionId) ?? project.versions[0]
  return <ProjectView project={project} version={version} />
}

function ProjectView({ project, version }: { project: Project; version: ProjectVersion | undefined }) {
  const { t } = useTranslation('projects')
  const { t: tCommon } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const lastHintId = useId()

  const [editOpen, setEditOpen] = useState(false)
  // null: closed; 'new': a new version; a version: rename it.
  const [versionDialog, setVersionDialog] = useState<ProjectVersion | 'new' | null>(null)
  const [deleting, setDeleting] = useState<ProjectVersion | null>(null)

  const removeVersion = useDeleteProjectVersion()
  const reopen = useUpdateProject()

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(project.id) }),
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() }),
    ])

  const openDelete = (v: ProjectVersion | null) => {
    removeVersion.reset()
    setDeleting(v)
  }
  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await removeVersion.mutateAsync({ id: project.id, versionId: deleting.id })
    } catch {
      return // shown by ErrorMessage via removeVersion.error
    }
    setDeleting(null)
    await navigate(projectPath(project.id), { replace: true })
    await refresh()
  }

  // Reopening sends the project as it is, with the status active.
  const doReopen = async () => {
    try {
      const saved = await reopen.mutateAsync({
        id: project.id,
        data: {
          name: project.name,
          status: 'active',
          language: project.language,
          currency: project.currency,
          exchangeRate: project.exchangeRate,
          customer: project.customer,
          notes: project.notes,
          productTypeIds: project.productTypeIds,
          expectedUpdatedAt: project.updatedAt,
        },
      })
      queryClient.setQueryData(getGetProjectQueryKey(project.id), saved)
    } catch {
      return // shown by ErrorMessage via reopen.error
    }
    await queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() })
  }

  const customer = [project.customer.name, project.customer.company].filter(Boolean).join(', ')
  const canWrite = project.can.update
  const isLast = project.versions.length <= 1

  return (
    <Page
      width="wide"
      title={`${project.number} ${project.name}`}
      description={customer || t('page.noCustomer')}
      actions={
        canWrite ? (
          <Button variant="secondary" onClick={() => setEditOpen(true)}>
            <Pencil /> {t('edit')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <ProjectStatusBadge status={project.status} />
        {project.tenant && <span>{project.tenant.name}</span>}
      </div>

      {project.status !== 'active' && (
        <Notice tone="warning">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{t(`page.readOnly.${project.status}`)}</span>
            {project.can.reopen && (
              <Button size="sm" variant="secondary" disabled={reopen.isPending} onClick={() => void doReopen()}>
                {t('page.reopen')}
              </Button>
            )}
          </span>
        </Notice>
      )}
      <ErrorMessage error={reopen.error} />

      {version && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full sm:w-64">
            <SelectField
              label={t('page.versionSelect')}
              value={version.id}
              options={project.versions.map((v) => ({ value: v.id, label: v.name }))}
              onValueChange={(v) => void navigate(versionPath(project.id, v))}
            />
          </div>
          {canWrite && (
            <>
              <Button variant="secondary" onClick={() => setVersionDialog('new')}>
                <Plus /> {t('page.newVersion')}
              </Button>
              {version.can.update && (
                <Button variant="secondary" onClick={() => setVersionDialog(version)}>
                  <Pencil /> {t('page.renameVersion')}
                </Button>
              )}
              {/* Disabled on the last version; the wrapper shows why on hover (a disabled button gets no pointer events). */}
              <span title={isLast ? t('page.lastVersionHint') : undefined}>
                <Button variant="danger-quiet" disabled={!version.can.delete} aria-describedby={isLast ? lastHintId : undefined} onClick={() => openDelete(version)}>
                  <Trash2 /> {t('page.deleteVersion')}
                </Button>
              </span>
              {isLast && (
                <span id={lastHintId} className="sr-only">
                  {t('page.lastVersionHint')}
                </span>
              )}
            </>
          )}
        </div>
      )}
      {version?.notes && <p className="text-sm whitespace-pre-line text-muted">{version.notes}</p>}

      {/* Plans arrive in 2b (the floorplan editor), which adds the action here. */}
      <EmptyState title={t('page.noPlans')} />

      <ProjectFormDialog open={editOpen} onOpenChange={setEditOpen} item={project} />
      {version && (
        <VersionFormDialog
          open={versionDialog !== null}
          onOpenChange={(open) => !open && setVersionDialog(null)}
          project={project}
          item={versionDialog === 'new' || versionDialog === null ? null : versionDialog}
          currentVersionId={version.id}
          onSaved={(saved) => void navigate(versionPath(project.id, saved.id))}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && openDelete(null)}
        title={t('version.deleteTitle')}
        message={t('version.deleteMessage', { name: deleting?.name ?? '' })}
        confirmLabel={tCommon('action.delete')}
        pending={removeVersion.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={removeVersion.error} />}
      />
    </Page>
  )
}
