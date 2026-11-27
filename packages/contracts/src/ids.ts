export type ProjectId = string;
export type WorkId = string;
export type ContextSourceId = string;
export type FolderId = string;
export type DocumentId = string;
export type DraftId = string;

const ID_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newDraftId(): DraftId {
  let id = "";
  for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(12)))
    id += ID_DIGITS[byte % 36];
  return id;
}

const DRAFT_ID = /^[0-9a-z]{12}$/;

export function isDraftId(value: unknown): value is DraftId {
  return typeof value === "string" && DRAFT_ID.test(value);
}
export type DraftItemKey = string;

export function draftItemKey(draftId: DraftId, documentId: DocumentId): DraftItemKey {
  return `${draftId}:${documentId}`;
}

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
export type CommandId = string;
export type ThreadId = string;
export type TurnId = string;
export type PromptBakeId = string;
export type TurnBlockId = string;
export type ModelResponseId = string;
export type UserSubscriptionId = string;
export type CreditLotId = string;
export type CreditTransactionId = string;
export type UserId = string;
export type DocumentRestorePointId = string;
export type EventJournalId = string;
