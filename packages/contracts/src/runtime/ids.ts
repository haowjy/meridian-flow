import type { EventJournalId, TurnBlockId } from "../ids.js";

/**
 * Runtime-facing ID names reuse the canonical Meridian brands.
 * These aliases exist only for copied runtime modules whose local vocabulary
 * differs from the database-facing contract names.
 */
export type {
  AgentDefinitionId,
  ContextSourceId,
  CreditLotId,
  CreditTransactionId,
  DocumentId,
  DocumentRestorePointId,
  EventJournalId,
  FolderId,
  ModelResponseId,
  ProjectId,
  SkillId,
  ThreadId,
  TurnBlockId,
  TurnDocumentTouchId,
  TurnId,
  UserId,
  UserInstalledSkillId,
  UserSubscriptionId,
  WorkId,
} from "../ids.js";

export type BlockId = TurnBlockId;
export type EventId = EventJournalId;

export type TraceId = string & { readonly __brand: "TraceId" };
export type SpanId = string & { readonly __brand: "SpanId" };
export type ToolRunId = string & { readonly __brand: "ToolRunId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };
