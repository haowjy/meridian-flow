// Supported public surface for the agent editing core.
import { type CreateWriteToolOptions, createWriteTool } from "./tool/write.js";

export type AgentEditCoreOptions = CreateWriteToolOptions;

export interface AgentEditCore {
  write: ReturnType<typeof createWriteTool>["write"];
  recover: ReturnType<typeof createWriteTool>["recover"];
  commitResponse: ReturnType<typeof createWriteTool>["commitResponse"];
  rollbackResponse: ReturnType<typeof createWriteTool>["rollbackResponse"];
  getAvailability: ReturnType<typeof createWriteTool>["getAvailability"];
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
    undoTurn: tool.undoTurn,
    redoTurn: tool.redoTurn,
    invalidateThread: tool.invalidateThread,
  };
}

export { createCodec, requiredBlockNamesForSchema } from "./codec/create-codec.js";
export { markdownCodec } from "./codec/presets/markdown.js";
export { mdxCodec } from "./codec/presets/mdx.js";
export type {
  Block,
  BlockCodec,
  Codec,
  MarkAttrs,
  MarkCodec,
  ParseContext,
  ParsedContent,
  PMNode,
  SerializeContext,
  Span,
} from "./codec/types.js";
export { CodecParseError } from "./codec/types.js";
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
export type { AgentEditModel, DocumentModel } from "./ports/model.js";
export type {
  CompactionResult,
  JournalSnapshot,
  PersistedUpdate,
  ReversalRecord,
  ReversalStatus,
  UpdateMeta,
  UpdateOrigin,
} from "./ports/types.js";
export type {
  ActiveWriteSummary,
  JournalBatchAppendEntry,
  JournalBatchAppendResult,
  UpdateJournal,
  WriteMutationRow,
} from "./ports/update-journal.js";
export { parseWriteHandle, writeHandle } from "./ports/update-journal.js";
export type {
  ComponentRegistry,
  ComponentSpec,
  EditorSpec,
  PropSpec,
} from "./registry/component-registry.js";
export type {
  ResponseCommitDocumentResult,
  ResponseCommitResult,
  ResponseRollbackResult,
  ResponseStagedCreateOutcome,
  TurnRedoResult,
  TurnUndoResult,
  WriteCommand,
  WriteContext,
  WriteErrorStatus,
  WriteFunction,
  WriteOutcome,
  WriteStatus,
} from "./tool/types.js";
export type { UndoAvailability } from "./undo/availability.js";
