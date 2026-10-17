/** Coordinates persisted branch-peer Y.Docs behind one mutation surface. */

import type { SemanticEditIRV1 } from "@meridian/agent-edit/integration";
import { bytesEqual } from "@meridian/agent-edit/integration";
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  assertBranchLeaseCovers,
  type BranchCriticalSections,
  type BranchLockLease,
  createBranchCriticalSections,
} from "./branch-critical-sections.js";
import type { BranchJournalReadStore, BranchJournalRow } from "./branch-push-contracts.js";
import { BranchCorruptError } from "./branch-resolver.js";
import { createDocumentContainment } from "./document-containment.js";
import {
  admitCertifiedMutation,
  admitWriterUpdate,
  replicateFrozenIdentity,
} from "./document-mutation-policy.js";
import { currentResponseTransactionId, enlistResponseParticipant } from "./response-transaction.js";
import { DocumentSchemaMajorMismatchError, isStaleSchema } from "./stale-schema.js";
import { certifyWriterRestorations } from "./writer-restoration.js";

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

/**
 * The branch as committed at `revision`: replaced, never mutated. `seq` is the highest journal
 * id it contains; `encoded` is its update bytes, computed once when first needed.
 */
type PublishedReplica = {
  readonly revision: number;
  readonly checkpointRevision: number;
  readonly seq: number;
  readonly generation: number;
  readonly doc: Y.Doc;
  encoded?: Uint8Array;
};

/** A save's uncommitted overlay of a branch (main's transient publication; phase 1b scopes it). */
type TransientOverlay = { readonly generation: number; readonly doc: Y.Doc };

/**
 * What a branch operation works from: the committed replica at the snapshot's revision, and
 * the document it reads, which is the overlay when a save published one.
 */
type BranchBase = {
  snapshot: BranchSnapshot;
  replica: PublishedReplica;
  doc: Y.Doc;
  overlaid: boolean;
};

/** The pre-replay view a save's staged rows are reconciled against. */
export type StagedBranchView = BranchSnapshot & {
  /** The committed branch bytes at `revision`, captured before any replay. */
  readonly encoded: Uint8Array;
};

export type SegmentRowsInput = {
  branchId: string;
  expectedGeneration: number;
  sourceDoc: Y.Doc;
  rows: readonly Omit<AppendBranchJournalInput, "generation">[];
};

/** The journal reads a save performs: the helper's generation history and attribution's concurrent rows. */
export type BranchSaveJournalReads = Pick<BranchJournalReadStore, "listConcurrentJournalRows"> & {
  listJournalRowsForBranch(
    input: Parameters<BranchJournalReadStore["listJournalRowsForBranch"]>[0],
  ): Promise<(BranchJournalRow & { editKind?: string })[]>;
};

export type OwnedBranchSession = {
  read<T>(branchId: string, fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>): Promise<T>;
  withTransient<T>(
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T>;
  withStagedRows<T>(
    branchId: string,
    run: (
      doc: Y.Doc,
      snapshot: StagedBranchView,
    ) => Promise<{ result: T; rows: readonly Omit<AppendBranchJournalInput, "generation">[] }>,
    commit: boolean,
  ): Promise<T>;
  commitSegmentRows(input: SegmentRowsInput): Promise<boolean>;
  checkpoint(branchId: string): Promise<void>;
  /** The generation history B+ replays against, with each row's persisted inverse evidence. */
  listHelperHistory: BranchSaveJournalReads["listJournalRowsForBranch"];
  listConcurrentRows: BranchSaveJournalReads["listConcurrentJournalRows"];
};

export type BranchCoordinator = {
  /**
   * Merges `upstream` into the branch under a lease the caller holds (a pull takes its
   * branches' leases before its transaction); throws for a branch the lease does not cover.
   */
  pullFromDoc(lease: BranchLockLease, branchId: string, upstream: Y.Doc): Promise<Uint8Array>;
  resetFromDocIfUnchangedWithLease(
    lease: BranchLockLease,
    input: {
      branchId: string;
      upstream: Y.Doc;
      expectedGeneration: number;
      expectedRevision: number;
      schemaVersion?: CollabSchemaVersion;
      editDisposition?: "discarded" | "retired";
    },
  ): Promise<boolean>;
  /**
   * These branches' leases in one ordered acquisition, for an operation that touches
   * several (a peer and its draft branch) and runs every step under the one lease.
   */
  withLeases<T>(
    branchIds: readonly string[],
    run: (lease: BranchLockLease) => Promise<T>,
  ): Promise<T>;
  readBranch<T>(
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T>;
  commitWriterUpdate(input: {
    branchId: string;
    expectedGeneration: number;
    updateData: Uint8Array;
    actorUserId?: string;
    roomDocument: Y.Doc;
  }): Promise<{ admitted: boolean }>;
  /**
   * A save's one door to branch state: every call runs under `lease`, acquires nothing, and
   * throws `BranchLeaseScopeError` for a branch the lease does not cover.
   */
  ownedSession(lease: BranchLockLease): OwnedBranchSession;
  notifyReset(input: { branchId: string; generation: number }): void;
  broadcastUpdate(input: { branchId: string; update: Uint8Array }): void;
};

export function createBranchCoordinator(input: {
  store: BranchStore;
  /** The reads a save's owned session makes; leave it to the adapter that serves them. */
  journalReads?: BranchSaveJournalReads;
  criticalSections?: BranchCriticalSections;
  maxCasRetries?: number;
  onBranchUpdate?: (input: { branchId: string; update: Uint8Array }) => void;
  onBranchReset?: (input: { branchId: string; generation: number }) => void;
}): BranchCoordinator {
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const documentContainment = createDocumentContainment();
  const published = new Map<string, PublishedReplica>();
  const pendingTransients = new Map<string, TransientOverlay>();
  const overlays = new Map<string, TransientOverlay>();
  const maxCasRetries = input.maxCasRetries ?? 3;

  async function resetFromDocIfUnchangedWithLease(
    lease: BranchLockLease,
    resetInput: {
      branchId: string;
      upstream: Y.Doc;
      expectedGeneration: number;
      expectedRevision: number;
      schemaVersion?: CollabSchemaVersion;
      editDisposition?: "discarded" | "retired";
    },
  ): Promise<boolean> {
    assertBranchLeaseCovers(lease, resetInput.branchId);
    const snapshot = await loadSnapshot(resetInput.branchId);
    assertWorkDraftResetTarget(snapshot);
    if (
      snapshot.generation !== resetInput.expectedGeneration ||
      snapshot.revision !== resetInput.expectedRevision
    ) {
      return false;
    }
    await persistReset(
      snapshot,
      resetInput.upstream,
      resetInput.schemaVersion ?? snapshot.schemaVersion,
      resetInput.editDisposition,
    );
    return true;
  }

  async function loadSnapshot(branchId: string): Promise<BranchSnapshot> {
    const snapshot = await input.store.getBranch(branchId);
    if (!snapshot) throw new BranchMissingError(branchId);
    assertReadableBranch(snapshot);
    return snapshot;
  }

  /**
   * The branch as committed now, from the published replica when its revision still holds,
   * caught up from the tail when only appends landed since, otherwise materialized.
   */
  async function loadBase(branchId: string): Promise<BranchBase> {
    const current = published.get(branchId);
    const read = await input.store.readBranchAt(
      branchId,
      current ? { checkpointRevision: current.checkpointRevision, seq: current.seq } : undefined,
    );
    if (!read) throw new BranchMissingError(branchId);
    const snapshot = read.branch;
    assertReadableBranch(snapshot);
    const replica = replicaFor(read, current);
    const transactionId = currentResponseTransactionId();
    const overlay =
      (transactionId
        ? pendingTransients.get(pendingTransientKey(transactionId, branchId))
        : undefined) ?? overlays.get(branchId);
    if (overlay && overlay.generation === snapshot.generation) {
      return { snapshot, replica, doc: overlay.doc, overlaid: true };
    }
    return { snapshot, replica, doc: replica.doc, overlaid: false };
  }

  function replicaFor(read: BranchRead, current: PublishedReplica | undefined): PublishedReplica {
    const { branch } = read;
    if (current?.revision === branch.revision) return current;
    try {
      let next: PublishedReplica;
      if (!read.checkpoint && current) {
        // Only appends (or metadata-only bumps) since the replica: apply the tail to a copy.
        const doc = read.tail.length ? cloneDoc(current.doc) : current.doc;
        for (const row of read.tail) Y.applyUpdate(doc, row.update);
        next = {
          revision: branch.revision,
          checkpointRevision: branch.checkpointRevision,
          seq: Math.max(current.seq, ...read.tail.map((row) => row.id)),
          generation: branch.generation,
          doc,
          ...(read.tail.length ? {} : { encoded: current.encoded }),
        };
      } else {
        next = {
          revision: branch.revision,
          checkpointRevision: branch.checkpointRevision,
          seq: Math.max(branch.checkpointSeq, ...read.tail.map((row) => row.id)),
          generation: branch.generation,
          doc: materializeBranchRead(read),
        };
      }
      publishReplica(branch.branchId, next);
      return next;
    } catch (cause) {
      throw new BranchCorruptError({
        branchId: branch.branchId,
        documentId: branch.documentId,
        threadId: branch.threadId ?? ("" as ThreadId),
        cause,
      });
    }
  }

  /**
   * Publication is committed state only: a replica read inside a transaction becomes visible
   * when that transaction commits, and a lower revision never replaces a higher one.
   */
  function publishReplica(branchId: string, replica: PublishedReplica): void {
    const publish = () => {
      const current = published.get(branchId);
      if (!current || current.revision < replica.revision) published.set(branchId, replica);
    };
    if (currentResponseTransactionId()) {
      enlistResponseParticipant({ commit: publish, abort() {} });
      return;
    }
    if (!input.store.deferUntilCommit(publish)) publish();
  }

  function encodedOf(replica: PublishedReplica): Uint8Array {
    replica.encoded ??= Y.encodeStateAsUpdate(replica.doc);
    return replica.encoded;
  }

  async function applySegmentRows(
    doc: Y.Doc,
    snapshot: BranchSnapshot,
    journals: readonly AppendBranchJournalInput[],
  ): Promise<void> {
    // Admission remains per logical write; segment rows keep their own attribution.
    for (let index = 0; index < journals.length; ) {
      const first = journals[index];
      const writeRows = [first];
      index++;
      while (
        index < journals.length &&
        first.semanticEditIr &&
        journals[index].semanticEditIr === first.semanticEditIr
      )
        writeRows.push(journals[index++]);
      const apply = () => {
        for (const row of writeRows) {
          assertFreshAgentClient(doc, row);
          Y.applyUpdate(doc, row.updateData);
        }
      };
      if (first.semanticEditIr) {
        const ir = first.semanticEditIr;
        await admitCertifiedMutation(
          {
            readMutationTarget: () => ({
              documentId: snapshot.documentId,
              generation: BigInt(snapshot.generation),
              doc,
            }),
            readCurrentRevision: async () => ir.inputRevision,
            lowerCertifiedMutation: async () =>
              Y.mergeUpdates(writeRows.map((row) => row.updateData)),
            admitImmediate: async () => {
              apply();
              return { sequence: 0n, joined: 0 };
            },
          },
          { ir },
        );
      } else apply();
    }
  }

  function forget(branchId: string): void {
    published.delete(branchId);
    overlays.delete(branchId);
  }

  /** After commit: the candidate becomes the published replica and the room hears the rows. */
  function afterCommit(
    branchId: string,
    replica: PublishedReplica,
    update: Uint8Array | undefined,
  ): void {
    const publish = () => {
      overlays.delete(branchId);
      const current = published.get(branchId);
      if (!current || current.revision < replica.revision) published.set(branchId, replica);
      if (update) input.onBranchUpdate?.({ branchId, update });
    };
    if (currentResponseTransactionId()) {
      enlistResponseParticipant({ commit: publish, abort() {} });
      return;
    }
    if (!input.store.deferUntilCommit(publish)) publish();
  }

  /**
   * Commits journal rows judged on `candidate`. From the committed replica they are an append;
   * from a save's published overlay (content the database lacks) the candidate is a checkpoint.
   */
  async function persistRows(
    base: BranchBase,
    candidate: Y.Doc,
    journals: readonly AppendBranchJournalInput[],
  ): Promise<void> {
    const { snapshot } = base;
    const receiptBase = encodedOf(base.replica);
    let replica: PublishedReplica;
    if (!base.overlaid) {
      const outcome = await input.store.appendRows({
        branchId: snapshot.branchId,
        expectedRevision: snapshot.revision,
        expectedGeneration: snapshot.generation,
        rows: journals,
        receiptBase,
      });
      if (outcome.status !== "appended") {
        forget(snapshot.branchId);
        throw new BranchCasConflictError(snapshot.branchId);
      }
      replica = {
        revision: outcome.revision,
        checkpointRevision: base.replica.checkpointRevision,
        seq: Math.max(base.replica.seq, ...outcome.rowIds),
        generation: snapshot.generation,
        doc: candidate,
      };
    } else {
      const outcome = await input.store.commitRewrite({
        branchId: snapshot.branchId,
        policy: { kind: "exact", revision: snapshot.revision },
        fence: { kind: "none" },
        doc: candidate,
        operation: { kind: "checkpoint", rows: journals, receiptBase },
      });
      if (outcome.status !== "committed") {
        forget(snapshot.branchId);
        throw new BranchCasConflictError(snapshot.branchId);
      }
      replica = { ...outcome, doc: candidate };
    }
    afterCommit(
      snapshot.branchId,
      replica,
      journals.length ? Y.mergeUpdates(journals.map((row) => row.updateData)) : undefined,
    );
  }

  /** Commits `candidate` as the branch's checkpoint at the revision `base` was read at. */
  async function persistCheckpoint(
    base: BranchBase,
    candidate: Y.Doc,
    kind: "mutation" | "pull",
    publishUpdate?: Uint8Array,
    upstream?: Y.Doc,
  ): Promise<void> {
    const { snapshot } = base;
    if (!upstream && bytesEqual(Y.encodeStateAsUpdate(candidate), encodedOf(base.replica))) return;
    const outcome = await input.store.commitRewrite({
      branchId: snapshot.branchId,
      policy: { kind: "exact", revision: snapshot.revision },
      fence: { kind: "none" },
      doc: candidate,
      operation:
        kind === "pull"
          ? {
              kind: "pull",
              ...(upstream && snapshot.kind === "work_draft"
                ? { liveCut: Y.encodeStateAsUpdate(upstream) }
                : {}),
            }
          : { kind: "checkpoint" },
    });
    if (outcome.status !== "committed") {
      forget(snapshot.branchId);
      throw new BranchCasConflictError(snapshot.branchId);
    }
    afterCommit(snapshot.branchId, { ...outcome, doc: candidate }, publishUpdate);
  }

  function notifyReset(reset: { branchId: string; generation: number }): void {
    forget(reset.branchId);
    const publish = () => input.onBranchReset?.(reset);
    if (!input.store.deferUntilCommit(publish)) publish();
  }

  async function persistReset(
    snapshot: BranchSnapshot,
    upstream: Y.Doc,
    schemaVersion: CollabSchemaVersion,
    editDisposition: "discarded" | "retired" = "discarded",
  ): Promise<void> {
    const resetDoc = createCollabYDoc({ gc: false });
    try {
      await replicateFrozenSource(upstream, resetDoc);
      const outcome = await input.store.commitRewrite({
        branchId: snapshot.branchId,
        policy: { kind: "exact", revision: snapshot.revision },
        fence: { kind: "none" },
        doc: resetDoc,
        operation: { kind: "reset", editDisposition, schemaVersion },
      });
      forget(snapshot.branchId);
      if (outcome.status !== "committed") throw new BranchCasConflictError(snapshot.branchId);
    } finally {
      resetDoc.destroy();
    }
    notifyReset({ branchId: snapshot.branchId, generation: snapshot.generation + 1 });
  }

  /** One snapshot-clone-persist step of a branch operation; the caller holds the branch's lease. */
  async function runUnder<T>(
    branchId: string,
    operation: (snapshot: BranchSnapshot, doc: Y.Doc) => Promise<T>,
    updateToPublish?: (result: T) => Uint8Array,
    kind: "mutation" | "pull" = "mutation",
    upstream?: Y.Doc,
  ): Promise<T> {
    const base = await loadBase(branchId);
    const { snapshot } = base;
    // A durable thread peer has already saved its writes into the Work draft.
    // If the parent no longer contains them, a review retired their effect.
    // Merging cannot remove those structs or undo their tombstones.
    if (
      snapshot.kind === "thread_peer" &&
      upstream &&
      !Y.snapshotContainsUpdate(Y.snapshot(upstream), encodedOf(base.replica))
    ) {
      const doc = cloneDoc(upstream);
      try {
        const result = await operation(snapshot, doc);
        await persistReset(snapshot, upstream, snapshot.schemaVersion);
        return result;
      } finally {
        doc.destroy();
      }
    }
    // The candidate is a private copy: a failed commit never touches a published replica.
    const doc = cloneDoc(base.doc);
    const result = await operation(snapshot, doc);
    await persistCheckpoint(base, doc, kind, updateToPublish?.(result), upstream);
    return result;
  }

  /** Retries a CAS conflict; `acquire` takes the branch's lease around each attempt, or none under a held one. */
  async function retryCas<T>(attempt: () => Promise<T>): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        return await attempt();
      } catch (cause) {
        if (!(cause instanceof BranchCasConflictError) || tries >= maxCasRetries) throw cause;
      }
    }
  }

  async function replicateFrozenSource(source: Y.Doc, target: Y.Doc): Promise<Uint8Array> {
    let admittedUpdate: Uint8Array | undefined;
    const frozenSource = cloneDoc(source);
    try {
      await replicateFrozenIdentity({
        source: { documentId: "branch", doc: frozenSource },
        target: { documentId: "branch", generation: 0n, doc: target },
        plan: { kind: "wholeDocument" },
        admit: async ({ update }) => {
          admittedUpdate = update;
          Y.applyUpdate(target, update);
          return { sequence: 0n, joined: 0 };
        },
      });
      if (!admittedUpdate) throw new Error("Identity replication produced no branch update");
      return admittedUpdate;
    } finally {
      frozenSource.destroy();
    }
  }

  async function persistJournaledUpdate(
    base: BranchBase,
    inputJournal: Omit<AppendBranchJournalInput, "generation">,
  ): Promise<boolean> {
    // The candidate is a private copy: a failed commit never touches a published replica.
    const candidate = cloneDoc(base.doc);
    const beforeState = Y.encodeStateAsUpdate(candidate);
    Y.applyUpdate(candidate, inputJournal.updateData);
    if (bytesEqual(beforeState, Y.encodeStateAsUpdate(candidate))) {
      candidate.destroy();
      throw new BranchStaleUpdateError(inputJournal.branchId);
    }
    await persistRows(base, candidate, [{ ...inputJournal, generation: base.snapshot.generation }]);
    return true;
  }

  async function readUnder<T>(
    lease: BranchLockLease,
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T> {
    assertBranchLeaseCovers(lease, branchId);
    const base = await loadBase(branchId);
    return fn(base.doc, base.snapshot);
  }

  async function transientUnder<T>(
    lease: BranchLockLease,
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T> {
    assertBranchLeaseCovers(lease, branchId);
    const base = await loadBase(branchId);
    const { snapshot } = base;
    assertWritableBranch(snapshot);
    const doc = cloneDoc(base.doc);
    const result = await fn(doc, snapshot);
    const next = { generation: snapshot.generation, doc };
    const transactionId = currentResponseTransactionId();
    // Main's behavior, kept through phase 1a: without a response transaction the overlay is
    // published for the branch's next operation, which persists it as a checkpoint.
    if (!transactionId) {
      overlays.set(snapshot.branchId, next);
      return result;
    }
    const key = pendingTransientKey(transactionId, snapshot.branchId);
    pendingTransients.set(key, next);
    enlistResponseParticipant({
      commit() {
        const pending = pendingTransients.get(key);
        if (!pending) return;
        pendingTransients.delete(key);
        overlays.set(snapshot.branchId, pending);
      },
      abort() {
        pendingTransients.delete(key);
      },
    });
    return result;
  }

  /** Replays a response's rows on a clone of the branch and, when `commit`, publishes them; the caller holds the lease. */
  async function stagedRowsUnder<T>(
    branchId: string,
    run: (
      doc: Y.Doc,
      snapshot: StagedBranchView,
    ) => Promise<{ result: T; rows: readonly Omit<AppendBranchJournalInput, "generation">[] }>,
    commit: boolean,
  ): Promise<T> {
    const base = await loadBase(branchId);
    const { snapshot } = base;
    assertWritableBranch(snapshot);
    const doc = cloneDoc(base.doc);
    let published = false;
    try {
      const { result, rows } = await run(doc, { ...snapshot, encoded: encodedOf(base.replica) });
      if (commit && rows.length) {
        const admitted = cloneDoc(base.doc);
        try {
          await applySegmentRows(
            admitted,
            snapshot,
            rows.map((row) => ({ ...row, generation: snapshot.generation })),
          );
          if (!bytesEqual(Y.encodeStateAsUpdate(admitted), Y.encodeStateAsUpdate(doc)))
            throw new Error("Response replay differs from its admitted segment rows");
        } finally {
          admitted.destroy();
        }
        await persistRows(
          base,
          doc,
          rows.map((row) => ({ ...row, generation: snapshot.generation })),
        );
        published = true;
      }
      return result;
    } finally {
      // A committed candidate becomes the published replica.
      if (!published) doc.destroy();
    }
  }

  async function segmentRowsUnder(batch: SegmentRowsInput): Promise<boolean> {
    const base = await loadBase(batch.branchId);
    const { snapshot } = base;
    assertWritableBranch(snapshot);
    if (snapshot.generation !== batch.expectedGeneration)
      throw new BranchStaleUpdateError(batch.branchId);
    const doc = cloneDoc(base.doc);
    const journals = batch.rows.map((row) => ({ ...row, generation: snapshot.generation }));
    await applySegmentRows(doc, snapshot, journals);
    if (journalSyncDelta(batch.sourceDoc, doc))
      throw new Error("Segment publication left an unjournaled residual");
    if (!journals.length) return false;
    await persistRows(base, doc, journals);
    return true;
  }

  /** Every branch operation a reply's save performs, bound to the lease the pool holds (contract §2.3). */
  function ownedSession(lease: BranchLockLease): OwnedBranchSession {
    const under = async <T>(branchId: string, run: () => Promise<T>): Promise<T> => {
      assertBranchLeaseCovers(lease, branchId);
      return run();
    };
    return {
      read: (branchId, fn) => readUnder(lease, branchId, fn),
      withTransient: (branchId, fn) => transientUnder(lease, branchId, fn),
      withStagedRows: (branchId, run, commit) =>
        under(branchId, () => stagedRowsUnder(branchId, run, commit)),
      commitSegmentRows: (batch) =>
        under(batch.branchId, () => retryCas(() => segmentRowsUnder(batch))),
      checkpoint: (branchId) =>
        under(branchId, () => retryCas(() => runUnder(branchId, async () => undefined))),
      listHelperHistory: (query) =>
        under(query.branchId, async () => requireJournalReads().listJournalRowsForBranch(query)),
      listConcurrentRows: (branchId, generation, options) =>
        under(branchId, async () =>
          requireJournalReads().listConcurrentJournalRows(branchId, generation, options),
        ),
    };
  }

  function requireJournalReads(): BranchSaveJournalReads {
    if (!input.journalReads) throw new Error("This coordinator reads no branch journal");
    return input.journalReads;
  }

  function assertWorkDraftResetTarget(snapshot: BranchSnapshot): void {
    if (snapshot.kind !== "work_draft" || snapshot.status !== "active") {
      throw new Error(`Branch ${snapshot.branchId} is not an active work draft reset target`);
    }
  }

  return {
    notifyReset,
    readBranch(branchId, fn) {
      return criticalSections.withBranches([branchId], (lease) => readUnder(lease, branchId, fn));
    },

    withLeases: (branchIds, run) => criticalSections.withBranches(branchIds, run),

    ownedSession,

    pullFromDoc(lease, branchId, upstream) {
      assertBranchLeaseCovers(lease, branchId);
      return retryCas(() =>
        runUnder(
          branchId,
          async (_snapshot, doc) => replicateFrozenSource(upstream, doc),
          (update) => update,
          "pull",
          upstream,
        ),
      );
    },

    resetFromDocIfUnchangedWithLease,

    broadcastUpdate(update) {
      // Published replicas are immutable: the next read catches up from the committed tail.
      input.onBranchUpdate?.(update);
    },

    commitWriterUpdate,
  };

  async function commitWriterUpdate(
    inputWriter: Parameters<BranchCoordinator["commitWriterUpdate"]>[0],
  ): Promise<{ admitted: boolean }> {
    let attempt = 0;
    while (true) {
      try {
        return await criticalSections.withBranches([inputWriter.branchId], async () => {
          const base = await loadBase(inputWriter.branchId);
          const { snapshot } = base;
          const admission = await admitWriterUpdate({
            targetDocument: base.doc,
            update: inputWriter.updateData,
            validateTarget() {
              if (
                snapshot.kind !== "work_draft" ||
                snapshot.status !== "active" ||
                snapshot.generation !== inputWriter.expectedGeneration ||
                !documentContainment.contains(inputWriter.roomDocument, encodedOf(base.replica))
              ) {
                throw new BranchStaleUpdateError(inputWriter.branchId);
              }
            },
            isContained: () => documentContainment.contains(base.doc, inputWriter.updateData),
            append: () =>
              persistJournaledUpdate(base, {
                branchId: inputWriter.branchId,
                updateData: inputWriter.updateData,
                source: "writer",
                actorUserId: inputWriter.actorUserId,
                updateMeta: {
                  restorationAliases: certifyWriterRestorations(base.doc, inputWriter.updateData),
                },
              }),
          });
          return { admitted: admission.admitted };
        });
      } catch (cause) {
        if (!(cause instanceof BranchCasConflictError) || attempt++ >= maxCasRetries) throw cause;
      }
    }
  }
}

function pendingTransientKey(transactionId: string, branchId: string): string {
  return `${transactionId}\0${branchId}`;
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

function assertWritableBranch(snapshot: BranchSnapshot): void {
  if (snapshot.status !== "active") {
    throw new BranchStaleUpdateError(snapshot.branchId);
  }
}

function cloneDoc(doc: Y.Doc): Y.Doc {
  const clone = createCollabYDoc({ gc: false });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
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

/** Journal the effective sync transaction, not inherited source tombstones. */
function journalSyncDelta(from: Y.Doc, to: Y.Doc): Uint8Array | null {
  const probe = cloneDoc(to);
  const updates: Uint8Array[] = [];
  probe.on("update", (update: Uint8Array) => updates.push(update));
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
    // A source peer includes the target's complete causal prefix. Never drop
    // unresolved structs/deletes by journaling only the events that integrated.
    if (probe.store.pendingStructs || probe.store.pendingDs) {
      throw new Error("Branch sync delta has unresolved Yjs dependencies");
    }
    return updates.length > 0 ? Y.mergeUpdates(updates) : null;
  } finally {
    probe.destroy();
  }
}

/** Draft agent rows own fresh structs; deletes may refer to older clients. */
function assertFreshAgentClient(doc: Y.Doc, row: AppendBranchJournalInput): void {
  if (row.source !== "agent") return;
  const clients = Y.decodeStateVector(Y.encodeStateVector(doc));
  for (const struct of Y.decodeUpdate(row.updateData).structs) {
    if (clients.has(struct.id.client))
      throw new Error(`Agent segment reused client ${struct.id.client}`);
  }
}
