/** Draft-scoped agent-edit adapters that persist response writes without touching live Yjs state. */
import type {
  ActiveWriteSummary,
  CompactionResult,
  DocumentCoordinator,
  DocumentLifecycle,
  JournalBatchAppendResult,
  JournalReadOptions,
  JournalSnapshot,
  PersistedUpdate,
  ReversalActor,
  ReversalStore,
  SyncState,
  SyncStateStore,
  UpdateJournal,
  UpdateMeta,
  WriteMutationRow,
} from "@meridian/agent-edit";
import { parseWriteHandle, writeHandle } from "@meridian/agent-edit";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditMutations,
  agentEditSyncState,
  agentEditWidCounters,
  documentYjsDrafts,
  documentYjsDraftUpdates,
  documentYjsUpdates,
  threadWorks,
} from "@meridian/database";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import { buildDraftDoc as projectDraftDoc } from "../domain/draft-projection.js";
import { ActiveDraftConflictError, createDraftId, type DraftStore } from "../domain/drafts.js";
import { scopedConflictTarget, scopedValues, scopedWhere } from "./drizzle-agent-edit-scope.js";

// Drizzle's transaction subtype is structurally compatible with the table methods we use.
type DraftAgentEditDb = Pick<Database, "select" | "insert" | "update" | "delete" | "transaction">;

export type DraftSessionFence = {
  capture(input: { documentId: string; threadId: string; draftId: string }): void;
  expectedDraftId(input: { documentId: string; threadId: string }): string | undefined;
};

type DraftResolver = {
  activeDraftId(documentId: string, threadId: string): Promise<string | null>;
  ensureDraftId(documentId: string, threadId: string, actorTurnId?: string): Promise<string>;
};

const DRAFT_UNDO_UNSUPPORTED = "Draft-scoped agent-edit undo/redo is deferred and not supported";
const DRAFT_CLOSED_FOR_APPEND = "Draft review was closed before this response could commit";

class DraftClosedForAppendError extends Error {
  constructor(draftId: string) {
    super(`${DRAFT_CLOSED_FOR_APPEND}: ${draftId}`);
    this.name = "DraftClosedForAppendError";
  }
}

export function isDraftClosedForAppendError(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes(DRAFT_CLOSED_FOR_APPEND);
}

export function createDraftSessionFence(): DraftSessionFence {
  const draftIds = new Map<string, string>();
  return {
    capture(input) {
      draftIds.set(draftFenceKey(input.documentId, input.threadId), input.draftId);
    },
    expectedDraftId(input) {
      return draftIds.get(draftFenceKey(input.documentId, input.threadId));
    },
  };
}

function draftFenceKey(documentId: string, threadId: string): string {
  return `${documentId}:${threadId}`;
}

const asDocumentId = (value: string) => value as DocumentId;
const asThreadId = (value: string) => value as ThreadId;
const asTurnId = (value: string) => value as TurnId;

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer);
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

export function createDrizzleDraftAgentEditJournal(
  db: DraftAgentEditDb,
  options: {
    threadId?: string;
    draftFence?: DraftSessionFence;
    latestLiveUpdateSeq?: (documentId: DocumentId) => Promise<number>;
    afterDraftUpdateAppended?: (input: { draftId: string; update: Uint8Array }) => void;
  } = {},
): UpdateJournal & ReversalStore {
  const resolver = createDrizzleDraftResolver(db, {
    draftFence: options.draftFence,
    latestLiveUpdateSeq: options.latestLiveUpdateSeq,
  });

  async function mutationsForWrites(
    documentId: string,
    threadId: string,
    handles: readonly string[],
  ): Promise<Map<string, WriteMutationRow[]>> {
    const draftId = await resolver.activeDraftId(documentId, threadId);
    const result = new Map<string, WriteMutationRow[]>();
    if (!draftId) return result;
    const ordinals = handles
      .map((handle) => parseWriteHandle(handle))
      .filter((ordinal): ordinal is number => ordinal !== undefined);
    if (ordinals.length === 0) return result;
    const rows = await db
      .select({
        writeId: agentEditMutations.writeId,
        wId: agentEditMutations.wId,
        turnId: agentEditMutations.turnId,
        createdSeq: agentEditMutations.createdSeq,
        status: agentEditMutations.status,
        undoUpdateSeq: agentEditMutations.undoUpdateSeq,
      })
      .from(agentEditMutations)
      .where(
        scopedWhere(
          agentEditMutations,
          { documentId, threadId, scopeId: draftId },
          inArray(agentEditMutations.wId, ordinals),
        ),
      )
      .orderBy(asc(agentEditMutations.createdSeq), asc(agentEditMutations.wId));

    for (const row of rows) {
      const handle = writeHandle(row.wId);
      const existing = result.get(handle);
      const mapped = mapWriteMutationRow(row);
      if (existing) existing.push(mapped);
      else result.set(handle, [mapped]);
    }
    return result;
  }

  return {
    async append(_docId, _update, _meta) {
      throw new Error("Draft journal append requires mutation thread metadata; use appendBatch");
    },

    async appendBatch(entries) {
      if (entries.length === 0) return [];
      const appended: Array<{ draftId: string; update: Uint8Array }> = [];
      const results = await db.transaction(async (tx) => {
        const txDb = tx as DraftAgentEditDb;
        const results: JournalBatchAppendResult[] = [];

        for (const entry of entries) {
          if (!entry.mutation) {
            throw new Error("Draft journal appendBatch requires mutation metadata for every entry");
          }
          if (entry.mutation.turnId === null) {
            throw new Error("Draft journal appendBatch requires actor turn metadata");
          }
          const draftId = await ensureDraftIdInDb(txDb, {
            documentId: entry.docId,
            threadId: entry.mutation.threadId,
            actorTurnId: entry.mutation.turnId,
            latestLiveUpdateSeq: options.latestLiveUpdateSeq,
            expectedDraftId: options.draftFence?.expectedDraftId({
              documentId: entry.docId,
              threadId: entry.mutation.threadId,
            }),
            draftFence: options.draftFence,
          });
          const [updateRow] = await txDb
            .insert(documentYjsDraftUpdates)
            .values({
              draftId,
              updateData: toBuffer(entry.update),
              actorTurnId: asTurnId(entry.mutation.turnId),
            })
            .returning({ id: documentYjsDraftUpdates.id });
          if (!updateRow) throw new Error("Failed to append draft Yjs update");

          const touchedDraft = await txDb
            .update(documentYjsDrafts)
            .set({ lastActorTurnId: asTurnId(entry.mutation.turnId), updatedAt: sql`now()` })
            .where(and(eq(documentYjsDrafts.id, draftId), eq(documentYjsDrafts.status, "active")))
            .returning({ id: documentYjsDrafts.id });
          if (touchedDraft.length === 0) throw new DraftClosedForAppendError(draftId);

          const wId =
            entry.mutation.wId ??
            (await reserveDraftWriteOrdinal(txDb, {
              documentId: entry.docId,
              threadId: entry.mutation.threadId,
              scopeId: draftId,
            }));
          await txDb.insert(agentEditMutations).values({
            wId,
            ...scopedValues({
              documentId: entry.docId,
              threadId: entry.mutation.threadId,
              scopeId: draftId,
            }),
            turnId: asTurnId(entry.mutation.turnId),
            writeId:
              entry.mutation.writeId ??
              `${entry.mutation.threadId}:${entry.mutation.turnId}:${updateRow.id}`,
            status: "active",
            createdSeq: updateRow.id,
          });
          appended.push({ draftId, update: entry.update });
          results.push({ seq: updateRow.id, wId });
        }

        return results;
      });
      for (const update of appended) options.afterDraftUpdateAppended?.(update);
      return results;
    },

    async reserveWriteOrdinal(documentId, threadId) {
      const draftId = await resolver.ensureDraftId(documentId, threadId);
      return reserveDraftWriteOrdinal(db, { documentId, threadId, scopeId: draftId });
    },

    async read(documentId, opts = {}) {
      const draftId = options.threadId
        ? await resolver.activeDraftId(documentId, options.threadId)
        : null;
      if (!draftId) return { checkpoint: null, updates: [] };
      return readDraftUpdates(db, draftId, opts);
    },

    async readForReconstruction(_docId) {
      throw new Error(DRAFT_UNDO_UNSUPPORTED);
    },

    async checkpoint(_docId, _state, _upToSeq) {
      // Draft logs are deltas only. Live seeding is handled by the draft coordinator.
    },

    async compact(_docId, _before): Promise<CompactionResult> {
      return { updatesFolded: 0, reversalsExpired: 0 };
    },

    async latestActiveWrite(documentId, threadId) {
      const draftId = await resolver.activeDraftId(documentId, threadId);
      if (!draftId) return undefined;
      const [row] = await db
        .select({
          writeId: agentEditMutations.writeId,
          wId: agentEditMutations.wId,
          turnId: agentEditMutations.turnId,
          createdSeq: agentEditMutations.createdSeq,
        })
        .from(agentEditMutations)
        .where(
          scopedWhere(
            agentEditMutations,
            { documentId, threadId, scopeId: draftId },
            eq(agentEditMutations.status, "active"),
          ),
        )
        .orderBy(desc(agentEditMutations.wId))
        .limit(1);
      return row ? mapActiveWrite(row) : undefined;
    },

    async activeWriteSummary(documentId, threadId) {
      const draftId = await resolver.activeDraftId(documentId, threadId);
      if (!draftId) return [];
      const rows = await db
        .select({
          writeId: agentEditMutations.writeId,
          wId: agentEditMutations.wId,
          turnId: agentEditMutations.turnId,
          createdSeq: agentEditMutations.createdSeq,
        })
        .from(agentEditMutations)
        .where(
          scopedWhere(
            agentEditMutations,
            { documentId, threadId, scopeId: draftId },
            eq(agentEditMutations.status, "active"),
          ),
        )
        .orderBy(asc(agentEditMutations.wId));
      return rows.map(mapActiveWrite);
    },

    async writeMinCreatedSeq(documentId, threadId, handle) {
      const draftId = await resolver.activeDraftId(documentId, threadId);
      if (!draftId) return undefined;
      const ordinal = parseWriteHandle(handle);
      if (ordinal === undefined) return undefined;
      const [row] = await db
        .select({ minSeq: sql<number>`min(${agentEditMutations.createdSeq})` })
        .from(agentEditMutations)
        .where(
          scopedWhere(
            agentEditMutations,
            { documentId, threadId, scopeId: draftId },
            eq(agentEditMutations.wId, ordinal),
          ),
        );
      return row?.minSeq === null || row?.minSeq === undefined ? undefined : Number(row.minSeq);
    },

    async mutationsForWrite(documentId, threadId, handle) {
      const rowsByHandle = await mutationsForWrites(documentId, threadId, [handle]);
      return rowsByHandle.get(handle) ?? [];
    },

    mutationsForWrites,

    async persistUndo(_docId, _undoUpdate, _records, _actor?: ReversalActor) {
      throw new Error(DRAFT_UNDO_UNSUPPORTED);
    },

    async persistRedo(_docId, _redoUpdate, _ref, _meta: UpdateMeta) {
      throw new Error(DRAFT_UNDO_UNSUPPORTED);
    },

    async readReversals(_docId, _opts) {
      throw new Error(DRAFT_UNDO_UNSUPPORTED);
    },

    async documentsForTurn(_threadId, _turnId) {
      throw new Error(DRAFT_UNDO_UNSUPPORTED);
    },

    async reversalOpSeqsForHandles(_docId, _threadId, _handles) {
      throw new Error(DRAFT_UNDO_UNSUPPORTED);
    },
  };
}

