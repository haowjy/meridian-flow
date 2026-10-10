/**
 * Durable unresolved chat-submission journal.
 *
 * One record per `(accountId, submissionId)`. It stores only the local intent
 * needed to re-issue an idempotent lookup/replay and rebuild one user row: it
 * is not a thread replica and never holds assistant turns. Composer submissions
 * retain their structured snapshot only until ownership returns to authoring or
 * the server acknowledges the message.
 * Canonical history stays in the server admission/turn records.
 */

import type { AgentSelection } from "@meridian/contracts/agents";
import type { SubmittedReference, UserMessageBlock } from "@meridian/contracts/protocol";
import {
  type ComposerDraftSnapshot,
  parseRestorableComposerDraft,
} from "@/components/app/composer/composer-document";

export const CHAT_SUBMISSIONS_SCHEMA_VERSION = 1;
export const CHAT_SUBMISSIONS_STORAGE_PREFIX = "meridian:chat-submissions:v1:";

export type ChatSubmissionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
};

type ChatSubmissionBase = {
  submissionId: string;
  threadId: string;
  projectId: string | null;
  createdAt: string;
  text: string;
  /** With `references`, the exact message payload the composer submitted. */
  blocks: UserMessageBlock[];
  references: SubmittedReference[];
  activatedSkillSlugs: string[];
};

export type ExistingThreadChatSubmission = ChatSubmissionBase & {
  kind: "existing-thread";
  /** Structured authoring ownership while admission is unresolved. Absent for non-composer sends. */
  draft?: ComposerDraftSnapshot;
};

/** Project Home first send. Mirrors the `persistCreation` inputs. */
export type FirstSendChatSubmission = ChatSubmissionBase & {
  kind: "first-send";
  projectId: string;
  title: string;
  workId: string | null;
  agentSelection: AgentSelection;
  agentName: string;
  agentSlug: string;
};

export type ChatSubmission = ExistingThreadChatSubmission | FirstSendChatSubmission;

export function chatSubmissionStorageKey(accountId: string, submissionId: string): string {
  return `${CHAT_SUBMISSIONS_STORAGE_PREFIX}${accountId}:${submissionId}`;
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

function parseCommon(
  value: Record<string, unknown>,
): (ChatSubmissionBase & { kind: string }) | null {
  if (
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
    !isStringArray(value.activatedSkillSlugs)
  ) {
    return null;
  }
  return {
    kind: value.kind as string,
    submissionId: value.submissionId,
    threadId: value.threadId,
    projectId: value.projectId,
    createdAt: value.createdAt,
    text: value.text,
    blocks: value.blocks as UserMessageBlock[],
    references: value.references as SubmittedReference[],
    activatedSkillSlugs: value.activatedSkillSlugs,
  };
}

function parseSubmission(raw: string, accountId: string): ChatSubmission | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (parsed.schemaVersion !== CHAT_SUBMISSIONS_SCHEMA_VERSION || parsed.accountId !== accountId) {
    return null;
  }
  const common = parseCommon(parsed);
  if (!common) return null;
  if (common.kind === "existing-thread") {
    const draft = parseRestorableComposerDraft(parsed.draft);
    return { ...common, kind: "existing-thread", ...(draft ? { draft } : {}) };
  }
  if (common.kind === "first-send") {
    if (
      typeof common.projectId !== "string" ||
      typeof parsed.title !== "string" ||
      (parsed.workId !== null && typeof parsed.workId !== "string") ||
      !isAgentSelection(parsed.agentSelection) ||
      typeof parsed.agentName !== "string" ||
      typeof parsed.agentSlug !== "string"
    ) {
      return null;
    }
    return {
      ...common,
      kind: "first-send",
      projectId: common.projectId,
      title: parsed.title,
      workId: parsed.workId,
      agentSelection: parsed.agentSelection,
      agentName: parsed.agentName,
      agentSlug: parsed.agentSlug,
    };
  }
  return null;
}

export class DeviceChatSubmissionJournal {
  private state: { accountId: string } | null = null;
  /** Session fence: bumped on every account bind. Not a durable revision. */
  private bindEpoch = 0;

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
        const raw = this.storage.getItem(key);
        const parsed = raw ? parseSubmission(raw, accountId) : null;
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

  get(submissionId: string): ChatSubmission | null {
    const accountId = this.state?.accountId;
    if (!accountId) return null;
    try {
      const raw = this.storage.getItem(chatSubmissionStorageKey(accountId, submissionId));
      return raw ? parseSubmission(raw, accountId) : null;
    } catch {
      return null;
    }
  }

  record(accountId: string, entry: ChatSubmission): boolean {
    if (this.state?.accountId !== accountId) return false;
    try {
      this.storage.setItem(
        chatSubmissionStorageKey(accountId, entry.submissionId),
        JSON.stringify({ schemaVersion: CHAT_SUBMISSIONS_SCHEMA_VERSION, accountId, ...entry }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete an entry only for the current bind. `expectedEpoch` fences an
   * A→B→A return: a live send that completes after the account re-bound must
   * not delete the entry the new session still needs to reconcile.
   */
  retire(accountId: string, submissionId: string, expectedEpoch?: number): boolean {
    if (this.state?.accountId !== accountId) return false;
    if (expectedEpoch !== undefined && this.bindEpoch !== expectedEpoch) return false;
    try {
      this.storage.removeItem(chatSubmissionStorageKey(accountId, submissionId));
    } catch {
      // The in-memory boundary already refuses a foreign retire.
    }
    return true;
  }
}
