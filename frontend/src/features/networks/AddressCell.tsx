import { Check, Pencil, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useContext, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AddressInput } from '@/api/generated/model'
import { useSetAddresses } from '@/api/generated/networks/networks'
import { Badge, ErrorMessage, IconButton, Input } from '@/components/ui'

import { AddressesContext, addressValue, useAddressedItem } from './addresses-context'
import { useRefreshNetworks } from './refresh'

/**
 * The Address column of a device: the address with "By hand" / "Automatic",
 * and for writers an inline edit (empty clears). `id="device-<itemId>"` is
 * the target of the Checks tab's address findings.
 */
export function AddressCell({ device, name }: { device: { planId: string; itemId: string }; name: string }) {
  const { t } = useTranslation('networks')
  const { versionId, data, onWrite } = useContext(AddressesContext)
  const item = useAddressedItem(device)
  const save = useSetAddresses()
  const refresh = useRefreshNetworks(versionId)
  const [editing, setEditing] = useState<string | null>(null)
  const canUpdate = !!data?.can.update

  const wrap = (content: ReactNode) => (
    <div id={`device-${device.itemId}`} className="scroll-mt-20 min-w-36 space-y-1">
      {content}
    </div>
  )
  if (!item || item.powerSupply || item.scheme === 'none') return wrap(<span className="text-muted">{t('address.none')}</span>)
  const value = addressValue(item)

  const errorId = `device-${device.itemId}-address-error`
  const submit = async () => {
    if (editing === null) return
    const input: AddressInput = { planId: item.planId, itemId: item.itemId }
    const v = editing.trim()
    // Unchanged: nothing to save (an automatic address would become pinned).
    if (v === value) {
      setEditing(null)
      save.reset()
      return
    }
    if (v !== '') input[item.scheme as 'knx' | 'hdl' | 'ieee'] = v
    if (item.address?.note) input.note = item.address.note
    onWrite?.()
    try {
      await save.mutateAsync({ versionId, data: { addresses: [input] } })
    } catch {
      return // shown by ErrorMessage via save.error
    }
    setEditing(null)
    await refresh()
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditing(null)
      save.reset()
    }
  }

  if (editing !== null)
    return wrap(
      <>
        <div className="flex items-center gap-1">
          <Input
            aria-label={t('address.label', { device: name })}
            value={editing}
            placeholder={t(`address.placeholder.${item.scheme as 'knx' | 'hdl' | 'ieee'}`)}
            aria-invalid={!!save.error}
            aria-describedby={save.error ? errorId : undefined}
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={onKey}
            className="h-8 min-w-28 font-mono"
          />
          <IconButton label={t('address.save')} icon={<Check />} disabled={save.isPending} onClick={() => void submit()} />
          <IconButton
            label={t('address.cancel')}
            icon={<X />}
            onClick={() => {
              setEditing(null)
              save.reset()
            }}
          />
        </div>
        {save.error && <ErrorMessage id={errorId} error={save.error} />}
      </>,
    )

  return wrap(
    // The edit button stays beside the value; value and badge may wrap.
    <span className="flex items-center gap-2">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {value ? <span className="font-mono tabular-nums break-all">{value}</span> : <span className="text-muted">{t('address.none')}</span>}
        {value && (item.address?.pinned ? <Badge variant="primary">{t('address.pinned')}</Badge> : <Badge>{t('address.automatic')}</Badge>)}
      </span>
      {canUpdate && (
        <IconButton
          label={t('address.edit', { device: name })}
          icon={<Pencil />}
          onClick={() => {
            save.reset()
            setEditing(value)
          }}
        />
      )}
    </span>,
  )
}
