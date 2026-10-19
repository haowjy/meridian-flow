/**
 * Agent-edit bindings over a thread's Work drafts: a call reads its Work draft's room copy, a
 * reply's save reconciles and appends its rows there. The thread peer is identity only.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AgentEditCodec,
  bytesEqual,
  type ConcurrentUpdateOrigin,
  cloneYDoc,
  type DocumentAccess,
  DocumentAccessLostError,
  type DocumentCoordinator,
  type JournalBatchAppendEntry,
  type JournalReadOptions,
  type JournalSnapshot,
  type PersistedUpdate,
  type StagedReconcile,
  type StagedRoomEntries,
  type StagedWriteSaveResult,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
  yjsDeltaUpdate,
  yjsUpdateFromState,
} from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import type { Branches } from "./branches.js";
import { collabHook } from "./collab-test-hooks.js";
import type { DraftCoordinator } from "./draft-coordinator.js";
import type { DraftJournalRow, DraftReplayJournalReads } from "./draft-journal.js";
import { peerLossReason, ThreadPeerPullLost, type WorkDraftLookup } from "./draft-pulls.js";
import type { DraftResolver, ResolvedDraft } from "./draft-resolver.js";
import { reconcileStagedDraftWrites } from "./draft-response-replay.js";
import {
  DraftCasConflictError,
  DraftMissingError,
  type DraftSnapshot,
  DraftStaleUpdateError,
} from "./draft-store.js";
import {
  type AttributionRow,
  docFromState,
  partitionByBlockCoverage,
  touchedHashesForCoverage,
} from "./draft-update-attribution.js";
import { draftRoom } from "./observation-rooms.js";
import type { ReplyPin } from "./reply-save-fences.js";
import type { ResponseCommitParticipant } from "./response-transaction.js";

export type DraftConcurrentJournalWatermarks = {
  current(threadId: ThreadId, documentId: DocumentId): number | undefined;
  capturePending(
    threadId: ThreadId,
    documentId: DocumentId,
    journalId: number,
    attemptId?: string,
  ): void;
  commitPending(threadId: ThreadId, documentId: DocumentId, attemptId?: string): void;
  clearPending(threadId: ThreadId, documentId: DocumentId): void;
};

export type DraftAgentEditDiagnostics = {
  replyPinMismatch(payload: { documentId: DocumentId; threadId?: ThreadId; pin: ReplyPin }): void;
};

export type AfterCommit = (callback: () => void | Promise<void>) => void;
export type EnlistResponseParticipant = (participant: ResponseCommitParticipant) => boolean;

export function createDraftConcurrentJournalWatermarks(): DraftConcurrentJournalWatermarks {
  const currentByThreadDocument = new Map<string, number>();
  const pendingByThreadDocument = new Map<string, { journalId: number; attemptId?: string }>();
  const key = (threadId: ThreadId, documentId: DocumentId) => `${threadId}:${documentId}`;
  return {
    current(threadId, documentId) {
      return currentByThreadDocument.get(key(threadId, documentId));
    },
    capturePending(threadId, documentId, journalId, attemptId) {
      pendingByThreadDocument.set(key(threadId, documentId), { journalId, attemptId });
    },
    commitPending(threadId, documentId, attemptId) {
      const mapKey = key(threadId, documentId);
      const pending = pendingByThreadDocument.get(mapKey);
      if (pending === undefined) return;
      if (pending.attemptId !== attemptId) return;
      const current = currentByThreadDocument.get(mapKey) ?? 0;
      if (pending.journalId > current) currentByThreadDocument.set(mapKey, pending.journalId);
      pendingByThreadDocument.delete(mapKey);
    },
    clearPending(threadId, documentId) {
      pendingByThreadDocument.delete(key(threadId, documentId));
    },
  };
}

type ConcurrentAttributionBasis = {
  baselineSnapshot: Y.Snapshot;
  baselineState: Uint8Array | null;
  currentUpstreamState?: Uint8Array;
  fallbackCurrentUpstream: Y.Doc;
  journalRows: readonly AttributionRow[];
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
};

type PartitionedConcurrentUpdate =
  | {
      type: "journal";
      rowId: number;
      origin: ConcurrentUpdateOrigin;
      effectiveUpdate: Uint8Array;
      touchedHashes?: { human?: readonly string[]; agent?: readonly string[] };
      deletedHashes?: { human?: readonly string[]; agent?: readonly string[] };
    }
  | {
      type: "human";
      origin: { type: "human"; userId: string };
      residualUpdate: Uint8Array;
      touchedHashes?: { human?: readonly string[]; agent?: readonly string[] };
      deletedHashes?: { human?: readonly string[]; agent?: readonly string[] };
    };

export function createDraftAgentEditCoordinator(input: {
  threadId: ThreadId;
  draftCoordinator: DraftCoordinator;
  drafts: DraftLookupWithSnapshots;
  journalRows: DraftReplayJournalReads;
  liveJournal?: Pick<UpdateJournal, "read">;
  /** The live→Work rebase at the tool boundary: every room read runs it first. */
  flushLivePull(documentId: DocumentId): Promise<void>;
  branches: Pick<Branches, "shareActive">;
  afterCommit: AfterCommit;
  enlistResponseParticipant: EnlistResponseParticipant;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  concurrentJournalWatermarks?: DraftConcurrentJournalWatermarks;
}): DocumentCoordinator {
  const concurrentJournalWatermarks =
    input.concurrentJournalWatermarks ?? createDraftConcurrentJournalWatermarks();
  function draftRows(draftId: string, entries: readonly JournalBatchAppendEntry[]) {
    return entries.flatMap((entry) => {
      const mutation = entry.mutation;
      if (mutation?.mode !== "threadPeer")
        throw new Error("thread_peer_commit_missing_draft_generation");
      return (mutation.editParts ?? [entry.update]).map((updateData) => ({
        draftId,
        source: "agent" as const,
        updateData,
        documentEditKey: mutation.writeId,
        threadId: (mutation.threadId as ThreadId | undefined) ?? input.threadId,
        turnId: mutation.turnId ?? null,
        wId: mutation.wId ?? null,
        toolCallId: mutation.toolCallId ?? null,
        updateMeta: entry.meta ?? null,
        ...(mutation.semanticEditIr ? { semanticEditIr: mutation.semanticEditIr } : {}),
      }));
    });
  }
  const drafts = input.draftCoordinator;
  /** The peer of the access running now: attribution inside it resolves no other identity. */
  const accessedPeer = new AsyncLocalStorage<string>();

  /**
   * One scope's entries reconciled on `doc`, a copy of the Work draft at `generation`: only a
   * retirement or an inverse since the scope's cut drops a whole logical write.
   */
  /**
   * Entries an earlier peer of this scope accepted, when that peer has since closed: a Discard
   * took them, and its retirement will say so. Until it does, no view shows them and no save
   * keeps them; each is refused now with the Discard's reason.
   */
  async function retiredPeerEntries(
    entries: readonly JournalBatchAppendEntry[],
    peerDraftId: string | undefined,
  ): Promise<Map<string, StagedReconcile["rejected"][number]["reason"]>> {
    const refused = new Map<string, StagedReconcile["rejected"][number]["reason"]>();
    const checked = new Map<string, Awaited<ReturnType<typeof peerLossReason>> | null>();
    for (const entry of entries) {
      const mutation = entry.mutation;
      const accepted = mutation?.mode === "threadPeer" ? mutation.peerDraftId : undefined;
      if (!mutation?.writeId || !accepted || !peerDraftId || accepted === peerDraftId) continue;
      if (!checked.has(accepted)) {
        const old = await input.drafts.getDraft(accepted);
        checked.set(
          accepted,
          old && old.status !== "closed"
            ? null
            : ((await peerLossReason(
                input,
                new ThreadPeerPullLost(accepted, old?.upstreamDraftId ?? "", null),
                old?.branchId,
              )) ?? "discarded_edit"),
        );
      }
      const reason = checked.get(accepted);
      if (reason) refused.set(mutation.writeId, reason);
    }
    return refused;
  }

  async function reconcile(
    draftId: string,
    doc: Y.Doc,
    generation: number,
    staged: StagedRoomEntries,
    peerDraftId: string | undefined,
  ): Promise<{ keptEntries: JournalBatchAppendEntry[] } & Pick<StagedReconcile, "rejected">> {
    if (staged.cut.generation > generation)
      throw new Error("Response cut belongs to a future draft generation");
    const refused = await retiredPeerEntries(staged.entries, peerDraftId);
    const entries = staged.entries.filter((entry) => !refused.has(entry.mutation?.writeId ?? ""));
    const cut = Y.decodeSnapshotV2(staged.cut.snapshot);
    const retired: Uint8Array[] = [];
    const inverses: Uint8Array[] = [];
    // Every intervening generation can contain an inverse; the cut excludes already observed
    // removals without a second sequence fence.
    for (let at = staged.cut.generation; at <= generation; at++) {
      for (const row of await input.journalRows.listJournalRowsForDraft({
        draftId,
        generation: at,
      })) {
        const observed = Y.snapshotContainsUpdate(cut, row.updateData);
        if (at === staged.cut.generation && at < generation && observed)
          retired.push(row.updateData);
        if (!observed && row.editKind && row.editKind !== "write") inverses.push(row.updateData);
      }
    }
    const replay = reconcileStagedDraftWrites(doc, entries, retired, cut, inverses);
    return {
      keptEntries: replay.keptEntries,
      rejected: [
        ...[...refused].map(([writeId, reason]) => ({ writeId, reason })),
        ...replay.rejectedWrites,
      ],
    };
  }

  /**
   * `run` as an access to the peer a call is bound to, on its Work draft: a Discard that closed
   * the peer, its Work draft or the branch since the ensure is `DocumentAccessLostError` naming
   * that Discard (else `ThreadPeerPullLost`). It acquires nothing: a save or a close racing it
   * is ordered by the revisions its writes were prepared at.
   */
  async function underAccess<T>(
    peerDraftId: string,
    run: (workDraftId: string) => Promise<T>,
  ): Promise<T> {
    await collabHook("draft.beforeAccess");
    let upstreamDraftId = "";
    let branchId: BranchId | undefined;
    try {
      const peer = await input.drafts.getDraft(peerDraftId);
      upstreamDraftId = peer?.upstreamDraftId ?? "";
      branchId = peer?.branchId;
      if (!peer) throw new DraftMissingError(peerDraftId);
      if (peer.status === "closed") throw new DraftStaleUpdateError(`Draft ${peerDraftId}`);
      if (!upstreamDraftId) throw new Error(`Thread peer ${peerDraftId} has no Work draft`);
      return await accessedPeer.run(peerDraftId, () => run(upstreamDraftId));
    } catch (cause) {
      if (
        cause instanceof DraftStaleUpdateError ||
        cause instanceof DraftCasConflictError ||
        cause instanceof DraftMissingError
      ) {
        // A Discard's loss is the write's named refusal, not a failure.
        const lost = new ThreadPeerPullLost(peerDraftId, upstreamDraftId, cause);
        const reason = await peerLossReason(input, lost, branchId);
        throw reason ? new DocumentAccessLostError(reason, { cause: lost }) : lost;
      }
      throw cause;
    }
  }

  /** The thread's Work draft a call bound to no peer reads (a read never ensures one). */
  async function threadWorkDraft(documentId: DocumentId): Promise<ResolvedDraft> {
    return input.drafts.resolveWorkDraftForThread(documentId, input.threadId);
  }

  return {
    async readRoom(docId, staged, access) {
      const peer = access?.pinnedDraftId;
      const read = async (workDraftId: string, bound: boolean) => {
        const { doc, snapshot } = await drafts.copyDraft(workDraftId);
        try {
          if (bound && snapshot.status !== "active")
            throw new DraftStaleUpdateError(`Draft ${workDraftId}`);
          const replay = staged
            ? await reconcile(workDraftId, doc, snapshot.generation, staged, peer)
            : { keptEntries: [], rejected: [] };
          return {
            doc,
            room: draftRoom(workDraftId),
            generation: snapshot.generation,
            kept: replay.keptEntries.flatMap((entry) =>
              entry.mutation?.writeId ? [entry.mutation.writeId] : [],
            ),
            rejected: replay.rejected,
          };
        } catch (cause) {
          doc.destroy();
          throw cause;
        }
      };
      await input.flushLivePull(docId as DocumentId);
      return peer
        ? underAccess(peer, (workDraftId) => read(workDraftId, true))
        : read((await threadWorkDraft(docId as DocumentId)).draftId, false);
    },

    // A drafted write commits only through its reply's save: the pool runs even a write with
    // no reply as a one-entry reply, so nothing reaches the draft through this door.
    withDocument() {
      throw new Error("A drafted document is read through readRoom and saved by its reply");
    },

    stagedWrites: {
      async prepareSave({ docId, cut, entries, access }): Promise<StagedWriteSaveResult> {
        const peerId =
          access?.pinnedDraftId ?? (await resolveThreadDraftId(input, docId as DocumentId));
        return underAccess(peerId, async (workDraftId) => {
          const { result, write } = await drafts.prepareStagedRows(
            workDraftId,
            async (doc, snapshot) => {
              const replay = await reconcile(
                workDraftId,
                doc,
                snapshot.generation,
                { cut, entries },
                peerId,
              );
              return {
                result: {
                  kept: replay.keptEntries.flatMap((entry) =>
                    entry.mutation?.writeId ? [entry.mutation.writeId] : [],
                  ),
                  rejected: replay.rejected,
                  room: draftRoom(workDraftId),
                  beforeState: snapshot.encoded,
                  afterState: Y.encodeStateAsUpdate(doc),
                },
                rows: draftRows(workDraftId, replay.keptEntries),
              };
            },
            true,
          );
          if (!write) return { ...result, write: { kind: "no-effect" } };
          return {
            ...result,
            write: {
              kind: "write",
              async persist() {
                await write.persist();
              },
              // Installing the replica waits for the enclosing root commit: the coordinator defers it.
              transfer: () => write.transfer(),
              dispose: () => write.dispose(),
            },
          };
        });
      },
    },

    // A Work draft's committed replica is its truth: there is nothing to recover into.
    async recover(): Promise<void> {},

    async concurrentUpdatesSince({
      docId,
      doc,
      baselineDoc,
      afterJournalId,
      liveJournalSeq,
      attemptId,
      reportingCut,
      access,
    }) {
      const baselineState = baselineDoc ? Y.encodeStateAsUpdate(baselineDoc) : null;
      const baselineSnapshot = baselineDoc ? Y.snapshot(baselineDoc) : Y.emptySnapshot;
      const concurrent = await concurrentUpstreamJournalRows(
        input,
        docId as DocumentId,
        afterJournalId,
        access,
        accessedPeer.getStore(),
      );
      if (reportingCut) {
        const cut = Y.snapshot(doc);
        concurrent.rows = concurrent.rows.filter((row) =>
          Y.snapshotContainsUpdate(cut, row.updateData),
        );
        concurrent.upstreamState = reportingCut;
      }
      // Durable upstream work-draft rows are never suppressed as "self" merely
      // because they came from this thread; the journal watermark is the fence.
      const liveRows = input.liveJournal
        ? liveAttributionRows(
            (
              await input.liveJournal.read(docId, {
                since: (liveJournalSeq ?? Number.MAX_SAFE_INTEGER) + 1,
              })
            ).updates.filter((update) => update.seq > (liveJournalSeq ?? Number.MAX_SAFE_INTEGER)),
          )
        : [];
      const partitioned = partitionConcurrentUpdates({
        baselineSnapshot,
        baselineState,
        journalRows: [
          ...concurrent.rows.map((row) => ({
            id: row.id,
            origin: originForJournalRow(row),
            update: row.updateData,
          })),
          ...liveRows,
        ],
        currentUpstreamState: concurrent.upstreamState,
        fallbackCurrentUpstream: doc,
        model: input.model,
        codec: input.codec,
      });
      const maxRowId = partitioned.reduce(
        (max, item) => (item.type === "journal" ? Math.max(max, item.rowId) : max),
        0,
      );
      if (maxRowId > 0) {
        // Load-bearing: this is only a captured candidate. Advancing the floor here would
        // skip rows if the surrounding draft write later fails or CAS-exhausts.
        concurrentJournalWatermarks.capturePending(
          input.threadId,
          docId as DocumentId,
          maxRowId,
          attemptId,
        );
        if (reportingCut)
          advanceConcurrentJournalWatermark(
            concurrentJournalWatermarks,
            input.threadId,
            docId as DocumentId,
            input.afterCommit,
            input.enlistResponseParticipant,
            attemptId,
          );
        // Capture itself is provisional: failures before draft persistence must
        // clear the candidate even though no watermark-advance participant exists yet.
        input.enlistResponseParticipant({
          commit() {},
          abort() {
            concurrentJournalWatermarks.clearPending(input.threadId, docId as DocumentId);
          },
        });
      }
      return partitioned.map((item) =>
        item.type === "journal"
          ? {
              update: item.effectiveUpdate,
              origin: item.origin,
              touchedHashes: item.touchedHashes,
              deletedHashes: item.deletedHashes,
            }
          : {
              update: item.residualUpdate,
              origin: item.origin,
              touchedHashes: item.touchedHashes,
              deletedHashes: item.deletedHashes,
            },
      );
    },
  };
}

/**
 * The draft core's journal: reads and ordinals come from live; nothing appends through it,
 * since a drafted write saves through its reply.
 */
export function createDraftAgentEditJournal(input: { liveJournal: UpdateJournal }): UpdateJournal {
  const materializeDestructiveProvenance = input.liveJournal.materializeDestructiveProvenance?.bind(
    input.liveJournal,
  );
  const refuse = () =>
    Promise.reject(new Error("A drafted write saves through its reply, not the journal"));

  return {
    append: refuse,
    appendBatch: refuse,

    read(_docId: string, _opts?: JournalReadOptions): Promise<JournalSnapshot> {
      return Promise.resolve({ checkpoint: null, updates: [] });
    },

    readAttribution(docId: string): Promise<JournalSnapshot> {
      return input.liveJournal.readAttribution?.(docId) ?? input.liveJournal.read(docId);
    },

    ...(materializeDestructiveProvenance
      ? {
          materializeDestructiveProvenance: (request) =>
            materializeDestructiveProvenance({
              ...request,
              // Roots absent from the live document were born on this agent-owned draft.
              fallbackProvenance: "agent",
            }),
        }
      : {}),

    compact(_docId, _before) {
      return Promise.resolve({ updatesFolded: 0 });
    },

    reserveWriteOrdinal(documentId, threadId) {
      return input.liveJournal.reserveWriteOrdinal(documentId, threadId);
    },
  };
}

export type DraftLookupWithSnapshots = WorkDraftLookup &
  DraftResolver & {
    getDraft(
      draftId: string,
    ): Promise<Pick<
      DraftSnapshot,
      "upstreamDraftId" | "branchId" | "generation" | "status"
    > | null>;
    /** The thread's primary Work's active draft on the document, as metadata. */
    resolveWorkDraftForThread(documentId: DocumentId, threadId: ThreadId): Promise<ResolvedDraft>;
  };

/**
 * The thread's current peer of the document. A peer is made only by the write path's ensure:
 * an access that finds none is `DraftNotFoundError`, never a new peer draft.
 */
async function resolveThreadDraftId(
  input: { threadId: ThreadId; drafts: DraftLookupWithSnapshots },
  documentId: DocumentId,
): Promise<string> {
  return (await input.drafts.resolveThreadDraft(documentId, input.threadId)).draftId;
}

/** The upstream draft's rows since `afterJournalId`, and its state they were read at. */
async function concurrentUpstreamJournalRows(
  input: {
    threadId: ThreadId;
    draftCoordinator: DraftCoordinator;
    drafts: DraftLookupWithSnapshots;
    journalRows: DraftReplayJournalReads;
  },
  documentId: DocumentId,
  afterJournalId?: number,
  access?: DocumentAccess,
  accessedPeer?: string,
): Promise<{ rows: DraftJournalRow[]; upstreamState?: Uint8Array }> {
  // A pinned or running access names the peer; only a free-standing read resolves it.
  const peerId =
    access?.pinnedDraftId ??
    accessedPeer ??
    (await input.drafts.resolveThreadDraft(documentId, input.threadId)).draftId;
  const upstreamDraftId = (await input.drafts.getDraft(peerId))?.upstreamDraftId;
  if (!upstreamDraftId) return { rows: [] };
  return input.draftCoordinator.readDraft(upstreamDraftId, async (doc, snapshot) => {
    const rows = await input.journalRows.listConcurrentJournalRows(
      upstreamDraftId,
      snapshot.generation,
      { afterJournalId, documentId },
    );
    return { rows, upstreamState: Y.encodeStateAsUpdate(doc) };
  });
}

function originForJournalRow(row: DraftJournalRow): ConcurrentUpdateOrigin {
  if (row.source === "agent") {
    return { type: "agent" as const, actorTurnId: row.turnId ?? row.threadId ?? "unknown-agent" };
  }
  return { type: "human" as const, userId: row.actorUserId ?? "unknown" };
}

function liveAttributionRows(updates: readonly PersistedUpdate[]): AttributionRow[] {
  return updates.map(({ seq, update, meta }) => {
    let origin: ConcurrentUpdateOrigin;
    if (meta.origin === "system:reconcile") {
      origin = { type: "system" };
    } else if (meta.origin.startsWith("agent:")) {
      origin = { type: "agent", actorTurnId: meta.actorTurnId ?? "unknown-agent" };
    } else {
      origin = {
        type: "human",
        userId: meta.origin.startsWith("human:") ? meta.origin.slice("human:".length) : "unknown",
      };
    }
    return { id: -seq, origin, update };
  });
}

function partitionConcurrentUpdates(
  input: ConcurrentAttributionBasis,
): PartitionedConcurrentUpdate[] {
  const upstreamState =
    input.currentUpstreamState ?? Y.encodeStateAsUpdate(input.fallbackCurrentUpstream);
  // A state vector alone misses delete-only edits. Capture structs and tombstones
  // before journal reads yield, so both checks use the same baseline cut.
  const rows = input.journalRows.filter(
    (row) => !Y.snapshotContainsUpdate(input.baselineSnapshot, row.update),
  );
  if (rows.length === 0 && input.baselineState && bytesEqual(input.baselineState, upstreamState)) {
    return [];
  }
  const scratch = docFromState(input.baselineState);
  try {
    const coverage = partitionByBlockCoverage({
      baselineState: input.baselineState,
      upstreamState,
      rows,
      model: input.model,
      codec: input.codec,
    });

    const partitioned: PartitionedConcurrentUpdate[] = [];
    for (const row of rows) {
      const effectiveUpdate = effectiveUpdateFromApplyingToScratch(scratch, row.update);
      if (!effectiveUpdate) Y.applyUpdate(scratch, row.update);
      const touchedHashes = touchedHashesForCoverage(coverage.coverage, row.origin);
      const deletedHashes = touchedHashesForCoverage(coverage.deletedCoverage, row.origin);
      if (effectiveUpdate || touchedHashes || deletedHashes) {
        partitioned.push({
          type: "journal",
          rowId: row.id,
          origin: row.origin,
          effectiveUpdate: effectiveUpdate ?? new Uint8Array(),
          touchedHashes: touchedHashes ?? (effectiveUpdate ? {} : undefined),
          deletedHashes,
        });
      }
    }

    const target = yjsUpdateFromState(upstreamState);
    try {
      const residualUpdate = yjsDeltaUpdate(target, scratch) ?? new Uint8Array();
      if (
        residualUpdate.length > 0 ||
        coverage.humanResidualHashes.size > 0 ||
        coverage.humanDeletedHashes.size > 0
      ) {
        partitioned.push({
          type: "human",
          origin: { type: "human", userId: "unknown" },
          residualUpdate,
          touchedHashes:
            coverage.humanResidualHashes.size > 0
              ? { human: [...coverage.humanResidualHashes] }
              : residualUpdate.length > 0
                ? {}
                : undefined,
          deletedHashes:
            coverage.humanDeletedHashes.size > 0
              ? { human: [...coverage.humanDeletedHashes] }
              : undefined,
        });
      }
    } finally {
      target.destroy();
    }
    return partitioned;
  } finally {
    scratch.destroy();
  }
}

function effectiveUpdateFromApplyingToScratch(
  scratch: Y.Doc,
  update: Uint8Array,
): Uint8Array | null {
  const probe = cloneYDoc(scratch);
  try {
    Y.applyUpdate(probe, update);
    const effective = yjsDeltaUpdate(probe, scratch);
    if (!effective) return null;
    Y.applyUpdate(scratch, effective);
    return effective;
  } finally {
    probe.destroy();
  }
}

function advanceConcurrentJournalWatermark(
  watermarks: DraftConcurrentJournalWatermarks,
  threadId: ThreadId,
  documentId: DocumentId,
  afterCommit: AfterCommit,
  enlistResponseParticipant: EnlistResponseParticipant,
  attemptId?: string,
): void {
  if (
    enlistResponseParticipant({
      commit() {
        watermarks.commitPending(threadId, documentId, attemptId);
      },
      abort() {
        watermarks.clearPending(threadId, documentId);
      },
    })
  ) {
    return;
  }
  afterCommit(() => {
    watermarks.commitPending(threadId, documentId, attemptId);
  });
}
