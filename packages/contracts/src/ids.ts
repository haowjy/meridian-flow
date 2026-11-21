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
/**
 * A `drafts` row: one draft, everything pending in it (its suggestion marks in Live documents and
 * its tree records). A Work and a root conversation each name theirs; the draft names no owner.
 */
export type DraftId = string;

const ID_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A fresh draft id: 12 base-36 characters (62 random bits), as a change id. It sits on every
 * changed word in Live history for good, so it is short.
 */
export function newDraftId(): DraftId {
  let id = "";
  for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(12)))
    id += ID_DIGITS[byte % 36];
  return id;
}

const DRAFT_ID = /^[0-9a-z]{12}$/;

/** Whether a string has a draft id's shape. */
export function isDraftId(value: unknown): value is DraftId {
  return typeof value === "string" && DRAFT_ID.test(value);
}
/** `${draftId}:${documentId}`: the client's one review identity for a document of a draft. */
export type DraftItemKey = string;

/** The one builder of a draft item key, for text and binary items alike. */
export function draftItemKey(draftId: DraftId, documentId: DocumentId): DraftItemKey {
  return `${draftId}:${documentId}`;
}

/** The draft and document a draft item key names; null when the string is not one. */
export function parseDraftItemKey(
  itemKey: string,
): { draftId: DraftId; documentId: DocumentId } | null {
  const separator = itemKey.indexOf(":");
  if (separator <= 0 || separator === itemKey.length - 1) return null;
  const draftId = itemKey.slice(0, separator);
  const documentId = itemKey.slice(separator + 1) as DocumentId;
  return draftItemKey(draftId, documentId) === itemKey && !documentId.includes(":")
    ? { draftId, documentId }
    : null;
}
/** A client-generated UUID naming one document command; resends reuse it. */
export type CommandId = string;
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
export type EventJournalId = string;
export const asEventJournalId = (s: string) => s as EventJournalId;
/** Identity of one durable document authority head; a handle bound to another id is retired. */
export type DocumentAuthorityId = string;
export const asDocumentAuthorityId = (s: string) => s as DocumentAuthorityId;
export type DocumentRevision = string;
export const asDocumentRevision = (s: string) => s as DocumentRevision;
