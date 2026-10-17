/** Coordinates persisted branch-peer Y.Docs behind one mutation surface. */

import { bytesEqual } from "@meridian/agent-edit/integration";
import type { ThreadId } from "@meridian/contracts/runtime";
import { type CollabSchemaVersion, createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  type Attempt,
  type AttemptScope,
  NO_ATTEMPT_SCOPE,
  runBoundedAttempts,
} from "./branch-attempts.js";
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
  type CommitRewriteInput,
  materializeBranchRead,
  membershipFlipWork,
  type RewriteFence,
  type RewriteOperation,
} from "./branch-store.js";
import { collabHook } from "./collab-test-hooks.js";
import { createDocumentContainment } from "./document-containment.js";
import {
  documentEffectsEqual,
  type EffectFingerprint,
  effectFingerprint,
  effectFingerprintsEqual,
} from "./document-content.js";
import {
  admitSegmentRows,
  admitWriterUpdate,
  replicateFrozenSource,
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
 * A branch write prepared on a private candidate, an `AttemptCandidate` of the attempt that
 * prepared it: nothing is persisted until `persist` runs inside that attempt's commit scope,
 * nothing is visible until `transfer` hands it to publication once the whole attempt
 * completed, and `dispose` drops it on any unwind. `persist` throws `BranchCasConflictError`
 * when the branch moved since the candidate's base.
 */
export type PreparedBranchWrite = {
  readonly branchId: string;
  /** The content the write commits; read it, never mutate it. */
  readonly candidate: Y.Doc;
  persist(): Promise<void>;
  transfer(): void;
  dispose(): void;
};

/** A frame's commit attempts: three judged off every lock, the fourth under its Work and row. */
const FRAME_ATTEMPTS = 4;

/** Every other exact-predicate write: four commit attempts, then the caller's own outcome. */
const COMMIT_ATTEMPTS = 4;

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

/**
 * A work draft re-forked from `upstream` at the generation it was read: `exact` only at the
 * revision read; `fold` over every append since, which the reset discards with its clocks fenced.
 */
export type ResetFromDocInput = Omit<ResetInput, "expectedRevision"> &
  ({ policy: "exact"; expectedRevision: number } | { policy: "fold" });

/** A work draft re-forked from `upstream`, only at the generation and revision it was read. */
type ResetInput = {
  branchId: string;
  upstream: Y.Doc;
  expectedGeneration: number;
  expectedRevision: number;
  schemaVersion?: CollabSchemaVersion;
  editDisposition?: "discarded" | "retired";
  fence?: RewriteFence;
};

export type BranchCoordinator = {
  /**
   * Merges `upstream` into the branch under a lease the caller holds (a pull takes its
   * branches' leases first), outside any transaction: each attempt is its own commit scope.
   * Throws for a branch the lease does not cover.
   */
  pullFromDoc(lease: BranchLockLease, branchId: string, upstream: Y.Doc): Promise<Uint8Array>;
  resetFromDocIfUnchangedWithLease(lease: BranchLockLease, input: ResetInput): Promise<boolean>;
  /**
   * Re-forks a work draft from `upstream` inside the caller's transaction, with no lease:
   * false when the branch is no longer at the generation (or, `exact`, the revision) read.
   * With `owner`, the caller's attempt owns the reset candidate and the write runs in its
   * already-open commit scope, so a later miss in that attempt disposes it; without one, the
   * reset is a single attempt in the caller's transaction. A moved branch throws
   * `BranchCasConflictError` for the caller's attempt to classify.
   */
  resetFromDoc(input: ResetFromDocInput, owner?: Attempt): Promise<boolean>;
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
  /** Each attempt's rollback boundary: a root transaction, or a savepoint in an ambient one. */
  attemptScope?: AttemptScope;
  onBranchUpdate?: (input: { branchId: string; update: Uint8Array }) => void;
  onBranchReset?: (input: { branchId: string; generation: number }) => void;
  diagnostics?: BranchCoordinatorDiagnostics;
}): BranchCoordinator {
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const attemptScope = input.attemptScope ?? NO_ATTEMPT_SCOPE;
  const documentContainment = createDocumentContainment();
  const published = new Map<string, PublishedReplica>();
  const baselines = new Map<string, CachedBaseline>();
  const compacting = new Set<string>();

  /**
   * An exact-predicate write's attempts: a moved branch recaptures, and the last miss is
   * `moved`'s to answer (by default it throws).
   */
  function commitAttempts<T>(
    run: (attempt: Attempt) => Promise<T>,
    options: { bound?: number; scope?: AttemptScope; moved?: (cause: unknown) => T } = {},
  ): Promise<T> {
    return runBoundedAttempts({
      bound: options.bound ?? COMMIT_ATTEMPTS,
      scope: options.scope ?? attemptScope,
      isMiss: (cause) => cause instanceof BranchCasConflictError,
      run,
      exhausted:
        options.moved ??
        ((cause) => {
          throw cause;
        }),
    });
  }

  /** One write as a whole attempt inside `scope`. */
  function commitOnce(
    write: PreparedBranchWrite,
    options: { scope?: AttemptScope; moved?: (cause: unknown) => void },
  ): Promise<void> {
    return commitAttempts(
      async (attempt) => {
        attempt.own(write);
        await attempt.commit(() => write.persist());
      },
      { bound: 1, ...options },
    );
  }

  async function resetFromDocIfUnchangedWithLease(
    lease: BranchLockLease,
    resetInput: ResetInput,
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
    const { write } = await prepareReset(snapshot, resetInput.upstream, resetInput);
    // The caller's transaction is the scope; its miss handling is the caller's too.
    await commitOnce(write, { scope: NO_ATTEMPT_SCOPE });
    return true;
  }

  async function resetFromDoc(resetInput: ResetFromDocInput, owner?: Attempt): Promise<boolean> {
    const snapshot = await loadSnapshot(resetInput.branchId);
    assertWorkDraftResetTarget(snapshot);
    if (snapshot.generation !== resetInput.expectedGeneration) return false;
    if (resetInput.policy === "exact" && snapshot.revision !== resetInput.expectedRevision)
      return false;
    const policy =
      resetInput.policy === "exact"
        ? { kind: "exact" as const, revision: snapshot.revision }
        : {
            kind: "fold" as const,
            checkpointRevision: snapshot.checkpointRevision,
            seq: snapshot.checkpointSeq,
          };
    const { write } = await prepareReset(snapshot, resetInput.upstream, resetInput, policy);
    if (!owner) {
      await commitOnce(write, { scope: NO_ATTEMPT_SCOPE });
      return true;
    }
    owner.own(write);
    await write.persist();
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
      publishAfterCommit(branch.branchId, next);
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
   * Publication is committed state only: a replica becomes visible when the transaction it
   * was read or written in commits, and a lower revision never replaces a higher one. A
   * candidate whose transaction rolls back instead is destroyed; the room hears `update`.
   */
  function publishAfterCommit(
    branchId: string,
    replica: PublishedReplica,
    candidate?: { update: Uint8Array | undefined },
  ): void {
    const publish = () => {
      const current = published.get(branchId);
      if (!current || current.revision < replica.revision) published.set(branchId, replica);
      if (candidate?.update) input.onBranchUpdate?.({ branchId, update: candidate.update });
    };
    const abort = () => {
      if (candidate) replica.doc.destroy();
    };
    if (currentResponseTransactionId()) {
      enlistResponseParticipant({ commit: publish, abort });
      return;
    }
    if (!input.store.deferUntilCommit(publish, abort)) publish();
  }

  function encodedOf(replica: PublishedReplica): Uint8Array {
    replica.encoded ??= Y.encodeStateAsUpdate(replica.doc);
    return replica.encoded;
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
    const workTouch = membershipFlipWork(
      { branch: snapshot, pendingRows: base.pendingRows },
      hasEffect,
    );
    return {
      hasEffect,
      ...(baseline.unstored ? { liveCut: baseline.unstored } : {}),
      ...(workTouch ? { workTouch } : {}),
    };
  }

  /**
   * The one lifetime of a prepared write: prepared (nothing persisted), persisted in its
   * attempt (written, but the attempt can still roll it back), transferred (the attempt
   * completed; publication owns the candidate, or a reset closes the room). Disposing destroys
   * the candidate in every state but the last, so a write whose own statement succeeded in a
   * scope that a later miss rolled back is dropped like one that never ran.
   */
  function preparedWrite(write: {
    branchId: string;
    candidate: Y.Doc;
    /** The room's update once published; none for a checkpoint the room already holds. */
    update?: Uint8Array;
    persist(): Promise<PublishedReplica | { resetTo: number }>;
  }): PreparedBranchWrite {
    let state: "prepared" | "persisted" | "transferred" | "disposed" = "prepared";
    let committed: PublishedReplica | { resetTo: number } | undefined;
    return {
      branchId: write.branchId,
      candidate: write.candidate,
      async persist() {
        if (state !== "prepared") throw new Error(`Branch ${write.branchId} write is ${state}`);
        committed = await write.persist();
        state = "persisted";
      },
      transfer() {
        if (state !== "persisted" || !committed)
          throw new Error(`Branch ${write.branchId} write was never persisted`);
        state = "transferred";
        if (!("resetTo" in committed)) {
          publishAfterCommit(write.branchId, committed, { update: write.update });
          return;
        }
        // A reset's candidate is never published: the room closes on the new generation.
        write.candidate.destroy();
        notifyReset({ branchId: write.branchId, generation: committed.resetTo });
      },
      dispose() {
        if (state === "transferred" || state === "disposed") return;
        state = "disposed";
        write.candidate.destroy();
      },
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
    const { snapshot, replica } = base;
    const effect = await appendEffect(base, candidate);
    return preparedWrite({
      branchId: snapshot.branchId,
      candidate,
      ...(journals.length ? { update: Y.mergeUpdates(journals.map((row) => row.updateData)) } : {}),
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
        return {
          revision: outcome.revision,
          checkpointRevision: replica.checkpointRevision,
          seq: Math.max(replica.seq, ...outcome.rowIds),
          generation: snapshot.generation,
          doc: candidate,
          tail: grownTail(
            replica.tail,
            journals.map((row) => row.updateData),
          ),
        };
      },
    });
  }

  /** `candidate` committed through shape B as `rewrite` describes it. */
  function prepareRewrite(
    branchId: string,
    candidate: Y.Doc,
    rewrite: Omit<CommitRewriteInput, "branchId" | "doc">,
    update?: Uint8Array,
  ): PreparedBranchWrite {
    return preparedWrite({
      branchId,
      candidate,
      ...(update ? { update } : {}),
      async persist() {
        const outcome = await input.store.commitRewrite({ branchId, doc: candidate, ...rewrite });
        if (outcome.status !== "committed") throw new BranchCasConflictError(branchId);
        if (rewrite.operation.kind === "reset") return { resetTo: outcome.generation };
        return { ...outcome, doc: candidate, tail: EMPTY_TAIL };
      },
    });
  }

  /**
   * `candidate` as the branch's checkpoint at the base's exact revision: a peer's catch-up,
   * or a pull with the effect it was computed to have against `upstream`.
   */
  function prepareCheckpoint(
    base: BranchBase,
    candidate: Y.Doc,
    pull?: { upstream: Y.Doc; update: Uint8Array },
  ): PreparedBranchWrite {
    const { snapshot } = base;
    const operation: RewriteOperation = !pull
      ? { kind: "checkpoint" }
      : snapshot.kind === "work_draft"
        ? {
            kind: "pull",
            effect: {
              hasEffect: !documentEffectsEqual(pull.upstream, candidate),
              liveCut: Y.encodeStateAsUpdate(pull.upstream),
            },
          }
        : { kind: "pull" };
    const policy = { kind: "exact" as const, revision: snapshot.revision };
    return prepareRewrite(
      snapshot.branchId,
      candidate,
      { policy, fence: { kind: "none" }, operation },
      pull?.update,
    );
  }

  /** A re-fork of the branch from `upstream` at the snapshot's exact revision. */
  async function prepareReset(
    snapshot: BranchSnapshot,
    upstream: Y.Doc,
    reset: Pick<ResetInput, "schemaVersion" | "editDisposition" | "fence">,
    policy: CommitRewriteInput["policy"] = { kind: "exact", revision: snapshot.revision },
  ): Promise<{ write: PreparedBranchWrite; update: Uint8Array }> {
    const candidate = createCollabYDoc({ gc: false });
    const update = await replicatedInto(upstream, candidate);
    const operation = {
      kind: "reset" as const,
      editDisposition: reset.editDisposition ?? "discarded",
      schemaVersion: reset.schemaVersion ?? snapshot.schemaVersion,
    };
    const fence = reset.fence ?? { kind: "none" };
    const write = prepareRewrite(snapshot.branchId, candidate, { policy, fence, operation });
    return { write, update };
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
        const policy = {
          kind: "fold" as const,
          checkpointRevision: current.checkpointRevision,
          seq: current.seq,
        };
        const write = prepareRewrite(branchId, cloneReplica(current), {
          policy,
          fence: { kind: "none" },
          operation: { kind: "compact" },
        });
        // A moved or closed branch: the next frame past the bound tries again.
        await commitOnce(write, { moved: () => {} });
      })
      .catch((cause: unknown) => input.diagnostics?.compactionFailed({ branchId, cause }))
      .finally(() => compacting.delete(branchId));
  }

  function notifyReset(reset: { branchId: string; generation: number }): void {
    published.delete(reset.branchId);
    const publish = () => input.onBranchReset?.(reset);
    if (!input.store.deferUntilCommit(publish)) publish();
  }

  /**
   * One pull attempt: everything, the effect included, computed on a candidate of the
   * committed replica before the attempt's scope; inside it only the revision is compared and
   * the checkpoint written.
   */
  async function pullAttempt(
    attempt: Attempt,
    branchId: string,
    upstream: Y.Doc,
  ): Promise<Uint8Array> {
    const base = await loadBase(branchId);
    const { snapshot } = base;
    // A durable thread peer has already saved its writes into the Work draft. If the parent
    // no longer contains them, a review retired their effect: merging cannot remove those
    // structs or undo their tombstones, so the peer re-forks from the parent.
    if (
      snapshot.kind === "thread_peer" &&
      !Y.snapshotContainsUpdate(Y.snapshot(upstream), encodedOf(base.replica))
    ) {
      const { write, update } = await prepareReset(snapshot, upstream, {});
      attempt.own(write);
      await attempt.commit(() => write.persist());
      return update;
    }
    const candidate = cloneReplica(base.replica);
    const update = await replicatedInto(upstream, candidate);
    const write = attempt.own(prepareCheckpoint(base, candidate, { upstream, update }));
    await attempt.commit(() => write.persist());
    return update;
  }

  /** `source` replicated into `target`, which is destroyed when replication fails. */
  async function replicatedInto(source: Y.Doc, target: Y.Doc): Promise<Uint8Array> {
    try {
      return await replicateFrozenSource(source, target);
    } catch (cause) {
      target.destroy();
      throw cause;
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

  /** The rows' receipts, captured on a fresh copy of the base before the rows apply. */
  function receiptsBefore(
    base: BranchBase,
    journals: readonly AppendBranchJournalInput[],
  ): AppendReceiptGroup[] {
    const receiptDoc = cloneReplica(base.replica);
    try {
      return captureAppendReceipts(receiptDoc, journals);
    } finally {
      receiptDoc.destroy();
    }
  }

  /**
   * `journals` admitted on a fresh candidate of the base, as an append with their receipts:
   * the one way a save's replay and a segment batch prepare rows.
   */
  async function prepareRows(
    base: BranchBase,
    journals: readonly AppendBranchJournalInput[],
  ): Promise<PreparedBranchWrite> {
    const candidate = cloneReplica(base.replica);
    try {
      await admitSegmentRows(candidate, base.snapshot, journals);
      return await prepareAppend(base, candidate, journals, receiptsBefore(base, journals));
    } catch (cause) {
      candidate.destroy();
      throw cause;
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
    const replay = cloneReplica(base.replica);
    try {
      const { result, rows } = await run(replay, { ...snapshot, encoded: encodedOf(base.replica) });
      if (!commit || !rows.length) return { result, write: null };
      const write = await prepareRows(
        base,
        rows.map((row) => ({ ...row, generation: snapshot.generation })),
      );
      if (!bytesEqual(Y.encodeStateAsUpdate(write.candidate), Y.encodeStateAsUpdate(replay))) {
        write.dispose();
        throw new Error("Response replay differs from its admitted segment rows");
      }
      return { result, write };
    } finally {
      replay.destroy();
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

  async function segmentRowsAttempt(attempt: Attempt, batch: SegmentRowsInput): Promise<boolean> {
    const base = await loadBase(batch.branchId);
    const { snapshot } = base;
    assertWritableBranch(snapshot);
    if (snapshot.generation !== batch.expectedGeneration)
      throw new BranchStaleUpdateError(batch.branchId);
    const journals = batch.rows.map((row) => ({ ...row, generation: snapshot.generation }));
    const write = journals.length ? attempt.own(await prepareRows(base, journals)) : null;
    if (journalSyncDelta(batch.sourceDoc, write?.candidate ?? base.replica.doc))
      throw new Error("Segment publication left an unjournaled residual");
    if (!write) return false;
    await attempt.commit(() => write.persist());
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
        under(batch.branchId, () =>
          commitAttempts((attempt) => segmentRowsAttempt(attempt, batch)),
        ),
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
      return commitAttempts((attempt) => pullAttempt(attempt, branchId, upstream));
    },

    resetFromDocIfUnchangedWithLease,
    resetFromDoc,

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
   * the new revision; the fourth attempt judges under the Work row and the branch row.
   *
   * Only the first attempt fences a stale room (one missing a committed update: `1008`). A
   * retry exists because a concurrent commit moved the branch, and that commit reaches this
   * room through its own publish, which runs after its COMMIT returns and so may land after
   * this frame judges again: the room lags it without being stale.
   */
  async function commitWriterUpdate(
    inputWriter: Parameters<BranchCoordinator["commitWriterUpdate"]>[0],
  ): Promise<{ admitted: boolean }> {
    const { branchId } = inputWriter;
    const outcome = await runBoundedAttempts({
      bound: FRAME_ATTEMPTS,
      scope: attemptScope,
      isMiss: (cause) => cause instanceof BranchCasConflictError,
      retrying: (attempt) => input.diagnostics?.frameRetried({ branchId, attempt }),
      // Under its own row lock the append cannot miss; a miss there is a moved branch.
      exhausted: () => {
        throw new BranchStaleUpdateError(branchId);
      },
      run: async (attempt) => {
        const judge = async () => {
          const write = await judgeWriterUpdate(inputWriter, { fenceRoom: attempt.number === 1 });
          return write && attempt.own(write);
        };
        let write: PreparedBranchWrite | null;
        if (attempt.last) {
          write = await attempt.commit(() =>
            input.store.withJudgementLocks(branchId, async () => {
              const judged = await judge();
              await judged?.persist();
              return judged;
            }),
          );
        } else {
          write = await judge();
          const judged = write;
          if (judged) await attempt.commit(() => judged.persist());
        }
        if (!write) return { admitted: false };
        await collabHook("branch.append.afterCommit");
        return { admitted: true };
      },
    });
    if (outcome.admitted) compactIfLong(branchId);
    return outcome;
  }

  /** The frame judged on the committed replica: its prepared append, or null when contained. */
  async function judgeWriterUpdate(
    inputWriter: Parameters<BranchCoordinator["commitWriterUpdate"]>[0],
    { fenceRoom }: { fenceRoom: boolean },
  ): Promise<PreparedBranchWrite | null> {
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
        try {
          const receipts = captureAppendReceipts(candidate, journals);
          return await prepareAppend(base, candidate, journals, receipts);
        } catch (cause) {
          candidate.destroy();
          throw cause;
        }
      },
    });
    return admission.admitted ? admission.value : null;
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
