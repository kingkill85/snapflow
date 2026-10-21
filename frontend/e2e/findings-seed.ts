import { type Api, expect, unique, uniqueKey } from './fixtures'
import { wiringSeed } from './wiring-seed'

type Id = { id: string }
type Module = { id: string; variantId: string; rowId: string; offsetTe: number; label: string; existing: boolean; addonVariantIds: string[]; instanceValues: object }

// The step 4b-3 project (one problem list, D453, D454): the wiring seed plus, on the floorplan, a presence sensor
// and a wall switch with a cover plate add-on and a light need without power connected to the dimmer (power
// unknown); on the board a module without a rail width (info) and a wide actuator at the row's end. `breakIt`
// then breaks the catalog: the sensor's variant and the cover plate go inactive, the wide actuator grows past
// the row (row overflow).
export async function findingsSeed(api: Api) {
  const s = await wiringSeed(api)
  const post = async <T = Id,>(path: string, data: object) => {
    const res = await api.ctx.post(path, { data })
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const text = (en: string) => ({ en })
  const floorCat = await post('/api/categories', { key: uniqueKey('floor'), name: text(unique('Room devices')), isActive: true, mounting: 'floorplan', attributes: [], instanceAttributes: [] })
  const product = async (categoryId: string, name: string, attributes: Record<string, number> = {}) => {
    const p = await post<Id & { variants: Id[] }>('/api/products', { productTypeId: s.knx.id, categoryId, modelNumber: uniqueKey('m'), name: text(name), isActive: true, attributes, firstVariant: { name: text('Std'), price: '20.00' } })
    return { id: p.id, name, variantId: p.variants[0].id }
  }
  const sensor = await product(floorCat.id, unique('Presence sensor'))
  const wallSwitch = await product(floorCat.id, unique('Wall switch'))
  const cover = await product(floorCat.id, unique('Cover plate'))
  await api.replaceAddons(wallSwitch.id, wallSwitch.variantId, [{ addonVariantId: cover.variantId }])
  const noWidth = await product(s.category.id, unique('Bus coupler'))
  const wide = await product(s.category.id, unique('Wide actuator'), { [s.f.width.key]: 4, [s.f.busMa.key]: 10 })

  // The dimmer gets a minimum load per channel, so a need without power cannot be checked (power unknown).
  const minW = uniqueKey('minw')
  await post('/api/catalog-fields', { key: minW, label: text(minW), type: 'number', meaning: 'channel_min_load_w', outputKindId: s.dimmerKind.id })
  const cat = await api.category(s.category.id)
  await api.updateCategory(s.category.id, { attributes: [...cat.attributes, { key: minW, label: text(minW), type: 'number', fieldKey: minW }] as never })
  await api.updateProduct(s.dimmer.id, { attributes: { ...s.dimmer.attrs, [minW]: 5 } })
  s.dimmer.attrs = { ...s.dimmer.attrs, [minW]: 5 } as typeof s.dimmer.attrs

  const pendant = crypto.randomUUID()
  await api.savePlanContent(s.floor.id, {
    zones: [s.kitchen, s.living],
    placements: [
      { variantId: sensor.variantId, x: 220, y: 200, label: 'B1' },
      { variantId: wallSwitch.variantId, x: 380, y: 200, label: 'S1', addonVariantIds: [cover.variantId] },
    ],
    needs: [
      { zoneId: s.kitchen.id, functionTypeId: s.light.id, quantity: 3, powerW: '7.00', label: 'Spots', x: 220, y: 380 },
      { zoneId: s.kitchen.id, functionTypeId: s.blind.id, quantity: 2, label: 'Windows' },
      { zoneId: s.living.id, functionTypeId: s.light.id, quantity: 1, powerW: '40.00', label: 'Ceiling' },
      { id: pendant, zoneId: s.living.id, functionTypeId: s.light.id, quantity: 1, label: 'Pendant' },
    ],
  })

  // The board: a bus coupler without rail width and the wide actuator at the row's end.
  await post(`/api/plans/${s.board.id}/lock`, {})
  const content = (await (await api.ctx.get(`/api/plans/${s.board.id}/board`)).json()) as { contentUpdatedAt: string; rows: { id: string; capacityTe: number }[]; modules: Module[] }
  const row = content.rows[0].id
  const mod = (variantId: string, offsetTe: number, label: string): Module => ({ id: crypto.randomUUID(), variantId, rowId: row, offsetTe, label, existing: false, addonVariantIds: [], instanceValues: {} })
  const res = await api.ctx.put(`/api/plans/${s.board.id}/board`, {
    data: {
      expectedContentUpdatedAt: content.contentUpdatedAt,
      enclosureVariantId: null,
      rows: [{ id: row, capacityTe: 24 }],
      modules: [...content.modules.map(({ id, variantId, rowId, offsetTe, label, existing, addonVariantIds, instanceValues }) => ({ id, variantId, rowId, offsetTe, label, existing, addonVariantIds, instanceValues })), mod(noWidth.variantId, 14, 'K1'), mod(wide.variantId, 20, 'W1')],
    },
  })
  expect(res.ok(), await res.text()).toBe(true)
  await api.ctx.delete(`/api/plans/${s.board.id}/lock`)
  const d1 = content.modules.find((m) => m.label === 'D1')!
  await post(`/api/versions/${s.versionId}/connections`, { needPlanId: s.floor.id, needId: pendant, units: 1, targetPlanId: s.board.id, targetItemId: d1.id, outputKindId: s.dimmerKind.id, channelNo: 1 })

  const setVariantActive = async (productId: string, active: boolean) => {
    const p = await api.product(productId)
    const v = p.variants[0]
    const r = await api.ctx.put(`/api/products/${productId}/variants/${v.id}`, {
      data: { name: v.name, sku: v.sku, imageFileId: v.imageFileId, attributes: v.attributes, isActive: active, price: v.price, expectedUpdatedAt: v.updatedAt },
    })
    expect(r.ok(), await r.text()).toBe(true)
  }
  const breakIt = async () => {
    await setVariantActive(sensor.id, false)
    await api.updateProduct(cover.id, { isActive: false })
    await api.updateProduct(wide.id, { attributes: { [s.f.width.key]: 6, [s.f.busMa.key]: 10 } })
  }
  return { ...s, sensor, wallSwitch, cover, noWidth, wide, setVariantActive, breakIt }
}