export function createDraftProjectionDocumentCoordinator(deps: {
  liveCoordinator: DocumentCoordinator;
  draftStore: Pick<DraftStore, "getActiveDraft" | "listUpdates">;
  threadId: string;
  draftFence?: DraftSessionFence;
}): DocumentCoordinator {
  const mutex = new KeyedMutex();

  return {
    withDocument(documentId, fn) {
      return mutex.run(`${documentId}:${deps.threadId}`, async () => {
        let liveState: Uint8Array | null = null;
        await deps.liveCoordinator.withDocument(documentId, async (liveDoc) => {
          liveState = Y.encodeStateAsUpdate(liveDoc);
        });
        const draft = await deps.draftStore.getActiveDraft({
          documentId: documentId as DocumentId,
          threadId: deps.threadId as ThreadId,
        });
        const updates = draft ? await deps.draftStore.listUpdates(draft.id) : [];
        if (draft) {
          deps.draftFence?.capture({ documentId, threadId: deps.threadId, draftId: draft.id });
        }
        const doc = projectDraftDoc({ checkpoint: liveState, updates: [] }, updates);
        return fn(doc);
      });
    },

    async recover(_documentId) {
      // The next withDocument call rebuilds the transient projection from live + draft updates.
    },
  };
}

export function createDrizzleDraftSyncStateStore(
  db: DraftAgentEditDb,
  input: { draftStore: Pick<DraftStore, "getActiveDraft"> },
): SyncStateStore {
  return {
    async load(documentId, threadId) {
      const draft = await input.draftStore.getActiveDraft({
        documentId: documentId as DocumentId,
        threadId: threadId as ThreadId,
      });
      if (!draft) return null;
      const [row] = await db
        .select({
          stateVector: agentEditSyncState.stateVector,
          syncedSnapshot: agentEditSyncState.syncedSnapshot,
          committedSnapshot: agentEditSyncState.committedSnapshot,
        })
        .from(agentEditSyncState)
        .where(scopedWhere(agentEditSyncState, { documentId, threadId, scopeId: draft.id }))
        .limit(1);
      if (!row) return null;
      return {
        stateVector: toBytes(row.stateVector),
        syncedSnapshot: toBytes(row.syncedSnapshot),
        committedSnapshot: toBytes(row.committedSnapshot),
      };
    },

    async save(documentId, threadId, state: SyncState) {
      const draft = await input.draftStore.getActiveDraft({
        documentId: documentId as DocumentId,
        threadId: threadId as ThreadId,
      });
      // Reads before the first mutation do not create empty drafts; the runtime can resync from live.
      if (!draft) return;
      await db
        .insert(agentEditSyncState)
        .values({
          ...scopedValues({ documentId, threadId, scopeId: draft.id }),
          stateVector: toBuffer(state.stateVector),
          syncedSnapshot: toBuffer(state.syncedSnapshot),
          committedSnapshot: toBuffer(state.committedSnapshot),
        })
        .onConflictDoUpdate({
          target: scopedConflictTarget(agentEditSyncState),
          set: {
            stateVector: toBuffer(state.stateVector),
            syncedSnapshot: toBuffer(state.syncedSnapshot),
            committedSnapshot: toBuffer(state.committedSnapshot),
            updatedAt: sql`now()`,
          },
        });
    },

    async delete(documentId, threadId) {
      const draft = await input.draftStore.getActiveDraft({
        documentId: documentId as DocumentId,
        threadId: threadId as ThreadId,
      });
      if (!draft) return;
      await db
        .delete(agentEditSyncState)
        .where(scopedWhere(agentEditSyncState, { documentId, threadId, scopeId: draft.id }));
    },
  };
}

