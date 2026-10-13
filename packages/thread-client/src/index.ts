/** Platform-neutral client behavior shared by the app and ./mf. */

export { buildMessageDoc } from "./message/build";
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
  SerializedMessage,
} from "./message/types";
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
  createAssistantTurn,
  type EnsureAssistantTurnOptions,
  ensureAssistantTurnIn,
  patchTurnStatusIn,
  type TurnStatusPatch,
  upsertBlockIn,
} from "./turns/turn-ops";
export type { AssistantView, ViewItem, ViewRun } from "./view/assistant-view";
export { isImageBlock, isToolDeliveryBlock } from "./view/block-kind";
export type { CardSummary } from "./view/card-summary";
export { componentBlockContent } from "./view/component-block-content";
export {
  type DeliverySegment,
  groupDeliverySegments,
  type ToolView,
} from "./view/group-delivery-segments";
export type { DirectInvocationResult } from "./view/invocation-direct-result";
export { isOptimisticTurnId, OPTIMISTIC_TURN_ID_PREFIX } from "./view/optimistic-turn-id";
export { queuedWriterTurnIds } from "./view/pending-writer-turns";
export { placeStandIns } from "./view/retry-stand-ins";
export type { FoldDigest } from "./view/thinking-digest";
export { threadMessageRow } from "./view/thread-message-result";
export {
  copySourcePath,
  humanizeSkillSlug,
  skillFile,
  stringInput,
  type ToolCommand,
  toolCommand,
  toolInputObject,
  type WorkReceipt,
  type WriteMode,
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
