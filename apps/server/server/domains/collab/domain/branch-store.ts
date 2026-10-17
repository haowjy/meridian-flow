/**
 * The branch storage contract: a branch is a checkpoint plus a journal tail, fenced by
 * `revision`. The row and content types, the store port every adapter implements, and the
 * materialization of one read. The coordinator and the storage adapters both build on this.
 */

import type { CapturedPart, SemanticEditIRV1 } from "@meridian/agent-edit/integration";
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
  /**
   * The branch has active or rollback-pending rows of its generation: with `hasEffect` and
   * `blocking`, the inputs of its review membership.
   */
  pendingRows: boolean;
  /** A work draft's effect baseline (`live_cut`) is stored. */
  liveCutStored: boolean;
};

/**
 * The Work an append of rows judged to `hasEffect` must lock first and touch: the one whose
 * review membership (`(has_effect OR blocking) AND` pending rows) the append flips.
 */
export function membershipFlipWork(
  read: { branch: BranchSnapshot; pendingRows: boolean },
  hasEffect: boolean,
): WorkId | undefined {
  const { branch } = read;
  const member = (effect: boolean, rows: boolean) => (effect || branch.blocking) && rows;
  const flips = member(branch.hasEffect, read.pendingRows) !== member(hasEffect, true);
  return flips && branch.workId ? branch.workId : undefined;
}

/** A work draft's effect baseline: the live state its `has_effect` is measured against. */
export type EffectBaseline = {
  state: Uint8Array;
  /** Read from `live_cut` at this checkpoint revision; otherwise built from the live journal. */
  stored: boolean;
  checkpointRevision: number;
};

/** One logical write's edit receipts, computed on the candidate before the append commits. */
export type AppendReceiptGroup = {
  /** The rows of the write, by index into `AppendRowsInput.rows`. */
  rowIndexes: readonly number[];
  parts: readonly CapturedPart[];
};

/** A cursor a warm replica already holds, so a read ships only what came after it. */
export type BranchReadSince = { checkpointRevision: number; seq: number };

export type AppendBranchJournalInput = {
  /** One logical tool write, shared by its segment rows. */
  documentEditKey?: string;
  branchId: string;
  generation: number;
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

/**
 * Journal rows appended past the checkpoint, fenced by the revision they were judged at.
 * Everything that depends on content (receipts, the effect) was computed on the candidate
 * before the append; the store only writes it.
 */
export type AppendRowsInput = {
  branchId: string;
  documentId: DocumentId;
  expectedRevision: number;
  expectedGeneration: number;
  rows: readonly AppendBranchJournalInput[];
  receipts: readonly AppendReceiptGroup[];
  /** A work draft's `has_effect` on the candidate; a thread peer carries none. */
  hasEffect?: boolean;
  /** The baseline the effect was measured against, stored when the branch had none. */
  liveCut?: Uint8Array;
  /**
   * The branch's Work when the append flips its review membership: the Work row is locked
   * before the branch row and the Work's projection touched in the same transaction.
   */
  workTouch?: WorkId;
};

export type AppendRowsOutcome =
  | { status: "appended"; revision: number; rowIds: readonly number[] }
  | { status: "moved" };

/**
 * What else a rewrite must not race: a pull is fenced by an unfinished settlement on its
 * document (`fenced` while it is pending, `blocked` once it is terminally blocked); a
 * settlement's own reset is not; Discard and close fence on neither.
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
   * stay. The coordinator schedules it once a committed writer frame leaves the tail past its
   * bound (decision D10).
   */
  | { kind: "compact" }
  /**
   * Live (or the upstream) merged into the branch. A work draft's `effect` was computed on the
   * candidate against `liveCut`, its new baseline, before the rewrite locked anything.
   */
  | { kind: "pull"; effect?: PullEffect }
  /** A content rewrite the branch's Work must admit: a thread peer catching up its upstream. */
  | { kind: "checkpoint" }
  /** A re-fork: the next generation, the tail discarded with its clocks fenced. */
  | {
      kind: "reset";
      editDisposition: "discarded" | "retired";
      schemaVersion: CollabSchemaVersion;
    };

/**
 * A pull's effect against its new baseline, judged on the candidate. When a `fold` applies
 * rows the candidate lacked, the checkpoint is no longer the candidate: `refolded` judges the
 * folded checkpoint instead, under the row lock, and only then (frames rarely land inside a
 * pull's short commit window).
 */
export type PullEffect = {
  hasEffect: boolean;
  liveCut: Uint8Array;
  refolded?(doc: Y.Doc): boolean;
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
  /**
   * Whether the branch's Work must be active (decision D19): a pull, a peer's catch-up and a
   * peer's containment reset move content into a draft, which an archived Work freezes; they
   * are refused `inactive`. `any` names an operation the freeze exempts: a settlement's reset
   * completing a batch staged before the archive (decision D1's settlement fence), Discard and
   * purge (lifecycle operations themselves), and compaction (content-free).
   */
  work: "active" | "any";
};

export type RewriteOutcome =
  | {
      status: "committed";
      revision: number;
      checkpointRevision: number;
      seq: number;
      generation: number;
    }
  /** `inactive`: a `work: "active"` rewrite whose Work is archived, deleted or gone (D19). */
  | { status: "moved" | "fenced" | "blocked" | "closed" | "upstreamMoved" | "inactive" };

export type BranchStore = {
  /** The row only; content comes through `readBranchAt`. */
  getBranch(branchId: string): Promise<BranchSnapshot | null>;
  readBranchAt(branchId: string, since?: BranchReadSince): Promise<BranchRead | null>;
  /** A work draft's effect baseline; null for a branch that carries no effect. */
  readEffectBaseline(branchId: string): Promise<EffectBaseline | null>;
  appendRows(input: AppendRowsInput): Promise<AppendRowsOutcome>;
  /**
   * A frame's last attempt: `run` inside one transaction holding the branch's Work row
   * (`FOR NO KEY UPDATE`) and then its branch row (`FOR UPDATE`), so its judgement and
   * append cannot miss. The one judgement made under a branch-store lock.
   */
  withJudgementLocks<T>(branchId: string, run: () => Promise<T>): Promise<T>;
  commitRewrite(input: CommitRewriteInput): Promise<RewriteOutcome>;
  /**
   * Defers cache-visible effects until the ambient transaction commits, and `onRollback`
   * until it rolls back instead; false (nothing deferred) outside a transaction.
   */
  deferUntilCommit(callback: () => void, onRollback?: () => void): boolean;
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
