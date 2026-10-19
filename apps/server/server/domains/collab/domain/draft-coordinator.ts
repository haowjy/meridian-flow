/** Draft operation policy over the shared committed-replica runtime. */

import { bytesEqual } from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import {
  admitSegmentRows,
  assertSegmentRowsComplete,
  replicateFrozenSource,
} from "./document-mutation-policy.js";
import {
  type Attempt,
  type AttemptScope,
  NO_ATTEMPT_SCOPE,
  runBoundedAttempts,
} from "./draft-attempts.js";
import {
  createDraftRuntime,
  type DraftBase,
  DraftRewriteRefused,
  type DraftRuntime,
  type DraftRuntimeInput,
  type PreparedDraftWrite,
  type RoomReconcileTrigger,
} from "./draft-runtime.js";
import {
  type AppendDraftJournalInput,
  DraftCasConflictError,
  DraftMissingError,
  type DraftSnapshot,
  DraftStaleUpdateError,
} from "./draft-store.js";
import { createWriterFrames, type WriterFrameInput } from "./draft-writer-frames.js";

/** An exact-predicate write's attempt policy; the last miss is `moved`'s (default: throw). */
type CommitAttemptOptions<T> = {
  bound?: number;
  scope?: AttemptScope;
  moved?: (cause: unknown) => T;
};

/** Every other exact-predicate write: four commit attempts, then the caller's own outcome. */
const COMMIT_ATTEMPTS = 4;

/** The pre-replay view a save's staged rows are reconciled against. */
export type StagedDraftView = DraftSnapshot & {
  /** The committed draft bytes at `revision`, captured before any replay. */
  readonly encoded: Uint8Array;
};

export type SegmentRowsInput = {
  draftId: string;
  expectedGeneration: number;
  sourceDoc: Y.Doc;
  rows: readonly Omit<AppendDraftJournalInput, "generation">[];
};

/**
 * A pull merges `upstream` into the draft. A peer's pull names the upstream epoch it read
 * `upstream` at: the commit locks that row `FOR SHARE` and loses if it closed or moved.
 */
export type PullInput = {
  draftId: string;
  upstream: Y.Doc;
  upstreamEpoch?: { draftId: string; generation: number };
};

/**
 * A completed thread-peer pull, a closed draft, or a changed upstream.
 */
export type PullOutcome = "pulled" | "closed" | "upstreamMoved";

export type DraftCoordinator = Pick<DraftRuntime, "loadBase" | "prepareAppend"> & {
  /**
   * Merges `upstream` into the draft as a folding rewrite, outside any transaction: each
   * attempt is its own commit scope. Frames that commit while the pull computes are folded
   * into its checkpoint, never a miss; only another rewrite makes it recompute.
   */
  pullFromDoc(input: PullInput): Promise<PullOutcome>;
  readDraft<T>(
    draftId: string,
    fn: (doc: Y.Doc, snapshot: DraftSnapshot) => Promise<T>,
  ): Promise<T>;
  // A reply prepares without acquiring a hold; its staged rows are sequenced at persistence.
  /** A private copy of the draft for `fn` to change; nothing it does is kept or installed. */
  withTransient<T>(
    draftId: string,
    fn: (doc: Y.Doc, snapshot: DraftSnapshot) => Promise<T>,
  ): Promise<T>;
  /**
   * Replays a response's rows on a candidate of the committed draft. With `commit`, the rows
   * come back as a prepared write (null when there are none) for the caller's commit scope.
   */
  prepareStagedRows<T>(
    draftId: string,
    run: (
      doc: Y.Doc,
      snapshot: StagedDraftView,
    ) => Promise<{ result: T; rows: readonly Omit<AppendDraftJournalInput, "generation">[] }>,
    commit: boolean,
  ): Promise<{ result: T; write: PreparedDraftWrite | null }>;
  /** `source` merged into the draft as a checkpoint write; null when it holds `source` already. */
  prepareCatchUp(draftId: string, source: Y.Doc): Promise<PreparedDraftWrite | null>;
  commitSegmentRows(input: SegmentRowsInput): Promise<boolean>;
  /** A writer frame (`draft-writer-frames.ts`). */
  commitWriterUpdate(input: WriterFrameInput): Promise<{ admitted: boolean }>;
  /** Brings this process's rooms up to what is committed now: a read, installed as any other. */
  deliverCommitted(draftId: string): Promise<void>;
  /**
   * Brings a registered room up to what is committed on its generation (decisions D26, D27):
   * at its enrollment, from which on every installed transition reaches it, and at each tab's
   * handshake, so a room that missed a delivery heals on the next exchange whether or not the
   * tab may write. Returns the base it reconciled against, or null when the draft closed or
   * left the room's generation.
   */
  reconcileRegisteredRoom(input: {
    draftId: string;
    generation: number;
    room: Y.Doc;
    trigger: Exclude<RoomReconcileTrigger, "frame">;
  }): Promise<DraftBase | null>;
};

