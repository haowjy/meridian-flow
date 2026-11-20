/** Committed draft replicas, prepared append/rewrite lifetime, delivery and maintenance. */
import {
  type SaveCut,
  type SavePrecondition,
  SavePreconditionRefused,
} from "@meridian/agent-edit/integration";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { processDetachedWork } from "../../../shared/detached-work.js";
import { testHook } from "../../../shared/test-hooks.js";
import { createDocumentContainment } from "./document-containment.js";
import { type AttemptScope, NO_ATTEMPT_SCOPE, runBoundedAttempts } from "./draft-attempts.js";
import {
  type AuthorServerRows,
  type FinalizeAppendInput,
  type FinalizedAppend,
  finalizeAppend,
} from "./draft-receipts.js";
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
  type RewritePolicy,
} from "./draft-store.js";
import { encodeImmutableDraft } from "./immutable-draft-state.js";
/**
 * The draft as committed at `revision`: replaced, never mutated. `seq` is the highest journal
 * id it contains; `tail` counts the rows (and their bytes) it holds past its checkpoint;
 * its immutable document shares lazy update bytes with any save cut.
 */
export type CommittedReplica = {
  readonly revision: number;
  readonly checkpointRevision: number;
  readonly seq: number;
  readonly doc: Y.Doc;
  readonly tail: TailSize;
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

export type WriterFrame = { draftId: string; updateData: Uint8Array; actorUserId?: string };

/** What a draft operation works from: the row as read and the committed replica at it. */
export type DraftBase = {
  snapshot: DraftSnapshot;
  replica: CommittedReplica;
};

/**
 * The runtime surface the coordinator's operations build on: committed replicas, private
 * candidates of them, prepared writes and their attempts.
 */
export type DraftRuntime = {
  loadBase(draftId: string): Promise<DraftBase>;
  /** The replica committed for the draft, if any: read it, never mutate it. */
  committed(draftId: string): CommittedReplica | undefined;
  cloneReplica(replica: CommittedReplica): Y.Doc;
  encodedOf(replica: CommittedReplica): Uint8Array;
  containment: ReturnType<typeof createDocumentContainment>;
  /**
   * `journals` as an append from `base`, finalized under the row lock against what is
   * committed (design §2.2). `admitted`, when given, is the caller's pre-lock document holding
   * the rows; it is the write's `candidate` until the write commits.
   */
  prepareAppend(
    base: DraftBase,
    journals: readonly AppendDraftJournalInput[],
    options?: {
      admitted?: Y.Doc;
      authorServerRows?: AuthorServerRows;
      serverRow?: FinalizeAppendInput["serverRow"];
      work?: "active" | "any";
      precondition?: SavePrecondition;
    },
  ): PreparedDraftAppend;
  prepareRewrite(
    draftId: string,
    candidate: Y.Doc,
    rewrite: Omit<CommitRewriteInput, "draftId" | "doc">,
  ): PreparedDraftWrite;
  foldPolicy(replica: CommittedReplica): RewritePolicy;
  /**
   * A writer's frame, already judged in the room: stored with one insert. The committed
   * replica is not touched; the next command's read catches it up from the tail.
   */
  appendWriterFrame(frame: WriterFrame): Promise<void>;
  /** `write` as one whole attempt: true when it wrote, false when it was contained. */
  commitOnce(
    write: PreparedDraftWrite,
    options: { scope?: AttemptScope; moved?: (cause: unknown) => void },
  ): Promise<boolean>;
};

export type DraftDiagnostics = {
  /** The background tail fold failed; the tail stays until the next append crosses the bound. */
  compactionFailed(input: { draftId: string; cause: unknown }): void;
  /** An append's rows depend on rows the journal lacks: nothing was written. */
  appendPrefixMissing(input: {
    draftId: string;
    clocks: readonly { client: number; clock: number }[];
  }): void;
};

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
  /** Installation waits for the surrounding transaction's commit, so a later rollback installs nothing. */
  transfer(): void;
  dispose(): void;
};

/** An append's committed-prefix cut, available after persist resolves. */
export type PreparedDraftAppend = PreparedDraftWrite & { cut(): SaveCut };

