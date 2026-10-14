/** Coordinates persisted branch-peer Y.Docs behind one mutation surface. */

import {
  DRAFT_SERVER_CLIENT_ID,
  findLostEdits,
  type LateTyping,
  type LostEdit,
  NO_LATE_TYPING,
  recoverLatePeerEdits,
  revisesLateTyping,
} from "@meridian/agent-edit/diff";
import type { SemanticEditIRV1 } from "@meridian/agent-edit/integration";
import { bytesEqual } from "@meridian/agent-edit/integration";
import type { DraftBaseRevision, DraftId } from "@meridian/contracts";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
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
import { draftDiffersFromBase, draftSchema } from "./draft-rebase.js";
import { currentResponseTransactionId, enlistResponseParticipant } from "./response-transaction.js";
import { DocumentSchemaMajorMismatchError, isStaleSchema } from "./stale-schema.js";

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
  state: Uint8Array;
  stateVector: Uint8Array;
  /** The live revision `review_base` reflects; null until a text branch's first rebase. */
  baseRevision?: DraftBaseRevision | null;
  schemaVersion: CollabSchemaVersion;
};

/**
 * How a write settles `has_effect`; the writer states it, nothing infers it. `text`: a Work draft, whose
 * effect is `draftDiffersFromBase` of the document being written. `peer`: a thread peer, which carries no
 * membership effect.
 */
export type BranchWriteEffect = { kind: "text"; hasEffect: boolean } | { kind: "peer" };

/** One branch-state write: a compare-and-swap on the full prior state (`writeBranchState`). */
export type PersistBranchInput = {
  branchId: string;
  expectedState: Uint8Array;
  state: Uint8Array;
  stateVector: Uint8Array;
  effect: BranchWriteEffect;
  /** Written with the state by the same CAS; absent leaves the column alone. */
  baseRevision?: DraftBaseRevision;
};

export type CommitBranchMutationInput = PersistBranchInput & {
  journals?: readonly AppendBranchJournalInput[];
};

export type AppendBranchJournalInput = {
  /** One logical tool write, shared by its segment rows. */
  documentEditKey?: string;
  branchId: string;
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

/** What late-peer recovery did with one writer update: counts only, never the writer's words. */
export type LateWriterEdits = {
  branchId: string;
  documentId: DocumentId;
  /** Lost edits found: typed runs plus deleted characters. */
  lost: number;
  /** Paragraphs of the peer's typing written into the draft. */
  written: number;
  /** Characters of rebased text the update deleted, left as they are (log-only). */
  dropped: number;
};

export type BranchStore = {
  getBranch(branchId: string): Promise<BranchSnapshot | null>;
  updateBranchSnapshot(input: PersistBranchInput): Promise<boolean>;
  commitBranchMutation(input: CommitBranchMutationInput): Promise<boolean>;
  /** Defers cache-visible effects when persistence joined a response transaction. */
  deferUntilCommit(callback: () => void): boolean;
};

export class BranchStaleUpdateError extends Error {
  constructor(readonly branchId: string) {
    super(`Branch ${branchId} update did not apply to the current state`);
    this.name = "BranchStaleUpdateError";
  }
}

/**
 * No writer frame can ever land on this branch: it is closed, or it is not a Work draft
 * (a writer room only ever targets a Work draft). `reason` names which.
 */
export class BranchClosedError extends Error {
  constructor(
    readonly branchId: string,
    readonly reason: "branch_closed" | "not_writer_draft" = "branch_closed",
  ) {
    super(
      reason === "branch_closed"
        ? `Branch ${branchId} is closed`
        : `Branch ${branchId} is not a writer draft`,
    );
    this.name = "BranchClosedError";
  }
}

/**
 * Admission judged a writer frame and refused it. Retrying the same bytes
 * refuses again, so the transport must end the room rather than reconnect.
 */
export class BranchWriterRefusedError extends Error {
  constructor(
    readonly branchId: string,
    readonly closed: boolean,
    cause: unknown,
  ) {
    super(`Branch ${branchId} refused a writer update`, { cause });
    this.name = "BranchWriterRefusedError";
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
  state: Uint8Array;
  stateVector: Uint8Array;
  doc: Y.Doc;
};

export type SegmentRowsInput = {
  branchId: string;
  sourceDoc: Y.Doc;
  rows: readonly AppendBranchJournalInput[];
};

/** The journal reads a save performs: the helper's history and attribution's concurrent rows. */
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
    ) => Promise<{ result: T; rows: readonly AppendBranchJournalInput[] }>,
    commit: boolean,
  ): Promise<T>;
  commitSegmentRows(input: SegmentRowsInput): Promise<boolean>;
  checkpoint(branchId: string): Promise<void>;
  /** The branch history B+ replays against, with each row's persisted inverse evidence. */
  listHelperHistory: BranchSaveJournalReads["listJournalRowsForBranch"];
  listConcurrentRows: BranchSaveJournalReads["listConcurrentJournalRows"];
};

