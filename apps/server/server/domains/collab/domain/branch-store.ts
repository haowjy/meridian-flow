/**
 * The branch storage contract: a branch is a checkpoint plus a journal tail, fenced by
 * `revision`. The row and content types, the store port every adapter implements, and the
 * materialization of one read. The coordinator and the storage adapters both build on this.
 */

import type { SemanticEditIRV1 } from "@meridian/agent-edit/integration";
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { DocumentSchemaMajorMismatchError, isStaleSchema } from "./stale-schema.js";

export type BranchKind = "work_draft" | "thread_peer";
export type BranchStatus = "active" | "closed";

/** The branch's origin Work as the row was read: archived, deleted or missing freeze it. */
export type BranchWorkLifecycle = "active" | "archived" | "deleted" | "missing";

/** A branch row without its content: the content is read only through `readBranchAt`. */
export type BranchSnapshot = {
  branchId: string;
  documentId: DocumentId;
  kind: BranchKind;
  upstreamBranchId: string | null;
  /** The draft this branch belongs to; a thread peer carries its upstream's. */
  draftId: DraftId;
  /** Derived: the draft's origin Work (`drafts.origin_work_id`), null when it has none. */
  workId: WorkId | null;
  threadId: ThreadId | null;
  status: BranchStatus;
  /** The re-fork epoch: room name, journal grouping, edit placement. A reset bumps it. */
  generation: number;
  /** Bumped by every committed write to the branch; the write fence. */
  revision: number;
  /** The revision the checkpoint was written at. */
  checkpointRevision: number;
  /** The highest journal id the checkpoint contains; the tail is every later row. */
  checkpointSeq: number;
  /** Derived from the origin Work as read, never stored: anything but `active` is frozen. */
  lifecycle: BranchWorkLifecycle;
  hasEffect: boolean;
  blocking: boolean;
  discardedStateVector?: Uint8Array | null;
  schemaVersion: CollabSchemaVersion;
};

/** A journal row past the checkpoint, applied on read. */
export type BranchTailRow = { id: number; update: Uint8Array; source: "agent" | "writer" };

/**
 * One point-in-time read of a branch: its row, its checkpoint and its tail, from one statement.
 * `checkpoint` is null when the read was asked `since` a checkpoint it still has: `tail` then
 * holds only the rows after that cursor.
 */
export type BranchRead = {
  branch: BranchSnapshot;
  checkpoint: { state: Uint8Array; stateVector: Uint8Array } | null;
  tail: readonly BranchTailRow[];
};

/** A cursor a warm replica already holds, so a read ships only what came after it. */
export type BranchReadSince = { checkpointRevision: number; seq: number };

export type AppendBranchJournalInput = {
  /** One logical tool write, shared by its segment rows. */
  documentEditKey?: string;
  branchId: string;
  generation: number;
  /** Rejects a staged reversal if branch history advanced after planning. */
  expectedJournalWatermark?: number;
  /** Rejects status-only Apply/discard/redo transitions after planning. */
  expectedJournalRevision?: string;
  updateData: Uint8Array;
  source: "agent" | "writer";
  wId?: number | null;
  toolCallId?: string | null;
  threadId?: ThreadId | null;
  turnId?: string | null;
  actorUserId?: string | null;
  updateMeta?: unknown;
  semanticEditIr?: SemanticEditIRV1;
};

/** Journal rows appended past the checkpoint, fenced by the revision they were judged at. */
export type AppendRowsInput = {
  branchId: string;
  expectedRevision: number;
  expectedGeneration: number;
  rows: readonly AppendBranchJournalInput[];
  /** The committed branch state the rows apply to, for their edit receipts. */
  receiptBase: Uint8Array;
};

export type AppendRowsOutcome =
  | { status: "appended"; revision: number; rowIds: readonly number[] }
  | { status: "moved" };

/**
 * What else a rewrite must not race: a pull is fenced by a pending settlement on its
 * document; a settlement's own reset is not; Discard and close fence on neither.
 */
export type RewriteFence =
  | { kind: "pending-settlement" }
  | { kind: "settlement-owned"; batchId: string }
  | { kind: "none" };

/**
 * `exact` commits only at the revision the rewrite was computed at; `fold` commits over any
 * appends since its checkpoint cursor (a pull applies them, a reset discards them).
 */
export type RewritePolicy =
  | { kind: "exact"; revision: number }
  | { kind: "fold"; checkpointRevision: number; seq: number };

