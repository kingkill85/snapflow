import { createContext, useContext } from 'react'

import type { AddressedItem, Addresses, LinePrefix } from '@/api/generated/model'

/**
 * The version's device addresses (step 3e, D419); undefined while loading.
 * onWrite is called before an address is saved (the tab drops its notice
 * about the last auto-assign).
 */
export const AddressesContext = createContext<{ versionId: string; data: Addresses | undefined; onWrite?: () => void }>({
  versionId: '',
  data: undefined,
})

const key = (i: { planId: string; itemId: string }) => `${i.planId}:${i.itemId}`

/** The addressed item of a device, if the API lists it. */
export function useAddressedItem(item: { planId: string; itemId: string }): AddressedItem | undefined {
  const { data } = useContext(AddressesContext)
  return data?.items.find((i) => key(i) === key(item))
}

/** The address prefix of a bus line (KNX area.line, HDL subnet). */
export function useLinePrefix(lineId: string): LinePrefix | undefined {
  return useContext(AddressesContext).data?.lines.find((l) => l.busLineId === lineId)
}

/** The value of an item's address in its scheme ("1.1.5", "1.12", IEEE). */
export function addressValue(item: AddressedItem): string {
  const a = item.address
  if (!a) return ''
  if (item.scheme === 'knx') return a.knx ?? ''
  if (item.scheme === 'hdl') return a.hdl ?? ''
  if (item.scheme === 'ieee') return a.ieee ?? ''
  return ''
}
