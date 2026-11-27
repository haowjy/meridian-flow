import { isDraftId, newDraftId } from "@meridian/contracts";
import type { AgentSelection } from "@meridian/contracts/agents";
import {
  readRunState,
  type SubmittedReference,
  type UserMessageBlock,
} from "@meridian/contracts/protocol";
import {
  NO_OVERRIDES,
  type RunState,
  type ThreadOverrides,
  threadOverridesSchema,
} from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { Occurrence } from "@meridian/thread-client";
import { browserRecord } from "@/client/storage/browser-record";
import {
  type ComposerDraftSnapshot,
  parseRestorableComposerDraft,
} from "@/components/app/composer/composer-document";

export const CHAT_SUBMISSIONS_SCHEMA_VERSION = 3;
export const CHAT_SUBMISSIONS_STORAGE_PREFIX = "meridian:chat-submissions:v3:";
/** Per-chat `seq` counters. Outside the record prefix, so enumerating records never sees them. */
export const CHAT_SUBMISSION_SEQ_PREFIX = "meridian:chat-submission-seq:v1:";

export type ChatSubmissionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
};

export type ControlAnswer = {
  runState: RunState;
  at: number;
};

export const ANSWER_GRACE_MS = 60_000;

export type ChatSubmission = {
  recordId: string;
  submissionId: string;
  occurrence?: Occurrence;
  threadId: string;
  projectId: string | null;
  createdAt: string;
  seq: number;
  text: string;
  blocks: UserMessageBlock[];
  references: SubmittedReference[];
  activatedSkillSlugs: string[];
  state?: "rejected";
  control?: { kind: "write_mode"; mode: AiWriteMode };
  answer?: ControlAnswer;
  posted?: true;
  draft?: ComposerDraftSnapshot;
  creation?: {
    title: string;
    draftId: string;
    workId: string | null;
    workAiWriteMode: AiWriteMode;
    aiWriteMode?: AiWriteMode;
    overrides: ThreadOverrides;
    agentSelection: AgentSelection;
    agentName: string;
    agentSlug: string;
  };
};

export type NewChatSubmission = Omit<ChatSubmission, "seq"> & { seq?: number };

export function compareSubmissions(a: ChatSubmission, b: ChatSubmission): number {
  return a.seq - b.seq || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);
}

export function chatSubmissionSeqKey(accountId: string, threadId: string): string {
  return `${CHAT_SUBMISSION_SEQ_PREFIX}${accountId}:${threadId}`;
}

