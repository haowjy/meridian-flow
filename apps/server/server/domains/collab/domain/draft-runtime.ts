/** Committed draft replicas, prepared append/rewrite lifetime, delivery and maintenance. */
import {
  DRAFT_SERVER_CLIENT_ID,
  findLostEdits,
  type LateTyping,
  NO_LATE_TYPING,
  recoverLatePeerEdits,
  retainLateTypingDeletions,
} from "@meridian/agent-edit/diff";
import type { ThreadId } from "@meridian/contracts/runtime";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { createDocumentContainment } from "./document-containment.js";
import { assertWriterAuthorship } from "./document-mutation-policy.js";
import { type AttemptScope, NO_ATTEMPT_SCOPE, runBoundedAttempts } from "./draft-attempts.js";
import { type AuthorServerRows, type FinalizedAppend, finalizeAppend } from "./draft-receipts.js";
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
  type RewriteOutcome,
  type RewritePolicy,
} from "./draft-store.js";
import type { WriterFrameDiagnostics } from "./draft-writer-frames.js";
/**
 * The draft as committed at `revision`: replaced, never mutated. `seq` is the highest journal
 * id it contains; `tail` counts the rows (and their bytes) it holds past its checkpoint;
 * `encoded` is its update bytes, computed once when first needed.
 */
