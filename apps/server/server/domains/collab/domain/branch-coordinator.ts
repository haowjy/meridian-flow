/**
 * The branch runtime and the operations on it. The runtime holds one immutable published
 * replica per branch, prepares every write on a private candidate (append, rewrite, reset) and
 * publishes it only once its attempt completes; the operations (pull, reset, a reply's staged
 * rows, a peer's catch-up, segment batches) are attempts over it. Writer frames and the tail
 * fold they trigger are `branch-writer-frames.ts`, over the same runtime surface.
 */

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
  type RewriteOutcome,
  type RewritePolicy,
} from "./branch-store.js";
import {
  createWriterFrames,
  type WriterFrameDiagnostics,
  type WriterFrameInput,
} from "./branch-writer-frames.js";
import { createDocumentContainment } from "./document-containment.js";
import {
  documentEffectsEqual,
  type EffectFingerprint,
  effectFingerprint,
  effectFingerprintsEqual,
} from "./document-content.js";
import {
  admitSegmentRows,
  assertSegmentRowsComplete,
  replicateFrozenSource,
} from "./document-mutation-policy.js";
import { currentResponseTransactionId, enlistResponseParticipant } from "./response-transaction.js";

/**
 * The branch as committed at `revision`: replaced, never mutated. `seq` is the highest journal
 * id it contains; `tail` counts the rows (and their bytes) it holds past its checkpoint;
 * `encoded` is its update bytes, computed once when first needed.
 */
