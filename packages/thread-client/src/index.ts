/** Platform-neutral client behavior shared by the app and ./mf. */

export { buildMessageDoc } from "./message/build";
export {
  type ChatReferenceScope,
  chatReferenceResolver,
  composerDocFromHandedBack,
  prependMessageDoc,
  type ReferenceFacts,
  type ResolveReference,
} from "./message/hand-back";
export {
  imageCapable,
  referenceOccurrence,
  referenceSpelling,
  skillOccurrence,
} from "./message/occurrences";
export { serializeMessageDoc } from "./message/serialize";
export type {
  BuiltMessageDoc,
  MessageDoc,
  MessageHardBreakNode,
  MessageInlineNode,
  MessageParagraphNode,
  MessageReference,
  MessageReferenceNode,
  MessageSkill,
  MessageSkillNode,
  MessageTextNode,
  RestorableReference,
  SerializedMessage,
  StableReferenceAuthority,
} from "./message/types";
export * from "./run-state";
export type * from "./socket/socket-ports";
export { ThreadSocketClient, type ThreadSocketClientOptions } from "./socket/thread-socket-client";
export type * from "./socket/thread-transport";
export { InMemoryTurnStore, type InMemoryTurnStoreOptions } from "./turns/in-memory-turn-store";
export {
  createTurnReducer,
  isDurableBlockEvent,
  isWellFormedDurableBlockEvent,
  type TurnReducer,
  type TurnReducerOptions,
  type TurnStore,
} from "./turns/reduce-turn-event";
export { baseTurnFields } from "./turns/state-helpers";
export {
  applySnapshotTo,
  createAssistantTurn,
  type EnsureAssistantTurnOptions,
  ensureAssistantTurnIn,
  ensureSwitchTurnIn,
  patchTurnStatusIn,
  removeTurnsIn,
  type SwitchTurnFacts,
  type Tombstones,
  type TurnStatusPatch,
  type TurnsWithTombstones,
  upsertBlockIn,
} from "./turns/turn-ops";
export type { AssistantView, ViewItem, ViewRun } from "./view/assistant-view";
export { isImageBlock, isToolDeliveryBlock } from "./view/block-kind";
export { componentBlockContent } from "./view/component-block-content";
export {
  type DeliverySegment,
  groupDeliverySegments,
  type ToolView,
} from "./view/group-delivery-segments";
export type { DirectInvocationResult } from "./view/invocation-direct-result";
export { isOptimisticTurnId, OPTIMISTIC_TURN_ID_PREFIX } from "./view/optimistic-turn-id";
export { placeStandIns } from "./view/retry-stand-ins";
export { type FoldDigest, foldDigest } from "./view/thinking-digest";
export { threadMessageRow } from "./view/thread-message-result";
export {
  copySourcePath,
  documentToolFailed,
  humanizeSkillSlug,
  skillFile,
  stringInput,
  type ToolCommand,
  toolCommand,
  toolInputObject,
  type WorkReceipt,
  workReceipt,
} from "./view/tool-command";
export { isToolViewVisible } from "./view/tool-view-visibility";
export type {
  DeliveryEvent,
  InheritedMark,
  InheritedTranscript,
  PersistedContractFailure,
  TranscriptRow,
} from "./view/transcript-model";
export { cacheHitPercent, type TurnStats } from "./view/turn-stats";
export {
  type RowIdentity,
  type TranscriptView,
  type TranscriptViewInput,
  type ViewRow,
  viewTranscript,
} from "./view/view-transcript";
export {
  projectWriterText,
  type WriterReferenceOccurrence,
  type WriterSkillOccurrence,
  type WriterText,
} from "./view/writer";
