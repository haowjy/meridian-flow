/** Coordinates persisted branch-peer Y.Docs behind one mutation surface. */

import { bytesEqual } from "@meridian/agent-edit/integration";
import type { ThreadId } from "@meridian/contracts/runtime";
import { type CollabSchemaVersion, createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  assertBranchLeaseCovers,
  type BranchCriticalSections,
  type BranchLockLease,
  createBranchCriticalSections,
} from "./branch-critical-sections.js";
import type { BranchJournalReadStore, BranchJournalRow } from "./branch-push-contracts.js";
import { captureAppendReceipts } from "./branch-receipts.js";
import { BranchCorruptError } from "./branch-resolver.js";
import {
  type AppendBranchJournalInput,
  type AppendReceiptGroup,
  type AppendRowsInput,
  assertReadableBranch,
  BranchCasConflictError,
  BranchMissingError,
  type BranchRead,
  type BranchSnapshot,
  BranchStaleUpdateError,
  type BranchStore,
  materializeBranchRead,
  type RewriteFence,
} from "./branch-store.js";
import { createDocumentContainment } from "./document-containment.js";
import {
  type EffectFingerprint,
  effectFingerprint,
  effectFingerprintsEqual,
} from "./document-content.js";
import {
  admitCertifiedMutation,
  admitWriterUpdate,
  replicateFrozenIdentity,
} from "./document-mutation-policy.js";
import { currentResponseTransactionId, enlistResponseParticipant } from "./response-transaction.js";
import { certifyWriterRestorations } from "./writer-restoration.js";

/**
 * The branch as committed at `revision`: replaced, never mutated. `seq` is the highest journal
 * id it contains; `tail` counts the rows (and their bytes) it holds past its checkpoint;
 * `encoded` is its update bytes, computed once when first needed.
 */
type PublishedReplica = {
  readonly revision: number;
  readonly checkpointRevision: number;
  readonly seq: number;
  readonly generation: number;
  readonly doc: Y.Doc;
  readonly tail: TailSize;
  encoded?: Uint8Array;
};

type TailSize = { readonly rows: number; readonly bytes: number };
const EMPTY_TAIL: TailSize = { rows: 0, bytes: 0 };

function grownTail(tail: TailSize, updates: readonly Uint8Array[]): TailSize {
  return {
    rows: tail.rows + updates.length,
    bytes: updates.reduce((total, update) => total + update.byteLength, tail.bytes),
  };
}

/**
 * A tail past either bound is folded into a new checkpoint (decision D10): every cold read of
 * the branch replays its whole tail. The fold changes no content, effect or stamp.
 */
const COMPACT_TAIL_ROWS = 512;
const COMPACT_TAIL_BYTES = 2 * 1024 * 1024;

export type BranchCoordinatorDiagnostics = {
  /** A frame's append missed its revision; `attempt` is the one it judges next. */
  frameRetried(input: { branchId: string; attempt: number }): void;
  /** The background tail fold failed; the tail stays until the next frame crosses the bound. */
  compactionFailed(input: { branchId: string; cause: unknown }): void;
};

/**
 * What a branch operation works from: the committed replica at the row's revision and the
 * row read's review-membership inputs.
 */
type BranchBase = {
  snapshot: BranchSnapshot;
  replica: PublishedReplica;
  pendingRows: boolean;
  liveCutStored: boolean;
};

/** A work draft's effect baseline as fingerprinted, at the checkpoint revision it was read. */
type CachedBaseline = { checkpointRevision: number; fingerprint: EffectFingerprint };

/**
 * A branch write prepared on a private candidate: nothing is persisted until `persist` runs
 * inside the caller's commit scope, nothing is visible until `publish` runs after that scope
 * succeeded, and `dispose` drops it on a miss. `persist` throws `BranchCasConflictError` when
 * the branch moved since the candidate's base.
 */
export type PreparedBranchWrite = {
  readonly branchId: string;
  /** The content the write commits; read it, never mutate it. */
  readonly candidate: Y.Doc;
  persist(): Promise<void>;
  publish(): void;
  dispose(): void;
};

