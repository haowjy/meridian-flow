export type ProjectId = string;
export const asProjectId = (s: string) => s as ProjectId;
export type WorkId = string;
export const asWorkId = (s: string) => s as WorkId;
export type ContextSourceId = string;
export const asContextSourceId = (s: string) => s as ContextSourceId;
export type FolderId = string;
export const asFolderId = (s: string) => s as FolderId;
export type DocumentId = string;
export const asDocumentId = (s: string) => s as DocumentId;
/** A `branches` row: one Work branch, the unit Discard all closes (D68). */
export type BranchId = string;
/** One document's pending `work_draft` version inside a branch (D68). */
export type DraftId = string;
/** `${branchId}:${documentId}`: the client's one review identity for a document of a branch (D68). */
export type DraftItemKey = string;

/** The one builder of a draft item key, for text and binary items alike. */
export function draftItemKey(branchId: BranchId, documentId: DocumentId): DraftItemKey {
  return `${branchId}:${documentId}`;
}

/** The branch and document a draft item key names; null when the string is not one. */
export function parseDraftItemKey(
  itemKey: string,
): { branchId: BranchId; documentId: DocumentId } | null {
  const separator = itemKey.indexOf(":");
  if (separator <= 0 || separator === itemKey.length - 1) return null;
  const branchId = itemKey.slice(0, separator);
  const documentId = itemKey.slice(separator + 1) as DocumentId;
  return draftItemKey(branchId, documentId) === itemKey && !documentId.includes(":")
    ? { branchId, documentId }
    : null;
}
/** A client-generated UUID naming one writer Apply or Discard command; resends reuse it. */
export type BranchCommandId = string;
export type ThreadId = string;
export const asThreadId = (s: string) => s as ThreadId;
export type TurnId = string;
export const asTurnId = (s: string) => s as TurnId;
export type PromptBakeId = string;
export const asPromptBakeId = (s: string) => s as PromptBakeId;
export type TurnBlockId = string;
export const asTurnBlockId = (s: string) => s as TurnBlockId;
export type ModelResponseId = string;
export const asModelResponseId = (s: string) => s as ModelResponseId;
export type UserSubscriptionId = string;
export const asUserSubscriptionId = (s: string) => s as UserSubscriptionId;
export type CreditLotId = string;
export const asCreditLotId = (s: string) => s as CreditLotId;
export type CreditTransactionId = string;
export const asCreditTransactionId = (s: string) => s as CreditTransactionId;
export type UserId = string;
export const asUserId = (s: string) => s as UserId;
export type DocumentRestorePointId = string;
export const asDocumentRestorePointId = (s: string) => s as DocumentRestorePointId;
export type TurnDocumentTouchId = string;
export const asTurnDocumentTouchId = (s: string) => s as TurnDocumentTouchId;
export type EventJournalId = string;
export const asEventJournalId = (s: string) => s as EventJournalId;
/** Identity held by one durable document authority head across its fenced generations. */
export type DocumentAuthorityId = string;
export const asDocumentAuthorityId = (s: string) => s as DocumentAuthorityId;
export type DocumentRevision = string;
export const asDocumentRevision = (s: string) => s as DocumentRevision;