export type RewriteOperation =
  /**
   * A long tail folded into the checkpoint: the content, the effect and the modification stamp
   * stay. Nothing schedules it in phase 1a; its trigger lands with the inverse's attempt contract.
   */
  | { kind: "compact" }
  /** Live (or the upstream) merged into the branch; `liveCut` is the work draft's new baseline. */
  | { kind: "pull"; liveCut?: Uint8Array }
  /** A content rewrite under the Work lock, with the rows it contains when it has any. */
  | {
      kind: "checkpoint";
      rows?: readonly AppendBranchJournalInput[];
      receiptBase?: Uint8Array;
    }
  /** A re-fork: the next generation, the tail discarded with its clocks fenced. */
  | {
      kind: "reset";
      editDisposition: "discarded" | "retired";
      schemaVersion: CollabSchemaVersion;
    };

export type CommitRewriteInput = {
  branchId: string;
  policy: RewritePolicy;
  fence: RewriteFence;
  /** The peer's upstream as captured: locked `FOR SHARE` and checked before the peer row. */
  upstream?: { branchId: string; generation: number };
  /** The rewritten checkpoint. A `fold` pull applies the tail into it. */
  doc: Y.Doc;
  operation: RewriteOperation;
};

export type RewriteOutcome =
  | {
      status: "committed";
      revision: number;
      checkpointRevision: number;
      seq: number;
      generation: number;
    }
  | { status: "moved" | "fenced" | "closed" | "upstreamMoved" };

export type BranchStore = {
  /** The row only; content comes through `readBranchAt`. */
  getBranch(branchId: string): Promise<BranchSnapshot | null>;
  readBranchAt(branchId: string, since?: BranchReadSince): Promise<BranchRead | null>;
  appendRows(input: AppendRowsInput): Promise<AppendRowsOutcome>;
  commitRewrite(input: CommitRewriteInput): Promise<RewriteOutcome>;
  /** Defers cache-visible effects when persistence joined a response transaction. */
  deferUntilCommit(callback: () => void): boolean;
};

export class BranchStaleUpdateError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} update did not apply to the current generation`);
    this.name = "BranchStaleUpdateError";
  }
}

export class BranchCasConflictError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} changed before its snapshot could be persisted`);
    this.name = "BranchCasConflictError";
  }
}

/** A load named a branch whose rows are gone (a last-use Discard deleted them). */
export class BranchMissingError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} does not exist`);
    this.name = "BranchMissingError";
  }
}

export function assertReadableBranch(
  snapshot: Pick<BranchSnapshot, "documentId" | "schemaVersion">,
): void {
  if (isStaleSchema(snapshot.schemaVersion, COLLAB_SCHEMA_VERSION)) {
    throw new DocumentSchemaMajorMismatchError(
      snapshot.documentId,
      snapshot.schemaVersion,
      COLLAB_SCHEMA_VERSION,
    );
  }
}

/** The branch's content at the read: its checkpoint, then its tail rows in id order. */
export function materializeBranchRead(
  read: BranchRead,
  doc: Y.Doc = createCollabYDoc({ gc: false }),
): Y.Doc {
  if (!read.checkpoint)
    throw new Error("A branch read since a checkpoint cannot materialize alone");
  try {
    Y.applyUpdate(doc, read.checkpoint.state);
    for (const row of read.tail) Y.applyUpdate(doc, row.update);
    return doc;
  } catch (cause) {
    doc.destroy();
    throw cause;
  }
}

/** The read's state vector without materializing: the checkpoint's, advanced by each tail row. */
export function branchReadStateVector(read: BranchRead): Uint8Array {
  if (!read.checkpoint) throw new Error("A branch read since a checkpoint has no state vector");
  let vector = read.checkpoint.stateVector;
  for (const row of read.tail) {
    const to = Y.parseUpdateMeta(row.update).to;
    if (to.size) vector = mergeStateVectors(vector, Y.encodeStateVector(to));
  }
  return vector;
}

export function mergeStateVectors(
  left: Uint8Array | null | undefined,
  right: Uint8Array,
): Uint8Array {
  if (!left) return right;
  const merged = new Map(Y.decodeStateVector(left));
  for (const [client, clock] of Y.decodeStateVector(right)) {
    merged.set(client, Math.max(merged.get(client) ?? 0, clock));
  }
  return Y.encodeStateVector(new Map(merged));
}
