// Supported public surface for the agent editing core.
import { type CreateWriteToolOptions, createWriteTool } from "./tool/write.js";
import { type CompactOnLoadResult, compactOnLoad } from "./undo/compaction.js";

export type AgentEditCoreOptions = CreateWriteToolOptions;

export interface AgentEditCore {
  write: ReturnType<typeof createWriteTool>["write"];
  recover: ReturnType<typeof createWriteTool>["recover"];
  compact(docId: string, before: Date): Promise<CompactOnLoadResult>;
}

export function createAgentEditCore(options: AgentEditCoreOptions): AgentEditCore {
  const tool = createWriteTool(options);
  return {
    write: tool.write,
    recover: tool.recover,
    compact: (docId, before) =>
      compactOnLoad(options.journal, { docId, before, registry: tool.registry }),
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
export type { DocumentModel } from "./model/types.js";
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
export type {
  CompactionResult,
  JournalSnapshot,
  PersistedUpdate,
  ReversalRecord,
  ReversalStatus,
  UpdateMeta,
  UpdateOrigin,
} from "./ports/types.js";
export type { UpdateJournal } from "./ports/update-journal.js";
export type {
  ComponentRegistry,
  ComponentSpec,
  EditorSpec,
  PropSpec,
} from "./registry/component-registry.js";
export type {
  CreateCommand,
  InsertCommand,
  RedoCommand,
  ReplaceCommand,
  UndoCommand,
  UndoRedoOutcome,
  ViewCommand,
  ViewFormat,
  WriteCommand,
  WriteContext,
  WriteErrorStatus,
  WriteFunction,
  WriteOutcome,
  WriteStatus,
} from "./tool/types.js";
export type { CompactOnLoadOptions, CompactOnLoadResult } from "./undo/compaction.js";
export { compactOnLoad } from "./undo/compaction.js";
export type {
  ReconstructionOptions,
  UndoReconstructionResult,
} from "./undo/reconstruction.js";
export { reconstructUndoUpdateFromSnapshot } from "./undo/reconstruction.js";
