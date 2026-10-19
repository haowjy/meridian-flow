/**
 * The draft storage contract: a draft is a checkpoint plus a journal tail; appends are
 * sequenced by the draft row's lock and rewrites fenced by `revision`. The row and content types, the store port every adapter implements, and the
 * materialization of one read. The coordinator and the storage adapters both build on this.
 */

import type { CapturedPart, SemanticEditIRV1 } from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { DocumentSchemaMajorMismatchError, isStaleSchema } from "./stale-schema.js";

export type DraftKind = "work_draft" | "thread_peer";
export type DraftStatus = "active" | "closed";

/** The branch's origin Work as the row was read: archived, deleted or missing freeze it. */
export type DraftWorkLifecycle = "active" | "archived" | "deleted" | "missing";

/** A draft row without its content: the content is read only through `readDraftAt`. */
export type DraftSnapshot = {
  draftId: string;
  documentId: DocumentId;
  kind: DraftKind;
  upstreamDraftId: string | null;
  /** The branch this draft belongs to; a thread peer carries its upstream's. */
  branchId: BranchId;
  /** Derived: the branch's origin Work (`branches.origin_work_id`), null when it has none. */
  workId: WorkId | null;
  threadId: ThreadId | null;
  status: DraftStatus;
  /** The re-fork epoch: room name, journal grouping, edit placement. A reset bumps it. */
  generation: number;
  /** Bumped by every committed write to the draft; the fence of exact rewrites. */
  revision: number;
  /** The revision the checkpoint was written at. */
  checkpointRevision: number;
  /** The highest journal id the checkpoint contains; the tail is every later row. */
  checkpointSeq: number;
  /** Derived from the origin Work as read, never stored: anything but `active` is frozen. */
  lifecycle: DraftWorkLifecycle;
  hasEffect: boolean;
  blocking: boolean;
  discardedStateVector?: Uint8Array | null;
  schemaVersion: CollabSchemaVersion;
};

/** A journal row past the checkpoint, applied on read. */
export type DraftTailRow = { id: number; update: Uint8Array; source: "agent" | "writer" };

/**
 * One point-in-time read of a draft: its row, its checkpoint and its tail, from one statement.
 * `checkpoint` is null when the read was asked `since` a checkpoint it still has: `tail` then
 * holds only the rows after that cursor.
 */
export type DraftRead = {
  documentDraft: DraftSnapshot;
  checkpoint: { state: Uint8Array; stateVector: Uint8Array } | null;
  tail: readonly DraftTailRow[];
};

/**
 * A work draft's effect baseline (`live_cut`), the live state its `has_effect` is measured
 * against. `state` is null for a legacy draft created
 * before every creator stored one; the projection job establishes it with a pull.
 */
export type EffectBaseline = { state: Uint8Array | null };

/** One logical write's edit receipts, captured on the document the append commits into. */
export type AppendReceiptGroup = {
  /** The rows of the write, by index into the finalized rows. */
  rowIndexes: readonly number[];
  parts: readonly CapturedPart[];
};

/** A cursor a warm replica already holds, so a read ships only what came after it. */
export type DraftReadSince = { checkpointRevision: number; seq: number };

