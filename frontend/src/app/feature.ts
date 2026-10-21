import type { ComponentType } from 'react'

import type { Permission } from '@/api/generated/model'
import type { resources } from '@/i18n/resources'

type Namespace = keyof (typeof resources)['en']

/** What a feature contributes to the app shell. */
export type FeatureModule = {
  /** Route path below the app root, e.g. "catalog/function-types". */
  path: string
  element: ComponentType
  /** Needed to see the page and its navigation entry. Omit for every logged-in user. */
  permission?: Permission
  /**
   * Omit to keep the route out of the navigation. `section` groups the entry
   * (projects, catalog, setup, admin; D97, D442); `order` sorts within it (lower first,
   * unset last, ties in the order of the features list).
   */
  nav?: { section: 'catalog' | 'projects' | 'setup' | 'admin'; namespace: Namespace; labelKey: string; order?: number }
  /** Further pages below `path`, e.g. "new" and ":id" of an editor; they need `permission` plus their own. */
  pages?: { path: string; element: ComponentType; permission?: Permission }[]
}
