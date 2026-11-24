// Explicit composition and low-level integration surface for agent-edit hosts.
export { overwriteWithAssigned } from "./apply/overwrite.js";
export { EDIT_FAILED_MESSAGE } from "./apply/types.js";
export type { AgentEditCodec, AgentEditCodecFactory } from "./codec-adapter.js";
export { createAgentEditCodecFactory } from "./codec-adapter.js";
export type { Block, Span } from "./codec-types.js";
export type { DocumentAddress, ParseDocumentAddressResult } from "./document-address.js";
export { formatDocumentFile, parseDocumentAddress } from "./document-address.js";
export type {
  FrontierLookup,
  FrontierLookups,
  ObservationFrontier,
  ReplyMutations,
  ShownBlock,
} from "./frontier.js";
export { createReplyMutations, encodeFrontierMap } from "./frontier.js";
export * from "./index.js";
export type { AssignInput, AssignResult } from "./links/assign-refs.js";
export { assignLinkRefs, assignOccurrences } from "./links/assign-refs.js";
export type { ShownLink } from "./links/correspondence.js";
export type { OccurrenceAttrs } from "./links/occurrences.js";
export { rebuildOccurrences, sameAttrs } from "./links/occurrences.js";
export type { LinkShowing } from "./links/shown.js";
export {
  type DocumentModel,
  type LoroBlock,
  LoroDocument,
  loroModel,
} from "./model/loro-model.js";
export type {
  DocumentEditRequest,
  DocumentEditResult,
  DocumentEdits,
  ModelInverseCommand,
} from "./ports/document-edits.js";
export type {
  AheadMint,
  DocumentLinksPort,
  LinkPrepareRequest,
} from "./ports/document-links.js";
export type {
  AgentWriteRecord,
  DocumentCut,
} from "./ports/document-rooms.js";
export {
  type AgentEditRooms,
  type AgentEditRoomsHost,
  type AgentRoomRead,
  agentEditRooms,
  DocumentNotFoundError,
  isDocumentNotFoundError,
} from "./ports/document-rooms.js";
export {
  createStaticDocumentLinks,
  type StaticDocumentCatalog,
} from "./ports/static-document-links.js";
export type { WriteOrdinals } from "./ports/write-ordinals.js";
export { editHandle, parseEditHandle } from "./ports/write-ordinals.js";
export { captureDelta, readDelta, type StoredDelta } from "./tool/delta.js";
export {
  createEditCore,
  type EditCore,
  type EditCoreOptions,
} from "./tool/edit-core.js";
export { returnedWriteResult } from "./tool/receipt.js";
export type { LinkSpliceFallbackDetail, ObservationFailedDetail } from "./tool/types.js";
export { type RoomPart, undoInRooms } from "./undo-in-rooms.js";