export function createNoopDraftDocumentLifecycle(): Pick<DocumentLifecycle, "ensureDocument"> {
  return {
    async ensureDocument(_docId) {
      // Existing-document draft writes must not create live Yjs heads or visibility side effects.
    },
  };
}

function createDrizzleDraftResolver(
  db: DraftAgentEditDb,
  options: {
    draftFence?: DraftSessionFence;
    latestLiveUpdateSeq?: (documentId: DocumentId) => Promise<number>;
  } = {},
): DraftResolver {
  return {
    async activeDraftId(documentId, threadId) {
      if (!threadId) return null;
      const [row] = await db
        .select({ id: documentYjsDrafts.id })
        .from(documentYjsDrafts)
        .where(
          and(
            eq(documentYjsDrafts.documentId, asDocumentId(documentId)),
            eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, asThreadId(threadId))),
            eq(documentYjsDrafts.status, "active"),
          ),
        )
        .limit(1);
      if (row?.id) options.draftFence?.capture({ documentId, threadId, draftId: row.id });
      return row?.id ?? null;
    },

    async ensureDraftId(documentId, threadId, actorTurnId) {
      return ensureDraftIdInDb(db, {
        documentId,
        threadId,
        actorTurnId,
        latestLiveUpdateSeq: options.latestLiveUpdateSeq,
        expectedDraftId: options.draftFence?.expectedDraftId({ documentId, threadId }),
        draftFence: options.draftFence,
      });
    },
  };
}

