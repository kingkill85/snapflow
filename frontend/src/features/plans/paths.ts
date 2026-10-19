import { versionPath } from '@/features/projects/paths'

export const editorRoute = 'projects/:id/versions/:versionId/plans/:planId'
export const editorPath = (projectId: string, versionId: string, planId: string) => `${versionPath(projectId, versionId)}/plans/${planId}`
