// Checks (step 3d): the version's checks tab, connect picker, auto-connect, and the shared wiring model the
// floorplan editor, board editor and Networks tab show connections and statuses with.
export { ConnectDialog, type ConnectTarget } from './ConnectDialog'
export { boardStatus, type FindingNames, statusTone, useFindingText, useReasonText } from './format'
export { StatusChip } from './StatusChip'
export { channelKey, type ChannelRef, itemKey, needKey, useRefreshWiring, useWiringModel, type WiringModel } from './wiring'
export { ChecksTab } from './ChecksTab'
export { findingPlanId, findingsOf } from './findings'
export { FindingsList } from './FindingsList'
