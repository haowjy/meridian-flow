// Port interfaces and shared types for the agent editing core.

export type {
  ApplyEchoHunk,
  ApplyErrorCode,
  ApplyResult,
  ConcurrentEditInfo,
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
