import type { VersionNeeds } from '@/api/generated/model'

export const versionId = '00000000-0000-4000-8000-000000000201'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const dimmable = { id: id(1), key: 'dimmer', name: { en: 'Dimmable light', de: 'Dimmbares Licht' } }
export const blind = { id: id(2), key: 'blind', name: { en: 'Blind', de: 'Jalousie' } }
export const led = { id: id(3), key: 'led', name: { en: 'LED', de: 'LED' } }

/** Ground floor: Living room (3 dimmable lights, 60 W each, LED, plus a blind symbol), a symbol in no zone. */
export const needsSummary: VersionNeeds = {
  plans: [
    {
      planId: id(10),
      name: 'Ground floor',
      zones: [
        {
          zoneId: id(20),
          name: 'Living room',
          needs: [
            { id: id(30), functionType: dimmable, loadType: led, quantity: 3, powerW: 7.5, label: 'Ceiling', note: 'Warm white', symbol: false },
            { id: id(31), functionType: blind, loadType: null, quantity: 1, powerW: null, label: '', note: '', symbol: true },
          ],
          totals: { quantity: 4, powerW: 22.5 },
        },
        {
          zoneId: null,
          name: '',
          needs: [{ id: id(32), functionType: blind, loadType: null, quantity: 2, powerW: null, label: 'Terrace', note: '', symbol: true }],
          totals: { quantity: 2, powerW: 0 },
        },
      ],
      totals: { quantity: 6, powerW: 22.5 },
    },
  ],
  functionTypes: [
    { functionType: blind, totals: { quantity: 3, powerW: 0 } },
    { functionType: dimmable, totals: { quantity: 3, powerW: 22.5 } },
  ],
  loadTypes: [
    { loadType: led, totals: { quantity: 3, powerW: 22.5 } },
    { loadType: null, totals: { quantity: 3, powerW: 0 } },
  ],
  totals: { quantity: 6, powerW: 22.5 },
}

export const emptyNeeds: VersionNeeds = { plans: [], functionTypes: [], loadTypes: [], totals: { quantity: 0, powerW: 0 } }
