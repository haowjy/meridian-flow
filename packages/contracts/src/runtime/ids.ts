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
  ThreadId,
  TurnBlockId as BlockId,
  TurnBlockId,
  TurnDocumentTouchId,
  TurnId,
  UserId,
  UserInstalledSkillId,
  UserSubscriptionId,
  WorkId,
} from "../ids.js";

export type EventId = string & { readonly __brand: "EventId" };
export type TraceId = string & { readonly __brand: "TraceId" };
export type SpanId = string & { readonly __brand: "SpanId" };
export type ToolRunId = string & { readonly __brand: "ToolRunId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };
