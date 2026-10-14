/** Agent-edit bindings that make a thread-peer branch the write tool's document world. */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AgentEditCodec,
  bytesEqual,
  type ConcurrentUpdateOrigin,
  cloneYDoc,
  type DocumentCoordinator,
  type DocumentLockOptions,
  type JournalBatchAppendEntry,
  type JournalBatchAppendResult,
  type JournalReadOptions,
  type JournalSnapshot,
  type PersistedUpdate,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
  yjsDeltaUpdate,
  yjsUpdateFromState,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import type {
  BranchCoordinator,
  BranchSaveJournalReads,
  BranchSnapshot,
  OwnedBranchSession,
} from "./branch-coordinator.js";
import type { BranchLockLease } from "./branch-critical-sections.js";
import type { WorkDraftLookup } from "./branch-pulls.js";
import type { BranchJournalReadStore, BranchJournalRow } from "./branch-push-contracts.js";
import type { BranchResolver } from "./branch-resolver.js";
import { reconcileStagedBranchWrites } from "./branch-response-replay.js";
import {
  type AttributionRow,
  docFromState,
  partitionByBlockCoverage,
  touchedHashesForCoverage,
} from "./branch-update-attribution.js";
import { collabHook } from "./collab-test-hooks.js";
import type { ReplyPin } from "./reply-save-fences.js";
import type { ResponseCommitParticipant } from "./response-transaction.js";

