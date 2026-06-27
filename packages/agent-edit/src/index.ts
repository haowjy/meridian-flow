// Supported public surface for the agent editing core.
import { type CreateWriteToolOptions, createWriteTool } from "./tool/write.js";

export type AgentEditCoreOptions = CreateWriteToolOptions;

export interface AgentEditCore {
  write: ReturnType<typeof createWriteTool>["write"];
  recover: ReturnType<typeof createWriteTool>["recover"];
  commitResponse: ReturnType<typeof createWriteTool>["commitResponse"];
  rollbackResponse: ReturnType<typeof createWriteTool>["rollbackResponse"];
  getAvailability: ReturnType<typeof createWriteTool>["getAvailability"];
  undo: ReturnType<typeof createWriteTool>["undo"];
  redo: ReturnType<typeof createWriteTool>["redo"];
  reverse: ReturnType<typeof createWriteTool>["reverse"];
  undoTurn: ReturnType<typeof createWriteTool>["undoTurn"];
  redoTurn: ReturnType<typeof createWriteTool>["redoTurn"];
  invalidateThread: ReturnType<typeof createWriteTool>["invalidateThread"];
}

export function createAgentEditCore(options: AgentEditCoreOptions): AgentEditCore {
  const tool = createWriteTool(options);
  return {
    write: tool.write,
    recover: tool.recover,
    commitResponse: tool.commitResponse,
    rollbackResponse: tool.rollbackResponse,
    getAvailability: tool.getAvailability,
    undo: tool.undo,
    redo: tool.redo,
    reverse: tool.reverse,
    undoTurn: tool.undoTurn,
    redoTurn: tool.redoTurn,
    invalidateThread: tool.invalidateThread,
  };
}

export type { ConcurrentEditInfo } from "./apply/types.js";
export type { AgentEditCodec } from "./codec-adapter.js";
export { createAgentEditCodec } from "./codec-adapter.js";
export type { Block, Span } from "./codec-types.js";
export type { DocumentAddress, ParseDocumentAddressResult } from "./document-address.js";
export { formatDocumentFile, parseDocumentAddress, splitDocumentFile } from "./document-address.js";
export type { YProsemirrorDocumentModel } from "./model/y-prosemirror.js";
export { fragmentOf, yProsemirrorModel } from "./model/y-prosemirror.js";
export type {
  ActorSession,
  ActorSessionDocumentState,
  ActorSessionStore,
} from "./ports/actor-session-store.js";
export type { DocumentCoordinator } from "./ports/document-coordinator.js";
export {
  DocumentNotFoundError,
  isDocumentNotFoundError,
} from "./ports/document-coordinator.js";
export type { DocumentLifecycle } from "./ports/document-lifecycle.js";
export type { AgentEditModel, BlockLookup, DocumentModel, TextRun } from "./ports/model.js";
export type { SyncState, SyncStateStore } from "./ports/sync-state-store.js";
export type {
  CompactionResult,
  JournalSnapshot,
  PersistedUpdate,
  ReversalActor,
  ReversalRecord,
  ReversalStatus,
  UpdateMeta,
  UpdateOrigin,
} from "./ports/types.js";
export type {
  ActiveWriteSummary,
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  JournalReadOptions,
  ReversalStore,
  UpdateJournal,
  WriteMutationRow,
} from "./ports/update-journal.js";
export { parseWriteHandle, writeHandle } from "./ports/update-journal.js";
export type {
  RedoResult,
  ResponseCommitDocumentResult,
  ResponseCommitResult,
  ResponseRollbackResult,
  ResponseStagedCreateOutcome,
  TurnRedoResult,
  TurnUndoResult,
  UndoResult,
  WriteCommand,
  WriteContext,
  WriteErrorStatus,
  WriteFunction,
  WriteOutcome,
  WriteResultBlock,
  WriteStatus,
} from "./tool/types.js";
export type { ReverseInput } from "./tool/write.js";
export type { UndoAvailability } from "./undo/availability.js";
export type { ReversalSelection } from "./undo/reversal-plan.js";
