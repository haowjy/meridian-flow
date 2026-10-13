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
  generation: number;
  state: Uint8Array;
  stateVector: Uint8Array;
  discardedStateVector?: Uint8Array | null;
  liveCut?: Uint8Array | null;
  schemaVersion: CollabSchemaVersion;
};

export type PersistBranchInput = {
  liveCut?: Uint8Array;
  branchId: string;
  expectedGeneration: number;
  expectedStateVector: Uint8Array;
  expectedState: Uint8Array;
  state: Uint8Array;
  stateVector: Uint8Array;
};

export type CommitBranchMutationInput = PersistBranchInput & {
  journals?: readonly AppendBranchJournalInput[];
};

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

export type ResetBranchSnapshotInput = {
  editDisposition?: "discarded" | "retired";
  branchId: string;
  expectedGeneration: number;
  expectedStateVector: Uint8Array;
  expectedState: Uint8Array;
  state: Uint8Array;
  stateVector: Uint8Array;
  discardedStateVector: Uint8Array;
  schemaVersion: CollabSchemaVersion;
};

export type BranchStore = {
  getBranch(branchId: string): Promise<BranchSnapshot | null>;
  updateBranchSnapshot(input: PersistBranchInput): Promise<boolean>;
  commitBranchMutation(input: CommitBranchMutationInput): Promise<boolean>;
  resetBranchSnapshot(input: ResetBranchSnapshotInput): Promise<boolean>;
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

type CachedBranchDoc = {
  generation: number;
  state: Uint8Array;
  stateVector: Uint8Array;
  doc: Y.Doc;
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
      snapshot: BranchSnapshot,
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
      expectedStateVector: Uint8Array;
      expectedState: Uint8Array;
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
  withStagedRows<T>(
    branchId: string,
    run: (
      doc: Y.Doc,
      snapshot: BranchSnapshot,
    ) => Promise<{
      result: T;
      rows: readonly Omit<AppendBranchJournalInput, "generation">[];
    }>,
    commit: boolean,
  ): Promise<T>;
  commitSegmentRows(input: SegmentRowsInput): Promise<boolean>;
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
  const cached = new Map<string, CachedBranchDoc>();
  const pendingTransients = new Map<string, CachedBranchDoc>();
  const dirtyTransientBranches = new Set<string>();
  const maxCasRetries = input.maxCasRetries ?? 3;

  async function resetFromDocIfUnchangedWithLease(
    lease: BranchLockLease,
    resetInput: {
      branchId: string;
      upstream: Y.Doc;
      expectedGeneration: number;
      expectedStateVector: Uint8Array;
      expectedState: Uint8Array;
      schemaVersion?: CollabSchemaVersion;
      editDisposition?: "discarded" | "retired";
    },
  ): Promise<boolean> {
    assertBranchLeaseCovers(lease, resetInput.branchId);
    const snapshot = await loadSnapshot(resetInput.branchId);
    assertWorkDraftResetTarget(snapshot);
    if (
      snapshot.generation !== resetInput.expectedGeneration ||
      !bytesEqual(snapshot.stateVector, resetInput.expectedStateVector) ||
      !bytesEqual(snapshot.state, resetInput.expectedState)
    ) {
      cached.delete(resetInput.branchId);
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

  async function materialize(snapshot: BranchSnapshot): Promise<CachedBranchDoc> {
    const transactionId = currentResponseTransactionId();
    const pending = transactionId
      ? pendingTransients.get(pendingTransientKey(transactionId, snapshot.branchId))
      : undefined;
    if (pending) return pending;
    const current = cached.get(snapshot.branchId);
    if (
      current &&
      current.generation === snapshot.generation &&
      (dirtyTransientBranches.has(snapshot.branchId) ||
        (bytesEqual(current.stateVector, snapshot.stateVector) &&
          bytesEqual(current.state, snapshot.state)))
    ) {
      return current;
    }
    try {
      const doc = createCollabYDoc({ gc: false });
      Y.applyUpdate(doc, snapshot.state);
      const next = {
        generation: snapshot.generation,
        state: snapshot.state,
        stateVector: snapshot.stateVector,
        doc,
      };
      cached.set(snapshot.branchId, next);
      return next;
    } catch (cause) {
      throw new BranchCorruptError({
        branchId: snapshot.branchId,
        documentId: snapshot.documentId,
        threadId: snapshot.threadId ?? ("" as ThreadId),
        cause,
      });
    }
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

  async function persist(
    snapshot: BranchSnapshot,
    doc: Y.Doc,
    journals?: readonly AppendBranchJournalInput[],
    publishUpdate?: Uint8Array,
    kind: "mutation" | "pull" = "mutation",
    upstream?: Y.Doc,
  ): Promise<void> {
    const state = Y.encodeStateAsUpdate(doc);
    const stateVector = Y.encodeStateVector(doc);
    if (!journals?.length && bytesEqual(state, snapshot.state) && !upstream) return;
    const mutation = {
      branchId: snapshot.branchId,
      expectedGeneration: snapshot.generation,
      expectedStateVector: snapshot.stateVector,
      expectedState: snapshot.state,
      state,
      stateVector,
      ...(journals ? { journals } : {}),
      ...(upstream && snapshot.kind === "work_draft"
        ? { liveCut: Y.encodeStateAsUpdate(upstream) }
        : {}),
    };
    // Replication creates no reviewable edit. Its CAS must not reacquire the
    // Work lifecycle lock a reader may already hold in another transaction.
    const ok =
      kind === "pull"
        ? await input.store.updateBranchSnapshot(mutation)
        : await input.store.commitBranchMutation(mutation);
    if (!ok) {
      cached.delete(snapshot.branchId);
      dirtyTransientBranches.delete(snapshot.branchId);
      throw new BranchCasConflictError(snapshot.branchId);
    }
    const publish = () => {
      dirtyTransientBranches.delete(snapshot.branchId);
      cached.set(snapshot.branchId, { generation: snapshot.generation, state, stateVector, doc });
      const update = journals?.length
        ? Y.mergeUpdates(journals.map((row) => row.updateData))
        : publishUpdate;
      if (update) input.onBranchUpdate?.({ branchId: snapshot.branchId, update });
    };
    if (currentResponseTransactionId()) {
      enlistResponseParticipant({ commit: publish, abort() {} });
      return;
    }
    if (!input.store.deferUntilCommit(publish)) publish();
  }

  function notifyReset(reset: { branchId: string; generation: number }): void {
    dirtyTransientBranches.delete(reset.branchId);
    cached.delete(reset.branchId);
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
    await replicateFrozenSource(upstream, resetDoc);
    const state = Y.encodeStateAsUpdate(resetDoc);
    const stateVector = Y.encodeStateVector(resetDoc);
    const ok = await input.store.resetBranchSnapshot({
      branchId: snapshot.branchId,
      expectedGeneration: snapshot.generation,
      expectedStateVector: snapshot.stateVector,
      expectedState: snapshot.state,
      state,
      stateVector,
      editDisposition,
      discardedStateVector: mergeStateVectors(snapshot.discardedStateVector, snapshot.stateVector),
      schemaVersion,
    });
    if (!ok) {
      resetDoc.destroy();
      cached.delete(snapshot.branchId);
      dirtyTransientBranches.delete(snapshot.branchId);
      throw new BranchCasConflictError(snapshot.branchId);
    }
    dirtyTransientBranches.delete(snapshot.branchId);
    cached.delete(snapshot.branchId);
    resetDoc.destroy();
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
    const snapshot = await loadSnapshot(branchId);
    const { doc: cachedDoc } = await materialize(snapshot);
    // A durable thread peer has already saved its writes into the Work draft.
    // If the parent no longer contains them, a review retired their effect.
    // Merging cannot remove those structs or undo their tombstones.
    if (
      snapshot.kind === "thread_peer" &&
      upstream &&
      !Y.snapshotContainsUpdate(Y.snapshot(upstream), snapshot.state)
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
    // O(doc) clone-before-write is intentional per GATE-1 spec §9 (Q4 headroom):
    // failed CAS/rollback must never mutate the cached branch doc.
    const doc = cloneDoc(cachedDoc);
    const result = await operation(snapshot, doc);
    await persist(snapshot, doc, undefined, updateToPublish?.(result), kind, upstream);
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
    snapshot: BranchSnapshot,
    inputJournal: Omit<AppendBranchJournalInput, "generation">,
    currentDocument?: Y.Doc,
  ): Promise<boolean> {
    const cachedDoc = currentDocument ?? (await materialize(snapshot)).doc;
    // O(doc) clone-before-write is intentional per GATE-1 spec §9 (Q4 headroom):
    // failed CAS/rollback must never mutate the cached branch doc.
    const doc = cloneDoc(cachedDoc);
    const beforeState = Y.encodeStateAsUpdate(doc);
    Y.applyUpdate(doc, inputJournal.updateData);
    if (bytesEqual(beforeState, Y.encodeStateAsUpdate(doc))) {
      throw new BranchStaleUpdateError(inputJournal.branchId);
    }
    await persist(snapshot, doc, [{ ...inputJournal, generation: snapshot.generation }]);
    return true;
  }

  async function readUnder<T>(
    lease: BranchLockLease,
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T> {
    assertBranchLeaseCovers(lease, branchId);
    const snapshot = await loadSnapshot(branchId);
    const { doc } = await materialize(snapshot);
    return fn(doc, snapshot);
  }

  async function transientUnder<T>(
    lease: BranchLockLease,
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T> {
    assertBranchLeaseCovers(lease, branchId);
    const snapshot = await loadSnapshot(branchId);
    assertWritableBranch(snapshot);
    const { doc: cachedDoc } = await materialize(snapshot);
    const doc = cloneDoc(cachedDoc);
    const result = await fn(doc, snapshot);
    const next = {
      generation: snapshot.generation,
      state: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
      doc,
    };
    const transactionId = currentResponseTransactionId();
    if (!transactionId) {
      cached.set(snapshot.branchId, next);
      dirtyTransientBranches.add(snapshot.branchId);
      return result;
    }
    const key = pendingTransientKey(transactionId, snapshot.branchId);
    pendingTransients.set(key, next);
    enlistResponseParticipant({
      commit() {
        const pending = pendingTransients.get(key);
        if (!pending) return;
        pendingTransients.delete(key);
        cached.set(snapshot.branchId, pending);
        dirtyTransientBranches.add(snapshot.branchId);
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
      snapshot: BranchSnapshot,
    ) => Promise<{ result: T; rows: readonly Omit<AppendBranchJournalInput, "generation">[] }>,
    commit: boolean,
  ): Promise<T> {
    const snapshot = await loadSnapshot(branchId);
    assertWritableBranch(snapshot);
    const doc = cloneDoc((await materialize(snapshot)).doc);
    let published = false;
    try {
      const { result, rows } = await run(doc, snapshot);
      if (commit && rows.length) {
        const admitted = cloneDoc((await materialize(snapshot)).doc);
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
        await persist(
          snapshot,
          doc,
          rows.map((row) => ({ ...row, generation: snapshot.generation })),
        );
        published = true;
      }
      return result;
    } finally {
      // Persist owns the admitted document until its publication callback.
      if (!published) doc.destroy();
    }
  }

  async function segmentRowsUnder(batch: SegmentRowsInput): Promise<boolean> {
    const snapshot = await loadSnapshot(batch.branchId);
    assertWritableBranch(snapshot);
    if (snapshot.generation !== batch.expectedGeneration)
      throw new BranchStaleUpdateError(batch.branchId);
    const doc = cloneDoc((await materialize(snapshot)).doc);
    const journals = batch.rows.map((row) => ({ ...row, generation: snapshot.generation }));
    await applySegmentRows(doc, snapshot, journals);
    if (journalSyncDelta(batch.sourceDoc, doc))
      throw new Error("Segment publication left an unjournaled residual");
    if (!journals.length) return false;
    await persist(snapshot, doc, journals);
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

    withStagedRows(branchId, run, commit) {
      return criticalSections.withBranches([branchId], () =>
        stagedRowsUnder(branchId, run, commit),
      );
    },

    commitSegmentRows(batch) {
      return retryCas(() =>
        criticalSections.withBranches([batch.branchId], () => segmentRowsUnder(batch)),
      );
    },

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
      const current = cached.get(update.branchId);
      if (current) {
        Y.applyUpdate(current.doc, update.update);
        current.state = Y.encodeStateAsUpdate(current.doc);
        current.stateVector = Y.encodeStateVector(current.doc);
      }
      input.onBranchUpdate?.(update);
    },

    async commitWriterUpdate(inputWriter) {
      let attempt = 0;
      while (true) {
        try {
          return await criticalSections.withBranches([inputWriter.branchId], async () => {
            const snapshot = await loadSnapshot(inputWriter.branchId);
            const { doc: currentDocument } = await materialize(snapshot);
            const admission = await admitWriterUpdate({
              targetDocument: currentDocument,
              update: inputWriter.updateData,
              validateTarget() {
                if (
                  snapshot.kind !== "work_draft" ||
                  snapshot.status !== "active" ||
                  snapshot.generation !== inputWriter.expectedGeneration ||
                  !documentContainment.contains(inputWriter.roomDocument, snapshot.state)
                ) {
                  throw new BranchStaleUpdateError(inputWriter.branchId);
                }
              },
              isContained: () =>
                documentContainment.contains(currentDocument, inputWriter.updateData),
              append: () =>
                persistJournaledUpdate(
                  snapshot,
                  {
                    branchId: inputWriter.branchId,
                    updateData: inputWriter.updateData,
                    source: "writer",
                    actorUserId: inputWriter.actorUserId,
                    updateMeta: {
                      restorationAliases: certifyWriterRestorations(
                        currentDocument,
                        inputWriter.updateData,
                      ),
                    },
                  },
                  currentDocument,
                ),
            });
            return { admitted: admission.admitted };
          });
        } catch (cause) {
          if (!(cause instanceof BranchCasConflictError) || attempt++ >= maxCasRetries) throw cause;
        }
      }
    },
  };
}

function pendingTransientKey(transactionId: string, branchId: string): string {
  return `${transactionId}\0${branchId}`;
}

export function assertReadableBranch(snapshot: BranchSnapshot): void {
  if (isStaleSchema(snapshot.schemaVersion, COLLAB_SCHEMA_VERSION)) {
    throw new DocumentSchemaMajorMismatchError(
      snapshot.documentId,
      snapshot.schemaVersion,
      COLLAB_SCHEMA_VERSION,
    );
  }
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
