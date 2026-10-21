import type { Rooms } from '@/api/generated/model'

export const projectId = '00000000-0000-4000-8000-000000000200'
export const versionId = '00000000-0000-4000-8000-000000000201'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const dimmable = { id: id(1), key: 'dimmer', name: { en: 'Dimmable light', de: 'Dimmbares Licht' } }
export const blind = { id: id(2), key: 'blind', name: { en: 'Blind', de: 'Jalousie' } }
export const groundId = id(10)
export const upperId = id(11)
export const livingId = id(20)
export const hallId = id(21)

/**
 * Ground floor: Living room (3 dimmable lights 7.5 W, 2 connected; a blind, connected), Hall (no needs), a blind
 * outside every zone (connected); Upper floor without zones.
 */
export const rooms: Rooms = {
  versionId,
  plans: [
    {
      planId: groundId,
      name: 'Ground floor',
      rooms: [
        {
          planId: groundId,
          zoneId: livingId,
          name: 'Living room',
          shortName: 'LR',
          needs: [
            { id: id(30), functionType: dimmable, quantity: 3, powerW: '7.50', label: 'Ceiling', connectedUnits: 2 },
            { id: id(31), functionType: blind, quantity: 1, powerW: null, label: '', connectedUnits: 1 },
          ],
          units: 4,
          connectedUnits: 3,
          status: 'partial',
        },
        { planId: groundId, zoneId: hallId, name: 'Hall', shortName: '', needs: [], units: 0, connectedUnits: 0, status: 'none' },
        {
          planId: groundId,
          zoneId: null,
          name: '',
          shortName: '',
          needs: [{ id: id(32), functionType: blind, quantity: 2, powerW: null, label: 'Terrace', connectedUnits: 2 }],
          units: 2,
          connectedUnits: 2,
          status: 'covered',
        },
      ],
    },
    { planId: upperId, name: 'Upper floor', rooms: [] },
  ],
  totals: { needs: 3, units: 6, connectedUnits: 5, powerW: '22.50' },
  functionTypes: [
    { functionType: blind, counts: { needs: 2, units: 3, connectedUnits: 3, powerW: '0.00' } },
    { functionType: dimmable, counts: { needs: 1, units: 3, connectedUnits: 2, powerW: '22.50' } },
  ],
  can: { update: true },
}

export const noRooms: Rooms = { versionId, plans: [], totals: { needs: 0, units: 0, connectedUnits: 0, powerW: '0.00' }, functionTypes: [], can: { update: true } }