export type DraftRuntimeInput = {
  store: DraftStore;
  /** Each attempt's rollback boundary: a root transaction, or a savepoint in an ambient one. */
  attemptScope?: AttemptScope;
  /**
   * A write committed: brings the draft's room (if this process has one open) up to the
   * journal. Called after the commit, outside every transaction; the runtime only joins it.
   */
  deliver?: (draftId: string) => Promise<void>;
  diagnostics?: DraftDiagnostics;
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
   * caught up from the tail when only appends landed since, otherwise materialized. It
   * delivers nothing: a room reads the draft in its own `catchUp`.
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
        };
        install(documentDraft.draftId, next);
        return next;
      }
      const next: CommittedReplica = {
        revision: documentDraft.revision,
        checkpointRevision: documentDraft.checkpointRevision,
        seq: Math.max(documentDraft.checkpointSeq, ...read.tail.map((row) => row.id)),
        doc: materializeDraftRead(read),
        tail: grownTail(EMPTY_TAIL, rows),
      };
      install(documentDraft.draftId, next);
      return next;
    } catch (cause) {
      throw new DraftCorruptError({
        draftId: documentDraft.draftId,
        documentId: documentDraft.documentId,
        cause,
      });
    }
  }

  /**
   * The one way a replica becomes the draft's committed replica. It runs when the transaction
   * the replica was read or written in commits (a savepoint's rows only once its root commits
   * too) and installs only past the replica installed by then; a candidate whose transaction
   * rolls back is destroyed instead. A replica a write produced (`written`) also tells the
   * draft's room to catch up, whether or not it won the install: the room reads the journal,
   * not this replica.
   */
  function install(draftId: string, next: CommittedReplica, options?: { written: true }): void {
    const install = () => {
      const previous = committed.get(draftId);
      if (!previous || previous.revision < next.revision) committed.set(draftId, next);
      if (options?.written && input.deliver)
        void processDetachedWork.track(input.deliver(draftId), "draft room catch-up");
    };
    const abort = options?.written ? () => next.doc.destroy() : undefined;
    if (!input.store.deferUntilCommit(install, abort)) install();
  }

  function encodedOf(replica: CommittedReplica): Uint8Array {
    return encodeImmutableDraft(replica.doc);
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
    persist(): Promise<CommittedReplica | { contained: true }>;
    /** Every document the write owns besides the candidate (an append's committed prefix). */
    owned?(): readonly Y.Doc[];
    /** The append's rows committed: told once its attempt completed. */
    appended?(): void;
  }): PreparedDraftWrite {
    let state: "prepared" | "persisted" | "transferred" | "disposed" = "prepared";
    let committed: CommittedReplica | { contained: true } | undefined;
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
        destroyOwned(committed.doc);
        install(write.draftId, committed, { written: true });
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
    options?: {
      admitted?: Y.Doc;
      authorServerRows?: AuthorServerRows;
      serverRow?: FinalizeAppendInput["serverRow"];
      work?: "active" | "any";
      precondition?: SavePrecondition;
    },
  ): PreparedDraftAppend {
    const { snapshot, replica } = base;
    const { admitted, authorServerRows, serverRow, work = "active", precondition } = options ?? {};
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
        const complete = () => {
          input.onAppendCommitted(snapshot.draftId);
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
              candidateState: encodedOf(replica),
              work,
              rows: journals,
              containment: documentContainment,
              authorServerRows,
              serverRow,
              precondition,
            });
            committedDoc = judged.doc;
            finalized = judged.result;
            cut = judged.cut;
            return judged.finalization;
          },
        });
        if (outcome.status === "contained") return { contained: true };
        if (outcome.status === "preconditionFailed")
          throw new SavePreconditionRefused(snapshot.documentId);
        if (outcome.status === "refused")
          throw new DraftStaleUpdateError(`Draft ${snapshot.draftId}`);
        if (outcome.status === "prefixMissing") {
          input.diagnostics?.appendPrefixMissing({
            draftId: snapshot.draftId,
            clocks: outcome.clocks,
          });
          throw new DraftPrefixMissingError(snapshot.draftId, outcome.clocks);
        }
        if (!finalized || !cut)
          throw new Error(`Draft ${snapshot.draftId} append was not finalized`);
        cut.position = Math.max(finalized.checkpointSeq, ...outcome.rowIds);
        const { doc, prefixHeld, prefixRows, checkpointSeq } = finalized;
        const rows = [
          ...prefixRows.map((row) => row.update),
          ...finalized.rows.map((row) => row.updateData),
        ];
        const seq = Math.max(...prefixRows.map((row) => row.id), ...outcome.rowIds);
        // A rewrite that moved the checkpoint leaves a tail of only these rows.
        return {
          revision: outcome.revision,
          checkpointRevision: prefixHeld ? replica.checkpointRevision : outcome.checkpointRevision,
          seq: Math.max(prefixHeld ? replica.seq : checkpointSeq, seq),
          doc,
          tail: grownTail(prefixHeld ? replica.tail : EMPTY_TAIL, rows),
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
        if (outcome.status !== "committed") throw new DraftCasConflictError(draftId);
        return { ...outcome, doc: candidate, tail: EMPTY_TAIL };
      },
    });
  }

  /**
   * Folds a long tail into a new checkpoint in the background. `compacting` keeps one fold per
   * draft in this process; anything else is the fold fence's: compaction is content-free, so
   * a frame or inverse that lands meanwhile is folded in, and a rewrite that commits first
   * makes it miss (the next append past the bound tries again). Called after an append
   * commits, outside every transaction; a failure is reported and leaves the tail for the
   * next append. A writer's frame leaves the replica as it was, so it passes `appends`, the
   * revisions since the checkpoint, which counts the tail's rows without reading them.
   */
  function compactIfLong(draftId: string, appends = 0): void {
    const long = ({ tail }: CommittedReplica) =>
      tail.rows >= COMPACT_TAIL_ROWS || tail.bytes >= COMPACT_TAIL_BYTES;
    const replica = committed.get(draftId);
    if (compacting.has(draftId) || !((replica && long(replica)) || appends >= COMPACT_TAIL_ROWS))
      return;
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

  async function appendWriterFrame(frame: WriterFrame): Promise<void> {
    const { revision, checkpointRevision } = await input.store.appendWriterRow(frame);
    await testHook("draft.append.afterCommit");
    input.onAppendCommitted(frame.draftId);
    compactIfLong(frame.draftId, revision - checkpointRevision);
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
    prepareAppend,
    prepareRewrite,
    foldPolicy,
    appendWriterFrame,
    commitOnce,
  };
}
