export type ProjectId = string & { readonly __brand: "ProjectId" };
export const asProjectId = (s: string) => s as ProjectId;

export type ContextSourceId = string & { readonly __brand: "ContextSourceId" };
export const asContextSourceId = (s: string) => s as ContextSourceId;

export type FolderId = string & { readonly __brand: "FolderId" };
export const asFolderId = (s: string) => s as FolderId;

export type DocumentId = string & { readonly __brand: "DocumentId" };
export const asDocumentId = (s: string) => s as DocumentId;

export type ThreadId = string & { readonly __brand: "ThreadId" };
export const asThreadId = (s: string) => s as ThreadId;

export type TurnId = string & { readonly __brand: "TurnId" };
export const asTurnId = (s: string) => s as TurnId;

export type TurnBlockId = string & { readonly __brand: "TurnBlockId" };
export const asTurnBlockId = (s: string) => s as TurnBlockId;

export type ModelResponseId = string & { readonly __brand: "ModelResponseId" };
export const asModelResponseId = (s: string) => s as ModelResponseId;

export type AgentDefinitionId = string & { readonly __brand: "AgentDefinitionId" };
export const asAgentDefinitionId = (s: string) => s as AgentDefinitionId;

export type SkillId = string & { readonly __brand: "SkillId" };
export const asSkillId = (s: string) => s as SkillId;

export type UserInstalledSkillId = string & { readonly __brand: "UserInstalledSkillId" };
export const asUserInstalledSkillId = (s: string) => s as UserInstalledSkillId;

export type UserSubscriptionId = string & { readonly __brand: "UserSubscriptionId" };
export const asUserSubscriptionId = (s: string) => s as UserSubscriptionId;

export type CreditLotId = string & { readonly __brand: "CreditLotId" };
export const asCreditLotId = (s: string) => s as CreditLotId;

export type CreditTransactionId = string & { readonly __brand: "CreditTransactionId" };
export const asCreditTransactionId = (s: string) => s as CreditTransactionId;

export type UserId = string & { readonly __brand: "UserId" };
export const asUserId = (s: string) => s as UserId;

export type DocumentRestorePointId = string & { readonly __brand: "DocumentRestorePointId" };
export const asDocumentRestorePointId = (s: string) => s as DocumentRestorePointId;

export type TurnDocumentTouchId = string & { readonly __brand: "TurnDocumentTouchId" };
export const asTurnDocumentTouchId = (s: string) => s as TurnDocumentTouchId;

export type EventJournalId = string & { readonly __brand: "EventJournalId" };
export const asEventJournalId = (s: string) => s as EventJournalId;