export function chatSubmissionStorageKey(accountId: string, recordId: string): string {
  return `${CHAT_SUBMISSIONS_STORAGE_PREFIX}${accountId}:${recordId}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseAnswer(value: unknown): ControlAnswer | undefined {
  if (!isObject(value) || typeof value.at !== "number") return undefined;
  const runState = readRunState(value.runState);
  return runState ? { runState, at: value.at } : undefined;
}

function isAiWriteMode(value: unknown): value is AiWriteMode {
  return value === "direct" || value === "draft";
}

function isAgentSelection(value: unknown): value is AgentSelection {
  return (
    isObject(value) &&
    typeof value.slug === "string" &&
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
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.blocks) ||
    !value.blocks.every(isObject) ||
    !Array.isArray(value.references) ||
    !value.references.every(isObject) ||
    !isStringArray(value.activatedSkillSlugs) ||
    (value.state !== undefined && value.state !== "rejected") ||
    (value.posted !== undefined && value.posted !== true) ||
    (value.answer !== undefined && !parseAnswer(value.answer))
  )
    return null;
  const control = value.control;
  if (
    control !== undefined &&
    (!isObject(control) || control.kind !== "write_mode" || !isAiWriteMode(control.mode))
  )
    return null;
  const creation = value.creation;
  if (
    creation !== undefined &&
    (!isObject(creation) ||
      typeof value.projectId !== "string" ||
      typeof creation.title !== "string" ||
      (creation.workId !== null && typeof creation.workId !== "string") ||
      !isAiWriteMode(creation.workAiWriteMode) ||
      (creation.aiWriteMode !== undefined && !isAiWriteMode(creation.aiWriteMode)) ||
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
    seq: value.seq,
    text: value.text,
    blocks: value.blocks as UserMessageBlock[],
    references: value.references as SubmittedReference[],
    activatedSkillSlugs: value.activatedSkillSlugs,
    ...(isObject(value.occurrence) &&
    typeof value.occurrence.requestId === "string" &&
    Number.isSafeInteger(value.occurrence.attempt) &&
    Number(value.occurrence.attempt) > 0
      ? {
          occurrence: {
            requestId: value.occurrence.requestId,
            attempt: Number(value.occurrence.attempt),
          },
        }
      : {}),
    ...(value.state === "rejected" ? { state: "rejected" } : {}),
    ...(control ? { control: { kind: "write_mode", mode: control.mode as AiWriteMode } } : {}),
    ...(value.answer ? { answer: parseAnswer(value.answer) } : {}),
    ...(value.posted ? { posted: true as const } : {}),
    ...(draft ? { draft } : {}),
    ...(creation
      ? {
          creation: {
            ...(creation as Omit<NonNullable<ChatSubmission["creation"]>, "overrides">),
            // A record an older build stored has no draft id: the chat it creates gets one now.
            draftId: isDraftId(creation.draftId) ? creation.draftId : newDraftId(),
            // A record from before the pair was one field parses to no overrides.
            overrides: threadOverridesSchema.safeParse(creation.overrides).data ?? NO_OVERRIDES,
          },
        }
      : {}),
  };
}

export class DeviceChatSubmissionJournal {
  private state: { accountId: string } | null = null;
  private bindEpoch = 0;
  private lastKnown: ChatSubmission[] = [];
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
    this.state = { accountId };
    this.lastKnown = [];
    this.notify();
  }

  entries(): ChatSubmission[] {
    return this.snapshot() ?? this.lastKnown;
  }

  snapshot(): ChatSubmission[] | null {
    const accountId = this.state?.accountId;
    if (!accountId) return [];
    const prefix = `${CHAT_SUBMISSIONS_STORAGE_PREFIX}${accountId}:`;
    const found: ChatSubmission[] = [];
    try {
      for (let index = 0; index < this.storage.length; index += 1) {
        const key = this.storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        let failed = false;
        const parsed = this.recordFor(accountId, key, () => {
          failed = true;
        }).read();
        if (failed) return null;
        if (parsed) found.push(parsed);
      }
    } catch {
      return null;
    }
    this.lastKnown = found;
    return found;
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

  record(accountId: string, entry: NewChatSubmission): boolean {
    if (this.state?.accountId !== accountId) return false;
    const stored = this.recordFor(accountId, chatSubmissionStorageKey(accountId, entry.recordId));
    const existing = stored.read();
    const seq = existing?.seq ?? this.nextSeq(accountId, entry.threadId);
    const occurrence = entry.occurrence ??
      existing?.occurrence ?? { requestId: entry.submissionId, attempt: 1 };
    const written = stored.write({ ...entry, seq, occurrence });
    if (written) this.pruneAnswered(accountId);
    if (written) this.notify();
    return written;
  }

  private pruneAnswered(accountId: string): void {
    const now = Date.now();
    for (const other of this.entries())
      if (other.answer && now - other.answer.at > ANSWER_GRACE_MS)
        this.recordFor(accountId, chatSubmissionStorageKey(accountId, other.recordId)).write(
          undefined,
        );
  }

  private nextSeq(accountId: string, threadId: string): number {
    const key = chatSubmissionSeqKey(accountId, threadId);
    let counter = 0;
    try {
      const stored = Number(this.storage.getItem(key));
      if (Number.isSafeInteger(stored) && stored > 0) counter = stored;
    } catch {
      /* An unreadable counter falls back to the held records. */
    }
    const held = this.entries()
      .filter((other) => other.threadId === threadId)
      .reduce((largest, other) => Math.max(largest, other.seq), 0);
    const seq = Math.max(counter, held) + 1;
    try {
      this.storage.setItem(key, String(seq));
    } catch {
      /* Best effort: the held records still order this append. */
    }
    return seq;
  }

  forgetOrder(accountId: string, threadId: string): void {
    if (this.state?.accountId !== accountId) return;
    try {
      this.storage.removeItem(chatSubmissionSeqKey(accountId, threadId));
    } catch {
      /* Best effort. */
    }
  }

  private recordFor(accountId: string, key: string, onError?: (error: unknown) => void) {
    return browserRecord(
      () => this.storage,
      { key, version: CHAT_SUBMISSIONS_SCHEMA_VERSION, accountId },
      (value) => parseSubmission(value) ?? undefined,
      onError,
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

export function submissionReplayChanged(before: string | null, after: string | null): boolean {
  const scheduling = (raw: string | null) => {
    if (raw === null) return null;
    try {
      const value = parseSubmission(JSON.parse(raw)?.payload);
      if (!value) return null;
      const { occurrence: _occurrence, ...command } = value;
      return JSON.stringify(command);
    } catch {
      return null;
    }
  };
  return scheduling(before) !== scheduling(after);
}
