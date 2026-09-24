/**
 * Loop ports for the inbox message model: the message vocabulary (intent +
 * provenance + body), the durable `Inbox` queue, the `RunAuthority` lease/lock,
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
  | { kind: "context"; parts: ContextPart[] };

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

export interface Inbox {
  /**
   * Durably appends a message, collapsing a duplicate on `(threadId, idempotencyKey)`.
   * Raw storage: it does not serialize with `closeRun`'s final claim. Producers
   * must go through `ThreadedInbox` (`loop/threaded-inbox.ts`), which holds the
   * per-thread lock around this call so the global `seq` orders commits within a
   * thread and the batch preserves enqueue order. Only the drain and `closeRun`
   * (the consumer side) hold the raw `Inbox`.
   */
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  claimPending(threadId: ThreadId): Promise<InboxMessage[]>;
  /**
   * Read-only view of the undelivered rows, ordered by `seq`. Unlike
   * `claimPending` it has no side effect. Its results are inputs only; writer
   * projection uses the joined lease/adoption snapshot below.
   */
  listPending(threadId: ThreadId): Promise<InboxMessage[]>;
  /** One statement snapshot of raw pending rows and current live-run consumption. */
  readPendingProjection(threadId: ThreadId): Promise<InboxProjection>;
  ack(threadId: ThreadId, ids: string[]): Promise<void>;
  /** Threads with at least one pending undelivered message, oldest first; the wake sweep's input. */
  pendingMessageThreads(limit: number): Promise<ThreadId[]>;
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

export interface RunAuthority {
  acquire(threadId: ThreadId, runId: RunId): Promise<Lease | null>;
  /** Returns `false` when the lease row is gone or owned by another run; the holder has lost it. */
  renew(lease: Lease): Promise<boolean>;
  holder(threadId: ThreadId): Promise<RunId | null>;
  publish(lease: Lease, phase: ThreadPhase): Promise<void>;
  /**
   * Binds the run's assistant turn to the live lease. Run liveness is the lease,
   * and this is the one place its running turn becomes observable to other
   * processes; bind it inside the turn-start setup transaction after the turn
   * and its report admission are projected.
   */
  bindTurn(lease: Lease, turnId: TurnId, messageIds: readonly string[]): Promise<void>;
  /** Replace the exact adopted batch on the live lease's bound assistant. */
  setInboxConsumption(lease: Lease, messageIds: readonly string[]): Promise<boolean>;
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
  /** Sets the live lease's durable cancel flag; idempotent, and the only cross-process cancel channel. */
  cancel(threadId: ThreadId): Promise<void>;
  /**
   * Releases the held lease. Guarded: an already-released or superseded lease is
   * a no-op and must never free a newer run's lock. `closeRun` releases under
   * the thread lock after the terminal write commits; the run owner's `finally`
   * releases again as the cancel/error backstop when the generator throws
   * before reaching `closeRun`. The guard is what makes that double release safe.
   */
  release(lease: Lease): Promise<void>;
}

export interface RunStarter {
  /** Best-effort wake after enqueue; the sweep is the durable guarantee. */
  start(threadId: ThreadId): Promise<void>;
}
