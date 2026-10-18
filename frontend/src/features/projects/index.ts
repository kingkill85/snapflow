import type { FeatureModule } from '@/app/feature'

import { ProjectPage } from './ProjectPage'
import { ProjectsPage } from './ProjectsPage'

export const projectsFeature: FeatureModule = {
  path: 'projects',
  element: ProjectsPage,
  permission: 'projects.read',
  nav: { section: 'projects', namespace: 'projects', labelKey: 'title', order: 1 },
  pages: [
    { path: ':id', element: ProjectPage },
    { path: ':id/versions/:versionId', element: ProjectPage },
  ],
}
