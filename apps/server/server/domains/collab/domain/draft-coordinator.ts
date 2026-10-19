/**
 * The draft runtime and the operations on it. The runtime holds one immutable committed
 * replica per draft, prepares every write on a private candidate (append, rewrite, reset) and
 * installs it only once its attempt completes; the operations (pull, reset, a reply's staged
 * rows, segment batches) are attempts over it. Writer frames and the tail
 * fold they trigger are `draft-writer-frames.ts`, over the same runtime surface.
 */

import { bytesEqual, type SaveCut } from "@meridian/agent-edit/integration";
import type { ThreadId } from "@meridian/contracts/runtime";
import { type CollabSchemaVersion, createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { createDocumentContainment } from "./document-containment.js";
import { documentEffectsEqual } from "./document-content.js";
import {
  admitSegmentRows,
  assertWriterAuthorship,
  replicateFrozenSource,
} from "./document-mutation-policy.js";
import {
  type Attempt,
  type AttemptScope,
  NO_ATTEMPT_SCOPE,
  runBoundedAttempts,
} from "./draft-attempts.js";
import { type FinalizedAppend, finalizeAppend } from "./draft-receipts.js";
import { DraftCorruptError } from "./draft-resolver.js";
import {
  type AppendDraftJournalInput,
  assertReadableDraft,
  type CommitRewriteInput,
  DraftCasConflictError,
  DraftMissingError,
  DraftPrefixMissingError,
  type DraftRead,
  type DraftSnapshot,
  DraftStaleUpdateError,
  type DraftStore,
  materializeDraftRead,
  type RewriteOperation,
  type RewriteOutcome,
  type RewritePolicy,
} from "./draft-store.js";
import {
  createWriterFrames,
  type WriterFrameDiagnostics,
  type WriterFrameInput,
} from "./draft-writer-frames.js";

/**
 * The draft as committed at `revision`: replaced, never mutated. `seq` is the highest journal
 * id it contains; `tail` counts the rows (and their bytes) it holds past its checkpoint;
 * `encoded` is its update bytes, computed once when first needed.
 */
export type CommittedReplica = {
  readonly revision: number;
  readonly checkpointRevision: number;
  readonly seq: number;
  readonly generation: number;
  readonly doc: Y.Doc;
  readonly tail: TailSize;
  encoded?: Uint8Array;
};

/**
 * A replica on its way to installation: `next`, and when it was built by applying `rows` to
 * `from`, those two, so delivery can send the rows instead of diffing whole documents.
 */
type Transition = {
  readonly next: CommittedReplica;
  readonly from?: CommittedReplica;
  readonly rows?: readonly Uint8Array[];
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
 * the draft replays its whole tail. The fold changes no content, effect or stamp.
 */

/** What a draft operation works from: the row as read and the committed replica at it. */
export type DraftBase = {
  snapshot: DraftSnapshot;
  replica: CommittedReplica;
};

/** An exact-predicate write's attempt policy; the last miss is `moved`'s (default: throw). */
type CommitAttemptOptions<T> = {
  bound?: number;
  scope?: AttemptScope;
  moved?: (cause: unknown) => T;
};

/**
 * The runtime surface the coordinator's operations and `draft-writer-frames.ts` build on:
 * committed replicas, private candidates of them, prepared writes and their attempts.
 */
export type DraftRuntime = {
  loadBase(draftId: string): Promise<DraftBase>;
  /** The replica committed for the draft, if any: read it, never mutate it. */
  committed(draftId: string): CommittedReplica | undefined;
  cloneReplica(replica: CommittedReplica): Y.Doc;
  containment: ReturnType<typeof createDocumentContainment>;
  /**
   * Brings `room` up to `replica` when it lacks any of the replica's content, reported as a
   * repair: a room misses committed content only through a delivery gap.
   */
  reconcileRoom(input: {
    draftId: string;
    room: Y.Doc;
    replica: CommittedReplica;
    trigger: RoomReconcileTrigger;
  }): void;
  /**
   * `journals` as an append from `base`, finalized under the row lock against what is
   * committed (design §2.2). `admitted`, when given, is the caller's pre-lock document holding
   * the rows; it is the write's `candidate` until the write commits.
   */
  prepareAppend(
    base: DraftBase,
    journals: readonly AppendDraftJournalInput[],
    admitted?: Y.Doc,
  ): PreparedDraftWrite;
  prepareRewrite(
    draftId: string,
    candidate: Y.Doc,
    rewrite: Omit<CommitRewriteInput, "draftId" | "doc">,
  ): PreparedDraftWrite;
  foldPolicy(replica: CommittedReplica): RewritePolicy;
  /** `write` as one whole attempt: true when it wrote, false when it was contained. */
  commitOnce(
    write: PreparedDraftWrite,
    options: { scope?: AttemptScope; moved?: (cause: unknown) => void },
  ): Promise<boolean>;
};

/**
 * What found a room behind its draft: a frame, its enrollment once registered, or a tab's
 * SyncStep1 handshake.
 */
export type RoomReconcileTrigger = "frame" | "enrollment" | "handshake";

/**
 * A draft write prepared on a private candidate, an `AttemptCandidate` of the attempt that
 * prepared it: nothing is persisted until `persist` runs inside that attempt's commit scope,
 * nothing is visible until `transfer` hands it to installation once the whole attempt
 * completed, and `dispose` drops it on any unwind. A rewrite's `persist` throws
 * `DraftCasConflictError` when the draft moved since the candidate's base; an append's never
 * does (it is sequenced, not fenced) and resolves false when everything it carried was already
 * committed.
 */
export type PreparedDraftWrite = {
  readonly draftId: string;
  /** The content the write was prepared as, before any lock; read it, never mutate it. */
  readonly candidate: Y.Doc;
  persist(): Promise<boolean>;
  transfer(): void;
  dispose(): void;
};

/**
 * An append's prepared write. Once `persist` resolved, `cut` is the draft as the append found
 * it under the draft row lock and with its kept rows, captured while finalizing, before the
 * attempt commits: for a contained append both are that same committed prefix.
 */
export type PreparedDraftAppend = PreparedDraftWrite & { cut(): SaveCut };

/** Every other exact-predicate write: four commit attempts, then the caller's own outcome. */
const COMMIT_ATTEMPTS = 4;

/** The pre-replay view a save's staged rows are reconciled against. */
export type StagedDraftView = DraftSnapshot & {
  /** The committed draft bytes at `revision`, captured before any replay. */
  readonly encoded: Uint8Array;
};

/** A pull merges `upstream` into the draft. */
export type PullInput = {
  draftId: string;
  upstream: Y.Doc;
};

/**
 * `pulled` committed. A live pull into a work draft waits out a pending settlement on its
 * document (`fenced`: nothing was written, and the caller tries again later); a settlement
 * terminally blocked on it freezes the pull (`blocked`: nothing written, nothing to retry
 * until something new arrives, since no transition lifts a blocked batch); a closed
 * draft has nothing to pull into. An archived Work's draft keeps pulling, so it applies
 * cleanly after unarchive.
 */
export type PullOutcome = "pulled" | "fenced" | "blocked" | "closed";

/** A rewrite refused for a reason other than a moved revision: never retried. */
class DraftRewriteRefused extends Error {
  constructor(
    readonly draftId: string,
    readonly status: Extract<RewriteOutcome["status"], "fenced" | "blocked">,
  ) {
    super(`Draft ${draftId} rewrite was refused: ${status}`);
    this.name = "DraftRewriteRefused";
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
  draftId: string;
  upstream: Y.Doc;
  expectedGeneration: number;
  expectedRevision: number;
  schemaVersion?: CollabSchemaVersion;
  editDisposition?: "discarded" | "retired";
};

export type DraftCoordinator = {
  /**
   * Merges `upstream` into the draft as a folding rewrite, outside any transaction: each
   * attempt is its own commit scope. Frames that commit while the pull computes are folded
   * into its checkpoint, never a miss; only another rewrite makes it recompute.
   */
  pullFromDoc(input: PullInput): Promise<PullOutcome>;
  /**
   * Re-forks a work draft from `upstream` inside the caller's transaction, holding nothing:
   * false when the draft is no longer at the generation (or, `exact`, the revision) read.
   * With `owner`, the caller's attempt owns the reset candidate and the write runs in its
   * already-open commit scope, so a later miss in that attempt disposes it; without one, the
   * reset is a single attempt in the caller's transaction. A moved draft throws
   * `DraftCasConflictError` for the caller's attempt to classify.
   */
  resetFromDoc(input: ResetFromDocInput, owner?: Attempt): Promise<boolean>;
  readDraft<T>(
    draftId: string,
    fn: (doc: Y.Doc, snapshot: DraftSnapshot) => Promise<T>,
  ): Promise<T>;
  /** A private copy of the committed draft, the caller's to change and destroy. */
  copyDraft(draftId: string): Promise<{ doc: Y.Doc; snapshot: DraftSnapshot }>;
  // A reply's save (contract §2.3) prepares through this and acquires nothing: every write
  // is an attempt fenced by the revision it was prepared at.
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
  ): Promise<{ result: T; write: PreparedDraftAppend | null }>;
  /** A writer frame (`draft-writer-frames.ts`). */
  commitWriterUpdate(input: WriterFrameInput): Promise<{ admitted: boolean }>;
  notifyReset(input: { draftId: string; generation: number }): void;
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

export function createDraftCoordinator(input: {
  store: DraftStore;
  /** Each attempt's rollback boundary: a root transaction, or a savepoint in an ambient one. */
  attemptScope?: AttemptScope;
  onDraftUpdate?: (input: { draftId: string; update: Uint8Array }) => void;
  onDraftReset?: (input: { draftId: string; generation: number }) => void;
  /** Applies a reconciling update to one room; defaults to a plain apply. */
  applyToRoom?: (room: Y.Doc, update: Uint8Array) => void;
  diagnostics?: WriterFrameDiagnostics;
  /**
   * A work draft's append committed rows: its derived state (`has_effect`, the Work's badge) is
   * stale until the projection job judges it (design §3.1). Required, so an omission fails to
   * compile rather than leaving the badge to the sweep.
   */
  onAppendCommitted: (draftId: string) => void;
}): DraftCoordinator {
  const attemptScope = input.attemptScope ?? NO_ATTEMPT_SCOPE;
  const documentContainment = createDocumentContainment();
  const committed = new Map<string, CommittedReplica>();

  /**
   * An exact-predicate write's attempts: a moved draft recaptures, and the last miss is
   * `moved`'s to answer (by default it throws).
   */
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

  /** One write as a whole attempt inside `scope`. */
  function commitOnce(
    write: PreparedDraftWrite,
    options: { scope?: AttemptScope; moved?: (cause: unknown) => void },
  ): Promise<boolean> {
    const { moved, ...rest } = options;
    return commitAttempts(
      async (attempt) => {
        attempt.own(write);
        return attempt.commit(() => write.persist());
      },
      {
        bound: 1,
        ...rest,
        ...(moved
          ? {
              moved: (cause: unknown) => {
                moved(cause);
                return false;
              },
            }
          : {}),
      },
    );
  }

  async function resetFromDoc(resetInput: ResetFromDocInput, owner?: Attempt): Promise<boolean> {
    const snapshot = await loadSnapshot(resetInput.draftId);
    if (snapshot.kind !== "work_draft" || snapshot.status !== "active")
      throw new Error(`Draft ${snapshot.draftId} is not an active work draft reset target`);
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
    const write = prepareReset(snapshot, resetInput.upstream, { ...resetInput, policy });
    if (owner) await owner.own(write).persist();
    else await commitOnce(write, { scope: NO_ATTEMPT_SCOPE });
    return true;
  }

  async function loadSnapshot(draftId: string): Promise<DraftSnapshot> {
    const snapshot = await input.store.getDraft(draftId);
    if (!snapshot) throw new DraftMissingError(draftId);
    assertReadableDraft(snapshot);
    return snapshot;
  }

  /**
   * The draft as committed now, from the committed replica when its revision still holds,
   * caught up from the tail when only appends landed since, otherwise materialized. What the
   * catch-up adds reaches this process's rooms too: another process's commits arrive nowhere
   * else, and a room missing them would fence every frame typed into it.
   */
  async function loadBase(draftId: string): Promise<DraftBase> {
    const current = committed.get(draftId);
    const read = await input.store.readDraftAt(
      draftId,
      current ? { checkpointRevision: current.checkpointRevision, seq: current.seq } : undefined,
    );
    if (!read) throw new DraftMissingError(draftId);
    const snapshot = read.documentDraft;
    assertReadableDraft(snapshot);
    return { snapshot, replica: replicaFor(read, current) };
  }

  function replicaFor(read: DraftRead, current: CommittedReplica | undefined): CommittedReplica {
    const { documentDraft } = read;
    if (current?.revision === documentDraft.revision) return current;
    try {
      const rows = read.tail.map((row) => row.update);
      if (!read.checkpoint && current) {
        // Only appends (or metadata-only bumps) since the replica: apply the tail to a copy.
        const doc = rows.length ? cloneReplica(current) : current.doc;
        for (const row of rows) Y.applyUpdate(doc, row);
        const next: CommittedReplica = {
          revision: documentDraft.revision,
          checkpointRevision: documentDraft.checkpointRevision,
          seq: Math.max(current.seq, ...read.tail.map((row) => row.id)),
          generation: documentDraft.generation,
          doc,
          tail: grownTail(current.tail, rows),
          ...(rows.length ? {} : { encoded: current.encoded }),
        };
        install(documentDraft.draftId, { next, from: current, rows });
        return next;
      }
      const next: CommittedReplica = {
        revision: documentDraft.revision,
        checkpointRevision: documentDraft.checkpointRevision,
        seq: Math.max(documentDraft.checkpointSeq, ...read.tail.map((row) => row.id)),
        generation: documentDraft.generation,
        doc: materializeDraftRead(read),
        tail: grownTail(EMPTY_TAIL, rows),
      };
      install(documentDraft.draftId, { next });
      return next;
    } catch (cause) {
      throw new DraftCorruptError({
        draftId: documentDraft.draftId,
        documentId: documentDraft.documentId,
        threadId: documentDraft.threadId ?? ("" as ThreadId),
        cause,
      });
    }
  }

  /**
   * The one way a replica becomes the draft's committed replica, and so the one way content
   * reaches this process's registered rooms (decision D25); a room that registers, or misses a
   * delivery, behind it is brought up by `reconcileRoom` (D26). It runs when the transaction the replica was
   * read or written in commits (a savepoint's rows only once its root commits too), installs
   * only past the replica installed by then, and hands the rooms what separates the two. A
   * lower or equal revision installs nothing and sends nothing: the committed replica already
   * holds its content, and so do the rooms. A candidate whose transaction rolls back is
   * destroyed instead.
   */
  function install(draftId: string, transition: Transition, owned = false): void {
    const install = () => {
      const previous = committed.get(draftId);
      if (previous && previous.revision >= transition.next.revision) return;
      committed.set(draftId, transition.next);
      if (!previous) return;
      if (previous.generation !== transition.next.generation) {
        // Another process re-forked the draft: rooms on an older generation close.
        input.onDraftReset?.({ draftId, generation: transition.next.generation });
        return;
      }
      const update = deliveryFrom(previous, transition);
      if (update) input.onDraftUpdate?.({ draftId, update });
    };
    const abort = owned ? () => transition.next.doc.destroy() : undefined;
    if (!input.store.deferUntilCommit(install, abort)) install();
  }

  /**
   * What `transition` adds to `previous` within one generation, which a rewrite only merges
   * into: its own rows when they cover everything past `previous` (design §2.4), otherwise the
   * difference of the two documents (a fold or checkpoint, whose rows this process never saw
   * one by one), or nothing when the rewrite changed no content. Rows built on `from` cover
   * `(from.seq, next.seq]`; with the checkpoint unmoved and `from` no newer than `previous`
   * that is a superset of `(previous.seq, next.seq]`, because commit order is id order within a
   * generation. Yjs applies a repeat as a no-op, so a room that already holds part of it is
   * unharmed.
   */
  function deliveryFrom(previous: CommittedReplica, transition: Transition): Uint8Array | null {
    const { from, rows, next } = transition;
    if (
      rows &&
      from &&
      from.generation === previous.generation &&
      next.checkpointRevision === previous.checkpointRevision &&
      from.revision <= previous.revision
    )
      return rows.length ? Y.mergeUpdates([...rows]) : null;
    if (transition.next.doc === previous.doc) return null;
    if (Y.equalSnapshots(Y.snapshot(previous.doc), Y.snapshot(transition.next.doc))) return null;
    return Y.encodeStateAsUpdate(transition.next.doc, Y.encodeStateVector(previous.doc));
  }

  /**
   * The other half of delivery (decision D26): `install` sends each transition to the rooms
   * registered when it installs, and this repairs a room that joined, or missed a delivery,
   * behind `replica`. The room gets the replica's structs past its state vector and the
   * replica's delete set, so a delete-only gap is covered too.
   */
  function reconcileRoom({
    draftId,
    room,
    replica,
    trigger,
  }: Parameters<DraftRuntime["reconcileRoom"]>[0]): void {
    if (documentContainment.contains(room, encodedOf(replica))) return;
    const update = Y.encodeStateAsUpdate(replica.doc, Y.encodeStateVector(room));
    (input.applyToRoom ?? Y.applyUpdate)(room, update);
    input.diagnostics?.roomReconciled({
      draftId,
      generation: replica.generation,
      revision: replica.revision,
      trigger,
      bytes: update.byteLength,
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

  function encodedOf(replica: CommittedReplica): Uint8Array {
    replica.encoded ??= Y.encodeStateAsUpdate(replica.doc);
    return replica.encoded;
  }

  /** A private, mutable copy of a replica: one apply of its cached bytes. */
  function cloneReplica(replica: CommittedReplica): Y.Doc {
    const doc = createCollabYDoc({ gc: false });
    Y.applyUpdate(doc, encodedOf(replica));
    return doc;
  }

  /**
   * The one lifetime of a prepared write: prepared (nothing persisted), persisted in its
   * attempt (written, but the attempt can still roll it back), transferred (the attempt
   * completed; installation owns the committed replica, or a reset closes the room). Disposing
   * destroys every document the write owns in every state but the last, so a write whose own
   * statement succeeded in a scope that a later miss rolled back is dropped like one that never
   * ran. A contained append persisted nothing and transfers nothing.
   */
  function preparedWrite(write: {
    draftId: string;
    candidate: Y.Doc;
    persist(): Promise<Transition | { resetTo: number } | { contained: true }>;
    /** Every document the write owns besides the candidate (an append's committed prefix). */
    owned?(): readonly Y.Doc[];
    /** The append's rows committed: told once its attempt completed. */
    appended?(): void;
  }): PreparedDraftWrite {
    let state: "prepared" | "persisted" | "transferred" | "disposed" = "prepared";
    let committed: Transition | { resetTo: number } | { contained: true } | undefined;
    const destroyOwned = (keep?: Y.Doc) => {
      for (const doc of new Set([write.candidate, ...(write.owned?.() ?? [])]))
        if (doc !== keep) doc.destroy();
    };
    return {
      draftId: write.draftId,
      candidate: write.candidate,
      async persist() {
        if (state !== "prepared") throw new Error(`Draft ${write.draftId} write is ${state}`);
        committed = await write.persist();
        state = "persisted";
        return !("contained" in committed);
      },
      transfer() {
        if (state !== "persisted" || !committed)
          throw new Error(`Draft ${write.draftId} write was never persisted`);
        state = "transferred";
        if ("contained" in committed) {
          destroyOwned();
          return;
        }
        if ("resetTo" in committed) {
          // A reset's candidate is never installed: the room closes on the new generation.
          destroyOwned();
          notifyReset({ draftId: write.draftId, generation: committed.resetTo });
          return;
        }
        destroyOwned(committed.next.doc);
        install(write.draftId, committed, true);
        write.appended?.();
      },
      dispose() {
        if (state === "transferred" || state === "disposed") return;
        state = "disposed";
        destroyOwned();
      },
    };
  }

  /**
   * `journals` as an append from `base`, sequenced by the draft row's lock: the store reads
   * the committed prefix under it, `finalizeAppend` trims each row to what is novel there and
   * captures the receipts on the document it commits into, and that document becomes the next
   * replica. Nothing judged before the lock is written as truth.
   */
  function prepareAppend(
    base: DraftBase,
    journals: readonly AppendDraftJournalInput[],
    admitted?: Y.Doc,
  ): PreparedDraftAppend {
    const { snapshot, replica } = base;
    let prefix: Y.Doc;
    try {
      prefix = cloneReplica(replica);
    } catch (cause) {
      admitted?.destroy();
      throw cause;
    }
    let finalized: FinalizedAppend | undefined;
    let committedDoc: Y.Doc | undefined;
    let cut: SaveCut | undefined;
    const write = preparedWrite({
      draftId: snapshot.draftId,
      candidate: admitted ?? prefix,
      owned: () => [prefix, ...(committedDoc ? [committedDoc] : [])],
      appended: () => {
        if (snapshot.kind !== "work_draft") return;
        const mark = () => input.onAppendCommitted(snapshot.draftId);
        if (!input.store.deferUntilCommit(mark)) mark();
      },
      async persist() {
        const outcome = await input.store.appendRows({
          draftId: snapshot.draftId,
          documentId: snapshot.documentId,
          expectedGeneration: snapshot.generation,
          base: { checkpointRevision: replica.checkpointRevision, seq: replica.seq },
          finalize(read) {
            const judged = finalizeAppend(read, {
              candidate: prefix,
              rows: journals,
              containment: documentContainment,
              validateWriter: assertWriterAuthorship,
            });
            committedDoc = judged.doc;
            finalized = judged.result;
            cut = judged.cut;
            return judged.finalization;
          },
        });
        if (outcome.status === "contained") return { contained: true };
        if (outcome.status === "refused")
          throw new DraftStaleUpdateError(`Draft ${snapshot.draftId}`);
        if (outcome.status === "prefixMissing") {
          input.diagnostics?.appendPrefixMissing({
            draftId: snapshot.draftId,
            clocks: outcome.clocks,
          });
          throw new DraftPrefixMissingError(snapshot.draftId, outcome.clocks);
        }
        if (!finalized) throw new Error(`Draft ${snapshot.draftId} append was not finalized`);
        const { doc, prefixHeld, prefixRows, checkpointSeq } = finalized;
        const rows = [
          ...prefixRows.map((row) => row.update),
          ...finalized.rows.map((row) => row.updateData),
        ];
        const seq = Math.max(...prefixRows.map((row) => row.id), ...outcome.rowIds);
        if (!prefixHeld)
          // A rewrite moved the checkpoint: delivery diffs documents, as after a fold.
          return {
            next: {
              revision: outcome.revision,
              checkpointRevision: outcome.checkpointRevision,
              seq: Math.max(checkpointSeq, seq),
              generation: snapshot.generation,
              doc,
              tail: grownTail(EMPTY_TAIL, rows),
            },
          };
        return {
          next: {
            revision: outcome.revision,
            checkpointRevision: replica.checkpointRevision,
            seq: Math.max(replica.seq, seq),
            generation: snapshot.generation,
            doc,
            tail: grownTail(replica.tail, rows),
          },
          from: replica,
          rows,
        };
      },
    });
    return {
      ...write,
      cut() {
        if (!cut) throw new Error(`Draft ${snapshot.draftId} append has not persisted`);
        return cut;
      },
    };
  }

  /** `candidate` committed through shape B as `rewrite` describes it. */
  function prepareRewrite(
    draftId: string,
    candidate: Y.Doc,
    rewrite: Omit<CommitRewriteInput, "draftId" | "doc">,
  ): PreparedDraftWrite {
    return preparedWrite({
      draftId,
      candidate,
      async persist() {
        const outcome = await input.store.commitRewrite({ draftId, doc: candidate, ...rewrite });
        if (outcome.status === "fenced" || outcome.status === "blocked")
          throw new DraftRewriteRefused(draftId, outcome.status);
        if (outcome.status !== "committed") throw new DraftCasConflictError(draftId);
        if (rewrite.operation.kind === "reset") return { resetTo: outcome.generation };
        // The fold may have applied rows this process never installed: delivery diffs the
        // documents rather than trusting anything computed before the lock.
        return { next: { ...outcome, doc: candidate, tail: EMPTY_TAIL } };
      },
    });
  }

  /**
   * `candidate`, `upstream` merged into the committed replica, as a fold over the replica's
   * cursor: rows appended since are applied into it under the row lock. A work draft's effect
   * is judged against `upstream`, its new baseline, before the lock, and judged again on the
   * folded checkpoint only when the fold applied rows.
   */
  function preparePull(base: DraftBase, candidate: Y.Doc, pull: PullInput): PreparedDraftWrite {
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
    return prepareRewrite(snapshot.draftId, candidate, {
      policy: foldPolicy(base.replica),
      // A live pull's checkpoint would move the revision a pending Apply's completion resets at.
      fence: snapshot.kind === "work_draft" ? { kind: "pending-settlement" } : { kind: "none" },
      operation,
    });
  }

  /** A fold over everything appended past `replica`'s cursor. */
  function foldPolicy(replica: CommittedReplica): RewritePolicy {
    return { kind: "fold", checkpointRevision: replica.checkpointRevision, seq: replica.seq };
  }

  /** A re-fork of the draft from `upstream` under the caller's revision policy. */
  function prepareReset(
    snapshot: DraftSnapshot,
    upstream: Y.Doc,
    reset: Pick<ResetInput, "schemaVersion" | "editDisposition"> & { policy: RewritePolicy },
  ): PreparedDraftWrite {
    const candidate = createCollabYDoc({ gc: false });
    replicatedInto(upstream, candidate);
    return prepareRewrite(snapshot.draftId, candidate, {
      policy: reset.policy,
      fence: { kind: "none" },
      operation: {
        kind: "reset",
        editDisposition: reset.editDisposition ?? "discarded",
        schemaVersion: reset.schemaVersion ?? snapshot.schemaVersion,
      },
    });
  }

  /** A re-fork committed: the replica is dropped and rooms on older generations close. */
  function notifyReset(reset: { draftId: string; generation: number }): void {
    const install = () => {
      const current = committed.get(reset.draftId);
      if (current && current.generation < reset.generation) committed.delete(reset.draftId);
      input.onDraftReset?.(reset);
    };
    if (!input.store.deferUntilCommit(install)) install();
  }

  /**
   * One pull attempt: everything, the effect included, computed on a candidate of the
   * committed replica before the attempt's scope; inside it the fold applies what landed since
   * and the checkpoint is written.
   */
  async function pullAttempt(attempt: Attempt, pull: PullInput): Promise<PullOutcome> {
    const base = await loadBase(pull.draftId);
    const { snapshot } = base;
    if (snapshot.status !== "active") return "closed";
    // A durable thread peer has already saved its writes into the Work draft. If the parent
    // no longer contains them, a review retired their effect: merging cannot remove those
    // structs or undo their tombstones, so the peer re-forks from the parent.
    if (
      snapshot.kind === "thread_peer" &&
      !Y.snapshotContainsUpdate(Y.snapshot(pull.upstream), encodedOf(base.replica))
    ) {
      const write = prepareReset(snapshot, pull.upstream, { policy: foldPolicy(base.replica) });
      attempt.own(write);
      await attempt.commit(() => write.persist());
      return "pulled";
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

  /** A private copy: whatever its owner changes stays with it (decision F6). */
  async function copyDraft(draftId: string): Promise<{ doc: Y.Doc; snapshot: DraftSnapshot }> {
    const base = await loadBase(draftId);
    return { doc: cloneReplica(base.replica), snapshot: base.snapshot };
  }

  /**
   * `journals` admitted on a fresh copy of the base (the pre-lock policy check, kept as the
   * write's candidate) and prepared as an append: the one way a save's replay prepares rows.
   */
  function prepareRows(
    base: DraftBase,
    journals: readonly AppendDraftJournalInput[],
  ): PreparedDraftAppend {
    const admitted = cloneReplica(base.replica);
    try {
      admitSegmentRows(admitted, base.snapshot.documentId, journals);
    } catch (cause) {
      admitted.destroy();
      throw cause;
    }
    return prepareAppend(base, journals, admitted);
  }

  async function prepareStagedRows<T>(
    draftId: string,
    run: (
      doc: Y.Doc,
      snapshot: StagedDraftView,
    ) => Promise<{ result: T; rows: readonly Omit<AppendDraftJournalInput, "generation">[] }>,
    commit: boolean,
  ): Promise<{ result: T; write: PreparedDraftAppend | null }> {
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

  const frames = createWriterFrames(
    {
      loadBase,
      committed: (draftId) => committed.get(draftId),
      cloneReplica,
      containment: documentContainment,
      reconcileRoom,
      prepareAppend,
      prepareRewrite,
      foldPolicy,
      commitOnce,
    },
    { diagnostics: input.diagnostics },
  );

  return {
    notifyReset,
    readDraft: readCommitted,
    copyDraft,
    prepareStagedRows,

    pullFromDoc(pull) {
      return commitAttempts((attempt) => pullAttempt(attempt, pull)).catch((cause: unknown) => {
        if (cause instanceof DraftRewriteRefused) return cause.status;
        throw cause;
      });
    },

    resetFromDoc,

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
