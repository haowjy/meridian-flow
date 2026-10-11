/**
 * Browser owner for the durable chat-submission journal.
 *
 * Reads and writes take an explicit `accountId`; a request for an account that
 * is not the current bind is refused, so a late callback cannot leak a row or
 * retire another account's unresolved intent.
 */
import { composerSessionDraft } from "@/client/composer-drafts";
import {
  type ChatSubmission,
  type ChatSubmissionStorage,
  DeviceChatSubmissionJournal,
} from "./store";

export {
  CHAT_SUBMISSIONS_SCHEMA_VERSION,
  CHAT_SUBMISSIONS_STORAGE_PREFIX,
  type ChatSubmission,
  chatSubmissionStorageKey,
} from "./store";

let journal: DeviceChatSubmissionJournal | null = null;

function browserStorage(): ChatSubmissionStorage {
  return window.localStorage;
}

function browserJournal(): DeviceChatSubmissionJournal | null {
  if (typeof window === "undefined") return null;
  if (!journal) {
    try {
      journal = new DeviceChatSubmissionJournal(browserStorage());
      window.addEventListener("storage", (event) => {
        if (event.storageArea === window.localStorage) journal?.notifyStorageChange(event.key);
      });
    } catch {
      return null;
    }
  }
  return journal;
}

export function bindChatSubmissions(accountId: string): void {
  browserJournal()?.setUser(accountId);
}

export function getChatSubmissionAccountId(): string | null {
  return browserJournal()?.accountId ?? null;
}

export function getChatSubmissionEpoch(): number {
  return browserJournal()?.epoch ?? 0;
}

export function readChatSubmissions(accountId: string): ChatSubmission[] {
  const current = browserJournal();
  if (!current || current.accountId !== accountId) return [];
  return current.entries();
}

export function readChatSubmission(accountId: string, submissionId: string): ChatSubmission | null {
  const current = browserJournal();
  return current?.accountId === accountId
    ? (current.entries().find((entry) => entry.submissionId === submissionId) ?? null)
    : null;
}

/** A rejected witness is durable, but no longer awaits admission lookup or replay. */
export function readUnresolvedSubmission(
  accountId: string,
  submissionId: string,
): ChatSubmission | null {
  const entry = readChatSubmission(accountId, submissionId);
  return entry?.state === "rejected" ? null : entry;
}

export function readFirstSendSubmission(
  accountId: string,
  threadId: string,
): ChatSubmission | null {
  return (
    readChatSubmissions(accountId).find(
      (entry) => Boolean(entry.creation) && entry.threadId === threadId,
    ) ?? null
  );
}

export function recordChatSubmission(accountId: string, entry: ChatSubmission): boolean {
  return browserJournal()?.record(accountId, entry) ?? false;
}

export function retireChatSubmission(
  accountId: string,
  recordId: string,
  expectedEpoch?: number,
): boolean {
  return browserJournal()?.retire(accountId, recordId, expectedEpoch) ?? false;
}

/** One settlement owner, independent of mounted panes. Transfer words before retiring the witness. */
export function settleChatSubmission(
  accountId: string,
  submissionId: string,
  outcome: "accepted" | "rejected",
  expectedEpoch: number,
): boolean {
  const current = browserJournal();
  if (!current || current.accountId !== accountId || current.epoch !== expectedEpoch) return false;
  const entry = current.entries().find((entry) => entry.submissionId === submissionId) ?? null;
  if (!entry) return false;
  if (!entry.creation) {
    const owner = composerSessionDraft(accountId, { kind: "chat", id: entry.threadId });
    if (outcome === "rejected") {
      if (!entry.draft || !owner.restoreRejected(entry.draft))
        return current.record(accountId, { ...entry, state: "rejected" });
    } else if (entry.draft && !owner.acceptSubmitted()) return false;
  }
  return current.retire(accountId, entry.recordId, expectedEpoch);
}

/** In-tab writes and cross-tab storage changes share the same subscription. */
export function subscribeChatSubmissions(listener: () => void): () => void {
  return browserJournal()?.subscribe(listener) ?? (() => undefined);
}

/** Provider-scoped pending flags also cover fork and handoff destinations. */
export function isThreadAwaitingCreation(
  accountId: string,
  threadId: string | null | undefined,
  pendingCreation = false,
): boolean {
  return Boolean(threadId && (pendingCreation || readFirstSendSubmission(accountId, threadId)));
}
