/**
 * Loop ports for the inbox message model: the message vocabulary (intent +
 * provenance + body), the read-only inbox view, the `RunClaim` lease/lock,
 * and the thin `RunStarter` actuation seam. Domain code depends on these;
 * adapters supply the durable store and the lock. Provider and transport choice
 * stays at the composition root.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  ControlBody,
  CurrentToolCall,
  MessageIntent,
  MessageProvenance,
  ThreadLeaseState,
  ThreadPhase,
  ThreadStatus,
} from "@meridian/contracts/threads";

export type ExecutionId = string;
export type CurrentTurn = { id: TurnId; kind: "assistant" | "compaction" };

/** Lease lifetime; a held lease is renewed at a third of this interval. */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/**
 * `awake` means a live lease exists; `phase` and `cancelRequested` come from the
 * lease row. The shape is the wire contract's `ThreadStatus`, so lease reads and
 * client live state cannot drift.
 */
export type { ThreadPhase, ThreadStatus };

/** A named fragment of model-visible context carried by a `context` body. */
export type ContextPart = { source: string; text: string };

/** The wake hint of a resolved ask: the run it starts continues that ask. */
export type AskResolvedBody = { kind: "ask_resolved"; askId: string };

export type MessageBody =
  | ControlBody
  | AskResolvedBody
  | { kind: "text"; text: string }
  | { kind: "context"; parts: ContextPart[] }
  | { kind: "work_context_refresh" };

export interface MessageDraft {
  threadId: ThreadId;
  intent: MessageIntent;
  provenance: MessageProvenance;
  body: MessageBody;
  idempotencyKey: string;
  /**
   * Producer-supplied durable id. The writer producer sets it to the user turn it
   * persisted at enqueue so the drain reuses the same turn id and skips the
   * re-persist. Controls use their client-minted id; other producers let storage mint one.
   */
  id?: string;
  /**
   * The execution that sends a machine message (a `thread_message`, a child's admission). The
   * enqueue refuses it under the receiver's lock when the fence says so (`RunClaim.wakeRefusal`);
   * it is not stored.
   */
  sender?: { threadId: ThreadId; executionId: ExecutionId };
}

export interface InboxMessage extends Omit<MessageDraft, "sender"> {
  id: string;
  seq: number;
  enqueuedAt: string;
  deliveredAt: string | null;
}

/** Read-only durable queue view. Mutations are owned by RuntimeDelivery. */
export interface InboxReader {
  selectPending(threadId: ThreadId): Promise<InboxMessage[]>;
  readPendingProjection(threadId: ThreadId): Promise<InboxProjection>;
  pendingMessageThreads(limit: number, afterThreadId?: ThreadId): Promise<ThreadId[]>;
}

export type InboxProjection = {
  blocked?: { reason: "credits_exhausted" };
  messages: InboxMessage[];
  run: { turnId: TurnId | null; messageIds: string[] } | null;
};

/** Handle to a held lease; the row's expiry, phase, and cancel flag are server-owned. */
export interface Lease {
  threadId: ThreadId;
  executionId: ExecutionId;
  holderId: string;
}

/** A held thread claim without an observable run lease. */
export interface HeldRunClaim {
  release(): Promise<void>;
  onLost(listener: () => void): () => void;
}

export type WakeRefusal = "sender_stopped" | "receiver_stopped";