async function ensureDraftIdInDb(
  db: DraftAgentEditDb,
  input: {
    documentId: string;
    threadId: string;
    actorTurnId?: string;
    latestLiveUpdateSeq?: (documentId: DocumentId) => Promise<number>;
    expectedDraftId?: string;
    draftFence?: DraftSessionFence;
  },
): Promise<string> {
  if (input.expectedDraftId) {
    const activeExpected = await activeDraftIdByIdInDb(db, input.expectedDraftId);
    if (activeExpected) return activeExpected;
    throw new DraftClosedForAppendError(input.expectedDraftId);
  }

  const existing = await activeDraftIdInDb(db, input.documentId, input.threadId);
  if (existing) {
    input.draftFence?.capture({
      documentId: input.documentId,
      threadId: input.threadId,
      draftId: existing,
    });
    return existing;
  }

  try {
    const baseLiveUpdateSeq = await latestLiveUpdateSeqInDb(
      db,
      input.latestLiveUpdateSeq,
      asDocumentId(input.documentId),
    );
    const [row] = await db
      .insert(documentYjsDrafts)
      .values({
        id: createDraftId(),
        documentId: asDocumentId(input.documentId),
        workId: await requirePrimaryWorkId(db, asThreadId(input.threadId)),
        status: "active",
        baseLiveUpdateSeq,
        lastActorTurnId: input.actorTurnId ? asTurnId(input.actorTurnId) : null,
      })
      .returning({ id: documentYjsDrafts.id });
    if (!row) throw new Error("Failed to create active draft");
    input.draftFence?.capture({
      documentId: input.documentId,
      threadId: input.threadId,
      draftId: row.id,
    });
    return row.id;
  } catch (cause) {
    if (!isUniqueConstraintViolation(cause)) throw cause;
    const concurrent = await activeDraftIdInDb(db, input.documentId, input.threadId);
    if (concurrent) {
      input.draftFence?.capture({
        documentId: input.documentId,
        threadId: input.threadId,
        draftId: concurrent,
      });
      return concurrent;
    }
    throw new ActiveDraftConflictError({
      documentId: input.documentId as DocumentId,
      threadId: input.threadId as ThreadId,
    });
  }
}

async function activeDraftIdByIdInDb(
  db: DraftAgentEditDb,
  draftId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: documentYjsDrafts.id })
    .from(documentYjsDrafts)
    .where(and(eq(documentYjsDrafts.id, draftId), eq(documentYjsDrafts.status, "active")))
    .limit(1);
  return row?.id ?? null;
}

