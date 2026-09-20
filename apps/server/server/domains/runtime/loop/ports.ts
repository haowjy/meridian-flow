/**
 * Loop ports for the notification and steering model: the message vocabulary
 * (intent + provenance + body), the durable `Inbox` queue, the `RunAuthority`
 * lease/lock, and the thin `RunStarter` actuation seam. Domain code depends on
 * these; adapters supply the durable store and the lock. Provider and transport
 * choice stays at the composition root.
 */
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import type { ThreadId } from "@meridian/contracts/runtime";

export type RunId = string;

/** Lease lifetime; a held lease is renewed at a third of this interval. */
export const DEFAULT_LEASE_TTL_MS = 30_000;

export type ThreadPhase = "generating" | "waiting";

/** `awake` means a live lease exists; `phase` and `cancelRequested` come from the lease row. */
export type ThreadStatus =
  | { kind: "asleep" }
  | { kind: "awake"; phase: ThreadPhase; cancelRequested: boolean };

export type MessageIntent = "steer" | "system";

export type MessageProvenance =
  | { kind: "writer"; actorId: string }
  | { kind: "agent"; threadId: ThreadId }
  | { kind: "child"; threadId: ThreadId; reportId: string }
  | { kind: "system"; source: string };

/** A named fragment of model-visible context carried by a `context` body. */
export type ContextPart = { source: string; text: string };

export type MessageBody =
  | { kind: "text"; text: string }
  | { kind: "report"; text: string; artifacts?: ArtifactRef[] }
  | { kind: "context"; parts: ContextPart[] };

export interface MessageDraft {
  threadId: ThreadId;
  intent: MessageIntent;
  provenance: MessageProvenance;
  body: MessageBody;
  idempotencyKey: string;
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
   * The domain `enqueue` serializes per thread (it holds the per-thread lock), so the
   * global `seq` orders commits within a thread and the batch preserves enqueue order.
   */
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  claimPending(threadId: ThreadId): Promise<InboxMessage[]>;
  ack(threadId: ThreadId, ids: string[]): Promise<void>;
  /** Threads with at least one pending undelivered steer, oldest first; the wake sweep's input. */
  pendingSteerThreads(limit: number): Promise<ThreadId[]>;
}

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
  read(threadId: ThreadId): Promise<ThreadStatus>;
  cancel(threadId: ThreadId): Promise<void>;
  release(lease: Lease): Promise<void>;
}

export interface RunStarter {
  /** Best-effort wake after enqueue; the sweep is the durable guarantee. */
  start(threadId: ThreadId): Promise<void>;
}