export interface RunClaim {
  /** Takes the shared run mutex without publishing a run lease. */
  hold(threadId: ThreadId): Promise<HeldRunClaim | null>;
  /** Short exclusive work uses the same claim without minting an observable lease. */
  withExclusiveThread<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T | null>;
  /**
   * Takes the claim, runs `settle` while holding it (stale-execution settlement
   * must finish before a new execution is published), then inserts the lease
   * row. A settle failure releases the claim and rethrows.
   */
  startExecution(
    threadId: ThreadId,
    executionId: ExecutionId,
    settle: () => Promise<void>,
  ): Promise<Lease | null>;
  /** Returns `false` when the lease row is gone or owned by another run; the holder has lost it. */
  renew(lease: Lease): Promise<boolean>;
  holder(threadId: ThreadId): Promise<ExecutionId | null>;
  publish(lease: Lease, phase: ThreadPhase): Promise<void>;
  /** Updates the live run's current tool; returns false when it did not change. */
  setCurrentTool(lease: Lease, currentTool: CurrentToolCall): Promise<boolean>;
  read(threadId: ThreadId): Promise<ThreadStatus>;
  /**
   * This execution's own lease row whatever its expiry, or null when the row is gone or another
   * execution holds it. Stop cancels an expired lease that is still held, so a caller that must
   * honour a cancel reads here, not through {@link read}, which reports an expired lease as asleep.
   */
  readOwned(lease: Lease): Promise<{ cancelRequested: boolean } | null>;
  /**
   * Batch liveness read for a page of threads, one lease query. Only threads
   * with a live lease appear; the value is the same projection `read` and
   * `readRunningTurnId` derive, so list and snapshot cannot drift.
   */
  readMany(threadIds: readonly ThreadId[]): Promise<Map<ThreadId, ThreadLeaseState>>;
  /**
   * The current turn bound to the live lease (assistant or compaction), or null when the thread is
   * asleep or a run has not yet bound its turn. Derived from the same row as
   * {@link read}, never from the turns table.
   */
  readRunningTurnId(threadId: ThreadId): Promise<TurnId | null>;
  /** Stop the live run that has bound this turn, matching membership under the lease row lock. */
  cancelExecution(threadId: ThreadId, turnId: TurnId): Promise<boolean>;
  /**
   * Flags whatever live run each thread holds as cancelled, in any process: its
   * heartbeat and batch adoption honour the flag. Lineage cancellation's durable half.
   */
  requestCancel(threadIds: readonly ThreadId[]): Promise<void>;
  /** Stamps the machine-wake fence on threads a lineage cancellation stopped (see `wakeRefusal`). */
  fenceWakes(threadIds: readonly ThreadId[]): Promise<void>;
  /**
   * Whether a machine wake one execution sends (a message, a child's admission, a spawn) is
   * refused: `sender_stopped` when that execution no longer holds its lease or was cancelled,
   * `receiver_stopped` when the receiver was fenced after the execution was admitted. Writer
   * actions never ask. Call under the receiver's thread lock, which the fence takes too; the
   * delivery enqueue does, for every draft that names its `sender`.
   */
  wakeRefusal(input: {
    sender: { threadId: ThreadId; executionId: ExecutionId };
    receiver: ThreadId | null;
  }): Promise<WakeRefusal | null>;
  /** See `ThreadStatusReader.readOpenExecutionId`. */
  readOpenExecutionId(threadId: ThreadId): Promise<ExecutionId | null>;
  /** Threads whose lease row expired: stale executions for the repair lane to settle. */
  listExpiredExecutions(limit: number, afterThreadId?: ThreadId): Promise<ThreadId[]>;
  /**
   * The physical half of an execution's end: deletes the owned lease row and
   * unlocks after the surrounding transaction commits. Returns whether a row was
   * deleted. Guarded: an already-released or superseded lease deletes nothing
   * and never frees a newer run's lock, but a still-held claim is unlocked.
   * Only `RuntimeDelivery`'s end protocol calls it.
   */
  release(lease: Lease): Promise<boolean>;
  /**
   * Gives up the claim without ending the execution: its turns are not all
   * terminal. Expires the row now so status reads asleep, then unlocks, even if
   * the expiry write fails; the next claim holder settles the row.
   */
  abandon(lease: Lease): Promise<void>;
}

export interface RunStarter {
  /** Best-effort wake after enqueue; the sweep is the durable guarantee. */
  start(threadId: ThreadId): Promise<void>;
}
