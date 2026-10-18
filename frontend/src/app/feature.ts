import type { ComponentType } from 'react'

import type { resources } from '@/i18n/resources'

type Namespace = keyof (typeof resources)['en']

/** What a feature contributes to the app shell. */
export type FeatureModule = {
  /** Route path below the app root, e.g. "catalog/function-types". */
  path: string
  element: ComponentType
  /** Omit to keep the route out of the navigation. */
  nav?: { section: 'catalog' | 'projects' | 'admin'; namespace: Namespace; labelKey: string }
}
