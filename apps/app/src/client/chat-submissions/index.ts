/**
 * Browser owner for the durable chat-submission journal.
 *
 * Reads and writes take an explicit `accountId`; a request for an account that
 * is not the current bind is refused, so a late callback cannot leak a row or
 * retire another account's unresolved intent.
 */
import { composerSessionDraft } from "@/client/composer-drafts";
import { browserSubmissionLock } from "./adapters/browser-lock";
import {
  type ChatCopyOwner,
  type ForgetChatResult,
  forgetCreatedChatCopies,
  reconcileChatCopies,
} from "./forget";
import { chatSubmissionMountState } from "./model";
import {
  type ChatSubmission,
  type ChatSubmissionStorage,
  DeviceChatSubmissionJournal,
} from "./store";
import { probeChatDestination } from "./thread-availability";

export {
  CHAT_SUBMISSIONS_SCHEMA_VERSION,
  CHAT_SUBMISSIONS_STORAGE_PREFIX,
  type ChatSubmission,
  chatSubmissionStorageKey,
} from "./store";
export { isThreadMissingForAccount } from "./thread-availability";

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
  const current = browserJournal();
  if (!current || current.accountId === accountId) return;
  const ready = current.setUser(accountId);
  const owner = copyOwner(accountId);
  // Bind rewrite finishes before the one pass enumerates destinations; mounted
  // owners also get a chance to register while legacy keys are under their locks.
  void ready
    .then(() =>
      reconcileChatCopies(
        owner,
        (threadId) =>
          chatSubmissionMountState(accountId, threadId, getChatSubmissionEpoch()).mounted,
        (threadId, submissionId) => probeChatDestination(accountId, threadId, submissionId),
      ),
    )
    .catch((error) => reportError(error));
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

/** An unavailable read cannot authorize projection retirement or destination changes. */
export function readChatSubmissionSnapshot(accountId: string): ChatSubmission[] | null {
  const current = browserJournal();
  return current?.accountId === accountId ? current.snapshot() : null;
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
  return Boolean(
    threadId &&
      (pendingCreation ||
        readChatSubmissions(accountId).some(
          (entry) => entry.threadId === threadId && entry.creation,
        )),
  );
}

function copyOwner(accountId: string): ChatCopyOwner {
  const epoch = getChatSubmissionEpoch();
  return {
    accountId,
    signal: new AbortController().signal,
    current: () => getChatSubmissionAccountId() === accountId && getChatSubmissionEpoch() === epoch,
    created: (threadId) => !chatSubmissionMountState(accountId, threadId, epoch).creating,
    lock: browserSubmissionLock,
    entries: () => readChatSubmissionSnapshot(accountId),
    retire: (id) => {
      retireChatSubmission(accountId, id, epoch);
    },
    forgetDraft: (threadId) =>
      composerSessionDraft(accountId, { kind: "chat", id: threadId }).forget(),
  };
}

export function forgetCreatedChat(accountId: string, threadId: string): Promise<ForgetChatResult> {
  return forgetCreatedChatCopies(copyOwner(accountId), threadId);
}
