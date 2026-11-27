import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { HandBackResponse, RunState } from "@meridian/contracts/threads";
import type { InboxMessage, InboxReader, Lease, MessageDraft } from "../ports.js";
import type { HandBackScopeFacts, StopFacts } from "../stop-rule.js";

export interface DeliveryStore extends InboxReader {
  setBlockedReason(threadId: ThreadId, reason: "credits_exhausted" | null): Promise<void>;
  markRunStateChanged(threadId: ThreadId): void;
  publishRunState(threadId: ThreadId): Promise<string | null>;
  answerRunState(threadId: ThreadId): Promise<RunState>;
  findMessage(id: string): Promise<InboxMessage | null>;
  workNoticeTargets(workId: WorkId): Promise<ThreadId[]>;
  canMaterializeWork(threadId: ThreadId): Promise<boolean>;
  pendingWorkThreads(limit: number, afterThreadId?: ThreadId): Promise<ThreadId[]>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  ack(
    threadId: ThreadId,
    ids: string[],
    byTurnId?: TurnId | null,
    options?: { handedBackBy?: string },
  ): Promise<string[]>;
}

export type StoredHandBack = {
  fingerprint: string;
  handedBack: string[];
  answered: string[];
  gone: string[];
  cancelledExecutionId: string | null;
};

export interface HandBackStore {
  find(threadId: ThreadId, requestId: string): Promise<StoredHandBack | null>;
  readFacts(threadId: ThreadId, scope: HandBackScopeFacts): Promise<StopFacts>;
  record(
    threadId: ThreadId,
    requestId: string,
    fingerprint: string,
    decision: {
      handBack: string[];
      answered: string[];
      gone: string[];
      cancelledExecutionId?: string | null;
    },
  ): Promise<void>;
  cancelExecution(threadId: ThreadId, executionId: string): Promise<boolean>;
  contentOf(
    userTurnIds: readonly string[],
  ): Promise<{ userTurnId: string; blocks: HandBackResponse["handedBack"][number]["blocks"] }[]>;
}

export interface DeliveryLeaseStore {
  lockThreadReceipt(
    threadId: ThreadId,
  ): Promise<{ ids: string[]; turnId: TurnId | null; lease: Lease } | null>;
  bindTurn(
    lease: Lease,
    turnId: TurnId,
    ids: readonly string[],
    kind: "assistant" | "compaction",
  ): Promise<void>;
  setAdoptedMessageIds(lease: Lease, ids: readonly string[]): Promise<boolean>;
  clearReceipt(lease: Lease, expectedIds: readonly string[]): Promise<boolean>;
  clearOrphanedReceipt(
    threadId: ThreadId,
    turnId: TurnId,
    expectedIds: readonly string[],
  ): Promise<boolean>;
  lockReceipt(lease: Lease): Promise<{ ids: string[]; cancelRequested: boolean } | null>;
}