export function createDraftCoordinator(input: DraftRuntimeInput): DraftCoordinator {
  const attemptScope = input.attemptScope ?? NO_ATTEMPT_SCOPE;
  const runtime = createDraftRuntime(input);
  const {
    loadBase,
    cloneReplica,
    encodedOf,
    prepareAppend,
    prepareRewrite,
    foldPolicy,
    reconcileRoom,
  } = runtime;
  const documentContainment = runtime.containment;

  function commitAttempts<T>(
    run: (attempt: Attempt) => Promise<T>,
    options: CommitAttemptOptions<T> = {},
  ): Promise<T> {
    return runBoundedAttempts({
      bound: options.bound ?? COMMIT_ATTEMPTS,
      scope: options.scope ?? attemptScope,
      isMiss: (cause) => cause instanceof DraftCasConflictError,
      run,
      exhausted:
        options.moved ??
        ((cause) => {
          throw cause;
        }),
    });
  }
  async function reconcileRegisteredRoom({
    generation,
    ...room
  }: Parameters<DraftCoordinator["reconcileRegisteredRoom"]>[0]): Promise<DraftBase | null> {
    const base = await loadBase(room.draftId).catch((cause: unknown) => {
      if (cause instanceof DraftMissingError) return null;
      throw cause;
    });
    if (base?.snapshot.status !== "active" || base.snapshot.generation !== generation) return null;
    reconcileRoom({ ...room, replica: base.replica });
    return base;
  }

  /** `candidate` as the draft's checkpoint at the base's exact revision: a peer's catch-up. */
  function prepareCheckpoint(base: DraftBase, candidate: Y.Doc): PreparedDraftWrite {
    const { snapshot } = base;
    return prepareRewrite(snapshot.draftId, candidate, {
      policy: { kind: "exact", revision: snapshot.revision },
      operation: { kind: "checkpoint" },
    });
  }

  /**
   * `candidate`, `upstream` merged into the committed replica, as a fold over the replica's
   * cursor: rows appended since are applied into it under the row lock.
   */
  function preparePull(base: DraftBase, candidate: Y.Doc, pull: PullInput): PreparedDraftWrite {
    const { snapshot } = base;
    return prepareRewrite(snapshot.draftId, candidate, {
      policy: foldPolicy(base.replica),
      operation: { kind: "pull" },
      ...(pull.upstreamEpoch ? { upstream: pull.upstreamEpoch } : {}),
    });
  }

  /**
   * One thread-peer pull attempt: computed on a candidate of the
   * committed replica before the attempt's scope; inside it the fold applies what landed since
   * and the checkpoint is written.
   */
  async function pullAttempt(attempt: Attempt, pull: PullInput): Promise<PullOutcome> {
    const base = await loadBase(pull.draftId);
    const { snapshot } = base;
    if (snapshot.status !== "active") return "closed";
    if (snapshot.kind !== "thread_peer") throw new Error("Work drafts must use a content rebase");
    // A durable thread peer has already saved its writes into the Work draft. If the parent
    // no longer contains them, merging cannot repair the lost lineage. Refuse the pull;
    // its caller translates this outcome to ThreadPeerPullLost without re-forking.
    if (
      snapshot.kind === "thread_peer" &&
      !Y.snapshotContainsUpdate(Y.snapshot(pull.upstream), encodedOf(base.replica))
    ) {
      return "upstreamMoved";
    }
    const candidate = cloneReplica(base.replica);
    replicatedInto(pull.upstream, candidate);
    const write = attempt.own(preparePull(base, candidate, pull));
    await attempt.commit(() => write.persist());
    return "pulled";
  }

  /** `source` replicated into `target`, which is destroyed when replication fails. */
  function replicatedInto(source: Y.Doc, target: Y.Doc): void {
    try {
      replicateFrozenSource(source, target);
    } catch (cause) {
      target.destroy();
      throw cause;
    }
  }

  /** `fn` over the committed replica, which it must only read. */
  async function readCommitted<T>(
    draftId: string,
    fn: (doc: Y.Doc, snapshot: DraftSnapshot) => Promise<T>,
  ): Promise<T> {
    const base = await loadBase(draftId);
    return fn(base.replica.doc, base.snapshot);
  }

  /** A private copy for `fn`: whatever it changes stays with the copy (decision F6). */
  async function transient<T>(
    draftId: string,
    fn: (doc: Y.Doc, snapshot: DraftSnapshot) => Promise<T>,
  ): Promise<T> {
    const base = await loadBase(draftId);
    assertWritableDraft(base.snapshot);
    const doc = cloneReplica(base.replica);
    try {
      return await fn(doc, base.snapshot);
    } finally {
      doc.destroy();
    }
  }

  /**
   * `journals` admitted on a fresh copy of the base (the pre-lock policy check, kept as the
   * write's candidate) and prepared as an append: the one way a save's replay and a segment
   * batch prepare rows.
   */
  function prepareRows(
    base: DraftBase,
    journals: readonly AppendDraftJournalInput[],
  ): PreparedDraftWrite {
    const admitted = cloneReplica(base.replica);
    try {
      admitSegmentRows(admitted, base.snapshot.documentId, journals);
    } catch (cause) {
      admitted.destroy();
      throw cause;
    }
    return prepareAppend(base, journals, { admitted });
  }

  async function prepareStagedRows<T>(
    draftId: string,
    run: (
      doc: Y.Doc,
      snapshot: StagedDraftView,
    ) => Promise<{ result: T; rows: readonly Omit<AppendDraftJournalInput, "generation">[] }>,
    commit: boolean,
  ): Promise<{ result: T; write: PreparedDraftWrite | null }> {
    const base = await loadBase(draftId);
    const { snapshot } = base;
    assertWritableDraft(snapshot);
    const replay = cloneReplica(base.replica);
    try {
      const { result, rows } = await run(replay, { ...snapshot, encoded: encodedOf(base.replica) });
      if (!commit || !rows.length) return { result, write: null };
      const write = prepareRows(
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
    draftId: string,
    source: Y.Doc,
  ): Promise<PreparedDraftWrite | null> {
    const base = await loadBase(draftId);
    assertWritableDraft(base.snapshot);
    if (base.snapshot.kind !== "thread_peer")
      throw new Error("Only thread peers replicate a catch-up");
    const update = Y.encodeStateAsUpdate(source);
    if (documentContainment.contains(base.replica.doc, update)) return null;
    const candidate = cloneReplica(base.replica);
    Y.applyUpdate(candidate, update);
    return prepareCheckpoint(base, candidate);
  }

  async function segmentRowsAttempt(attempt: Attempt, batch: SegmentRowsInput): Promise<boolean> {
    const base = await loadBase(batch.draftId);
    const { snapshot } = base;
    assertWritableDraft(snapshot);
    if (snapshot.generation !== batch.expectedGeneration)
      throw new DraftStaleUpdateError(`Draft ${batch.draftId}`);
    const journals = batch.rows.map((row) => ({ ...row, generation: snapshot.generation }));
    const write = journals.length ? attempt.own(prepareRows(base, journals)) : null;
    assertSegmentRowsComplete(batch.sourceDoc, write?.candidate ?? base.replica.doc);
    if (!write) return false;
    await attempt.commit(() => write.persist());
    return true;
  }

  const frames = createWriterFrames(runtime);

  return {
    loadBase,
    prepareAppend,
    readDraft: readCommitted,
    withTransient: transient,
    prepareStagedRows,
    prepareCatchUp,
    // An append is sequenced, never fenced: one attempt; a generation change refuses it.
    commitSegmentRows: (batch) =>
      commitAttempts((attempt) => segmentRowsAttempt(attempt, batch), { bound: 1 }),

    pullFromDoc(pull) {
      return commitAttempts((attempt) => pullAttempt(attempt, pull)).catch((cause: unknown) => {
        if (cause instanceof DraftRewriteRefused) return cause.status;
        throw cause;
      });
    },

    async deliverCommitted(draftId) {
      await loadBase(draftId);
    },

    reconcileRegisteredRoom,

    commitWriterUpdate: frames.commitWriterUpdate,
  };
}

function assertWritableDraft(snapshot: DraftSnapshot): void {
  if (snapshot.status !== "active") {
    throw new DraftStaleUpdateError(`Draft ${snapshot.draftId}`);
  }
}
