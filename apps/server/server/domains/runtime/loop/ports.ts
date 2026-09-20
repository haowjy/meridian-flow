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

export type ThreadPhase = "generating" | "waiting";

/** `awake` means a live lease exists; `phase` is what its holder published. */
export type ThreadStatus = { kind: "asleep" } | { kind: "awake"; phase: ThreadPhase };

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
  enqueue(draft: MessageDraft): Promise<InboxMessage>;
  claimPending(threadId: ThreadId, runId: RunId): Promise<InboxMessage[]>;
  ack(threadId: ThreadId, ids: string[], runId: RunId): Promise<void>;
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
  renew(lease: Lease): Promise<void>;
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
