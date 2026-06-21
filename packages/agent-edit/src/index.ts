// Port interfaces and shared types for the agent editing core.
import { type CreateWriteToolOptions, createWriteTool } from "./tool/write.js";
import { type CompactOnLoadResult, compactOnLoad } from "./undo/compaction.js";

export interface AgentEditCoreOptions extends CreateWriteToolOptions {}

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

export {
  applyConcurrentUpdates,
  computeEcho,
  diffSnapshots,
  snapshotBlocks,
} from "./apply/echo.js";
export { applyEdits } from "./apply/tiers.js";
export type {
  AgentOrigin,
  AppliedEditSummary,
  ApplyEchoHunk,
  ApplyEditsOptions,
  ApplyErrorCode,
  ApplyResult,
  ApplyTier,
  ApplyTransactionOrigin,
  ConcurrentEditInfo,
  ConcurrentUpdate,
  ConcurrentUpdateOrigin,
  EditResolutionErrorCode,
  ResolvedEdit,
  ResolvedSpan,
} from "./apply/types.js";
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
export {
  applyBlockDiff,
  applyTextEdit,
  deleteBlock,
  fragmentOf,
  insertBlocks,
  prosemirrorRootOf,
  toProsemirrorBlock,
  yProsemirrorModel,
} from "./model/y-prosemirror.js";
export type {
  ActorSession,
  ActorSessionDocumentState,
  ActorSessionStore,
} from "./ports/actor-session-store.js";
export type { DocumentCoordinator } from "./ports/document-coordinator.js";
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
export type { BlockHashLookup, BlockItemId } from "./resolver/block-hash.js";
export {
  fullHashForItemId,
  getBlockHash,
  getBlockItemId,
  getTopLevelXmlBlocks,
  isLiveXmlElement,
  lookupBlockHash,
} from "./resolver/block-hash.js";
export type { FindContext, FindMatch, FindResult } from "./resolver/find.js";
export { findTextMatches, serializeBlockBody, serializePmBlockBody } from "./resolver/find.js";
export type {
  ResolveWriteContext,
  ResolveWriteParams,
  ResolveWriteResult,
  WriteCommandName,
} from "./resolver/resolve.js";
export { resolveWrite } from "./resolver/resolve.js";
export type { BlockScope, ScopeContext, ScopeResult } from "./resolver/scope.js";
export {
  AROUND_BLOCK_RADIUS,
  headingLevel,
  isHeading,
  resolveFragment,
  resolveScope,
  resolveSearchScope,
  slugForHeadingText,
} from "./resolver/scope.js";
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
  WriteResult,
  WriteStatus,
} from "./tool/types.js";
export type { CreateWriteToolOptions, WriteTool } from "./tool/write.js";
export { createWriteTool } from "./tool/write.js";
export type { CompactOnLoadOptions, CompactOnLoadResult } from "./undo/compaction.js";
export { compactOnLoad } from "./undo/compaction.js";
export type {
  HotRedoOptions,
  HotRedoResult,
  HotUndoAddress,
  HotUndoResult,
  LiveThreadUndoManager,
  LiveThreadUndoState,
  UndoManagerRegistryOptions,
  UndoStackMetadata,
} from "./undo/manager-registry.js";
export { createUndoManagerRegistry, UndoManagerRegistry } from "./undo/manager-registry.js";
export type {
  ReconstructionOptions,
  RedoEligibility,
  RedoReconstructionResult,
  TurnUpdateGroup,
  UndoReconstructionResult,
} from "./undo/reconstruction.js";
export {
  evaluateRedoEligibility,
  groupUpdatesByTurn,
  reconstructRedoUpdate,
  reconstructRedoUpdateFromSnapshot,
  reconstructUndoUpdate,
  reconstructUndoUpdateFromSnapshot,
} from "./undo/reconstruction.js";
