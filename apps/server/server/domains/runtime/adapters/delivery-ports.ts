/** Storage ports of the delivery adapter: the inbox, hand-back records and the lease row. Adapter-private; never injected into the model loop or producers. */

import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { HandBackResponse, RunState } from "@meridian/contracts/threads";
import type { InboxMessage, InboxReader, Lease, MessageDraft } from "../loop/ports.js";
import type { HandBackScopeFacts, StopFacts } from "../loop/stop-rule.js";

/** Inbox storage primitives. */
export interface DeliveryStore extends InboxReader {
  setBlockedReason(threadId: ThreadId, reason: "credits_exhausted" | null): Promise<void>;
  /**
   * Records that a write outside this store (the chat's write mode) changed an input of the chat's
   * run-state record, so the transaction publishes a fresh record. Call under the thread lock.
   */
  markRunStateChanged(threadId: ThreadId): void;
  /** Appends the chat's run-state record now, under its lock; returns its stream version (null: none). */
  publishRunState(threadId: ThreadId): Promise<string | null>;
  /** The record a command answers with, under the chat's lock; see `answerRunState`. */
  answerRunState(threadId: ThreadId): Promise<RunState>;
  findMessage(id: string): Promise<InboxMessage | null>;
  workNoticeTargets(workId: WorkId): Promise<ThreadId[]>;
  canMaterializeWork(threadId: ThreadId): Promise<boolean>;
  pendingWorkThreads(limit: number, afterThreadId?: ThreadId): Promise<ThreadId[]>;
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  /**
   * Marks rows delivered once (rows already delivered are untouched). A message
   * row records `byTurnId` as its deliverer. Returns the message rows this call
   * delivered, in `seq` order.
   */
  ack(
    threadId: ThreadId,
    ids: string[],
    byTurnId?: TurnId | null,
    /** Takes writer messages out of the chat instead of delivering them: no deliverer, `handed_back_by` set. */
    options?: { handedBackBy?: string },
  ): Promise<string[]>;
}

/** What a hand-back request decided, stored by request id so a replay answers the same. */
export type StoredHandBack = {
  fingerprint: string;
  handedBack: string[];
  answered: string[];
  gone: string[];
  cancelledExecutionId: string | null;
};

/** Adapter-private storage for hand-back and Stop; every method runs under the chat's thread lock. */
export interface HandBackStore {
  find(threadId: ThreadId, requestId: string): Promise<StoredHandBack | null>;
  /** The lease, its receipt and the writer messages a request's scope could cover (see `StopFacts`). */
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
  /** Sets `cancel_requested` on the lease row of this execution, expiry ignored. */
  cancelExecution(threadId: ThreadId, executionId: string): Promise<boolean>;
  /** The writer's message blocks of these user turns, in the order given. */
  contentOf(
    userTurnIds: readonly string[],
  ): Promise<{ userTurnId: string; blocks: HandBackResponse["handedBack"][number]["blocks"] }[]>;
}

export interface DeliveryLeaseStore {
  cancelThreadReceipt(threadId: ThreadId, turnId: TurnId): Promise<boolean>;
  /** The thread's lease row and its receipt, locked, regardless of holder and expiry. */
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