export type BranchCoordinator = {
  /**
   * Merges `upstream` into the branch under a lease the caller holds (a pull takes its
   * branches' leases before its transaction); throws for a branch the lease does not cover.
   */
  pullFromDoc(lease: BranchLockLease, branchId: string, upstream: Y.Doc): Promise<Uint8Array>;
  /**
   * Rewrites a text branch's document as one server edit and persists it in one CAS under a lease the
   * caller holds. `run` edits the clone it is given; a returned `baseRevision` is written with the state.
   */
  rewriteDraft<T>(
    lease: BranchLockLease,
    branchId: string,
    run: (
      doc: Y.Doc,
      snapshot: BranchSnapshot,
    ) => Promise<{
      result: T;
      baseRevision?: DraftBaseRevision;
    }>,
  ): Promise<T>;
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
    updateData: Uint8Array;
    actorUserId?: string;
    roomDocument: Y.Doc;
  }): Promise<{ admitted: boolean }>;
  /**
   * A save's one door to branch state: every call runs under `lease`, acquires nothing, and
   * throws `BranchLeaseScopeError` for a branch the lease does not cover.
   */
  ownedSession(lease: BranchLockLease): OwnedBranchSession;
  broadcastUpdate(input: { branchId: string; update: Uint8Array }): void;
  /** Destroys every process replica; durable branches are untouched. Call after in-flight work finished. */
  dispose(): void;
};

