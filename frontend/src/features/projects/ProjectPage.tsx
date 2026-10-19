import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router'

import type { Project, ProjectVersion } from '@/api/generated/model'
import {
  getGetProjectQueryKey,
  getListProjectsQueryKey,
  useDeleteProjectVersion,
  useGetProject,
  useUpdateProject,
} from '@/api/generated/projects/projects'
import { BomTab, PricingTab } from '@/features/bom'
import { NeedsTab } from '@/features/needs'
import { ChecksTab } from '@/features/checks'
import { NetworksTab } from '@/features/networks'
import { PlansSection } from '@/features/plans'
import { InstallationDocumentsSection, ProgrammingExportsSection } from '@/features/installation'
import { ProposalsTab } from '@/features/proposals'
import { Button, ConfirmDialog, EmptyState, ErrorMessage, Loading, Notice, Page, SelectField, Tabs, TextLink } from '@/components/ui'

import { fresh, isNotFound, listPath, projectPath, versionPath } from './paths'
import { ProjectFormDialog } from './ProjectFormDialog'
import { RateBar } from './RateBar'
import { ProjectStatusBadge } from './StatusBadge'
import { TenantName } from './TenantName'
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
          exchangeRate: project.exchangeRate ?? '',
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
        {project.tenant && <TenantName tenant={project.tenant} />}
      </div>
      {project.notes && <Notes label={t('page.projectNotes')} text={project.notes} />}

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
      {version?.notes && <Notes label={t('page.versionNotes')} text={version.notes} />}

      {version && <VersionTabs project={project} version={version} canWrite={canWrite} />}

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

const versionTabs = ['plans', 'needs', 'networks', 'checks', 'bom', 'pricing', 'documents'] as const
type VersionTab = (typeof versionTabs)[number]

/** Old tab names still in links and bookmarks: the Proposals tab became Documents (D425). */
const tabAliases: Record<string, VersionTab> = { proposals: 'documents' }

/** Plans / Needs / Networks / Checks / Bill of materials / Pricing / Documents of a version; the tab is in the URL (?tab=bom, D236). */
function VersionTabs({ project, version, canWrite }: { project: Project; version: ProjectVersion; canWrite: boolean }) {
  const { t } = useTranslation('bom')
  const [params, setParams] = useSearchParams()
  const param = params.get('tab')
  const tab: VersionTab = versionTabs.find((k) => k === param) ?? (param ? tabAliases[param] : undefined) ?? 'plans'
  const select = (next: VersionTab) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        if (next === 'plans') out.delete('tab')
        else out.set('tab', next)
        return out
      },
      { replace: true },
    )
  return (
    <Tabs
      label={t('tabs.label')}
      value={tab}
      onValueChange={select}
      panelClassName="overflow-visible px-0 pt-6"
      tabs={[
        { key: 'plans', label: t('tabs.plans'), content: <PlansSection projectId={project.id} versionId={version.id} canWrite={canWrite} productTypeIds={project.productTypeIds} /> },
        { key: 'needs', label: t('tabs.needs'), content: <NeedsTab key={version.id} versionId={version.id} /> },
        { key: 'networks', label: t('tabs.networks'), content: <NetworksTab key={version.id} versionId={version.id} /> },
        { key: 'checks', label: t('tabs.checks'), content: <ChecksTab key={version.id} projectId={project.id} versionId={version.id} /> },
        {
          key: 'bom',
          label: t('tabs.bom'),
          content: (
            <div className="space-y-4">
              <RateBar project={project} versionId={version.id} />
              <BomTab key={version.id} projectId={project.id} versionId={version.id} canWrite={canWrite} productTypeIds={project.productTypeIds} />
            </div>
          ),
        },
        { key: 'pricing', label: t('tabs.pricing'), content: (
            <div className="space-y-4">
              <RateBar project={project} versionId={version.id} />
              <PricingTab key={version.id} versionId={version.id} canWrite={canWrite} />
            </div>
          ),
        },
        // Generating needs projects.write but no active project (D259): update or reopen says so.
        // Proposals, installation documents and programming exports in one tab (D425).
        {
          key: 'documents',
          label: t('tabs.documents'),
          content: (
            <div key={version.id} className="space-y-6">
              <ProposalsTab versionId={version.id} canGenerate={project.can.update || project.can.reopen} />
              <InstallationDocumentsSection versionId={version.id} canGenerate={project.can.update || project.can.reopen} />
              <ProgrammingExportsSection versionId={version.id} />
            </div>
          ),
        },
      ]}
    />
  )
}

/** Notes with a small label above them. */
function Notes({ label, text }: { label: string; text: string }) {
  return (
    <div className="space-y-0.5 text-sm">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="whitespace-pre-line">{text}</p>
    </div>
  )
}