export type CommittedReplica = {
  readonly revision: number;
  readonly checkpointRevision: number;
  readonly seq: number;
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

const COMPACT_TAIL_ROWS = 512;
const COMPACT_TAIL_BYTES = 2 * 1024 * 1024;

type TailSize = { readonly rows: number; readonly bytes: number };
const EMPTY_TAIL: TailSize = { rows: 0, bytes: 0 };

function grownTail(tail: TailSize, updates: readonly Uint8Array[]): TailSize {
  return {
    rows: tail.rows + updates.length,
    bytes: updates.reduce((total, update) => total + update.byteLength, tail.bytes),
  };
}

/** What a draft operation works from: the row as read and the committed replica at it. */
export type DraftBase = {
  snapshot: DraftSnapshot;
  replica: CommittedReplica;
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
  encodedOf(replica: CommittedReplica): Uint8Array;
  containment: ReturnType<typeof createDocumentContainment>;
  /** A durable echo can still carry the late peer's view of deleted separators. */
  acknowledgeContainedFrame(draftId: string, doc: Y.Doc, update: Uint8Array): boolean;
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
    options?: { admitted?: Y.Doc; authorServerRows?: AuthorServerRows; work?: "active" | "any" },
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

/** A rewrite refused for a reason other than a moved revision: never retried. */
export class DraftRewriteRefused extends Error {
  constructor(
    readonly draftId: string,
    readonly status: Extract<RewriteOutcome["status"], "upstreamMoved">,
  ) {
    super(`Draft ${draftId} rewrite was refused: ${status}`);
    this.name = "DraftRewriteRefused";
  }
}

export type DraftRuntimeInput = {
  store: DraftStore;
  /** Each attempt's rollback boundary: a root transaction, or a savepoint in an ambient one. */
  attemptScope?: AttemptScope;
  onDraftUpdate?: (input: { draftId: string; update: Uint8Array }) => void;
  /** Applies a reconciling update to one room; defaults to a plain apply. */
  applyToRoom?: (room: Y.Doc, update: Uint8Array) => void;
  diagnostics?: WriterFrameDiagnostics;
  /**
   * A work draft's append committed rows: its derived state (`has_effect`, the Work's badge) is
   * stale until the projection job judges it (design §3.1). Required, so an omission fails to
   * compile rather than leaving the badge to the sweep.
   */
  onAppendCommitted: (draftId: string) => void;
};

export function createDraftRuntime(input: DraftRuntimeInput): DraftRuntime {
  const attemptScope = input.attemptScope ?? NO_ATTEMPT_SCOPE;
  const documentContainment = createDocumentContainment();
  const committed = new Map<string, CommittedReplica>();
  const compacting = new Set<string>();
  const lateTyping = new Map<string, LateTyping>();

  function rememberLateTyping(draftId: string, memory: LateTyping): void {
    if (memory === NO_LATE_TYPING) lateTyping.delete(draftId);
    else lateTyping.set(draftId, memory);
  }

  function acknowledgeContainedFrame(draftId: string, doc: Y.Doc, update: Uint8Array): boolean {
    if (!documentContainment.contains(doc, update)) return false;
    if (!lateTyping.has(draftId)) return true;
    const lost = findLostEdits(doc, update);
    if (!lost.deleted.length) return true;
    const remember = () => {
      // An outer transaction can outlive another committed frame. Advance the latest
      // memory here, never replace it with a snapshot taken before that frame.
      const memory = lateTyping.get(draftId);
      if (!memory) return;
      rememberLateTyping(
        draftId,
        recoverLatePeerEdits({
          doc,
          update,
          lost: { typed: [], deleted: lost.deleted },
          memory,
          schema: buildDocumentSchema(),
          fragmentName: PROSEMIRROR_FRAGMENT_NAME,
          clientId: DRAFT_SERVER_CLIENT_ID,
        }).memory,
      );
    };
    if (!input.store.deferUntilCommit(remember)) remember();
    return true;
  }

  /** One write as a whole attempt inside `scope`. */
  function commitOnce(
    write: PreparedDraftWrite,
    options: { scope?: AttemptScope; moved?: (cause: unknown) => void },
  ): Promise<boolean> {
    return runBoundedAttempts({
      bound: 1,
      scope: options.scope ?? attemptScope,
      isMiss: (cause) => cause instanceof DraftCasConflictError,
      async run(attempt) {
        attempt.own(write);
        return attempt.commit(() => write.persist());
      },
      exhausted(cause) {
        if (!options.moved) throw cause;
        options.moved(cause);
        return false;
      },
    });
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
      const update = deliveryFrom(previous, transition);
      if (update) input.onDraftUpdate?.({ draftId, update });
    };
    const abort = owned ? () => transition.next.doc.destroy() : undefined;
    if (!input.store.deferUntilCommit(install, abort)) install();
  }

  /**
   * What `transition` adds to `previous` within one draft, which a rewrite only merges
   * into: its own rows when they cover everything past `previous` (design §2.4), otherwise the
   * difference of the two documents (a fold or checkpoint, whose rows this process never saw
   * one by one), or nothing when the rewrite changed no content. Rows built on `from` cover
   * `(from.seq, next.seq]`; with the checkpoint unmoved and `from` no newer than `previous`
   * that is a superset of `(previous.seq, next.seq]`, because commit order is id order within a
   * draft. Yjs applies a repeat as a no-op, so a room that already holds part of it is
   * unharmed.
   */
  function deliveryFrom(previous: CommittedReplica, transition: Transition): Uint8Array | null {
    const { from, rows, next } = transition;
    if (
      rows &&
      from &&
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
      revision: replica.revision,
      trigger,
      bytes: update.byteLength,
    });
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
   * completed; installation owns the committed replica). Disposing
   * destroys every document the write owns in every state but the last, so a write whose own
   * statement succeeded in a scope that a later miss rolled back is dropped like one that never
   * ran. A contained append persisted nothing and transfers nothing.
   */
  function preparedWrite(write: {
    draftId: string;
    candidate: Y.Doc;
    persist(): Promise<Transition | { contained: true }>;
    /** Every document the write owns besides the candidate (an append's committed prefix). */
    owned?(): readonly Y.Doc[];
    /** The append's rows committed: told once its attempt completed. */
    appended?(): void;
  }): PreparedDraftWrite {
    let state: "prepared" | "persisted" | "transferred" | "disposed" = "prepared";
    let committed: Transition | { contained: true } | undefined;
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
    options?: { admitted?: Y.Doc; authorServerRows?: AuthorServerRows; work?: "active" | "any" },
  ): PreparedDraftWrite {
    const { snapshot, replica } = base;
    const { admitted, authorServerRows, work = "active" } = options ?? {};
    let prefix: Y.Doc;
    try {
      prefix = cloneReplica(replica);
    } catch (cause) {
      admitted?.destroy();
      throw cause;
    }
    let finalized: FinalizedAppend | undefined;
    let committedDoc: Y.Doc | undefined;
    return preparedWrite({
      draftId: snapshot.draftId,
      candidate: admitted ?? prefix,
      owned: () => [prefix, ...(committedDoc ? [committedDoc] : [])],
      appended: () => {
        const complete = () => {
          if (snapshot.kind === "work_draft") {
            if (finalized?.lateTyping) {
              rememberLateTyping(
                snapshot.draftId,
                finalized.lateTyping === NO_LATE_TYPING
                  ? NO_LATE_TYPING
                  : retainLateTypingDeletions(
                      finalized.lateTyping,
                      lateTyping.get(snapshot.draftId) ?? NO_LATE_TYPING,
                    ),
              );
            }
            input.onAppendCommitted(snapshot.draftId);
          }
          compactIfLong(snapshot.draftId);
        };
        if (!input.store.deferUntilCommit(complete)) complete();
      },
      async persist() {
        const outcome = await input.store.appendRows({
          draftId: snapshot.draftId,
          documentId: snapshot.documentId,
          work,
          base: { checkpointRevision: replica.checkpointRevision, seq: replica.seq },
          async finalize(read) {
            const judged = await finalizeAppend(read, {
              candidate: prefix,
              work,
              rows: journals,
              containment: documentContainment,
              validateWriter: assertWriterAuthorship,
              authorServerRows,
              ...(snapshot.kind === "work_draft"
                ? {
                    recovery: {
                      memory: () => lateTyping.get(snapshot.draftId) ?? NO_LATE_TYPING,
                      serverDeletedBlocks: (ids: readonly Y.ID[]) =>
                        input.store.serverDeletedBlocks(snapshot.draftId, ids),
                    },
                  }
                : {}),
            });
            committedDoc = judged.doc;
            finalized = judged.result;
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
              doc,
              tail: grownTail(EMPTY_TAIL, rows),
            },
          };
        return {
          next: {
            revision: outcome.revision,
            checkpointRevision: replica.checkpointRevision,
            seq: Math.max(replica.seq, seq),
            doc,
            tail: grownTail(replica.tail, rows),
          },
          from: replica,
          rows,
        };
      },
    });
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
        if (outcome.status === "upstreamMoved")
          throw new DraftRewriteRefused(draftId, outcome.status);
        if (outcome.status !== "committed") throw new DraftCasConflictError(draftId);
        // The fold may have applied rows this process never installed: delivery diffs the
        // documents rather than trusting anything computed before the lock.
        return { next: { ...outcome, doc: candidate, tail: EMPTY_TAIL } };
      },
    });
  }

  /**
   * Folds a long tail into a new checkpoint in the background. `compacting` keeps one fold per
   * draft in this process; anything else is the fold fence's: compaction is content-free, so
   * a frame or inverse that lands meanwhile is folded in, and a rewrite that commits first
   * makes it miss (the next append past the bound tries again). Called after an append
   * commits, outside every transaction; a failure is reported and leaves the tail for the
   * next append.
   */
  function compactIfLong(draftId: string): void {
    const long = ({ tail }: CommittedReplica) =>
      tail.rows >= COMPACT_TAIL_ROWS || tail.bytes >= COMPACT_TAIL_BYTES;
    const replica = committed.get(draftId);
    if (!replica || compacting.has(draftId) || !long(replica)) return;
    compacting.add(draftId);
    void (async () => {
      const { replica: current } = await loadBase(draftId);
      if (!long(current)) return;
      const write = prepareRewrite(draftId, cloneReplica(current), {
        policy: foldPolicy(current),
        operation: { kind: "compact" },
      });
      // A moved or closed draft: the next append past the bound tries again.
      await commitOnce(write, { moved: () => {} });
    })()
      .catch((cause: unknown) => input.diagnostics?.compactionFailed({ draftId, cause }))
      .finally(() => compacting.delete(draftId));
  }

  /** A fold over everything appended past `replica`'s cursor. */
  function foldPolicy(replica: CommittedReplica): RewritePolicy {
    return { kind: "fold", checkpointRevision: replica.checkpointRevision, seq: replica.seq };
  }

  return {
    loadBase,
    committed: (id) => committed.get(id),
    cloneReplica,
    encodedOf,
    containment: documentContainment,
    reconcileRoom,
    prepareAppend,
    acknowledgeContainedFrame,
    prepareRewrite,
    foldPolicy,
    commitOnce,
  };
}