export function createBranchCoordinator(input: {
  store: BranchStore;
  /** The reads a save's owned session makes; leave it to the adapter that serves them. */
  journalReads?: BranchSaveJournalReads;
  criticalSections?: BranchCriticalSections;
  maxCasRetries?: number;
  /** Clean replicas kept warm; the least recently used beyond this are destroyed and rebuilt from persisted bytes. */
  maxCachedReplicas?: number;
  /** A thread peer was found to lack part of its upstream: with no reset or refork this never happens. */
  onPeerNotContained?: (input: { branchId: string; upstreamBranchId: string | null }) => void;
  onBranchUpdate?: (input: { branchId: string; update: Uint8Array }) => void;
  /** A writer update touched text a rebase had already removed; recovery says what it placed. */
  onLateWriterEdits?: (input: LateWriterEdits) => void;
}): BranchCoordinator {
  const criticalSections = input.criticalSections ?? createBranchCriticalSections();
  const documentContainment = createDocumentContainment();
  const cached = new Map<string, CachedBranchDoc>();
  const pendingTransients = new Map<string, CachedBranchDoc>();
  const dirtyTransientBranches = new Set<string>();
  const maxCasRetries = input.maxCasRetries ?? 3;
  const maxCachedReplicas = input.maxCachedReplicas ?? 32;
  // Late typing recovered per draft, so a reconnect's keystroke-per-frame replay extends one paragraph
  // per typed span. Process memory: after a restart or eviction later keystrokes start new paragraphs.
  const lateTyping = new Map<string, LateTyping>();
  const MAX_LATE_TYPING_BRANCHES = 64;
  // Branches an operation is using right now: their replica is never destroyed under it.
  const pins = new Map<string, number>();

  /** Caches a replica as most recently used, then drops clean idle ones beyond the bound. */
  function remember(branchId: string, entry: CachedBranchDoc): void {
    cached.delete(branchId);
    cached.set(branchId, entry);
    trimReplicas();
  }

  function trimReplicas(): void {
    for (const [branchId, entry] of cached) {
      if (cached.size <= maxCachedReplicas) return;
      if (dirtyTransientBranches.has(branchId) || pins.has(branchId)) continue;
      cached.delete(branchId);
      entry.doc.destroy();
    }
  }

  /** Runs `run` with these branches' replicas pinned. */
  async function pinned<T>(branchIds: readonly string[], run: () => Promise<T>): Promise<T> {
    for (const id of branchIds) pins.set(id, (pins.get(id) ?? 0) + 1);
    try {
      return await run();
    } finally {
      for (const id of branchIds) {
        const left = (pins.get(id) ?? 1) - 1;
        if (left) pins.set(id, left);
        else pins.delete(id);
      }
      trimReplicas();
    }
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
        state: snapshot.state,
        stateVector: snapshot.stateVector,
        doc,
      };
      remember(snapshot.branchId, next);
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
              generation: 0n,
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

  /** The effect of writing `doc` into `snapshot`'s branch: the writer states it, nothing infers it later. */
  function effectOf(snapshot: BranchSnapshot, doc: Y.Doc): BranchWriteEffect {
    return snapshot.kind === "work_draft"
      ? { kind: "text", hasEffect: draftDiffersFromBase(doc) }
      : { kind: "peer" };
  }

  /** Returns false (the caller still owns `doc`) when the write changed nothing and wrote nothing. */
  async function persist(
    snapshot: BranchSnapshot,
    doc: Y.Doc,
    journals?: readonly AppendBranchJournalInput[],
    publishUpdate?: Uint8Array,
    kind: "mutation" | "pull" = "mutation",
    baseRevision?: DraftBaseRevision,
  ): Promise<boolean> {
    const state = Y.encodeStateAsUpdate(doc);
    const stateVector = Y.encodeStateVector(doc);
    if (!journals?.length && bytesEqual(state, snapshot.state) && !baseRevision) return false;
    const mutation = {
      branchId: snapshot.branchId,
      expectedState: snapshot.state,
      state,
      stateVector,
      effect: effectOf(snapshot, doc),
      ...(baseRevision ? { baseRevision } : {}),
      ...(journals ? { journals } : {}),
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
      remember(snapshot.branchId, { state, stateVector, doc });
      const update = journals?.length
        ? Y.mergeUpdates(journals.map((row) => row.updateData))
        : publishUpdate;
      if (update) input.onBranchUpdate?.({ branchId: snapshot.branchId, update });
    };
    if (currentResponseTransactionId()) {
      enlistResponseParticipant({ commit: publish, abort() {} });
      return true;
    }
    if (!input.store.deferUntilCommit(publish)) publish();
    return true;
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
    // With no reset or refork an upstream only grows, so a peer always contains what it saved into it.
    // Report, never repair, if that ever stops being true.
    if (
      snapshot.kind === "thread_peer" &&
      upstream &&
      !Y.snapshotContainsUpdate(Y.snapshot(upstream), snapshot.state)
    ) {
      input.onPeerNotContained?.({ branchId, upstreamBranchId: snapshot.upstreamBranchId });
    }
    // O(doc) clone-before-write is intentional per GATE-1 spec §9 (Q4 headroom):
    // failed CAS/rollback must never mutate the cached branch doc.
    const doc = cloneDoc(cachedDoc);
    const result = await operation(snapshot, doc);
    await persist(snapshot, doc, undefined, updateToPublish?.(result), kind);
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

  /**
   * Appends a writer update. Typing the update would lose to a rebase (under text the rebase removed)
   * is written as its own paragraph by a server-client update in this same admission, so the words
   * reach the draft as one ordinary `writer` row; its deletions of rebased text stay log-only (D33). Recovery runs here, under the branch's critical section after
   * the update applies to a clone and before the CAS; it is not part of any owned save session.
   */
  async function persistWriterUpdate(
    snapshot: BranchSnapshot,
    inputWriter: { branchId: string; updateData: Uint8Array; actorUserId?: string },
    currentDocument: Y.Doc,
    lost: LostPeerEdits,
  ): Promise<boolean> {
    const journal = {
      branchId: inputWriter.branchId,
      updateData: inputWriter.updateData,
      source: "writer" as const,
      actorUserId: inputWriter.actorUserId,
    };
    if (!hasLostEdits(lost)) return persistJournaledUpdate(snapshot, journal, currentDocument);
    const doc = cloneDoc(currentDocument);
    Y.applyUpdate(doc, inputWriter.updateData);
    const recovery = recoverLatePeerEdits({
      doc,
      update: inputWriter.updateData,
      lost,
      memory: lateTyping.get(snapshot.branchId) ?? NO_LATE_TYPING,
      schema: draftSchema,
      fragmentName: PROSEMIRROR_FRAGMENT_NAME,
      clientId: DRAFT_SERVER_CLIENT_ID,
    });
    // A deletion-only update that hit dead copies (a reconnect repeating tombstones) changes nothing: a
    // late deletion is log-only (D33), never replayed against the rebased text.
    if (bytesEqual(Y.encodeStateAsUpdate(currentDocument), Y.encodeStateAsUpdate(doc))) {
      doc.destroy();
      rememberLateTyping(snapshot.branchId, recovery.memory);
      return false;
    }
    input.onLateWriterEdits?.({
      branchId: snapshot.branchId,
      documentId: snapshot.documentId,
      lost: lost.typed.length + lost.deleted.length,
      written: recovery.written.length,
      dropped: recovery.dropped,
    });
    // One journal row: the recovered text is the writer's, so it travels with the writer's update.
    await persist(snapshot, doc, [
      {
        ...journal,
        updateData: recovery.update
          ? Y.mergeUpdates([inputWriter.updateData, recovery.update])
          : inputWriter.updateData,
      },
    ]);
    rememberLateTyping(snapshot.branchId, recovery.memory);
    return true;
  }

  /** Keeps a draft's late typing once its frame is persisted, dropping the least recent drafts beyond the bound. */
  function rememberLateTyping(branchId: string, memory: LateTyping): void {
    lateTyping.delete(branchId);
    lateTyping.set(branchId, memory);
    for (const oldest of lateTyping.keys()) {
      if (lateTyping.size <= MAX_LATE_TYPING_BRANCHES) break;
      lateTyping.delete(oldest);
    }
  }

  async function persistJournaledUpdate(
    snapshot: BranchSnapshot,
    inputJournal: AppendBranchJournalInput,
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
    await persist(snapshot, doc, [inputJournal]);
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
      state: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
      doc,
    };
    const transactionId = currentResponseTransactionId();
    if (!transactionId) {
      remember(snapshot.branchId, next);
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
        dirtyTransientBranches.add(snapshot.branchId);
        remember(snapshot.branchId, pending);
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
    ) => Promise<{ result: T; rows: readonly AppendBranchJournalInput[] }>,
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
          await applySegmentRows(admitted, snapshot, rows);
          if (!bytesEqual(Y.encodeStateAsUpdate(admitted), Y.encodeStateAsUpdate(doc)))
            throw new Error("Response replay differs from its admitted segment rows");
        } finally {
          admitted.destroy();
        }
        await persist(snapshot, doc, rows);
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
    const doc = cloneDoc((await materialize(snapshot)).doc);
    const journals = batch.rows;
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
      listConcurrentRows: (branchId, options) =>
        under(branchId, async () =>
          requireJournalReads().listConcurrentJournalRows(branchId, options),
        ),
    };
  }

  function requireJournalReads(): BranchSaveJournalReads {
    if (!input.journalReads) throw new Error("This coordinator reads no branch journal");
    return input.journalReads;
  }

  return {
    readBranch(branchId, fn) {
      return pinned([branchId], () =>
        criticalSections.withBranches([branchId], (lease) => readUnder(lease, branchId, fn)),
      );
    },

    withLeases: (branchIds, run) =>
      pinned(branchIds, () => criticalSections.withBranches(branchIds, run)),

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

    rewriteDraft(lease, branchId, run) {
      assertBranchLeaseCovers(lease, branchId);
      return retryCas(async () => {
        const snapshot = await loadSnapshot(branchId);
        assertWritableBranch(snapshot);
        const doc = cloneDoc((await materialize(snapshot)).doc);
        try {
          const { result, baseRevision } = await run(doc, snapshot);
          const delta = Y.encodeStateAsUpdate(doc, snapshot.stateVector);
          const wrote = await persist(snapshot, doc, undefined, delta, "pull", baseRevision);
          // Persisted, the document is the cached replica; otherwise nothing owns it.
          if (!wrote) doc.destroy();
          return result;
        } catch (cause) {
          doc.destroy();
          throw cause;
        }
      });
    },

    dispose() {
      for (const entry of cached.values()) entry.doc.destroy();
      for (const entry of pendingTransients.values()) entry.doc.destroy();
      cached.clear();
      pendingTransients.clear();
      dirtyTransientBranches.clear();
      lateTyping.clear();
    },

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
          return await pinned([inputWriter.branchId], () =>
            criticalSections.withBranches([inputWriter.branchId], async () => {
              const snapshot = await loadSnapshot(inputWriter.branchId);
              const { doc: currentDocument } = await materialize(snapshot);
              // A pull or rebase can commit between the room loading and this frame. The room is
              // only behind the durable snapshot, so catch it up under the lock instead of
              // refusing a frame that is merely early.
              if (
                snapshot.kind === "work_draft" &&
                snapshot.status === "active" &&
                !documentContainment.contains(inputWriter.roomDocument, snapshot.state)
              ) {
                Y.applyUpdate(inputWriter.roomDocument, snapshot.state, "branch-room-reconcile");
              }
              const lost = findLostEdits(currentDocument, inputWriter.updateData);
              const admission = await admitWriterUpdate({
                targetDocument: currentDocument,
                update: inputWriter.updateData,
                validateTarget() {
                  if (snapshot.kind !== "work_draft") {
                    throw new BranchClosedError(inputWriter.branchId, "not_writer_draft");
                  }
                  if (snapshot.status !== "active")
                    throw new BranchClosedError(inputWriter.branchId);
                },
                // Containment first: a repeated delete set is no new instruction, so recovery judges
                // only what the document has not seen. A deletion of recovered typing is the exception:
                // the document holds it already (the typing was dead), but the paragraph does not.
                isContained: () =>
                  documentContainment.contains(currentDocument, inputWriter.updateData) &&
                  !revisesLateTyping(
                    lateTyping.get(inputWriter.branchId) ?? NO_LATE_TYPING,
                    lost.deleted,
                  ),
                append: () => persistWriterUpdate(snapshot, inputWriter, currentDocument, lost),
              });
              return { admitted: admission.admitted && admission.value };
            }),
          );
        } catch (cause) {
          if (!(cause instanceof BranchCasConflictError) || attempt++ >= maxCasRetries) throw cause;
        }
      }
    },
  };
}

type LostPeerEdits = { typed: LostEdit[]; deleted: LostEdit[] };
const hasLostEdits = (lost: LostPeerEdits) => lost.typed.length > 0 || lost.deleted.length > 0;

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
