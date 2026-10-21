import { type Api, expect, unique, uniqueKey } from './fixtures'

type Id = { id: string }

/** A small board catalog (as apptest.NewBoardCatalog): KNX (bus) and Zigbee (wireless) with capability fields. */
export async function boardCatalog(api: Api) {
  const post = async <T = Id,>(path: string, data: object) => {
    const res = await api.ctx.post(path, { data })
    expect(res.ok(), `${path}: ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }
  const text = (en: string) => ({ en })
  const knx = await post('/api/product-types', { key: uniqueKey('knx'), name: text(unique('KNX')), abbreviation: 'KNX', color: '#0a7d33', isActive: true, topology: 'bus' })
  const zigbee = await post('/api/product-types', { key: uniqueKey('zb'), name: text(unique('Zigbee')), abbreviation: 'ZB', color: '#1f6feb', isActive: true, topology: 'wireless', defaultWirelessPlacesUsed: 1 })
  const fields = [
    ['width', 'number', 'rail_width_te'],
    ['encrows', 'integer', 'enclosure_rows'],
    ['encte', 'number', 'enclosure_te_per_row'],
    ['busma', 'number', 'bus_current_used_ma'],
    ['supply', 'number', 'bus_current_supplied_ma'],
    ['places', 'integer', 'wireless_places_supplied'],
  ].map(([k, type, meaning]) => ({ key: uniqueKey(k), type, meaning }))
  for (const f of fields) await post('/api/catalog-fields', { ...f, label: text(f.key) })
  const attributes = fields.map((f) => ({ key: f.key, label: text(f.key), type: f.type, fieldKey: f.key }))
  const board = await post('/api/categories', { key: uniqueKey('board'), name: text(unique('Board devices')), isActive: true, mounting: 'board', attributes, instanceAttributes: [] })
  const floor = await post('/api/categories', { key: uniqueKey('floor'), name: text(unique('Floor devices')), isActive: true, mounting: 'floorplan', attributes, instanceAttributes: [] })
  const [width, encRows, encTe, busMa, supply, places] = fields.map((f) => f.key)
  const product = async (typeId: string, categoryId: string, name: string, values: Record<string, number>) => {
    const p = await post<Id & { variants: Id[] }>('/api/products', { productTypeId: typeId, categoryId, modelNumber: uniqueKey('m'), name: text(name), isActive: true, attributes: values, firstVariant: { name: text('Std'), price: '10.00' } })
    return { name, variantId: p.variants[0].id }
  }
  return {
    knx,
    zigbee,
    actuator: await product(knx.id, board.id, unique('Switch actuator'), { [width]: 4, [busMa]: 10 }),
    psu: await product(knx.id, board.id, unique('Power supply'), { [width]: 2, [supply]: 640 }),
    enclosure: await product(knx.id, board.id, unique('Enclosure'), { [encRows]: 2, [encTe]: 12 }),
    gateway: await product(zigbee.id, floor.id, unique('Gateway'), { [places]: 50 }),
    bulb: await product(zigbee.id, floor.id, unique('Bulb'), {}),
  }
}

