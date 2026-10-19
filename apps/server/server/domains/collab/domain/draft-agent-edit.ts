/** Agent-edit bindings that make a thread-peer draft the write tool's document world. */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type AgentEditCodec,
  bytesEqual,
  type ConcurrentUpdateOrigin,
  cloneYDoc,
  type DocumentAccess,
  type DocumentCoordinator,
  type JournalBatchAppendEntry,
  type JournalBatchAppendResult,
  type JournalReadOptions,
  type JournalSnapshot,
  type PersistedUpdate,
  type StagedWriteReplayInput,
  type StagedWriteReplayResult,
  type StagedWriteSaveResult,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
  yjsDeltaUpdate,
  yjsUpdateFromState,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { testHook } from "../../../shared/test-hooks.js";
import type { DraftCoordinator, PreparedDraftWrite } from "./draft-coordinator.js";
import type { DraftJournalRow, DraftReplayJournalReads } from "./draft-journal.js";
import type { WorkDraftLookup } from "./draft-pulls.js";
import type { DraftResolver } from "./draft-resolver.js";
import { reconcileStagedDraftWrites } from "./draft-response-replay.js";
import type { DraftSnapshot } from "./draft-store.js";
import {
  type AttributionRow,
  docFromState,
  partitionByBlockCoverage,
  touchedHashesForCoverage,
} from "./draft-update-attribution.js";
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
  stagedWriteNoop(payload: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: string;
    turnId: string | null;
    writeId: string | null;
  }): void;
  mutationLessPendingEntry(payload: { documentId: string; origin: string }): void;
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
  pendingJournalEntries?: DraftPendingJournalEntries;
  journalRows: DraftReplayJournalReads;
  liveJournal?: Pick<UpdateJournal, "read">;
  diagnostics?: DraftAgentEditDiagnostics;
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
   * A response's staged entries replayed on a candidate of its Work draft. A save also
   * prepares the draft's append and the peer's catch-up as one write the caller's attempt
   * owns; no write and no catch-up is an explicit `no-effect`.
   */
  function staged(request: StagedWriteReplayInput, save: false): Promise<StagedWriteReplayResult>;
  function staged(request: StagedWriteReplayInput, save: true): Promise<StagedWriteSaveResult>;
  async function staged(
    request: StagedWriteReplayInput,
    save: boolean,
  ): Promise<StagedWriteReplayResult | StagedWriteSaveResult> {
    const peerId =
      request.access?.pinnedDraftId ??
      (await resolveThreadDraftId(input, request.docId as DocumentId));
    const peer = await input.drafts.getDraft(peerId);
    const draftId = peer?.upstreamDraftId;
    if (!draftId) throw new Error("Response peer has no Work draft");
    return underAccess(peerId, async () => {
      const { result, write } = await drafts.prepareStagedRows(
        draftId,
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
              const rows = await input.journalRows.listJournalRowsForDraft({
                draftId,
                generation,
              });
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
          const replay = reconcileStagedDraftWrites(
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
              helperCut: { generation: snapshot.generation, state: snapshot.encoded },
              beforeState: snapshot.encoded,
            },
            rows: draftRows(draftId, kept),
          };
        },
        save,
      );
      if (!save) return result;
      // The thread's peer follows its draft in the same attempt: it catches up to the
      // upstream as this save commits it, upstream before peer.
      let catchUp: PreparedDraftWrite | null;
      try {
        catchUp = write
          ? await drafts.prepareCatchUp(peerId, write.candidate)
          : await drafts.readDraft(draftId, (doc) => drafts.prepareCatchUp(peerId, doc));
      } catch (cause) {
        write?.dispose();
        throw cause;
      }
      const writes = [write, catchUp].filter((entry): entry is PreparedDraftWrite =>
        Boolean(entry),
      );
      if (!writes.length) return { ...result, write: { kind: "no-effect" } };
      return {
        ...result,
        write: {
          kind: "write",
          async persist() {
            for (const entry of writes) await entry.persist();
          },
          // Installing the replica waits for the enclosing root commit: the coordinator defers it.
          transfer() {
            for (const entry of writes) entry.transfer();
          },
          dispose() {
            for (const entry of writes) entry.dispose();
          },
        },
      };
    });
  }

  /**
   * Runs `run` as an access to `peerDraftId`. It acquires nothing: a save or a close racing
   * it is ordered by the revisions its writes were prepared at.
   */
  async function underAccess<T>(peerDraftId: string, run: () => Promise<T>): Promise<T> {
    await testHook("draft.beforeAccess");
    return accessedPeer.run(peerDraftId, run);
  }
  return {
    async withDocument<T>(
      docId: string,
      fn: (doc: Y.Doc) => Promise<T>,
      access?: DocumentAccess,
    ): Promise<T> {
      const draftId =
        access?.pinnedDraftId ?? (await resolveThreadDraftId(input, docId as DocumentId));
      let result: T;
      try {
        result = await underAccess(draftId, () =>
          drafts.withTransient(draftId, async (doc, snapshot) => {
            const beforeState = Y.encodeStateAsUpdate(doc);
            const result = await fn(doc);
            const pendingBatch =
              input.pendingJournalEntries?.shiftBatch(docId, input.threadId) ?? [];
            if (!bytesEqual(beforeState, Y.encodeStateAsUpdate(doc))) {
              const workDraftId = snapshot.upstreamDraftId;
              if (!workDraftId) {
                throw new Error(`Thread-peer draft ${snapshot.draftId} has no work-draft upstream`);
              }
              const first = pendingBatch[0];
              if (
                first?.mutation?.mode !== "threadPeer" ||
                pendingBatch.some(
                  (pending) =>
                    pending.mutation?.mode !== "threadPeer" ||
                    pending.mutation.draftGeneration !==
                      (first.mutation?.mode === "threadPeer"
                        ? first.mutation.draftGeneration
                        : undefined),
                )
              ) {
                throw new Error("thread_peer_commit_missing_draft_generation");
              }
              const mutation = first.mutation;
              const committed = await drafts.commitSegmentRows({
                draftId: workDraftId,
                sourceDoc: doc,
                expectedGeneration: mutation.draftGeneration,
                rows: draftRows(workDraftId, pendingBatch),
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
              const workDraftId = snapshot.upstreamDraftId ?? snapshot.draftId;
              const pending = pendingBatch[0];
              input.diagnostics?.stagedWriteNoop({
                documentId: docId as DocumentId,
                threadId: input.threadId,
                draftId: workDraftId,
                turnId: pending?.mutation?.turnId ?? null,
                writeId: pending?.mutation?.writeId ?? null,
              });
              throw new StagedDraftWriteNoopError(workDraftId, docId);
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

    stagedWrites: {
      replay: (request) => staged(request, false),
      prepareSave: (request) => staged(request, true),
    },

    // A peer is made only by pulling from a Work draft: recovery never creates one.
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

export function createDraftAgentEditJournal(input: {
  liveJournal: UpdateJournal;
  pendingJournalEntries?: DraftPendingJournalEntries;
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

export class StagedDraftWriteNoopError extends Error {
  constructor(
    readonly draftId: string,
    readonly documentId: string,
  ) {
    super(
      `Staged write for document ${documentId} produced no durable draft journal row on draft ${draftId}`,
    );
    this.name = "StagedDraftWriteNoopError";
  }
}

export type DraftLookupWithSnapshots = WorkDraftLookup &
  DraftResolver & {
    getDraft(
      draftId: string,
    ): Promise<Pick<DraftSnapshot, "upstreamDraftId" | "branchId" | "generation"> | null>;
  };

type DraftPendingJournalEntries = {
  push(entry: JournalBatchAppendEntry): void;
  shiftBatch(documentId: string, threadId?: ThreadId): JournalBatchAppendEntry[];
};

export function createDraftPendingJournalEntries(
  enlistResponseParticipant: EnlistResponseParticipant,
  diagnostics?: Pick<DraftAgentEditDiagnostics, "mutationLessPendingEntry">,
): DraftPendingJournalEntries {
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

/**
 * The thread's current peer of the document. A peer is made only by pulling from a Work draft:
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
