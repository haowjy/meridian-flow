/**
 * Durable unresolved chat-submission journal.
 *
 * One record per `(accountId, recordId)`. It stores only the local intent
 * needed to re-issue an idempotent lookup/replay and rebuild one user row: it
 * is not a thread replica and never holds assistant turns. Composer submissions
 * retain their structured snapshot only until ownership returns to authoring or
 * the server acknowledges the message.
 * Canonical history stays in the server admission/turn records.
 */

import type { AgentSelection } from "@meridian/contracts/agents";
import type { SubmittedReference, UserMessageBlock } from "@meridian/contracts/protocol";
import { browserRecord } from "@/client/storage/browser-record";
import {
  type ComposerDraftSnapshot,
  parseRestorableComposerDraft,
} from "@/components/app/composer/composer-document";

export const CHAT_SUBMISSIONS_SCHEMA_VERSION = 2;
export const CHAT_SUBMISSIONS_STORAGE_PREFIX = "meridian:chat-submissions:v2:";

export type ChatSubmissionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
};

export type ChatSubmission = {
  recordId: string;
  submissionId: string;
  threadId: string;
  projectId: string | null;
  createdAt: string;
  text: string;
  blocks: UserMessageBlock[];
  references: SubmittedReference[];
  activatedSkillSlugs: string[];
  state?: "rejected";
  draft?: ComposerDraftSnapshot;
  creation?: {
    title: string;
    workId: string | null;
    agentSelection: AgentSelection;
    agentName: string;
    agentSlug: string;
  };
};