/** A frame's commit attempts: three judged off every lock, the fourth under its Work and row. */
const FRAME_ATTEMPTS = 4;

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
  /** A private copy of the branch for `fn` to change; nothing it does is kept or published. */
  withTransient<T>(
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T>;
  /**
   * Replays a response's rows on a candidate of the committed branch. With `commit`, the rows
   * come back as a prepared write (null when there are none) for the caller's commit scope.
   */
  prepareStagedRows<T>(
    branchId: string,
    run: (
      doc: Y.Doc,
      snapshot: StagedBranchView,
    ) => Promise<{ result: T; rows: readonly Omit<AppendBranchJournalInput, "generation">[] }>,
    commit: boolean,
  ): Promise<{ result: T; write: PreparedBranchWrite | null }>;
  /** `source` merged into the branch as a checkpoint write; null when it holds `source` already. */
  prepareCatchUp(branchId: string, source: Y.Doc): Promise<PreparedBranchWrite | null>;
  commitSegmentRows(input: SegmentRowsInput): Promise<boolean>;
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
      fence?: RewriteFence;
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
  diagnostics?: BranchCoordinatorDiagnostics;
}): BranchCoordinator {
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const documentContainment = createDocumentContainment();
  const published = new Map<string, PublishedReplica>();
  const baselines = new Map<string, CachedBaseline>();
  const compacting = new Set<string>();
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
      fence?: RewriteFence;
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
      resetInput.fence,
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
    return {
      snapshot,
      replica: replicaFor(read, current),
      pendingRows: read.pendingRows,
      liveCutStored: read.liveCutStored,
    };
  }

  function replicaFor(read: BranchRead, current: PublishedReplica | undefined): PublishedReplica {
    const { branch } = read;
    if (current?.revision === branch.revision) return current;
    try {
      let next: PublishedReplica;
      if (!read.checkpoint && current) {
        // Only appends (or metadata-only bumps) since the replica: apply the tail to a copy.
        const doc = read.tail.length ? cloneReplica(current) : current.doc;
        for (const row of read.tail) Y.applyUpdate(doc, row.update);
        next = {
          revision: branch.revision,
          checkpointRevision: branch.checkpointRevision,
          seq: Math.max(current.seq, ...read.tail.map((row) => row.id)),
          generation: branch.generation,
          doc,
          tail: grownTail(
            current.tail,
            read.tail.map((row) => row.update),
          ),
          ...(read.tail.length ? {} : { encoded: current.encoded }),
        };
      } else {
        next = {
          revision: branch.revision,
          checkpointRevision: branch.checkpointRevision,
          seq: Math.max(branch.checkpointSeq, ...read.tail.map((row) => row.id)),
          generation: branch.generation,
          doc: materializeBranchRead(read),
          tail: grownTail(
            EMPTY_TAIL,
            read.tail.map((row) => row.update),
          ),
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
  }

  /** After commit: the candidate becomes the published replica and the room hears the rows. */
  function afterCommit(
    branchId: string,
    replica: PublishedReplica,
    update: Uint8Array | undefined,
  ): void {
    const publish = () => {
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

  /** A private, mutable copy of a replica: one apply of its cached bytes. */
  function cloneReplica(replica: PublishedReplica): Y.Doc {
    const doc = createCollabYDoc({ gc: false });
    Y.applyUpdate(doc, encodedOf(replica));
    return doc;
  }

  /** The work draft's baseline fingerprint, cached per checkpoint while `live_cut` is stored. */
  async function effectBaseline(
    base: BranchBase,
  ): Promise<{ fingerprint: EffectFingerprint; unstored?: Uint8Array }> {
    const { branchId, checkpointRevision } = base.snapshot;
    const cached = baselines.get(branchId);
    if (base.liveCutStored && cached?.checkpointRevision === checkpointRevision)
      return { fingerprint: cached.fingerprint };
    const baseline = await input.store.readEffectBaseline(branchId);
    if (!baseline) throw new BranchStaleUpdateError(branchId);
    const doc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(doc, baseline.state);
      const fingerprint = effectFingerprint(doc);
      if (baseline.stored) {
        baselines.set(branchId, { checkpointRevision: baseline.checkpointRevision, fingerprint });
        return { fingerprint };
      }
      return { fingerprint, unstored: baseline.state };
    } finally {
      doc.destroy();
    }
  }

  /**
   * The effect half of an append judged on `candidate`: a work draft's `has_effect`, the
   * baseline to store when none is, and the Work to lock and touch when the append flips
   * the branch's review membership (`(has_effect or blocking) and pending rows`).
   */
  async function appendEffect(
    base: BranchBase,
    candidate: Y.Doc,
  ): Promise<Pick<AppendRowsInput, "hasEffect" | "liveCut" | "workTouch">> {
    const { snapshot } = base;
    if (snapshot.kind !== "work_draft") return {};
    const baseline = await effectBaseline(base);
    const hasEffect = !effectFingerprintsEqual(baseline.fingerprint, effectFingerprint(candidate));
    const member = (effect: boolean, rows: boolean) => (effect || snapshot.blocking) && rows;
    const flips = member(snapshot.hasEffect, base.pendingRows) !== member(hasEffect, true);
    return {
      hasEffect,
      ...(baseline.unstored ? { liveCut: baseline.unstored } : {}),
      ...(flips && snapshot.workId ? { workTouch: snapshot.workId } : {}),
    };
  }

  /**
   * Rows judged on `candidate` (which already holds them) as an append at the base's
   * revision, with the receipts computed before the rows and the effect computed after.
   */
  async function prepareAppend(
    base: BranchBase,
    candidate: Y.Doc,
    journals: readonly AppendBranchJournalInput[],
    receipts: readonly AppendReceiptGroup[],
  ): Promise<PreparedBranchWrite> {
    const { snapshot } = base;
    const effect = await appendEffect(base, candidate);
    let committed: PublishedReplica | undefined;
    return {
      branchId: snapshot.branchId,
      candidate,
      async persist() {
        const outcome = await input.store.appendRows({
          branchId: snapshot.branchId,
          documentId: snapshot.documentId,
          expectedRevision: snapshot.revision,
          expectedGeneration: snapshot.generation,
          rows: journals,
          receipts,
          ...effect,
        });
        if (outcome.status !== "appended") throw new BranchCasConflictError(snapshot.branchId);
        committed = {
          revision: outcome.revision,
          checkpointRevision: base.replica.checkpointRevision,
          seq: Math.max(base.replica.seq, ...outcome.rowIds),
          generation: snapshot.generation,
          doc: candidate,
          tail: grownTail(
            base.replica.tail,
            journals.map((row) => row.updateData),
          ),
        };
      },
      publish() {
        if (!committed) throw new Error(`Branch ${snapshot.branchId} write was never persisted`);
        afterCommit(
          snapshot.branchId,
          committed,
          journals.length ? Y.mergeUpdates(journals.map((row) => row.updateData)) : undefined,
        );
      },
      dispose() {
        if (!committed) candidate.destroy();
      },
    };
  }

  /** `candidate` as the branch's checkpoint at the base's exact revision. */
  function prepareCheckpoint(base: BranchBase, candidate: Y.Doc): PreparedBranchWrite {
    const { snapshot } = base;
    let committed: PublishedReplica | undefined;
    return {
      branchId: snapshot.branchId,
      candidate,
      async persist() {
        const outcome = await input.store.commitRewrite({
          branchId: snapshot.branchId,
          policy: { kind: "exact", revision: snapshot.revision },
          fence: { kind: "none" },
          doc: candidate,
          operation: { kind: "checkpoint" },
        });
        if (outcome.status !== "committed") throw new BranchCasConflictError(snapshot.branchId);
        committed = { ...outcome, doc: candidate, tail: EMPTY_TAIL };
      },
      publish() {
        if (!committed) throw new Error(`Branch ${snapshot.branchId} write was never persisted`);
        afterCommit(snapshot.branchId, committed, undefined);
      },
      dispose() {
        if (!committed) candidate.destroy();
      },
    };
  }

  /** Persists and publishes one prepared write on its own, as an operation's whole attempt. */
  async function commitAlone(write: PreparedBranchWrite): Promise<void> {
    try {
      await write.persist();
    } catch (cause) {
      write.dispose();
      throw cause;
    }
    write.publish();
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
    if (outcome.status !== "committed") throw new BranchCasConflictError(snapshot.branchId);
    afterCommit(snapshot.branchId, { ...outcome, doc: candidate, tail: EMPTY_TAIL }, publishUpdate);
  }

  /**
   * Folds a long tail into a new checkpoint in the background, under the branch's lease (it
   * still excludes rewrites from each other): content-free, so a frame or inverse that lands
   * meanwhile is folded in or recaptures, never lost. Called after a writer frame commits,
   * outside every transaction; a failure is reported and leaves the tail for the next frame.
   */
  function compactIfLong(branchId: string): void {
    const long = (tail: TailSize) =>
      tail.rows >= COMPACT_TAIL_ROWS || tail.bytes >= COMPACT_TAIL_BYTES;
    const replica = published.get(branchId);
    if (!replica || compacting.has(branchId) || !long(replica.tail)) return;
    compacting.add(branchId);
    void criticalSections
      .withBranches([branchId], async () => {
        const { replica: current } = await loadBase(branchId);
        if (!long(current.tail)) return;
        const doc = cloneReplica(current);
        const outcome = await input.store.commitRewrite({
          branchId,
          policy: {
            kind: "fold",
            checkpointRevision: current.checkpointRevision,
            seq: current.seq,
          },
          fence: { kind: "none" },
          doc,
          operation: { kind: "compact" },
        });
        // A moved or closed branch: the next frame past the bound tries again.
        if (outcome.status !== "committed") {
          doc.destroy();
          return;
        }
        afterCommit(branchId, { ...outcome, doc, tail: EMPTY_TAIL }, undefined);
      })
      .catch((cause: unknown) => input.diagnostics?.compactionFailed({ branchId, cause }))
      .finally(() => compacting.delete(branchId));
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
    fence: RewriteFence = { kind: "none" },
  ): Promise<void> {
    const resetDoc = createCollabYDoc({ gc: false });
    try {
      await replicateFrozenSource(upstream, resetDoc);
      const outcome = await input.store.commitRewrite({
        branchId: snapshot.branchId,
        policy: { kind: "exact", revision: snapshot.revision },
        fence,
        doc: resetDoc,
        operation: { kind: "reset", editDisposition, schemaVersion },
      });
      if (outcome.status !== "committed") throw new BranchCasConflictError(snapshot.branchId);
      forget(snapshot.branchId);
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
    const doc = cloneReplica(base.replica);
    let committed = false;
    try {
      const result = await operation(snapshot, doc);
      await persistCheckpoint(base, doc, kind, updateToPublish?.(result), upstream);
      committed = true;
      return result;
    } finally {
      if (!committed) doc.destroy();
    }
  }

  /** Retries a CAS conflict: four attempts, each recapturing the branch. */
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

  async function readUnder<T>(
    lease: BranchLockLease,
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T> {
    assertBranchLeaseCovers(lease, branchId);
    const base = await loadBase(branchId);
    return fn(base.replica.doc, base.snapshot);
  }

  /** A private copy for `fn`: whatever it changes stays with the copy (decision F6). */
  async function transientUnder<T>(
    lease: BranchLockLease,
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T> {
    assertBranchLeaseCovers(lease, branchId);
    const base = await loadBase(branchId);
    assertWritableBranch(base.snapshot);
    const doc = cloneReplica(base.replica);
    try {
      return await fn(doc, base.snapshot);
    } finally {
      doc.destroy();
    }
  }

  async function prepareStagedRows<T>(
    branchId: string,
    run: (
      doc: Y.Doc,
      snapshot: StagedBranchView,
    ) => Promise<{ result: T; rows: readonly Omit<AppendBranchJournalInput, "generation">[] }>,
    commit: boolean,
  ): Promise<{ result: T; write: PreparedBranchWrite | null }> {
    const base = await loadBase(branchId);
    const { snapshot } = base;
    assertWritableBranch(snapshot);
    const doc = cloneReplica(base.replica);
    let write: PreparedBranchWrite | null = null;
    try {
      const { result, rows } = await run(doc, { ...snapshot, encoded: encodedOf(base.replica) });
      if (commit && rows.length) {
        const journals = rows.map((row) => ({ ...row, generation: snapshot.generation }));
        const admitted = cloneReplica(base.replica);
        try {
          await applySegmentRows(admitted, snapshot, journals);
          if (!bytesEqual(Y.encodeStateAsUpdate(admitted), Y.encodeStateAsUpdate(doc)))
            throw new Error("Response replay differs from its admitted segment rows");
        } finally {
          admitted.destroy();
        }
        const receiptDoc = cloneReplica(base.replica);
        let receipts: AppendReceiptGroup[];
        try {
          receipts = captureAppendReceipts(receiptDoc, journals);
        } finally {
          receiptDoc.destroy();
        }
        write = await prepareAppend(base, doc, journals, receipts);
      }
      return { result, write };
    } finally {
      if (!write) doc.destroy();
    }
  }

  async function prepareCatchUp(
    branchId: string,
    source: Y.Doc,
  ): Promise<PreparedBranchWrite | null> {
    const base = await loadBase(branchId);
    assertWritableBranch(base.snapshot);
    const update = Y.encodeStateAsUpdate(source);
    if (documentContainment.contains(base.replica.doc, update)) return null;
    const candidate = cloneReplica(base.replica);
    Y.applyUpdate(candidate, update);
    return prepareCheckpoint(base, candidate);
  }

  async function segmentRowsUnder(batch: SegmentRowsInput): Promise<boolean> {
    const base = await loadBase(batch.branchId);
    const { snapshot } = base;
    assertWritableBranch(snapshot);
    if (snapshot.generation !== batch.expectedGeneration)
      throw new BranchStaleUpdateError(batch.branchId);
    const journals = batch.rows.map((row) => ({ ...row, generation: snapshot.generation }));
    const doc = cloneReplica(base.replica);
    let receipts: AppendReceiptGroup[];
    try {
      await applySegmentRows(doc, snapshot, journals);
      if (journalSyncDelta(batch.sourceDoc, doc))
        throw new Error("Segment publication left an unjournaled residual");
      if (!journals.length) {
        doc.destroy();
        return false;
      }
      const receiptDoc = cloneReplica(base.replica);
      try {
        receipts = captureAppendReceipts(receiptDoc, journals);
      } finally {
        receiptDoc.destroy();
      }
    } catch (cause) {
      doc.destroy();
      throw cause;
    }
    await commitAlone(await prepareAppend(base, doc, journals, receipts));
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
      prepareStagedRows: (branchId, run, commit) =>
        under(branchId, () => prepareStagedRows(branchId, run, commit)),
      prepareCatchUp: (branchId, source) => under(branchId, () => prepareCatchUp(branchId, source)),
      commitSegmentRows: (batch) =>
        under(batch.branchId, () => retryCas(() => segmentRowsUnder(batch))),
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

  /**
   * A writer frame, with no lease and no process-level ordering (section 2.2): judged on a
   * private candidate of the committed replica, appended under the revision it was judged
   * at, published only once committed. A miss destroys the candidate and judges again on
   * the new revision; the fourth attempt holds the Work row and the branch row.
   *
   * Only the first attempt fences a stale room (one missing a committed update: `1008`). A
   * retry exists because a concurrent commit moved the branch, and that commit reaches this
   * room through its own publish, which runs after its COMMIT returns and so may land after
   * this frame judges again: the room lags it without being stale.
   */
  async function commitWriterUpdate(
    inputWriter: Parameters<BranchCoordinator["commitWriterUpdate"]>[0],
  ): Promise<{ admitted: boolean }> {
    for (let attempt = 1; ; attempt++) {
      const locked = attempt === FRAME_ATTEMPTS;
      const judge = () => judgeWriterUpdate(inputWriter, { fenceRoom: attempt === 1 });
      const outcome = locked
        ? await input.store.withJudgementLocks(inputWriter.branchId, judge)
        : await judge();
      if (outcome === "admitted") compactIfLong(inputWriter.branchId);
      if (outcome !== "moved") return { admitted: outcome === "admitted" };
      // Under its own row lock the append cannot miss; a miss there is a moved branch.
      if (locked) throw new BranchStaleUpdateError(inputWriter.branchId);
      input.diagnostics?.frameRetried({ branchId: inputWriter.branchId, attempt: attempt + 1 });
    }
  }

  async function judgeWriterUpdate(
    inputWriter: Parameters<BranchCoordinator["commitWriterUpdate"]>[0],
    { fenceRoom }: { fenceRoom: boolean },
  ): Promise<"admitted" | "contained" | "moved"> {
    const base = await loadBase(inputWriter.branchId);
    const { snapshot, replica } = base;
    const admission = await admitWriterUpdate({
      targetDocument: replica.doc,
      update: inputWriter.updateData,
      validateTarget() {
        if (
          snapshot.kind !== "work_draft" ||
          snapshot.status !== "active" ||
          snapshot.lifecycle !== "active" ||
          snapshot.generation !== inputWriter.expectedGeneration ||
          (fenceRoom && !documentContainment.contains(inputWriter.roomDocument, encodedOf(replica)))
        ) {
          throw new BranchStaleUpdateError(inputWriter.branchId);
        }
      },
      isContained: () => documentContainment.contains(replica.doc, inputWriter.updateData),
      append: async () => {
        const journals: AppendBranchJournalInput[] = [
          {
            branchId: inputWriter.branchId,
            generation: snapshot.generation,
            updateData: inputWriter.updateData,
            source: "writer",
            actorUserId: inputWriter.actorUserId,
            updateMeta: {
              restorationAliases: certifyWriterRestorations(replica.doc, inputWriter.updateData),
            },
          },
        ];
        const candidate = cloneReplica(replica);
        let write: PreparedBranchWrite;
        try {
          const receipts = captureAppendReceipts(candidate, journals);
          write = await prepareAppend(base, candidate, journals, receipts);
        } catch (cause) {
          candidate.destroy();
          throw cause;
        }
        try {
          await write.persist();
        } catch (cause) {
          write.dispose();
          if (cause instanceof BranchCasConflictError) return false;
          throw cause;
        }
        write.publish();
        return true;
      },
    });
    if (!admission.admitted) return "contained";
    return admission.value ? "admitted" : "moved";
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
