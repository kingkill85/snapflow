import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Project } from '@/api/generated/model'
import { useCan } from '@/app/session'
import { Button, EmptyState, TextLink } from '@/components/ui'
import { listPath as catalogPath } from '@/features/products/paths'
import { ProjectFormDialog } from '@/features/projects/ProjectFormDialog'

/**
 * The palette without products, with the next step (D448): no systems ticked → "Choose systems" (the project's edit
 * dialog, systems focused; only who may update the project), else no active product of the systems goes on this plan
 * kind → "Open the catalog" (catalog.read).
 */
export function PaletteEmpty({ project, kind }: { project: Project; kind: 'floorplan' | 'board' }) {
  const { t } = useTranslation('plans')
  const can = useCan()
  const [editOpen, setEditOpen] = useState(false)

  if (project.productTypeIds.length === 0)
    return (
      <>
        <EmptyState
          compact
          title={t('palette.noSystems')}
          action={
            project.can.update && (
              <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
                {t('palette.chooseSystems')}
              </Button>
            )
          }
        />
        <ProjectFormDialog open={editOpen} onOpenChange={setEditOpen} item={project} focusSystems />
      </>
    )
  return (
    <EmptyState
      compact
      title={t(kind === 'board' ? 'palette.noneOnBoard' : 'palette.noneOnFloorplan')}
      action={can('catalog.read') && <TextLink to={catalogPath}>{t('palette.openCatalog')}</TextLink>}
    />
  )
}
