/**
 * Browser owner for the durable chat-submission journal.
 *
 * Reads and writes take an explicit `accountId`; a request for an account that
 * is not the current bind is refused, so a late callback cannot leak a row or
 * retire another account's unresolved intent.
 */
import {
  type ChatSubmission,
  type ChatSubmissionStorage,
  DeviceChatSubmissionJournal,
  type FirstSendChatSubmission,
} from "./store";

export {
  CHAT_SUBMISSIONS_SCHEMA_VERSION,
  CHAT_SUBMISSIONS_STORAGE_PREFIX,
  type ChatSubmission,
  chatSubmissionStorageKey,
  type ExistingThreadChatSubmission,
  type FirstSendChatSubmission,
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

export function readFirstSendSubmission(
  accountId: string,
  threadId: string,
): FirstSendChatSubmission | null {
  return (
    readChatSubmissions(accountId).find(
      (entry): entry is FirstSendChatSubmission =>
        entry.kind === "first-send" && entry.threadId === threadId,
    ) ?? null
  );
}

export function recordChatSubmission(accountId: string, entry: ChatSubmission): boolean {
  return browserJournal()?.record(accountId, entry) ?? false;
}

export function retireChatSubmission(
  accountId: string,
  submissionId: string,
  expectedEpoch?: number,
): boolean {
  return browserJournal()?.retire(accountId, submissionId, expectedEpoch) ?? false;
}