export function chatSubmissionStorageKey(accountId: string, recordId: string): string {
  return `${CHAT_SUBMISSIONS_STORAGE_PREFIX}${accountId}:${recordId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isAgentSelection(value: unknown): value is AgentSelection {
  return (
    isObject(value) &&
    typeof value.catalogEntryId === "string" &&
    typeof value.definitionRevisionId === "string"
  );
}

function parseSubmission(value: unknown): ChatSubmission | null {
  if (!isObject(value)) return null;
  if (
    typeof value.recordId !== "string" ||
    !value.recordId ||
    typeof value.submissionId !== "string" ||
    !value.submissionId ||
    typeof value.threadId !== "string" ||
    !value.threadId ||
    (value.projectId !== null && typeof value.projectId !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.text !== "string" ||
    !Array.isArray(value.blocks) ||
    !value.blocks.every(isObject) ||
    !Array.isArray(value.references) ||
    !value.references.every(isObject) ||
    !isStringArray(value.activatedSkillSlugs) ||
    (value.state !== undefined && value.state !== "rejected")
  )
    return null;
  const creation = value.creation;
  if (
    creation !== undefined &&
    (!isObject(creation) ||
      typeof value.projectId !== "string" ||
      typeof creation.title !== "string" ||
      (creation.workId !== null && typeof creation.workId !== "string") ||
      !isAgentSelection(creation.agentSelection) ||
      typeof creation.agentName !== "string" ||
      typeof creation.agentSlug !== "string")
  )
    return null;
  const draft = parseRestorableComposerDraft(value.draft);
  return {
    recordId: value.recordId,
    submissionId: value.submissionId,
    threadId: value.threadId,
    projectId: value.projectId,
    createdAt: value.createdAt,
    text: value.text,
    blocks: value.blocks as UserMessageBlock[],
    references: value.references as SubmittedReference[],
    activatedSkillSlugs: value.activatedSkillSlugs,
    ...(value.state === "rejected" ? { state: "rejected" } : {}),
    ...(draft ? { draft } : {}),
    ...(creation ? { creation: creation as ChatSubmission["creation"] } : {}),
  };
}

/** Remove after the first production deploy shipping v2 has been live for a release. */
function rewriteV1ChatSubmissions(storage: ChatSubmissionStorage, accountId: string): void {
  const prefix = `meridian:chat-submissions:v1:${accountId}:`;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (!key?.startsWith(prefix)) continue;
      const old = browserRecord(
        () => storage,
        { key, version: 1, accountId },
        (value) => {
          if (!isObject(value) || !["first-send", "existing-thread"].includes(String(value.kind)))
            return undefined;
          return (
            parseSubmission({
              ...value,
              recordId: value.submissionId,
              creation:
                value.kind === "first-send"
                  ? {
                      title: value.title,
                      workId: value.workId,
                      agentSelection: value.agentSelection,
                      agentName: value.agentName,
                      agentSlug: value.agentSlug,
                    }
                  : undefined,
            }) ?? undefined
          );
        },
      );
      const entry = old.read();
      if (!entry) continue;
      const target = browserRecord(
        () => storage,
        {
          key: chatSubmissionStorageKey(accountId, entry.recordId),
          version: CHAT_SUBMISSIONS_SCHEMA_VERSION,
          accountId,
        },
        (value) => parseSubmission(value) ?? undefined,
      );
      // A crash after the v2 write must not overwrite a subsequently re-minted record.
      if (target.read() || target.write(entry)) old.write(undefined);
    }
  } catch {
    /* Preserve v1 when storage is unavailable. */
  }
}

export class DeviceChatSubmissionJournal {
  private state: { accountId: string } | null = null;
  /** Session fence: bumped on every account bind. Not a durable revision. */
  private bindEpoch = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  notifyStorageChange(key: string | null): void {
    if (key === null || key.startsWith(`${CHAT_SUBMISSIONS_STORAGE_PREFIX}${this.accountId}:`)) {
      this.notify();
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        reportError(error);
      }
    }
  }

  constructor(private readonly storage: ChatSubmissionStorage) {}

  get accountId(): string | null {
    return this.state?.accountId ?? null;
  }

  get epoch(): number {
    return this.bindEpoch;
  }

  setUser(accountId: string): void {
    if (this.state?.accountId === accountId) return;
    this.bindEpoch += 1;
    // Per-account storage keys mean another account's records are never read
    // or removed here; they remain for that account's next bind.
    this.state = { accountId };
    rewriteV1ChatSubmissions(this.storage, accountId);
    this.notify();
  }

  entries(): ChatSubmission[] {
    const accountId = this.state?.accountId;
    if (!accountId) return [];
    const prefix = `${CHAT_SUBMISSIONS_STORAGE_PREFIX}${accountId}:`;
    const found: ChatSubmission[] = [];
    try {
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const parsed = this.recordFor(accountId, key).read();
        if (parsed) found.push(parsed);
      }
    } catch {
      return [];
    }
    return found;
  }

  forThread(threadId: string): ChatSubmission[] {
    return this.entries().filter((entry) => entry.threadId === threadId);
  }

  get(recordId: string): ChatSubmission | null {
    const accountId = this.state?.accountId;
    if (!accountId) return null;
    try {
      return (
        this.recordFor(accountId, chatSubmissionStorageKey(accountId, recordId)).read() ?? null
      );
    } catch {
      return null;
    }
  }

  record(accountId: string, entry: ChatSubmission): boolean {
    if (this.state?.accountId !== accountId) return false;
    const written = this.recordFor(
      accountId,
      chatSubmissionStorageKey(accountId, entry.recordId),
    ).write(entry);
    if (written) this.notify();
    return written;
  }

  private recordFor(accountId: string, key: string) {
    return browserRecord(
      () => this.storage,
      { key, version: CHAT_SUBMISSIONS_SCHEMA_VERSION, accountId },
      (value) => parseSubmission(value) ?? undefined,
    );
  }

  /**
   * Delete an entry only for the current bind. `expectedEpoch` fences an
   * A→B→A return: a live send that completes after the account re-bound must
   * not delete the entry the new session still needs to reconcile.
   */
  retire(accountId: string, recordId: string, expectedEpoch?: number): boolean {
    if (this.state?.accountId !== accountId) return false;
    if (expectedEpoch !== undefined && this.bindEpoch !== expectedEpoch) return false;
    const retired = this.recordFor(accountId, chatSubmissionStorageKey(accountId, recordId)).write(
      undefined,
    );
    if (retired) this.notify();
    return retired;
  }
}
