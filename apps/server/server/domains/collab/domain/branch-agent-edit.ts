/** Agent-edit bindings that make a thread-peer branch the write tool's document world. */
import {
  type AgentEditCodec,
  type BlockSnapshot,
  bytesEqual,
  cloneYDoc,
  DEFAULT_CONCURRENT_COLLAPSE_THRESHOLD,
  type DocumentCoordinator,
  DocumentNotFoundError,
  type JournalBatchAppendEntry,
  type JournalBatchAppendResult,
  type JournalReadOptions,
  type JournalSnapshot,
  type ReversalStore,
  snapshotBlocks,
  toDocHandle,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
  yjsDeltaUpdate,
  yjsUpdateFromState,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { runAfterDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { WorkDraftLookup } from "./branch-pulls.js";
import type { BranchJournalRow, BranchPushService } from "./branch-push.js";
import { type BranchResolver, isBranchNotFoundError } from "./branch-resolver.js";

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

type ConcurrentUpdateOrigin =
  | { type: "human"; userId?: string }
  | { type: "agent"; actorTurnId: string };

type ConcurrentAttributionBasis = {
  baselineState: Uint8Array | null;
  currentUpstreamState?: Uint8Array;
  fallbackCurrentUpstream: Y.Doc;
  journalRows: readonly BranchJournalRow[];
  selfActorIds: ReadonlySet<string>;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
};

type BlockCoverage = { origin: "agent" | "writer"; actorTurnId?: string };

type PartitionedConcurrentUpdate =
  | {
      type: "journal";
      rowId: number;
      origin: ConcurrentUpdateOrigin;
      effectiveUpdate: Uint8Array;
      touchedHashes?: { human?: readonly string[]; agent?: readonly string[] };
      deletedHashes?: { human?: readonly string[]; agent?: readonly string[] };
      collapsed?: boolean;
    }
  | {
      type: "human";
      origin: { type: "human" };
      residualUpdate: Uint8Array;
      touchedHashes?: { human?: readonly string[]; agent?: readonly string[] };
      deletedHashes?: { human?: readonly string[]; agent?: readonly string[] };
      collapsed?: boolean;
    };

export function createBranchAgentEditCoordinator(input: {
  threadId: ThreadId;
  liveCoordinator: DocumentCoordinator;
  branchCoordinator: BranchCoordinator;
  branches: BranchLookupWithSnapshots;
  pendingJournalEntries?: BranchPendingJournalEntries;
  branchPush?: Pick<BranchPushService, "pushAutoBranchAfterThreadPeerWrite">;
  journalRows?: {
    listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
    listConcurrentJournalRows(
      branchId: string,
      generation: number,
      options: { afterJournalId?: number; documentId: DocumentId },
    ): Promise<BranchJournalRow[]>;
  };
  eventSink?: EventSink;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  concurrentJournalWatermarks?: BranchConcurrentJournalWatermarks;
}): DocumentCoordinator {
  const concurrentJournalWatermarks =
    input.concurrentJournalWatermarks ?? createBranchConcurrentJournalWatermarks();
  return {
    async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
      const branchId = await ensureThreadBranch(input, docId as DocumentId);
      let autoPushBranchId: string | null = null;
      let result: T;
      try {
        result = await input.branchCoordinator.withBranchTransient(
          branchId,
          async (doc, snapshot) => {
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
              const pending = pendingBatch.at(-1);
              const mutation = pending?.mutation;
              if (mutation?.mode !== "threadPeer") {
                throw new Error("thread_peer_commit_missing_branch_generation");
              }
              const sourceHasBranchDelta = await sourceDocHasBranchDelta(
                input.branchCoordinator,
                workDraftBranchId,
                doc,
              );
              if (!sourceHasBranchDelta) {
                emitStagedWriteNoop(input.eventSink, {
                  documentId: docId as DocumentId,
                  threadId: input.threadId,
                  branchId: workDraftBranchId,
                  turnId: pending?.mutation?.turnId ?? null,
                  writeId: pending?.mutation?.writeId ?? null,
                });
                throw new StagedBranchWriteNoopError(workDraftBranchId, docId);
              }
              const committed = await input.branchCoordinator.commitSyncFromDoc({
                branchId: workDraftBranchId,
                sourceDoc: doc,
                source: "agent",
                wId: pending?.mutation?.wId ?? null,
                threadId: (pending?.mutation?.threadId as ThreadId | undefined) ?? input.threadId,
                turnId: pending?.mutation?.turnId ?? null,
                expectedGeneration: mutation.branchGeneration,
                updateMeta: pending?.meta ?? null,
              });
              if (!committed) return result;
              autoPushBranchId = workDraftBranchId;
              advanceConcurrentJournalWatermark(
                concurrentJournalWatermarks,
                input.threadId,
                docId as DocumentId,
                pending?.mutation?.writeId,
              );
            } else if (pendingBatch.length > 0) {
              const workDraftBranchId = snapshot.upstreamBranchId ?? snapshot.branchId;
              const pending = pendingBatch.at(-1);
              emitStagedWriteNoop(input.eventSink, {
                documentId: docId as DocumentId,
                threadId: input.threadId,
                branchId: workDraftBranchId,
                turnId: pending?.mutation?.turnId ?? null,
                writeId: pending?.mutation?.writeId ?? null,
              });
              throw new StagedBranchWriteNoopError(workDraftBranchId, docId);
            }
            return result;
          },
        );
      } catch (cause) {
        concurrentJournalWatermarks.clearPending(input.threadId, docId as DocumentId);
        throw cause;
      }
      if (autoPushBranchId && input.branchPush) {
        scheduleAutoPushAfterCommit({
          workDraftBranchId: autoPushBranchId,
          branchPush: input.branchPush,
          eventSink: input.eventSink,
        });
      }
      return result;
    },

    async recover(docId: string): Promise<void> {
      await ensureThreadBranch(input, docId as DocumentId);
    },

    async concurrentUpdatesSince({ docId, doc, baselineDoc, afterJournalId, attemptId }) {
      const baselineState = baselineDoc ? Y.encodeStateAsUpdate(baselineDoc) : null;
      const concurrent = await concurrentUpstreamJournalRows(
        input,
        docId as DocumentId,
        afterJournalId,
      );
      try {
        const partitioned = partitionConcurrentUpdates({
          baselineState,
          journalRows: concurrent.rows,
          currentUpstreamState: concurrent.upstreamState,
          fallbackCurrentUpstream: doc,
          selfActorIds: selfActorIdsForRows(concurrent.rows, input.threadId),
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
        }
        return partitioned.map((item) =>
          item.type === "journal"
            ? {
                update: item.effectiveUpdate,
                origin: item.origin,
                touchedHashes: item.touchedHashes,
                deletedHashes: item.deletedHashes,
                collapsed: item.collapsed,
              }
            : {
                update: item.residualUpdate,
                origin: item.origin,
                touchedHashes: item.touchedHashes,
                deletedHashes: item.deletedHashes,
                collapsed: item.collapsed,
              },
        );
      } finally {
        // baselineDoc is owned by the agent-edit core; this coordinator only snapshots it.
      }
    },
  };
}

export function createBranchAgentEditJournal(input: {
  threadId: ThreadId;
  liveJournal: UpdateJournal & ReversalStore;
  pendingJournalEntries?: BranchPendingJournalEntries;
}): UpdateJournal & ReversalStore {
  let syntheticSeq = 0;
  return {
    async append(_docId, _update, _meta) {
      syntheticSeq += 1;
      return syntheticSeq;
    },

    async appendBatch(entries) {
      for (const entry of entries) input.pendingJournalEntries?.push(entry);
      return Promise.all(
        entries.map(async (entry): Promise<JournalBatchAppendResult> => {
          syntheticSeq += 1;
          return {
            seq: syntheticSeq,
            wId: entry.mutation?.wId,
            journalCommitKind: "syntheticPending",
          };
        }),
      );
    },

    read(_docId: string, _opts?: JournalReadOptions): Promise<JournalSnapshot> {
      return Promise.resolve({ checkpoint: null, updates: [] });
    },

    checkpoint(_docId: string, _state: Uint8Array, _upToSeq: number): Promise<void> {
      return Promise.resolve();
    },

    compact(_docId, _before) {
      return Promise.resolve({ updatesFolded: 0, reversalsExpired: 0 });
    },

    reserveWriteOrdinal(documentId, threadId) {
      return input.liveJournal.reserveWriteOrdinal(documentId, threadId);
    },
    readForReconstruction(docId) {
      return input.liveJournal.readForReconstruction(docId);
    },
    documentsForTurn(threadId, turnId) {
      return input.liveJournal.documentsForTurn(threadId, turnId);
    },
    latestActiveWrite(documentId, threadId) {
      return input.liveJournal.latestActiveWrite(documentId, threadId);
    },
    activeWriteSummary(documentId, threadId) {
      return input.liveJournal.activeWriteSummary(documentId, threadId);
    },
    writeMinCreatedSeq(documentId, threadId, handle) {
      return input.liveJournal.writeMinCreatedSeq(documentId, threadId, handle);
    },
    mutationsForWrite(documentId, threadId, handle) {
      return input.liveJournal.mutationsForWrite(documentId, threadId, handle);
    },
    mutationsForWrites(documentId, threadId, handles) {
      return input.liveJournal.mutationsForWrites(documentId, threadId, handles);
    },
    persistUndo(docId, undoUpdate, records, actor, guard) {
      return input.liveJournal.persistUndo(docId, undoUpdate, records, actor, guard);
    },
    persistRedo(docId, redoUpdate, ref, meta) {
      return input.liveJournal.persistRedo(docId, redoUpdate, ref, meta);
    },
    readReversals(docId, opts) {
      return input.liveJournal.readReversals(docId, opts);
    },
    reversalOpSeqsForHandles(docId, threadId, handles) {
      return input.liveJournal.reversalOpSeqsForHandles(docId, threadId, handles);
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

function emitStagedWriteNoop(
  eventSink: EventSink | undefined,
  payload: {
    documentId: DocumentId;
    threadId: ThreadId;
    branchId: string;
    turnId: string | null;
    writeId: string | null;
  },
): void {
  if (!eventSink) return;
  emitEvent(eventSink, {
    level: "error",
    source: "collab.branch_agent_edit",
    name: "staged_write.no_durable_journal_row",
    payload,
  });
}

export type BranchLookupWithSnapshots = WorkDraftLookup &
  BranchResolver & {
    getBranch?(
      branchId: string,
    ): Promise<{ upstreamBranchId: string | null; generation: number } | null>;
  };

type BranchPendingJournalEntries = {
  push(entry: JournalBatchAppendEntry): void;
  shiftBatch(documentId: string, threadId?: ThreadId): JournalBatchAppendEntry[];
};

export function createBranchPendingJournalEntries(
  eventSink?: EventSink,
): BranchPendingJournalEntries {
  const byDocument = new Map<string, JournalBatchAppendEntry[]>();
  return {
    push(entry) {
      if (!entry.mutation) {
        if (eventSink)
          emitEvent(eventSink, {
            level: "warn",
            source: "collab.branch_pending_journal",
            name: "mutation_less_entry_dropped",
            payload: {
              documentId: entry.docId,
              origin: entry.meta.origin,
            },
          });
        return;
      }
      const entries = byDocument.get(entry.docId) ?? [];
      entries.push(entry);
      byDocument.set(entry.docId, entries);
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

async function sourceDocHasBranchDelta(
  branchCoordinator: BranchCoordinator,
  branchId: string,
  sourceDoc: Y.Doc,
): Promise<boolean> {
  return branchCoordinator.readBranch(branchId, async (branchDoc) =>
    Boolean(yjsDeltaUpdate(sourceDoc, branchDoc)),
  );
}

function emptyDocState(): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

async function ensureThreadBranch(
  input: {
    threadId: ThreadId;
    liveCoordinator: DocumentCoordinator;
    branches: BranchLookupWithSnapshots;
  },
  documentId: DocumentId,
): Promise<string> {
  try {
    return (await input.branches.resolveThreadBranch(documentId, input.threadId)).branchId;
  } catch (cause) {
    if (!isBranchNotFoundError(cause)) throw cause;
    const liveState = await input.liveCoordinator
      .withDocument(documentId, async (liveDoc) => Y.encodeStateAsUpdate(liveDoc))
      .catch((cause: unknown) => {
        if (cause instanceof DocumentNotFoundError) return emptyDocState();
        throw cause;
      });
    const liveDoc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(liveDoc, liveState);
      const peer = await input.branches.ensureThreadPeerBranch({
        documentId,
        threadId: input.threadId,
        liveDoc,
      });
      return peer.branchId;
    } finally {
      liveDoc.destroy();
    }
  }
}

async function concurrentUpstreamJournalRows(
  input: {
    threadId: ThreadId;
    branchCoordinator: BranchCoordinator;
    branches: BranchLookupWithSnapshots;
    journalRows?: {
      listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
      listConcurrentJournalRows(
        branchId: string,
        generation: number,
        options: { afterJournalId?: number; documentId: DocumentId },
      ): Promise<BranchJournalRow[]>;
    };
  },
  documentId: DocumentId,
  afterJournalId?: number,
): Promise<{ rows: BranchJournalRow[]; upstreamState?: Uint8Array }> {
  if (!input.journalRows || !input.branches.getBranch) return { rows: [] };
  const journalRows = input.journalRows;
  const peer = await input.branches.resolveThreadBranch(documentId, input.threadId);
  peer.doc.destroy();
  const peerSnapshot = await input.branches.getBranch(peer.branchId);
  const upstreamBranchId = peerSnapshot?.upstreamBranchId;
  if (!upstreamBranchId) return { rows: [] };
  if (typeof input.branchCoordinator.readBranch === "function") {
    return input.branchCoordinator.readBranch(upstreamBranchId, async (doc, snapshot) => {
      const rows = await listConcurrentRows(journalRows, {
        branchId: upstreamBranchId,
        generation: snapshot.generation,
        afterJournalId,
        documentId,
      });
      return {
        rows,
        upstreamState: Y.encodeStateAsUpdate(doc),
      };
    });
  }
  const upstream = await input.branches.getBranch(upstreamBranchId);
  if (!upstream) return { rows: [] };
  const rows = await listConcurrentRows(journalRows, {
    branchId: upstreamBranchId,
    generation: upstream.generation,
    afterJournalId,
    documentId,
  });
  return { rows };
}

async function listConcurrentRows(
  journalRows: NonNullable<Parameters<typeof concurrentUpstreamJournalRows>[0]["journalRows"]>,
  input: {
    branchId: string;
    generation: number;
    afterJournalId?: number;
    documentId: DocumentId;
  },
): Promise<BranchJournalRow[]> {
  return journalRows.listConcurrentJournalRows(input.branchId, input.generation, {
    afterJournalId: input.afterJournalId,
    documentId: input.documentId,
  });
}

function originForJournalRow(row: BranchJournalRow): ConcurrentUpdateOrigin {
  if (row.source === "agent") {
    return { type: "agent" as const, actorTurnId: row.turnId ?? row.threadId ?? "unknown-agent" };
  }
  return { type: "human" as const, userId: row.actorUserId ?? undefined };
}

function partitionConcurrentUpdates(
  input: ConcurrentAttributionBasis,
): PartitionedConcurrentUpdate[] {
  const upstreamState =
    input.currentUpstreamState ?? Y.encodeStateAsUpdate(input.fallbackCurrentUpstream);
  const coverage = partitionByBlockCoverage({
    baselineState: input.baselineState,
    upstreamState,
    rows: input.journalRows.map((row) => ({
      id: row.id,
      source: row.source,
      actorTurnId: actorTurnIdForJournalRow(row),
      update: row.updateData,
    })),
    selfActorIds: input.selfActorIds,
    model: input.model,
    codec: input.codec,
  });

  const scratch = docFromState(input.baselineState);
  try {
    const partitioned: PartitionedConcurrentUpdate[] = [];
    for (const row of input.journalRows) {
      const effectiveUpdate = effectiveUpdateFromApplyingToScratch(scratch, row.updateData);
      if (!effectiveUpdate) Y.applyUpdate(scratch, row.updateData);
      const actorTurnId = actorTurnIdForJournalRow(row);
      const touchedHashes = touchedHashesForCoverage(
        coverage.coverage,
        row.source,
        actorTurnId,
        input.selfActorIds,
      );
      const deletedHashes = touchedHashesForCoverage(
        coverage.deletedCoverage,
        row.source,
        actorTurnId,
        input.selfActorIds,
      );
      if (effectiveUpdate || touchedHashes || deletedHashes) {
        partitioned.push({
          type: "journal",
          rowId: row.id,
          origin: originForJournalRow(row),
          effectiveUpdate: effectiveUpdate ?? new Uint8Array(),
          touchedHashes: touchedHashes ?? (effectiveUpdate ? {} : undefined),
          deletedHashes,
          collapsed: coverage.collapsed,
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
          origin: { type: "human" },
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
          collapsed: coverage.collapsed,
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

type PartitionByBlockCoverageInput = {
  baselineState: Uint8Array | null;
  upstreamState: Uint8Array;
  rows: Array<{
    id: number;
    source: "agent" | "writer";
    actorTurnId?: string | null;
    update: Uint8Array;
  }>;
  selfActorIds: ReadonlySet<string>;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  collapseThreshold?: number;
};

function partitionByBlockCoverage(inputs: PartitionByBlockCoverageInput): {
  coverage: Map<string, BlockCoverage>;
  humanResidualHashes: Set<string>;
  deletedCoverage: Map<string, BlockCoverage>;
  humanDeletedHashes: Set<string>;
  collapsed: boolean;
} {
  const finalDoc = docFromState(inputs.upstreamState);
  const scratch = docFromState(inputs.baselineState);
  try {
    const finalBlocks = blocks(finalDoc, inputs.model, inputs.codec);
    const finalByBody = multimap(finalBlocks, blockBody);
    const baselineBlocks = blocks(scratch, inputs.model, inputs.codec);
    const baselineBodies = counted(baselineBlocks.map(blockBody));
    const baselineHistoricalText = historicalText(inputs.baselineState);
    const coverage = new Map<string, BlockCoverage>();
    const deletedCoverage = new Map<string, BlockCoverage>();
    for (const row of inputs.rows) {
      const beforeBlocks = blocks(scratch, inputs.model, inputs.codec);
      const beforeCounts = counted(beforeBlocks.map(blockBody));
      Y.applyUpdate(scratch, row.update);
      const afterBlocks = blocks(scratch, inputs.model, inputs.codec);
      const afterCounts = counted(afterBlocks.map(blockBody));
      const rowHashes = new Set<string>();
      claimDeletedBodies(
        beforeCounts,
        afterCounts,
        beforeBlocks,
        afterBlocks,
        deletedCoverage,
        row,
      );
      for (const block of afterBlocks) {
        const body = blockBody(block);
        const introduced = (afterCounts.get(body) ?? 0) - (beforeCounts.get(body) ?? 0);
        if (introduced <= 0) continue;
        const already = [...rowHashes].filter((hash) => {
          const finalBlock = finalBlocks.find((candidate) => candidate.hash === hash);
          return finalBlock ? blockBody(finalBlock) === body : false;
        }).length;
        if (already >= introduced) continue;
        claimOneByBody(finalByBody, body, coverage, rowHashes, row, inputs.selfActorIds);
      }
      for (const needle of insertedNeedles(row.update, beforeCounts)) {
        for (const block of finalBlocks) {
          if (rowHashes.has(block.hash)) continue;
          const body = blockBody(block);
          if ((baselineBodies.get(body) ?? 0) > 0) continue;
          if (!body.includes(needle)) continue;
          claimHash(block.hash, coverage, rowHashes, row, inputs.selfActorIds);
        }
      }
    }
    const humanDeleted = humanDeletedHashes(baselineBlocks, finalBlocks, deletedCoverage);
    const residual = new Set<string>();
    const consumedBaseline = new Map<string, number>();
    for (const block of finalBlocks) {
      if (coverage.has(block.hash)) continue;
      const body = blockBody(block);
      const used = consumedBaseline.get(body) ?? 0;
      const base = baselineBodies.get(body) ?? 0;
      if (used < base) {
        consumedBaseline.set(body, used + 1);
        continue;
      }
      if (baselineHistoricalText.includes(body)) continue;
      residual.add(block.hash);
    }
    const visibleCoverage = [...coverage, ...deletedCoverage].filter(
      ([, value]) => !isSelfCoverage(value, inputs.selfActorIds),
    ).length;
    return {
      coverage,
      humanResidualHashes: residual,
      deletedCoverage,
      humanDeletedHashes: humanDeleted,
      collapsed:
        visibleCoverage + residual.size + humanDeleted.size >
        (inputs.collapseThreshold ?? DEFAULT_CONCURRENT_COLLAPSE_THRESHOLD),
    };
  } finally {
    finalDoc.destroy();
    scratch.destroy();
  }
}

function claimDeletedBodies(
  beforeCounts: ReadonlyMap<string, number>,
  afterCounts: ReadonlyMap<string, number>,
  beforeBlocks: readonly BlockSnapshot[],
  afterBlocks: readonly BlockSnapshot[],
  deletedCoverage: Map<string, BlockCoverage>,
  row: { source: "agent" | "writer"; actorTurnId?: string | null },
): void {
  const afterHashes = new Set(afterBlocks.map((block) => block.hash));
  const claimedByBody = new Map<string, number>();
  for (const block of beforeBlocks) {
    if (afterHashes.has(block.hash) || deletedCoverage.has(block.hash)) continue;
    const body = blockBody(block);
    const dropped = (beforeCounts.get(body) ?? 0) - (afterCounts.get(body) ?? 0);
    if (dropped <= 0) continue;
    const claimed = claimedByBody.get(body) ?? 0;
    if (claimed >= dropped) continue;
    deletedCoverage.set(block.hash, rowCoverage(row));
    claimedByBody.set(body, claimed + 1);
  }
}

function humanDeletedHashes(
  baselineBlocks: readonly BlockSnapshot[],
  finalBlocks: readonly BlockSnapshot[],
  rowDeleted: ReadonlyMap<string, BlockCoverage>,
): Set<string> {
  const finalHashes = new Set(finalBlocks.map((block) => block.hash));
  const finalCounts = counted(finalBlocks.map(blockBody));
  const baselineCounts = counted(baselineBlocks.map(blockBody));
  const claimedByBody = new Map<string, number>();
  const deleted = new Set<string>();
  for (const block of baselineBlocks) {
    if (finalHashes.has(block.hash) || rowDeleted.has(block.hash)) continue;
    const body = blockBody(block);
    const dropped = (baselineCounts.get(body) ?? 0) - (finalCounts.get(body) ?? 0);
    if (dropped <= 0) continue;
    const claimed = claimedByBody.get(body) ?? 0;
    if (claimed >= dropped) continue;
    deleted.add(block.hash);
    claimedByBody.set(body, claimed + 1);
  }
  return deleted;
}

function rowCoverage(row: {
  source: "agent" | "writer";
  actorTurnId?: string | null;
}): BlockCoverage {
  return row.source === "agent"
    ? { origin: "agent", actorTurnId: row.actorTurnId ?? undefined }
    : { origin: "writer" };
}

function claimOneByBody(
  finalByBody: Map<string, BlockSnapshot[]>,
  body: string,
  coverage: Map<string, BlockCoverage>,
  rowHashes: Set<string>,
  row: { source: "agent" | "writer"; actorTurnId?: string | null },
  selfActorIds: ReadonlySet<string>,
): void {
  for (const block of finalByBody.get(body) ?? []) {
    const prev = coverage.get(block.hash);
    const next = rowCoverage(row);
    if (prev && !(isSelfCoverage(prev, selfActorIds) && !isSelfCoverage(next, selfActorIds)))
      continue;
    coverage.set(block.hash, next);
    rowHashes.add(block.hash);
    return;
  }
}

function claimHash(
  hash: string,
  coverage: Map<string, BlockCoverage>,
  rowHashes: Set<string>,
  row: { source: "agent" | "writer"; actorTurnId?: string | null },
  selfActorIds: ReadonlySet<string>,
): void {
  const next = rowCoverage(row);
  const prev = coverage.get(hash);
  if (prev && !(isSelfCoverage(prev, selfActorIds) && !isSelfCoverage(next, selfActorIds))) return;
  coverage.set(hash, next);
  rowHashes.add(hash);
}

function touchedHashesForCoverage(
  coverage: ReadonlyMap<string, BlockCoverage>,
  source: BranchJournalRow["source"],
  actorTurnId: string | null,
  selfActorIds: ReadonlySet<string>,
): { human?: readonly string[]; agent?: readonly string[] } | undefined {
  if (source === "writer") {
    const human = [...coverage]
      .filter(([, value]) => value.origin === "writer")
      .map(([hash]) => hash);
    return human.length > 0 ? { human } : undefined;
  }
  const agent = [...coverage]
    .filter(([, value]) => value.origin === "agent" && value.actorTurnId === actorTurnId)
    .filter(([, value]) => !isSelfCoverage(value, selfActorIds))
    .map(([hash]) => hash);
  return agent.length > 0 ? { agent } : undefined;
}

function isSelfCoverage(coverage: BlockCoverage, selfActorIds: ReadonlySet<string>): boolean {
  return (
    coverage.origin === "agent" && !!coverage.actorTurnId && selfActorIds.has(coverage.actorTurnId)
  );
}

function docFromState(state: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  if (state && state.byteLength > 0) Y.applyUpdate(doc, state);
  return doc;
}

function blocks(
  doc: Y.Doc,
  model: YProsemirrorDocumentModel,
  codec: AgentEditCodec,
): BlockSnapshot[] {
  return snapshotBlocks(toDocHandle(doc), model, codec);
}

function blockBody(block: BlockSnapshot): string {
  const separator = block.serialized.indexOf("|");
  const body = separator < 0 ? block.serialized : block.serialized.slice(separator + 1);
  return body.replace(/\s+/g, " ").trim();
}

function counted(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function multimap<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const itemKey = key(item);
    const values = map.get(itemKey) ?? [];
    values.push(item);
    map.set(itemKey, values);
  }
  return map;
}

function historicalText(update: Uint8Array | null): string {
  if (!update || update.byteLength === 0) return "";
  try {
    const parts: string[] = [];
    const decoded = Y.decodeUpdate(update);
    for (const struct of decoded.structs as Array<{ content?: { str?: unknown; arr?: unknown } }>) {
      const content = struct.content;
      if (typeof content?.str === "string") parts.push(content.str);
      if (Array.isArray(content?.arr))
        for (const item of content.arr) if (typeof item === "string") parts.push(item);
    }
    return parts.join("").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function insertedNeedles(update: Uint8Array, beforeCounts: Map<string, number>): string[] {
  const beforeBodies = [...beforeCounts.keys()];
  const needles = new Set<string>();
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    return [];
  }
  for (const struct of decoded.structs as Array<{ content?: { str?: unknown; arr?: unknown } }>) {
    const content = struct.content;
    const texts: string[] = [];
    if (typeof content?.str === "string") texts.push(content.str);
    if (Array.isArray(content?.arr))
      for (const item of content.arr) if (typeof item === "string") texts.push(item);
    for (const text of texts) {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (normalized.length >= 3 && !beforeBodies.some((body) => body.includes(normalized))) {
        needles.add(normalized);
      }
    }
  }
  return [...needles].sort((left, right) => right.length - left.length);
}

function actorTurnIdForJournalRow(row: BranchJournalRow): string | null {
  if (row.source !== "agent") return null;
  return row.turnId ?? row.threadId ?? "unknown-agent";
}

function selfActorIdsForRows(_rows: readonly BranchJournalRow[], _threadId: ThreadId): Set<string> {
  // Rows already durable in the upstream work-draft are not “self” for echo
  // purposes merely because they came from this thread. A later tool call in
  // the same assistant response must still see fresh upstream rows that were
  // not in its cold baseline; attempt fencing is handled by the journal
  // watermark, not by suppressing every row from the same thread.
  return new Set();
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
  attemptId?: string,
): void {
  runAfterDrizzleCommit(() => {
    watermarks.commitPending(threadId, documentId, attemptId);
  });
}

function scheduleAutoPushAfterCommit(input: {
  workDraftBranchId: string;
  branchPush: Pick<BranchPushService, "pushAutoBranchAfterThreadPeerWrite">;
  eventSink?: EventSink;
}): void {
  runAfterDrizzleCommit(() => {
    void input.branchPush
      .pushAutoBranchAfterThreadPeerWrite({ workDraftBranchId: input.workDraftBranchId })
      .catch((cause: unknown) => {
        if (input.eventSink) {
          emitEvent(input.eventSink, {
            level: "error",
            source: "collab.branch_auto_push",
            name: "auto_push.failed",
            payload: {
              workDraftBranchId: input.workDraftBranchId,
              ...unknownToEventPayload(cause),
            },
          });
          return;
        }
        console.error("Branch auto-push failed", {
          workDraftBranchId: input.workDraftBranchId,
          cause,
        });
      });
  });
}