export type AppendDraftJournalInput = {
  /** One logical tool write, shared by its segment rows. */
  documentEditKey?: string;
  draftId: string;
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
 * What finalization under the row lock decided (design §2.2): the rows to insert (their novel
 * bytes, past the committed prefix) with their receipts, or why nothing is written.
 */
export type AppendFinalization =
  | {
      status: "appended";
      rows: readonly AppendDraftJournalInput[];
      receipts: readonly AppendReceiptGroup[];
    }
  /** Every row was already in the committed prefix: nothing to write, the frame is acked. */
  | { status: "contained" }
  /** A row depends on structs or deletes the journal does not hold yet. */
  | { status: "prefixMissing"; clocks: readonly { client: number; clock: number }[] }
  /** The committed prefix's Work is no longer active. */
  | { status: "refused" };

/**
 * Rows appended past the checkpoint at whatever revision the draft is at: the row `UPDATE` is
 * the sequence point, with no revision predicate. Under its lock the store reads the committed
 * prefix `since` the caller's base cursor and hands it to `finalize`, which owns every fact that
 * depends on it (containment, novelty, receipts, authorship); the store writes what it returns.
 */
export type AppendRowsInput = {
  draftId: string;
  documentId: DocumentId;
  expectedGeneration: number;
  /** The checkpoint and highest row the caller's base replica holds. */
  base: DraftReadSince;
  /**
   * Runs under the row lock. Production's is synchronous: nothing awaits while the row is
   * held. A test fixture may reserve write ordinals here.
   */
  finalize(read: DraftRead): AppendFinalization | Promise<AppendFinalization>;
};

export type AppendRowsOutcome =
  | {
      status: "appended";
      revision: number;
      checkpointRevision: number;
      rowIds: readonly number[];
    }
  | Exclude<AppendFinalization, { status: "appended" }>;

/**
 * What else a rewrite must not race: a pull is fenced by an unfinished settlement on its
 * document (`fenced` while it is pending, `blocked` once it is terminally blocked); a
 * settlement's own reset is not; Discard and close fence on neither.
 */
export type RewriteFence = { kind: "pending-settlement" } | { kind: "none" };

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
   * Live (or the upstream) merged into the draft. A work draft's `effect` was computed on the
   * candidate against `liveCut`, its new baseline, before the rewrite locked anything.
   */
  | { kind: "pull"; effect?: PullEffect }
  /** A content rewrite the draft's owning Work must admit: a thread peer catching up its upstream. */
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
  draftId: string;
  policy: RewritePolicy;
  fence: RewriteFence;
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
  | { status: "moved" | "fenced" | "blocked" | "closed" };

/**
 * A stale draft and its keyset position in the sweep's order. `updatedAt` is the stored
 * timestamp as text, exact to the microsecond (a `Date` would truncate it and skip rows).
 */
export type StaleEffectCursor = { draftId: string; updatedAt: string };

export type DraftStore = {
  /** The row only; content comes through `readDraftAt`. */
  getDraft(draftId: string): Promise<DraftSnapshot | null>;
  readDraftAt(draftId: string, since?: DraftReadSince): Promise<DraftRead | null>;
  /** A work draft's effect baseline; null for a draft that carries no effect. */
  readEffectBaseline(draftId: string): Promise<EffectBaseline | null>;
  /**
   * The append, in its own savepoint: a `contained`, `prefixMissing` or `refused` outcome
   * rolled back the revision bump and everything registered inside it before it returns.
   */
  appendRows(input: AppendRowsInput): Promise<AppendRowsOutcome>;
  /**
   * The projection's write: `has_effect` and its watermark at exactly `revision`, touching the
   * branch's Work. `moved` when the draft moved past `revision`; `contended` when a lock it
   * needs was not free within the bound (100 ms per lock acquisition). Never bumps `revision`.
   */
  writeEffect(input: {
    draftId: string;
    revision: number;
    hasEffect: boolean;
    workId: WorkId | null;
  }): Promise<"written" | "moved" | "contended">;
  /** Active work drafts whose watermark is behind their revision, newest first, keyset paged. */
  staleEffectDrafts(input: {
    after?: StaleEffectCursor;
    limit: number;
  }): Promise<readonly StaleEffectCursor[]>;
  commitRewrite(input: CommitRewriteInput): Promise<RewriteOutcome>;
  /**
   * Defers cache-visible effects until the ambient transaction commits, and `onRollback`
   * until it rolls back instead; false (nothing deferred) outside a transaction.
   */
  deferUntilCommit(callback: () => void, onRollback?: () => void): boolean;
};

export class DraftStaleUpdateError extends Error {
  // `subject` names what went stale, "Draft <id>" or "Branch <id>"; no caller reads it.
  constructor(readonly subject: string) {
    super(`${subject} update did not apply to the current generation`);
    this.name = "DraftStaleUpdateError";
  }
}

export class DraftCasConflictError extends Error {
  constructor(readonly draftId: string) {
    super(`Draft ${draftId} changed before its snapshot could be persisted`);
    this.name = "DraftCasConflictError";
  }
}

/**
 * A writer update that depends on something the draft's journal does not hold yet (design
 * §2.7): nothing was written, and the socket resyncs (`WS_CLOSE.DRAFT_PREFIX_MISSING`).
 */
export class DraftPrefixMissingError extends Error {
  constructor(
    readonly draftId: string,
    readonly clocks: readonly { client: number; clock: number }[],
  ) {
    super(`Draft ${draftId} update depends on a prefix the journal does not hold`);
    this.name = "DraftPrefixMissingError";
  }
}

/** A load named a draft whose rows are gone (a last-use Discard deleted them). */
export class DraftMissingError extends Error {
  constructor(readonly draftId: string) {
    super(`Draft ${draftId} does not exist`);
    this.name = "DraftMissingError";
  }
}

export function assertReadableDraft(
  snapshot: Pick<DraftSnapshot, "documentId" | "schemaVersion">,
): void {
  if (isStaleSchema(snapshot.schemaVersion, COLLAB_SCHEMA_VERSION)) {
    throw new DocumentSchemaMajorMismatchError(
      snapshot.documentId,
      snapshot.schemaVersion,
      COLLAB_SCHEMA_VERSION,
    );
  }
}

/** The draft's content at the read: its checkpoint, then its tail rows in id order. */
export function materializeDraftRead(
  read: DraftRead,
  doc: Y.Doc = createCollabYDoc({ gc: false }),
): Y.Doc {
  if (!read.checkpoint) throw new Error("A draft read since a checkpoint cannot materialize alone");
  try {
    Y.applyUpdate(doc, read.checkpoint.state);
    for (const row of read.tail) Y.applyUpdate(doc, row.update);
    return doc;
  } catch (cause) {
    doc.destroy();
    throw cause;
  }
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