async function activeDraftIdInDb(
  db: DraftAgentEditDb,
  documentId: string,
  threadId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: documentYjsDrafts.id })
    .from(documentYjsDrafts)
    .where(
      and(
        eq(documentYjsDrafts.documentId, asDocumentId(documentId)),
        eq(documentYjsDrafts.workId, await requirePrimaryWorkId(db, asThreadId(threadId))),
        eq(documentYjsDrafts.status, "active"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function resolvePrimaryWorkId(
  db: Pick<Database, "select">,
  threadId: ThreadId,
): Promise<WorkId | null> {
  const [row] = await db
    .select({ workId: threadWorks.workId })
    .from(threadWorks)
    .where(and(eq(threadWorks.threadId, threadId), eq(threadWorks.isPrimary, true)))
    .limit(1);
  return (row?.workId as WorkId | undefined) ?? null;
}

async function requirePrimaryWorkId(
  db: Pick<Database, "select">,
  threadId: ThreadId,
): Promise<WorkId> {
  const workId = await resolvePrimaryWorkId(db, threadId);
  if (!workId) throw new Error(`Thread ${threadId} has no primary work`);
  return workId;
}

async function latestLiveUpdateSeqInDb(
  db: DraftAgentEditDb,
  override: ((documentId: DocumentId) => Promise<number>) | undefined,
  documentId: DocumentId,
): Promise<number> {
  if (override) return override(documentId);
  const [row] = await db
    .select({ latestSeq: max(documentYjsUpdates.id) })
    .from(documentYjsUpdates)
    .where(eq(documentYjsUpdates.documentId, documentId));
  return row?.latestSeq === null || row?.latestSeq === undefined ? 0 : Number(row.latestSeq);
}

async function reserveDraftWriteOrdinal(
  db: DraftAgentEditDb,
  input: { documentId: string; threadId: string; scopeId: string },
): Promise<number> {
  const [counter] = await db
    .insert(agentEditWidCounters)
    .values({ ...scopedValues(input), nextWid: 1 })
    .onConflictDoUpdate({
      target: scopedConflictTarget(agentEditWidCounters),
      set: { nextWid: sql`${agentEditWidCounters.nextWid} + 1` },
    })
    .returning({ wId: agentEditWidCounters.nextWid });
  if (!counter) throw new Error("Failed to allocate draft agent edit w-id");
  return counter.wId;
}

async function readDraftUpdates(
  db: DraftAgentEditDb,
  draftId: string,
  opts: JournalReadOptions,
): Promise<JournalSnapshot> {
  const conditions = [eq(documentYjsDraftUpdates.draftId, draftId)];
  if (opts.since !== undefined)
    conditions.push(sql`${documentYjsDraftUpdates.id} >= ${opts.since}`);
  if (opts.until !== undefined)
    conditions.push(sql`${documentYjsDraftUpdates.id} <= ${opts.until}`);
  const rows = await db
    .select()
    .from(documentYjsDraftUpdates)
    .where(and(...conditions))
    .orderBy(asc(documentYjsDraftUpdates.id));
  return { checkpoint: null, updates: rows.map(mapDraftUpdate) };
}

function mapDraftUpdate(row: typeof documentYjsDraftUpdates.$inferSelect): PersistedUpdate {
  return {
    seq: row.id,
    update: toBytes(row.updateData),
    meta: {
      origin: row.actorTurnId ? `agent:${row.actorTurnId}` : "system",
      ...(row.actorTurnId ? { actorTurnId: row.actorTurnId } : {}),
      seq: row.id,
    },
  };
}

function mapActiveWrite(row: {
  writeId: string;
  wId: number;
  turnId: string | null;
  createdSeq: number;
}): ActiveWriteSummary {
  return {
    writeId: row.writeId,
    handle: writeHandle(row.wId),
    wId: row.wId,
    turnId: row.turnId,
    createdSeq: Number(row.createdSeq),
  };
}

function mapWriteMutationRow(row: {
  writeId: string;
  wId: number;
  turnId: string | null;
  createdSeq: number;
  status: "active" | "reversed";
  undoUpdateSeq: number | null;
}): WriteMutationRow {
  return {
    writeId: row.writeId,
    handle: writeHandle(row.wId),
    wId: row.wId,
    turnId: row.turnId,
    createdSeq: Number(row.createdSeq),
    status: row.status,
    ...(row.undoUpdateSeq === null ? {} : { undoUpdateSeq: Number(row.undoUpdateSeq) }),
  };
}

function isUniqueConstraintViolation(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "23505";
}