export type BranchConcurrentJournalWatermarks = {
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

export type BranchAgentEditDiagnostics = {
  stagedWriteNoop(payload: {
    documentId: DocumentId;
    threadId: ThreadId;
    branchId: string;
    turnId: string | null;
    writeId: string | null;
  }): void;
  mutationLessPendingEntry(payload: { documentId: string; origin: string }): void;
  replyPinMismatch(payload: { documentId: DocumentId; threadId?: ThreadId; pin: ReplyPin }): void;
};

export type AfterCommit = (callback: () => void | Promise<void>) => void;
export type EnlistResponseParticipant = (participant: ResponseCommitParticipant) => boolean;

export function createBranchConcurrentJournalWatermarks(): BranchConcurrentJournalWatermarks {
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

export function createBranchAgentEditCoordinator(input: {
  threadId: ThreadId;
  branchCoordinator: BranchCoordinator;
  branches: BranchLookupWithSnapshots;
  pendingJournalEntries?: BranchPendingJournalEntries;
  journalRows?: Pick<BranchJournalReadStore, "listConcurrentJournalRows"> &
    Partial<Pick<BranchSaveJournalReads, "listJournalRowsForBranch">>;
  liveJournal?: Pick<UpdateJournal, "read">;
  diagnostics?: BranchAgentEditDiagnostics;
  afterCommit: AfterCommit;
  enlistResponseParticipant: EnlistResponseParticipant;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  concurrentJournalWatermarks?: BranchConcurrentJournalWatermarks;
}): DocumentCoordinator {
  const concurrentJournalWatermarks =
    input.concurrentJournalWatermarks ?? createBranchConcurrentJournalWatermarks();
  function branchRows(branchId: string, entries: readonly JournalBatchAppendEntry[]) {
    return entries.flatMap((entry) => {
      const mutation = entry.mutation;
      if (mutation?.mode !== "threadPeer")
        throw new Error("thread_peer_commit_missing_branch_generation");
      return (mutation.editParts ?? [entry.update]).map((updateData) => ({
        branchId,
        source: "agent" as const,
        updateData,
        documentEditKey: mutation.writeId,
        threadId: (mutation.threadId as ThreadId | undefined) ?? input.threadId,
        turnId: mutation.turnId ?? null,
        wId: mutation.wId ?? null,
        toolCallId: mutation.toolCallId ?? null,
        updateMeta: entry.meta ?? null,
        ...(mutation.semanticEditIr ? { semanticEditIr: mutation.semanticEditIr } : {}),
        ...(mutation.branchJournalWatermark !== undefined
          ? { expectedJournalWatermark: mutation.branchJournalWatermark }
          : {}),
        ...(mutation.branchJournalRevision !== undefined
          ? { expectedJournalRevision: mutation.branchJournalRevision }
          : {}),
      }));
    });
  }
  /**
   * Runs `run` in the save's owned session when the host handed over its lease. Any other
   * access takes the peer and its draft branch in one ordered acquisition, the order a save
   * and a close use (contract §14), so neither waits on the other in a cycle.
   */
  /** The session of the access running now, for the attribution reads made inside it. */
  const heldSession = new AsyncLocalStorage<{ owned: OwnedBranchSession; peerBranchId: string }>();
  async function underAccess<T>(
    access: DocumentLockOptions | undefined,
    peerBranchId: string,
    run: (owned: OwnedBranchSession) => Promise<T>,
  ): Promise<T> {
    if (access?.lease)
      return run(input.branchCoordinator.ownedSession(access.lease as BranchLockLease));
    return input.branchCoordinator.withLeases(
      await accessBranchIds(input, peerBranchId),
      async (lease) => {
        await collabHook("access.afterLeases");
        const owned = input.branchCoordinator.ownedSession(lease);
        return heldSession.run({ owned, peerBranchId }, () => run(owned));
      },
    );
  }
  return {
    async withDocument<T>(
      docId: string,
      fn: (doc: Y.Doc) => Promise<T>,
      access?: DocumentLockOptions,
    ): Promise<T> {
      const branchId =
        access?.pinnedBranchId ?? (await resolveThreadBranchId(input, docId as DocumentId));
      let result: T;
      try {
        result = await underAccess(access, branchId, (owned) =>
          owned.withTransient(branchId, async (doc, snapshot) => {
            const beforeState = Y.encodeStateAsUpdate(doc);
            const result = await fn(doc);
            const pendingBatch =
              input.pendingJournalEntries?.shiftBatch(docId, input.threadId) ?? [];
            if (!bytesEqual(beforeState, Y.encodeStateAsUpdate(doc))) {
              const workDraftBranchId = snapshot.upstreamBranchId;
              if (!workDraftBranchId) {
                throw new Error(
                  `Thread-peer branch ${snapshot.branchId} has no work-draft upstream`,
                );
              }
              const first = pendingBatch[0];
              if (
                first?.mutation?.mode !== "threadPeer" ||
                pendingBatch.some(
                  (pending) =>
                    pending.mutation?.mode !== "threadPeer" ||
                    pending.mutation.branchGeneration !==
                      (first.mutation?.mode === "threadPeer"
                        ? first.mutation.branchGeneration
                        : undefined),
                )
              ) {
                throw new Error("thread_peer_commit_missing_branch_generation");
              }
              const mutation = first.mutation;
              const committed = await owned.commitSegmentRows({
                branchId: workDraftBranchId,
                sourceDoc: doc,
                expectedGeneration: mutation.branchGeneration,
                rows: branchRows(workDraftBranchId, pendingBatch),
              });
              if (!committed) return result;
              advanceConcurrentJournalWatermark(
                concurrentJournalWatermarks,
                input.threadId,
                docId as DocumentId,
                input.afterCommit,
                input.enlistResponseParticipant,
                first.mutation?.writeId,
              );
            } else if (pendingBatch.length > 0) {
              const workDraftBranchId = snapshot.upstreamBranchId ?? snapshot.branchId;
              const pending = pendingBatch[0];
              input.diagnostics?.stagedWriteNoop({
                documentId: docId as DocumentId,
                threadId: input.threadId,
                branchId: workDraftBranchId,
                turnId: pending?.mutation?.turnId ?? null,
                writeId: pending?.mutation?.writeId ?? null,
              });
              throw new StagedBranchWriteNoopError(workDraftBranchId, docId);
            }
            return result;
          }),
        );
      } catch (cause) {
        concurrentJournalWatermarks.clearPending(input.threadId, docId as DocumentId);
        throw cause;
      }
      return result;
    },

    async withStagedWrites(request) {
      const peerId =
        request.access?.pinnedBranchId ??
        (await resolveThreadBranchId(input, request.docId as DocumentId));
      const peer = await input.branches.getBranch(peerId);
      const branchId = peer?.upstreamBranchId;
      if (!branchId) throw new Error("Response peer has no Work draft");
      return underAccess(request.access, peerId, async (owned) => {
        const result = await owned.withStagedRows(
          branchId,
          async (doc, snapshot) => {
            if (request.helperCut.generation > snapshot.generation)
              throw new Error("Response helper belongs to a future draft generation");
            const retired: Uint8Array[] = [];
            const inverses: Uint8Array[] = [];
            const planning = new Y.Doc({ gc: false });
            try {
              Y.applyUpdate(planning, request.helperCut.state);
              const cut = Y.snapshot(planning);
              // Every intervening generation can contain an inverse; the old cut
              // excludes already observed removals without a second sequence fence.
              for (
                let generation = request.helperCut.generation;
                generation <= snapshot.generation;
                generation++
              ) {
                const rows = await owned.listHelperHistory({ branchId, generation });
                for (const row of rows) {
                  const observed = Y.snapshotContainsUpdate(cut, row.updateData);
                  if (
                    generation === request.helperCut.generation &&
                    generation < snapshot.generation &&
                    observed
                  )
                    retired.push(row.updateData);
                  if (!observed && row.editKind && row.editKind !== "write")
                    inverses.push(row.updateData);
                }
              }
            } finally {
              planning.destroy();
            }
            const replay = reconcileStagedBranchWrites(
              doc,
              request.sourceDoc,
              request.entries,
              retired,
              request.helperCut.state,
              inverses,
            );
            const kept = replay.keptEntries;
            return {
              result: {
                keptEntries: kept,
                rejectedWrites: replay.rejectedWrites,
                helperState: Y.encodeStateAsUpdate(doc),
                helperCut: { generation: snapshot.generation, state: snapshot.state },
                beforeState: snapshot.state,
              },
              rows: branchRows(branchId, kept),
            };
          },
          request.commit,
        );
        if (request.commit) {
          const current = await owned.read(branchId, async (doc) => cloneYDoc(doc));
          try {
            await owned.withTransient(peerId, async (doc) => {
              Y.applyUpdate(doc, Y.encodeStateAsUpdate(current));
            });
            await owned.checkpoint(peerId);
          } finally {
            current.destroy();
          }
        }
        return result;
      });
    },

    // A peer is made only by a pull in a draft: recovery never creates one.
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
        heldSession.getStore(),
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
        // skip rows if the surrounding branch write later fails or CAS-exhausts.
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
        // Capture itself is provisional: failures before branch persistence must
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

export function createBranchAgentEditJournal(input: {
  liveJournal: UpdateJournal;
  pendingJournalEntries?: BranchPendingJournalEntries;
}): UpdateJournal {
  let syntheticSeq = 0;
  const materializeDestructiveProvenance = input.liveJournal.materializeDestructiveProvenance?.bind(
    input.liveJournal,
  );

  return {
    async append(_docId, _update, _meta) {
      syntheticSeq += 1;
      return syntheticSeq;
    },

    async appendBatch(entries) {
      for (const entry of entries) {
        input.pendingJournalEntries?.push(entry);
      }
      return Promise.all(
        entries.map(async (entry): Promise<JournalBatchAppendResult> => {
          syntheticSeq += 1;
          return {
            seq: syntheticSeq,
            wId: entry.mutation?.wId,
            journalCommitKind: "staged",
          };
        }),
      );
    },

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
              // Roots absent from the live document were born on this agent-owned branch.
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

export class StagedBranchWriteNoopError extends Error {
  constructor(
    readonly branchId: string,
    readonly documentId: string,
  ) {
    super(
      `Staged write for document ${documentId} produced no durable branch journal row on branch ${branchId}`,
    );
    this.name = "StagedBranchWriteNoopError";
  }
}

export type BranchLookupWithSnapshots = WorkDraftLookup &
  BranchResolver & {
    getBranch(
      branchId: string,
    ): Promise<Pick<
      BranchSnapshot,
      "upstreamBranchId" | "draftId" | "generation" | "state"
    > | null>;
  };

type BranchPendingJournalEntries = {
  push(entry: JournalBatchAppendEntry): void;
  shiftBatch(documentId: string, threadId?: ThreadId): JournalBatchAppendEntry[];
};

export function createBranchPendingJournalEntries(
  enlistResponseParticipant: EnlistResponseParticipant,
  diagnostics?: Pick<BranchAgentEditDiagnostics, "mutationLessPendingEntry">,
): BranchPendingJournalEntries {
  const byDocument = new Map<string, JournalBatchAppendEntry[]>();
  return {
    push(entry) {
      if (!entry.mutation) {
        diagnostics?.mutationLessPendingEntry({
          documentId: entry.docId,
          origin: entry.meta.origin,
        });
        return;
      }
      const entries = byDocument.get(entry.docId) ?? [];
      entries.push(entry);
      byDocument.set(entry.docId, entries);
      enlistResponseParticipant({
        commit() {},
        abort() {
          const pending = byDocument.get(entry.docId);
          if (!pending) return;
          const remaining = pending.filter((candidate) => candidate !== entry);
          if (remaining.length > 0) byDocument.set(entry.docId, remaining);
          else byDocument.delete(entry.docId);
        },
      });
    },
    shiftBatch(documentId, threadId) {
      const entries = byDocument.get(documentId);
      if (!entries || entries.length === 0) return [];
      const batchThreadId = threadId ?? entries[0]?.mutation?.threadId;
      const batch = batchThreadId
        ? entries.filter((entry) => entry.mutation?.threadId === batchThreadId)
        : [...entries];
      const remaining = batchThreadId
        ? entries.filter((entry) => entry.mutation?.threadId !== batchThreadId)
        : [];
      if (remaining.length > 0) byDocument.set(documentId, remaining);
      else byDocument.delete(documentId);
      return batch;
    },
  };
}

/** The peer and its draft branch: what one thread-core access leases. */
async function accessBranchIds(
  input: { branches: BranchLookupWithSnapshots },
  peerBranchId: string,
): Promise<string[]> {
  const peer = await input.branches.getBranch(peerBranchId);
  return peer?.upstreamBranchId ? [peerBranchId, peer.upstreamBranchId] : [peerBranchId];
}

/**
 * The thread's current peer of the document. A peer is made only by a pull in a draft:
 * an access that finds none is `BranchNotFoundError`, never a new branch.
 */
async function resolveThreadBranchId(
  input: { threadId: ThreadId; branches: BranchLookupWithSnapshots },
  documentId: DocumentId,
): Promise<string> {
  const peer = await input.branches.resolveThreadBranch(documentId, input.threadId);
  peer.doc.destroy();
  return peer.branchId;
}

async function concurrentUpstreamJournalRows(
  input: {
    threadId: ThreadId;
    branchCoordinator: BranchCoordinator;
    branches: BranchLookupWithSnapshots;
    journalRows?: Pick<BranchJournalReadStore, "listConcurrentJournalRows"> &
      Partial<Pick<BranchSaveJournalReads, "listJournalRowsForBranch">>;
  },
  documentId: DocumentId,
  afterJournalId?: number,
  access?: import("@meridian/agent-edit/integration").DocumentLockOptions,
  held?: { owned: OwnedBranchSession; peerBranchId: string },
): Promise<{ rows: BranchJournalRow[]; upstreamState?: Uint8Array }> {
  if (!input.journalRows) return { rows: [] };
  const journalRows = input.journalRows;
  const owned = access?.lease
    ? input.branchCoordinator.ownedSession(access.lease as BranchLockLease)
    : held?.owned;
  let peerId = access?.pinnedBranchId ?? held?.peerBranchId;
  if (!peerId) {
    if (owned) throw new Error("Owned attribution requires a pinned peer");
    const peer = await input.branches.resolveThreadBranch(documentId, input.threadId);
    peerId = peer.branchId;
    peer.doc.destroy();
  }
  const peerSnapshot = owned
    ? await owned.read(peerId, async (_doc, snapshot) => snapshot)
    : await input.branches.getBranch(peerId);
  const upstreamBranchId = peerSnapshot?.upstreamBranchId;
  if (!upstreamBranchId) return { rows: [] };
  return (owned ? owned.read : input.branchCoordinator.readBranch)(
    upstreamBranchId,
    async (doc, snapshot) => {
      const rows = await (owned ? owned.listConcurrentRows : journalRows.listConcurrentJournalRows)(
        upstreamBranchId,
        snapshot.generation,
        { afterJournalId, documentId },
      );
      return { rows, upstreamState: Y.encodeStateAsUpdate(doc) };
    },
  );
}

function originForJournalRow(row: BranchJournalRow): ConcurrentUpdateOrigin {
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
  watermarks: BranchConcurrentJournalWatermarks,
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
