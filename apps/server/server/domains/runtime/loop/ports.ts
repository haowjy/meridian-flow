/**
 * Loop ports for the inbox message model: the message vocabulary (intent +
 * provenance + body), the read-only inbox view, the `RunClaim` lease/lock,
 * and the thin `RunStarter` actuation seam. Domain code depends on these;
 * adapters supply the durable store and the lock. Provider and transport choice
 * stays at the composition root.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  MessageIntent,
  MessageProvenance,
  ThreadLeaseState,
  ThreadPhase,
  ThreadStatus,
} from "@meridian/contracts/threads";

export type RunId = string;

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

export type MessageBody =
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
   * re-persist; every other producer lets storage mint one.
   */
  id?: string;
}

export interface InboxMessage extends MessageDraft {
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
  messages: InboxMessage[];
  run: { turnId: TurnId | null; messageIds: string[] } | null;
};

/** Handle to a held lease; the row's expiry, phase, and cancel flag are server-owned. */
export interface Lease {
  threadId: ThreadId;
  runId: RunId;
  holderId: string;
}

export interface RunClaim {
  /** Short exclusive work uses the same claim without minting an observable lease. */
  withExclusiveThread<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T | null>;
  startExecution(threadId: ThreadId, runId: RunId): Promise<Lease | null>;
  /** Returns `false` when the lease row is gone or owned by another run; the holder has lost it. */
  renew(lease: Lease): Promise<boolean>;
  holder(threadId: ThreadId): Promise<RunId | null>;
  publish(lease: Lease, phase: ThreadPhase): Promise<void>;
  read(threadId: ThreadId): Promise<ThreadStatus>;
  /**
   * Batch liveness read for a page of threads, one lease query. Only threads
   * with a live lease appear; the value is the same projection `read` and
   * `readRunningTurnId` derive, so list and snapshot cannot drift.
   */
  readMany(threadIds: readonly ThreadId[]): Promise<Map<ThreadId, ThreadLeaseState>>;
  /**
   * The assistant turn bound to the live lease, or null when the thread is
   * asleep or a run has not yet bound its turn. Derived from the same row as
   * {@link read}, never from the turns table.
   */
  readRunningTurnId(threadId: ThreadId): Promise<TurnId | null>;
  /** Cancels only the live lease bound to this turn; false means no matching execution. */
  cancelExecution(threadId: ThreadId, turnId: TurnId): Promise<boolean>;
  /**
   * Releases the held lease. Guarded: an already-released or superseded lease is
   * a no-op and must never free a newer run's lock. Delivery close releases under
   * the thread lock after the terminal write commits; the run owner's `finally`
   * releases again as the cancel/error backstop when execution fails
   * before delivery close. The guard is what makes that double release safe.
   */
  release(lease: Lease): Promise<void>;
}

export interface RunStarter {
  /** Best-effort wake after enqueue; the sweep is the durable guarantee. */
  start(threadId: ThreadId): Promise<void>;
}
