// Port interfaces and shared types for the agent editing core.

export { createCodec } from "./codec/create-codec.js";
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
export type { DocumentModel } from "./model/types.js";
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
