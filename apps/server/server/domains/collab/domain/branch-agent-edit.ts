/** Agent-edit bindings that make a thread-peer branch the write tool's document world. */
import {
  type AgentEditCodec,
  type BlockSnapshot,
  bytesEqual,
  cloneYDoc,
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
    }
  | {
      type: "human";
      origin: { type: "human" };
      residualUpdate: Uint8Array;
      touchedHashes?: { human?: readonly string[]; agent?: readonly string[] };
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
    listConcurrentJournalRows?(
      branchId: string,
      generation: number,
      options?: { afterJournalId?: number; documentId?: DocumentId },
    ): Promise<BranchJournalRow[]>;
  };
  eventSink?: EventSink;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
}): DocumentCoordinator {
  const concurrentJournalWatermarkByDocument = new Map<DocumentId, number>();
  const pendingConcurrentJournalWatermarkByDocument = new Map<DocumentId, number>();
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
            if (!bytesEqual(beforeState, Y.encodeStateAsUpdate(doc))) {
              const workDraftBranchId = snapshot.upstreamBranchId;
              if (!workDraftBranchId) {
                throw new Error(
                  `Thread-peer branch ${snapshot.branchId} has no work-draft upstream`,
                );
              }
              const pending = input.pendingJournalEntries?.shift(docId);
              const committed = await input.branchCoordinator.commitSyncFromDoc({
                branchId: workDraftBranchId,
                sourceDoc: doc,
                source: "agent",
                wId: pending?.mutation?.wId ?? null,
                threadId: (pending?.mutation?.threadId as ThreadId | undefined) ?? input.threadId,
                turnId: pending?.mutation?.turnId ?? null,
                updateMeta: pending?.meta ?? null,
              });
              if (committed) {
                autoPushBranchId = workDraftBranchId;
                advanceConcurrentJournalWatermark(
                  concurrentJournalWatermarkByDocument,
                  pendingConcurrentJournalWatermarkByDocument,
                  docId as DocumentId,
                );
              }
            }
            return result;
          },
        );
      } catch (cause) {
        pendingConcurrentJournalWatermarkByDocument.delete(docId as DocumentId);
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

    async concurrentUpdatesSince({ docId, doc, baselineDoc }) {
      const baselineState = baselineDoc ? Y.encodeStateAsUpdate(baselineDoc) : null;
      const concurrent = await concurrentUpstreamJournalRows(
        input,
        docId as DocumentId,
        concurrentJournalWatermarkByDocument.get(docId as DocumentId),
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
          pendingConcurrentJournalWatermarkByDocument.set(docId as DocumentId, maxRowId);
        }
        return partitioned.map((item) =>
          item.type === "journal"
            ? {
                update: item.effectiveUpdate,
                origin: item.origin,
                touchedHashes: item.touchedHashes,
              }
            : {
                update: item.residualUpdate,
                origin: item.origin,
                touchedHashes: item.touchedHashes,
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
    persistUndo(docId, undoUpdate, records, actor) {
      return input.liveJournal.persistUndo(docId, undoUpdate, records, actor);
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

export type BranchLookupWithSnapshots = WorkDraftLookup &
  BranchResolver & {
    getBranch?(
      branchId: string,
    ): Promise<{ upstreamBranchId: string | null; generation: number } | null>;
  };

type BranchPendingJournalEntries = {
  push(entry: JournalBatchAppendEntry): void;
  shift(documentId: string): JournalBatchAppendEntry | undefined;
};

export function createBranchPendingJournalEntries(): BranchPendingJournalEntries {
  const byDocument = new Map<string, JournalBatchAppendEntry[]>();
  return {
    push(entry) {
      const entries = byDocument.get(entry.docId) ?? [];
      entries.push(entry);
      byDocument.set(entry.docId, entries);
    },
    shift(documentId) {
      const entries = byDocument.get(documentId);
      const entry = entries?.shift();
      if (entries && entries.length === 0) byDocument.delete(documentId);
      return entry;
    },
  };
}

async function concurrentUpstreamJournalRows(
  input: {
    threadId: ThreadId;
    branchCoordinator: BranchCoordinator;
    branches: BranchLookupWithSnapshots;
    journalRows?: {
      listActiveJournalRows(branchId: string, generation: number): Promise<BranchJournalRow[]>;
      listConcurrentJournalRows?(
        branchId: string,
        generation: number,
        options?: { afterJournalId?: number; documentId?: DocumentId },
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
  input: { branchId: string; generation: number; afterJournalId?: number; documentId: DocumentId },
): Promise<BranchJournalRow[]> {
  if (journalRows.listConcurrentJournalRows) {
    return journalRows.listConcurrentJournalRows(input.branchId, input.generation, {
      afterJournalId: input.afterJournalId,
      documentId: input.documentId,
    });
  }
  const rows = await journalRows.listActiveJournalRows(input.branchId, input.generation);
  const afterJournalId = input.afterJournalId;
  return afterJournalId === undefined ? rows : rows.filter((row) => row.id > afterJournalId);
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
      const touchedHashes = touchedHashesForCoverage(
        coverage.coverage,
        row.source,
        actorTurnIdForJournalRow(row),
        input.selfActorIds,
      );
      if (effectiveUpdate || touchedHashes) {
        partitioned.push({
          type: "journal",
          rowId: row.id,
          origin: originForJournalRow(row),
          effectiveUpdate: effectiveUpdate ?? new Uint8Array(),
          touchedHashes,
        });
      }
    }

    const target = yjsUpdateFromState(upstreamState);
    try {
      const residualUpdate = yjsDeltaUpdate(target, scratch) ?? new Uint8Array();
      const agentResidual = agentCoveredResidual(
        coverage.coverage,
        input.journalRows,
        input.selfActorIds,
      );
      if (residualUpdate.length > 0 && coverage.humanResidualHashes.size === 0 && agentResidual) {
        partitioned.push({
          type: "journal",
          rowId: agentResidual.rowId,
          origin: { type: "agent", actorTurnId: agentResidual.actorTurnId },
          effectiveUpdate: residualUpdate,
          touchedHashes: { agent: agentResidual.hashes },
        });
      } else if (residualUpdate.length > 0 || coverage.humanResidualHashes.size > 0) {
        partitioned.push({
          type: "human",
          origin: { type: "human" },
          residualUpdate,
          touchedHashes:
            coverage.humanResidualHashes.size > 0
              ? { human: [...coverage.humanResidualHashes] }
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

function agentCoveredResidual(
  coverage: ReadonlyMap<string, BlockCoverage>,
  rows: readonly BranchJournalRow[],
  selfActorIds: ReadonlySet<string>,
): { rowId: number; actorTurnId: string; hashes: string[] } | null {
  const hashesByActor = new Map<string, string[]>();
  for (const [hash, covered] of coverage) {
    if (covered.origin !== "agent" || !covered.actorTurnId) continue;
    if (isSelfCoverage(covered, selfActorIds)) continue;
    const hashes = hashesByActor.get(covered.actorTurnId) ?? [];
    hashes.push(hash);
    hashesByActor.set(covered.actorTurnId, hashes);
  }
  for (const row of rows) {
    if (row.source !== "agent") continue;
    const actorTurnId = actorTurnIdForJournalRow(row);
    if (!actorTurnId) continue;
    const hashes = hashesByActor.get(actorTurnId);
    if (hashes && hashes.length > 0) return { rowId: row.id, actorTurnId, hashes };
  }
  return null;
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
  collapsed: boolean;
} {
  const finalDoc = docFromState(inputs.upstreamState);
  const scratch = docFromState(inputs.baselineState);
  try {
    const finalBlocks = blocks(finalDoc, inputs.model, inputs.codec);
    const finalByBody = multimap(finalBlocks, blockBody);
    const baselineBodies = counted(blocks(scratch, inputs.model, inputs.codec).map(blockBody));
    const baselineHistoricalText = historicalText(inputs.baselineState);
    const coverage = new Map<string, BlockCoverage>();
    for (const row of inputs.rows) {
      const beforeCounts = counted(blocks(scratch, inputs.model, inputs.codec).map(blockBody));
      Y.applyUpdate(scratch, row.update);
      const afterBlocks = blocks(scratch, inputs.model, inputs.codec);
      const afterCounts = counted(afterBlocks.map(blockBody));
      const rowHashes = new Set<string>();
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
          if (!blockBody(block).includes(needle)) continue;
          claimHash(block.hash, coverage, rowHashes, row, inputs.selfActorIds);
        }
      }
    }
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
    const visibleCoverage = [...coverage].filter(
      ([, value]) => !isSelfCoverage(value, inputs.selfActorIds),
    ).length;
    return {
      coverage,
      humanResidualHashes: residual,
      collapsed: visibleCoverage + residual.size > (inputs.collapseThreshold ?? 5),
    };
  } finally {
    finalDoc.destroy();
    scratch.destroy();
  }
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
      if (normalized.length >= 3 && !beforeBodies.some((body) => body.includes(normalized)))
        needles.add(normalized);
      for (const part of normalized.split(/\s+/))
        if (part.length >= 3 && !beforeBodies.some((body) => body.includes(part)))
          needles.add(part);
    }
  }
  return [...needles].sort((left, right) => right.length - left.length);
}

function actorTurnIdForJournalRow(row: BranchJournalRow): string | null {
  if (row.source !== "agent") return null;
  return row.turnId ?? row.threadId ?? "unknown-agent";
}

function selfActorIdsForRows(rows: readonly BranchJournalRow[], threadId: ThreadId): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.threadId !== threadId) continue;
    if (row.turnId) ids.add(row.turnId);
    ids.add(threadId);
  }
  return ids;
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
  committed: Map<DocumentId, number>,
  pending: Map<DocumentId, number>,
  documentId: DocumentId,
): void {
  const maxRowId = pending.get(documentId);
  if (maxRowId === undefined) return;
  pending.delete(documentId);
  committed.set(documentId, Math.max(committed.get(documentId) ?? 0, maxRowId));
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

function emptyDocState(): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
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
