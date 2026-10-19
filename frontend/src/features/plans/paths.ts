import { versionPath } from '@/features/projects/paths'

export const editorRoute = 'projects/:id/versions/:versionId/plans/:planId'
export const editorPath = (projectId: string, versionId: string, planId: string) => `${versionPath(projectId, versionId)}/plans/${planId}`

export const boardRoute = 'projects/:id/versions/:versionId/boards/:planId'
export const boardPath = (projectId: string, versionId: string, planId: string) => `${versionPath(projectId, versionId)}/boards/${planId}`