export type PublishedReplica = {
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

/**
 * What a branch operation works from: the committed replica at the row's revision and the
 * row read's review-membership inputs.
 */
export type BranchBase = {
  snapshot: BranchSnapshot;
  replica: PublishedReplica;
  pendingRows: boolean;
  liveCutStored: boolean;
};

/** An exact-predicate write's attempt policy; the last miss is `moved`'s (default: throw). */
type CommitAttemptOptions<T> = {
  bound?: number;
  scope?: AttemptScope;
  moved?: (cause: unknown) => T;
  retrying?: (attempt: number) => void;
};

/**
 * The runtime surface the coordinator's operations and `branch-writer-frames.ts` build on:
 * committed replicas, private candidates of them, prepared writes and their attempts.
 */
export type BranchRuntime = {
  loadBase(branchId: string): Promise<BranchBase>;
  /** The replica published for the branch, if any: read it, never mutate it. */
  published(branchId: string): PublishedReplica | undefined;
  encodedOf(replica: PublishedReplica): Uint8Array;
  cloneReplica(replica: PublishedReplica): Y.Doc;
  containment: ReturnType<typeof createDocumentContainment>;
  prepareAppend(
    base: BranchBase,
    candidate: Y.Doc,
    journals: readonly AppendBranchJournalInput[],
    receipts: readonly AppendReceiptGroup[],
  ): Promise<PreparedBranchWrite>;
  prepareRewrite(
    branchId: string,
    candidate: Y.Doc,
    rewrite: Omit<CommitRewriteInput, "branchId" | "doc">,
    update?: Uint8Array,
  ): PreparedBranchWrite;
  foldPolicy(replica: PublishedReplica): RewritePolicy;
  commitAttempts<T>(
    run: (attempt: Attempt) => Promise<T>,
    options?: CommitAttemptOptions<T>,
  ): Promise<T>;
  commitOnce(
    write: PreparedBranchWrite,
    options: { scope?: AttemptScope; moved?: (cause: unknown) => void },
  ): Promise<void>;
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

/**
 * A pull merges `upstream` into the branch. A peer's pull names the upstream epoch it read
 * `upstream` at: the commit locks that row `FOR SHARE` and loses to a re-fork of it.
 */
export type PullInput = {
  branchId: string;
  upstream: Y.Doc;
  upstreamEpoch?: { branchId: string; generation: number };
};

/**
 * `pulled` committed. A live pull into a work draft waits out a pending settlement on its
 * document (`fenced`: nothing was written, and the caller tries again later); a settlement
 * terminally blocked on it freezes the pull (`blocked`: nothing written, nothing to retry
 * until something new arrives, since no transition lifts a blocked batch); a closed
 * branch has nothing to pull into; a peer whose upstream re-forked since its read is
 * `upstreamMoved`, its capture abandoned. An archived (or deleted) Work's draft is frozen
 * (decision D19): `inactive`, nothing written, and nothing to retry until it is unarchived,
 * when the next live update pulls again.
 */
export type PullOutcome = "pulled" | "fenced" | "blocked" | "closed" | "upstreamMoved" | "inactive";

/** A rewrite refused for a reason other than a moved revision: never retried. */
class BranchRewriteRefused extends Error {
  constructor(
    readonly branchId: string,
    readonly status: Extract<
      RewriteOutcome["status"],
      "fenced" | "blocked" | "upstreamMoved" | "inactive"
    >,
  ) {
    super(`Branch ${branchId} rewrite was refused: ${status}`);
    this.name = "BranchRewriteRefused";
  }
}

/**
 * A work draft re-forked from `upstream` at the generation it was read: `exact` only at the
 * revision read; `fold` over every append since, which the reset discards with its clocks fenced.
 */
export type ResetFromDocInput = Omit<ResetInput, "expectedRevision"> &
  ({ policy: "exact"; expectedRevision: number } | { policy: "fold" });

/** The fields every work-draft reset names. */
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
   * Merges `upstream` into the branch as a folding rewrite, outside any transaction: each
   * attempt is its own commit scope. Frames that commit while the pull computes are folded
   * into its checkpoint, never a miss; only another rewrite makes it recompute.
   */
  pullFromDoc(input: PullInput): Promise<PullOutcome>;
  /**
   * Re-forks a work draft from `upstream` inside the caller's transaction, holding nothing:
   * false when the branch is no longer at the generation (or, `exact`, the revision) read.
   * With `owner`, the caller's attempt owns the reset candidate and the write runs in its
   * already-open commit scope, so a later miss in that attempt disposes it; without one, the
   * reset is a single attempt in the caller's transaction. A moved branch throws
   * `BranchCasConflictError` for the caller's attempt to classify.
   */
  resetFromDoc(input: ResetFromDocInput, owner?: Attempt): Promise<boolean>;
  readBranch<T>(
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T>;
  // A reply's save (contract §2.3) prepares through these and acquires nothing: every write
  // is an attempt fenced by the revision it was prepared at.
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
  /** A writer frame (`branch-writer-frames.ts`). */
  commitWriterUpdate(input: WriterFrameInput): Promise<{ admitted: boolean }>;
  notifyReset(input: { branchId: string; generation: number }): void;
  broadcastUpdate(input: { branchId: string; update: Uint8Array }): void;
};

export function createBranchCoordinator(input: {
  store: BranchStore;
  /** Each attempt's rollback boundary: a root transaction, or a savepoint in an ambient one. */
  attemptScope?: AttemptScope;
  onBranchUpdate?: (input: { branchId: string; update: Uint8Array }) => void;
  onBranchReset?: (input: { branchId: string; generation: number }) => void;
  diagnostics?: WriterFrameDiagnostics;
}): BranchCoordinator {
  const attemptScope = input.attemptScope ?? NO_ATTEMPT_SCOPE;
  const documentContainment = createDocumentContainment();
  const published = new Map<string, PublishedReplica>();
  const baselines = new Map<string, CachedBaseline>();

  /**
   * An exact-predicate write's attempts: a moved branch recaptures, and the last miss is
   * `moved`'s to answer (by default it throws).
   */
  function commitAttempts<T>(
    run: (attempt: Attempt) => Promise<T>,
    options: CommitAttemptOptions<T> = {},
  ): Promise<T> {
    return runBoundedAttempts({
      bound: options.bound ?? COMMIT_ATTEMPTS,
      scope: options.scope ?? attemptScope,
      isMiss: (cause) => cause instanceof BranchCasConflictError,
      retrying: options.retrying,
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

  async function resetFromDoc(resetInput: ResetFromDocInput, owner?: Attempt): Promise<boolean> {
    const snapshot = await loadSnapshot(resetInput.branchId);
    if (snapshot.kind !== "work_draft" || snapshot.status !== "active")
      throw new Error(`Branch ${snapshot.branchId} is not an active work draft reset target`);
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
    // A settlement's reset completes a batch staged before any archive (decision D1's
    // settlement fence) and Discard/purge are lifecycle operations themselves: D19 exempts both.
    const write = await prepareReset(snapshot, resetInput.upstream, {
      ...resetInput,
      policy,
      work: "any",
    });
    if (owner) await owner.own(write).persist();
    else await commitOnce(write, { scope: NO_ATTEMPT_SCOPE });
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
        if (
          outcome.status === "fenced" ||
          outcome.status === "blocked" ||
          outcome.status === "upstreamMoved" ||
          outcome.status === "inactive"
        )
          throw new BranchRewriteRefused(branchId, outcome.status);
        if (outcome.status !== "committed") throw new BranchCasConflictError(branchId);
        if (rewrite.operation.kind === "reset") return { resetTo: outcome.generation };
        return { ...outcome, doc: candidate, tail: EMPTY_TAIL };
      },
    });
  }

  /** `candidate` as the branch's checkpoint at the base's exact revision: a peer's catch-up. */
  function prepareCheckpoint(base: BranchBase, candidate: Y.Doc): PreparedBranchWrite {
    const { snapshot } = base;
    return prepareRewrite(snapshot.branchId, candidate, {
      policy: { kind: "exact", revision: snapshot.revision },
      fence: { kind: "none" },
      operation: { kind: "checkpoint" },
      work: "active",
    });
  }

  /**
   * `candidate`, `upstream` merged into the committed replica, as a fold over the replica's
   * cursor: rows appended since are applied into it under the row lock. A work draft's effect
   * is judged against `upstream`, its new baseline, before the lock, and judged again on the
   * folded checkpoint only when the fold applied rows.
   */
  function preparePull(
    base: BranchBase,
    candidate: Y.Doc,
    pull: PullInput & { update: Uint8Array },
  ): PreparedBranchWrite {
    const { snapshot } = base;
    const operation: RewriteOperation =
      snapshot.kind === "work_draft"
        ? {
            kind: "pull",
            effect: {
              hasEffect: !documentEffectsEqual(pull.upstream, candidate),
              liveCut: Y.encodeStateAsUpdate(pull.upstream),
              refolded: (folded) => !documentEffectsEqual(pull.upstream, folded),
            },
          }
        : { kind: "pull" };
    return prepareRewrite(
      snapshot.branchId,
      candidate,
      {
        policy: foldPolicy(base.replica),
        // A live pull's checkpoint would move the revision a pending Apply's completion resets at.
        fence: snapshot.kind === "work_draft" ? { kind: "pending-settlement" } : { kind: "none" },
        operation,
        // An archived Work's draft is frozen to content-moving rewrites (decision D19).
        work: "active",
        ...(pull.upstreamEpoch ? { upstream: pull.upstreamEpoch } : {}),
      },
      pull.update,
    );
  }

  /** A fold over everything appended past `replica`'s cursor. */
  function foldPolicy(replica: PublishedReplica): RewritePolicy {
    return { kind: "fold", checkpointRevision: replica.checkpointRevision, seq: replica.seq };
  }

  /** A re-fork of the branch from `upstream` under the caller's revision policy. */
  async function prepareReset(
    snapshot: BranchSnapshot,
    upstream: Y.Doc,
    reset: Pick<ResetInput, "schemaVersion" | "editDisposition" | "fence"> & {
      policy: RewritePolicy;
      work: CommitRewriteInput["work"];
      upstreamEpoch?: PullInput["upstreamEpoch"];
    },
  ): Promise<PreparedBranchWrite> {
    const candidate = createCollabYDoc({ gc: false });
    await replicatedInto(upstream, candidate);
    return prepareRewrite(snapshot.branchId, candidate, {
      policy: reset.policy,
      fence: reset.fence ?? { kind: "none" },
      operation: {
        kind: "reset",
        editDisposition: reset.editDisposition ?? "discarded",
        schemaVersion: reset.schemaVersion ?? snapshot.schemaVersion,
      },
      work: reset.work,
      ...(reset.upstreamEpoch ? { upstream: reset.upstreamEpoch } : {}),
    });
  }

  function notifyReset(reset: { branchId: string; generation: number }): void {
    published.delete(reset.branchId);
    const publish = () => input.onBranchReset?.(reset);
    if (!input.store.deferUntilCommit(publish)) publish();
  }

  /**
   * One pull attempt: everything, the effect included, computed on a candidate of the
   * committed replica before the attempt's scope; inside it the fold applies what landed since
   * and the checkpoint is written.
   */
  async function pullAttempt(attempt: Attempt, pull: PullInput): Promise<PullOutcome> {
    const base = await loadBase(pull.branchId);
    const { snapshot } = base;
    if (snapshot.status !== "active") return "closed";
    // A durable thread peer has already saved its writes into the Work draft. If the parent
    // no longer contains them, a review retired their effect: merging cannot remove those
    // structs or undo their tombstones, so the peer re-forks from the parent.
    if (
      snapshot.kind === "thread_peer" &&
      !Y.snapshotContainsUpdate(Y.snapshot(pull.upstream), encodedOf(base.replica))
    ) {
      const write = await prepareReset(snapshot, pull.upstream, {
        policy: foldPolicy(base.replica),
        // Part of the peer's pull: frozen with it (decision D19).
        work: "active",
        ...(pull.upstreamEpoch ? { upstreamEpoch: pull.upstreamEpoch } : {}),
      });
      attempt.own(write);
      await attempt.commit(() => write.persist());
      return "pulled";
    }
    const candidate = cloneReplica(base.replica);
    const update = await replicatedInto(pull.upstream, candidate);
    const write = attempt.own(preparePull(base, candidate, { ...pull, update }));
    await attempt.commit(() => write.persist());
    return "pulled";
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

  /** `fn` over the committed replica, which it must only read. */
  async function readCommitted<T>(
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T> {
    const base = await loadBase(branchId);
    return fn(base.replica.doc, base.snapshot);
  }

  /** A private copy for `fn`: whatever it changes stays with the copy (decision F6). */
  async function transient<T>(
    branchId: string,
    fn: (doc: Y.Doc, snapshot: BranchSnapshot) => Promise<T>,
  ): Promise<T> {
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
    assertSegmentRowsComplete(batch.sourceDoc, write?.candidate ?? base.replica.doc);
    if (!write) return false;
    await attempt.commit(() => write.persist());
    return true;
  }

  const frames = createWriterFrames(
    {
      loadBase,
      published: (branchId) => published.get(branchId),
      encodedOf,
      cloneReplica,
      containment: documentContainment,
      prepareAppend,
      prepareRewrite,
      foldPolicy,
      commitAttempts,
      commitOnce,
    },
    { store: input.store, diagnostics: input.diagnostics },
  );

  return {
    notifyReset,
    readBranch: readCommitted,
    withTransient: transient,
    prepareStagedRows,
    prepareCatchUp,
    commitSegmentRows: (batch) => commitAttempts((attempt) => segmentRowsAttempt(attempt, batch)),

    pullFromDoc(pull) {
      return commitAttempts((attempt) => pullAttempt(attempt, pull)).catch((cause: unknown) => {
        if (cause instanceof BranchRewriteRefused) return cause.status;
        throw cause;
      });
    },

    resetFromDoc,

    broadcastUpdate(update) {
      // Published replicas are immutable: the next read catches up from the committed tail.
      input.onBranchUpdate?.(update);
    },

    commitWriterUpdate: frames.commitWriterUpdate,
  };
}

function assertWritableBranch(snapshot: BranchSnapshot): void {
  if (snapshot.status !== "active") {
    throw new BranchStaleUpdateError(snapshot.branchId);
  }
}
