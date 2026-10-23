/** Drizzle-backed collab persistence for Yjs updates, checkpoints, and lifecycle. */

import type {
  JournalReadOptions,
  JournalSnapshot,
  PersistedUpdate,
  UpdateMeta,
} from "@meridian/agent-edit/integration";
import {
  captureEditParts,
  isDocumentNotFoundError,
  SavePreconditionRefused,
} from "@meridian/agent-edit/integration";
import type { DocumentAuthorityId, ModelResponseId } from "@meridian/contracts";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditWidCounters,
  documentMarkdownProjections,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
  threads,
  turns,
} from "@meridian/database";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  createCollabYDoc,
  unpackCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, asc, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { requireAgentWriteGrant } from "../../../shared/edit-confirmation.js";
import { testHook } from "../../../shared/test-hooks.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import { requireLivingDocument } from "../../context/tree/living-document.js";
import type { CapturedCheckpointCut } from "../domain/checkpoint-cut.js";
import { documentContainsUpdate } from "../domain/document-containment.js";
import { RetiredDocumentHandleError } from "../domain/document-handle.js";
import type {
  CheckpointAuthority,
  CheckpointJournal,
} from "../domain/ports/checkpoint-authority.js";
import type { InitialDocumentSeeds } from "../domain/ports/initial-document-seeds.js";
import type { LiveWriterJournal } from "../domain/ports/live-writer-journal.js";
import { insertionAttributions } from "../domain/provenance.js";
import { DocumentSchemaMajorMismatchError, isStaleSchema } from "../domain/stale-schema.js";
import { resolveCheckpointCut } from "./checkpoint-capability.js";
import { storedDocument } from "./document-loader.js";
import { captureDrizzleCheckpoint } from "./drizzle-checkpoint-capture.js";
import {
  advanceHead,
  allocateAdmission,
  findDocumentAuthorityHead,
  findHeadSchemaVersion,
  initializeHead,
  readDocumentAuthorityHead,
  retireThrough,
} from "./drizzle-document-authority-head.js";
import { captureReceiptRows, recordDocumentEdit } from "./drizzle-document-edits.js";
import { parseAttributionManifest } from "./drizzle-provenance.js";

type JournalDb = Pick<
  Database,
  "select" | "selectDistinct" | "insert" | "update" | "delete" | "transaction" | "execute"
>;

type OriginType = "agent" | "human" | "system";
type UpdateMetaMode = "journal" | "latest";

export type FacadeCheckpointRecord = {
  id: string;
  documentId: string;
  state: Uint8Array;
  attributionManifest?: unknown;
  reason: string;
  createdAt: string;
};

export type CollabFacadeStore = {
  createCheckpoint(cut: CapturedCheckpointCut, reason: string): Promise<string | null>;
  getCheckpoint(id: string): Promise<FacadeCheckpointRecord | null>;
  listCheckpoints(docId: string): Promise<FacadeCheckpointRecord[]>;
  latestUpdate(docId: string): Promise<PersistedUpdate | null>;
  latestUpdateSeq(docId: string): Promise<number>;
};

export type CollabJournal = CheckpointJournal &
  LiveWriterJournal & {
    headSchemaVersion(documentId: string): Promise<CollabSchemaVersion | null>;
  };

export type DrizzleCollabPersistence = {
  journal: CollabJournal;
  seeds: InitialDocumentSeeds;
  store: CollabFacadeStore;
};

const asDocumentId = (value: string) => value as DocumentId;
const asThreadId = (value: string) => value as ThreadId;
const asTurnId = (value: string) => value as TurnId;
const asModelResponseId = (value: string | undefined) => value as ModelResponseId | undefined;
const asOptionalTurnId = (value: string | undefined) => value as TurnId | undefined;
const asUserId = (value: string | undefined) => value as UserId | undefined;

function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer);
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

/**
 * A journal write's prelude, inside its transaction (file-access §5): an
 * agent write must carry a grant; then the bound grants' Works lock and are
 * confirmed; then each document's mutation lock, in id order.
 */
async function enterJournalSeam(
  db: JournalDb,
  docIds: readonly string[],
  agentDocIds: readonly string[],
): Promise<JournalDb> {
  const txDb = currentDrizzleDb(db as Database) as JournalDb;
  if (agentDocIds.length > 0) await requireAgentWriteGrant(uniqueSortedDocIds(agentDocIds));
  await lockSeamWorks(db as Database, []);
  for (const docId of uniqueSortedDocIds(docIds)) await lockDocumentMutation(txDb, docId);
  return txDb;
}

function uniqueSortedDocIds(docIds: readonly string[]): string[] {
  return [...new Set(docIds)].sort();
}

/** Agent-authored updates require the model’s write grant. */
function agentAuthored(meta: UpdateMeta | undefined): boolean {
  if (!meta) return false;
  return meta.origin.startsWith("agent:");
}

function parseOrigin(meta: UpdateMeta): {
  originType: OriginType;
  actorTurnId?: TurnId;
  actorUserId?: UserId;
} {
  if (meta.origin === "system") {
    return { originType: "system", actorTurnId: asOptionalTurnId(meta.actorTurnId) };
  }

  const separator = meta.origin.indexOf(":");
  if (separator === -1) throw new Error(`Invalid update origin: ${meta.origin}`);

  const kind = meta.origin.slice(0, separator);
  const id = meta.origin.slice(separator + 1);
  if (!id) throw new Error(`Invalid update origin: ${meta.origin}`);

  if (kind === "agent") {
    return { originType: "agent", actorTurnId: asTurnId(meta.actorTurnId ?? id) };
  }
  if (kind === "human") {
    return {
      originType: "human",
      actorTurnId: asOptionalTurnId(meta.actorTurnId),
      actorUserId: asUserId(id),
    };
  }
  throw new Error(`Invalid update origin: ${meta.origin}`);
}

// Existing transport readers intentionally do not consume the new edit lineage.
const journalTransportColumns = {
  id: documentYjsUpdates.id,
  updateData: documentYjsUpdates.updateData,
  originType: documentYjsUpdates.originType,
  actorUserId: documentYjsUpdates.actorUserId,
  actorTurnId: documentYjsUpdates.actorTurnId,
  authoringResponseId: documentYjsUpdates.authoringResponseId,
};
type JournalTransportRow = Pick<
  typeof documentYjsUpdates.$inferSelect,
  keyof typeof journalTransportColumns
>;

function metaFromUpdateRow(
  row: JournalTransportRow,
  mode: UpdateMetaMode,
  author?: string | null,
): UpdateMeta {
  if (row.originType === "reconcile") {
    return {
      origin: "system:reconcile",
      seq: row.id,
    };
  }
  if (row.originType === "agent") {
    const originActor = row.actorTurnId ?? (mode === "journal" ? "unknown" : undefined);
    if (originActor) {
      return {
        origin: `agent:${originActor}`,
        ...(row.actorTurnId ? { actorTurnId: row.actorTurnId } : {}),
        ...(author ? { author: `agent (${author})` } : {}),
        ...(row.authoringResponseId ? { authoringResponseId: row.authoringResponseId } : {}),
        seq: row.id,
      };
    }
  }
  if (row.originType === "human" || row.originType === "user") {
    const originActor = row.actorUserId ?? (mode === "journal" ? "unknown" : undefined);
    if (originActor) {
      return {
        origin: `human:${originActor}`,
        ...(row.actorTurnId ? { actorTurnId: row.actorTurnId } : {}),
        seq: row.id,
      };
    }
  }
  return {
    origin: "system",
    ...(row.actorTurnId ? { actorTurnId: row.actorTurnId } : {}),
    ...(row.authoringResponseId ? { authoringResponseId: row.authoringResponseId } : {}),
    seq: row.id,
  };
}

function mapUpdate(
  row: JournalTransportRow,
  mode: UpdateMetaMode = "journal",
  author?: string | null,
): PersistedUpdate {
  return {
    seq: row.id,
    update: toBytes(row.updateData),
    meta: metaFromUpdateRow(row, mode, author),
  };
}

async function latestCheckpoint(
  db: JournalDb,
  documentId: string,
  authority: CheckpointAuthority,
  untilSeq?: number,
) {
  const conditions = [
    eq(documentYjsCheckpoints.documentId, asDocumentId(documentId)),
    eq(documentYjsCheckpoints.authorityId, authority.authorityId),
    eq(documentYjsCheckpoints.authorityGeneration, authority.generation),
  ];
  if (untilSeq !== undefined) conditions.push(lte(documentYjsCheckpoints.upToSeq, untilSeq));
  const [row] = await db
    .select()
    .from(documentYjsCheckpoints)
    .where(and(...conditions))
    .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id))
    .limit(1);
  return row ?? null;
}

function assertHeadSchemaCurrent(docId: string, storedVersion: CollabSchemaVersion | null): void {
  if (storedVersion !== null && isStaleSchema(storedVersion, COLLAB_SCHEMA_VERSION)) {
    throw new DocumentSchemaMajorMismatchError(docId, storedVersion, COLLAB_SCHEMA_VERSION);
  }
}

async function assertReadableHead(db: JournalDb, docId: string): Promise<void> {
  assertHeadSchemaCurrent(docId, await findHeadSchemaVersion(db, docId));
}

async function insertCheckpoint(
  db: JournalDb,
  documentId: string,
  state: Uint8Array,
  upToSeq: number,
  reason: string,
  authorityHead: CheckpointAuthority,
): Promise<number> {
  const stateVector = Y.encodeStateVectorFromUpdate(state);
  const attributionManifest = await checkpointAttributionManifest(
    db,
    documentId,
    upToSeq,
    authorityHead,
  );
  const [inserted] = await db
    .insert(documentYjsCheckpoints)
    .values({
      documentId: asDocumentId(documentId),
      authorityId: authorityHead.authorityId,
      authorityGeneration: authorityHead.generation,
      attributionManifest,
      state: toBuffer(state),
      stateVector: toBuffer(stateVector),
      upToSeq,
      reason,
    })
    .onConflictDoNothing({
      target: documentYjsCheckpoints.documentId,
      where: sql`${documentYjsCheckpoints.upToSeq} = 0`,
    })
    .returning({ id: documentYjsCheckpoints.id, stateVector: documentYjsCheckpoints.stateVector });
  const [adopted] = inserted
    ? [inserted]
    : upToSeq === 0
      ? await db
          .select({
            id: documentYjsCheckpoints.id,
            stateVector: documentYjsCheckpoints.stateVector,
          })
          .from(documentYjsCheckpoints)
          .where(
            and(
              eq(documentYjsCheckpoints.documentId, asDocumentId(documentId)),
              eq(documentYjsCheckpoints.upToSeq, 0),
            ),
          )
          .limit(1)
      : [];
  const row = inserted ?? adopted;
  if (!row) throw new Error("Failed to insert Yjs checkpoint");

  await advanceHead(db, documentId, {
    latestUpdateSeq: upToSeq,
    latestStateVector: toBytes(row.stateVector),
    checkpointId: row.id,
  });

  return row.id;
}

/** Called only while holding the document mutation lock. Unbound producers own their cut. */
async function validateAppendAuthority(
  db: JournalDb,
  documentId: string,
  authority?: { authorityId: string; generation: bigint },
): Promise<void> {
  if (!authority) return;
  const head = await findDocumentAuthorityHead(db, documentId);
  if (
    !head ||
    head.authorityId !== authority.authorityId ||
    head.generation !== authority.generation
  ) {
    throw new RetiredDocumentHandleError();
  }
}

type AppendedUpdate = { seq: number };

/**
 * One update inserted under the document mutation lock the caller holds. `stored` is the
 * document before it, present for a human update, whose edit receipts are captured against it.
 */
async function insertUpdate(
  db: JournalDb,
  documentId: string,
  update: Uint8Array,
  meta: UpdateMeta,
  stored: Y.Doc | undefined,
): Promise<AppendedUpdate> {
  const origin = parseOrigin(meta);
  const authorityHead = await allocateAdmission(db, documentId);
  const [row] = await db
    .insert(documentYjsUpdates)
    .values({
      documentId: asDocumentId(documentId),
      authorityId: authorityHead.authorityId,
      authorityGeneration: authorityHead.generation,
      admissionSequence: authorityHead.admissionSequence,
      batchOrdinal: 0,
      updateData: toBuffer(update),
      originType: origin.originType,
      actorUserId: origin.actorUserId ?? null,
      actorTurnId: origin.actorTurnId ?? null,
      authoringResponseId: asModelResponseId(meta.authoringResponseId) ?? null,
    })
    .returning({ id: documentYjsUpdates.id });
  if (!row) throw new Error("Failed to append Yjs update");
  if (stored && origin.originType === "human") {
    await recordDocumentEdit(db, {
      documentId: asDocumentId(documentId),
      actor: "human",
      actorUserId: origin.actorUserId,
      receipts: captureReceiptRows(stored, [{ update, origin: { kind: "live", seq: row.id } }]),
    });
  }
  return { seq: row.id };
}

async function checkpointAttributionManifest(
  db: JournalDb,
  documentId: string,
  upToSeq: number,
  authorityHead: { authorityId: DocumentAuthorityId; generation: bigint },
): Promise<unknown> {
  const [checkpoint] = await db
    .select()
    .from(documentYjsCheckpoints)
    .where(
      and(
        eq(documentYjsCheckpoints.documentId, asDocumentId(documentId)),
        eq(documentYjsCheckpoints.authorityId, authorityHead.authorityId),
        eq(documentYjsCheckpoints.authorityGeneration, authorityHead.generation),
        lte(documentYjsCheckpoints.upToSeq, upToSeq),
      ),
    )
    .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id))
    .limit(1);
  const previousManifest = checkpoint
    ? parseAttributionManifest(checkpoint.attributionManifest, {
        authorityId: checkpoint.authorityId,
        generation: checkpoint.authorityGeneration,
        checkpointId: String(checkpoint.id),
      })
    : null;
  const rows = await db
    .select({
      id: documentYjsUpdates.id,
      admissionSequence: documentYjsUpdates.admissionSequence,
      batchOrdinal: documentYjsUpdates.batchOrdinal,
      updateData: documentYjsUpdates.updateData,
      originType: documentYjsUpdates.originType,
      actorUserId: documentYjsUpdates.actorUserId,
    })
    .from(documentYjsUpdates)
    .where(
      and(
        eq(documentYjsUpdates.documentId, asDocumentId(documentId)),
        eq(documentYjsUpdates.authorityId, authorityHead.authorityId),
        eq(documentYjsUpdates.authorityGeneration, authorityHead.generation),
        lte(documentYjsUpdates.id, upToSeq),
      ),
    )
    .orderBy(
      asc(documentYjsUpdates.admissionSequence),
      asc(documentYjsUpdates.batchOrdinal),
      asc(documentYjsUpdates.id),
    );
  const floorRow = rows.at(-1);
  return {
    version: 1,
    floor: floorRow
      ? replayKeyJson(floorRow)
      : previousManifest?.floor
        ? replayKeyValueJson(previousManifest.floor)
        : null,
    attributions: insertionAttributions(
      rows.map((row) => ({
        admissionSequence: row.admissionSequence,
        batchOrdinal: row.batchOrdinal,
        journalRowId: BigInt(row.id),
        originType: row.originType,
        actorUserId: row.actorUserId,
        update: toBytes(row.updateData),
      })),
      previousManifest?.attributions,
    ).map((attribution) => ({
      ...attribution,
      origin: {
        admissionSequence: attribution.origin.admissionSequence.toString(),
        batchOrdinal: attribution.origin.batchOrdinal,
        journalRowId: attribution.origin.journalRowId.toString(),
      },
    })),
  };
}

function replayKeyJson(row: { admissionSequence: bigint; batchOrdinal: number; id: number }): {
  admissionSequence: string;
  batchOrdinal: number;
  journalRowId: string;
} {
  return {
    admissionSequence: row.admissionSequence.toString(),
    batchOrdinal: row.batchOrdinal,
    journalRowId: row.id.toString(),
  };
}

function replayKeyValueJson(row: {
  admissionSequence: bigint;
  batchOrdinal: number;
  journalRowId: bigint;
}): {
  admissionSequence: string;
  batchOrdinal: number;
  journalRowId: string;
} {
  return {
    admissionSequence: row.admissionSequence.toString(),
    batchOrdinal: row.batchOrdinal,
    journalRowId: row.journalRowId.toString(),
  };
}

async function reserveWriteOrdinal(
  db: JournalDb,
  input: { documentId: string; threadId: string },
): Promise<number> {
  const [counter] = await db
    .insert(agentEditWidCounters)
    .values({
      documentId: asDocumentId(input.documentId),
      threadId: asThreadId(input.threadId),
      nextWid: 1,
    })
    .onConflictDoUpdate({
      target: [agentEditWidCounters.documentId, agentEditWidCounters.threadId],
      set: { nextWid: sql`${agentEditWidCounters.nextWid} + 1` },
    })
    .returning({ wId: agentEditWidCounters.nextWid });
  if (!counter) throw new Error("Failed to allocate agent edit w-id");
  return counter.wId;
}

function mapCheckpoint(row: typeof documentYjsCheckpoints.$inferSelect): FacadeCheckpointRecord {
  return {
    id: String(row.id),
    documentId: row.documentId,
    state: toBytes(row.state),
    attributionManifest: row.attributionManifest,
    reason: row.reason ?? "checkpoint",
    createdAt: row.createdAt.toISOString(),
  };
}

async function materializeCurrentCheckpoint(
  db: JournalDb,
  cut: CapturedCheckpointCut,
): Promise<Uint8Array | null> {
  const isCurrent = async () => {
    const current = await findDocumentAuthorityHead(
      currentDrizzleDb(db as Database),
      cut.documentId,
    );
    return (
      current?.authorityId === cut.authority.authorityId &&
      current.generation === cut.authority.generation
    );
  };
  if (!(await isCurrent())) return null;
  try {
    return await resolveCheckpointCut(cut).materializeState();
  } catch (cause) {
    // A restore may retire inputs during the unlocked read. Preserve the stale
    // checkpoint contract; unrelated materialization failures still surface.
    if (!(await isCurrent())) return null;
    throw cause;
  }
}

export function createDrizzleJournal(db: JournalDb): CollabJournal {
  return {
    headSchemaVersion: (documentId) => findHeadSchemaVersion(db, documentId),

    async append(docId, update, meta, authority) {
      return runInDrizzleTransaction(db as Database, async () => {
        const txDb = await enterJournalSeam(db, [docId], agentAuthored(meta) ? [docId] : []);
        await validateAppendAuthority(txDb, docId, authority);
        // Agent and system appends carry their own fresh structs and are not judged.
        const stored =
          parseOrigin(meta).originType === "human"
            ? storedDocument(await createDrizzleJournal(txDb).read(docId))
            : undefined;
        try {
          return (await insertUpdate(txDb, docId, update, meta, stored)).seq;
        } finally {
          stored?.destroy();
        }
      });
    },

    async appendWriterUpdate(docId, update, meta, authority) {
      return runInDrizzleTransaction(db as Database, async () => {
        // A live room binds its edit grant around each frame (file-access §7).
        const txDb = await enterJournalSeam(db, [docId], []);
        await validateAppendAuthority(txDb, docId, authority);
        // Judged against what every earlier admission committed: a copy of an update another
        // socket already stored appends no row, spends no admission sequence, records no edit.
        const stored = storedDocument(await createDrizzleJournal(txDb).read(docId));
        try {
          if (documentContainsUpdate(stored, update)) return { status: "contained" } as const;
          return {
            status: "appended",
            ...(await insertUpdate(txDb, docId, update, meta, stored)),
          } as const;
        } finally {
          stored.destroy();
        }
      });
    },

    async appendBatch(entries, precondition) {
      if (entries.length === 0) return [];
      // Inside a reply's save the rows join its one transaction (D42) and stay
      // staged until it commits; otherwise this call owns a durable transaction.
      return runInDrizzleTransaction(db as Database, async () => {
        const txDb = await enterJournalSeam(
          db,
          entries.map((entry) => entry.docId),
          entries.filter((entry) => agentAuthored(entry.meta)).map((entry) => entry.docId),
        );
        for (const entry of entries)
          await validateAppendAuthority(txDb, entry.docId, entry.authority);
        // Each document as this append finds it under its lock: the batch's cut, the state its
        // precondition is judged on before anything is written (a refusal leaves an ambient
        // transaction untouched), and the base its receipts are captured against.
        const beforeStates = new Map<string, Uint8Array>();
        for (const docId of uniqueSortedDocIds(entries.map((e) => e.docId))) {
          const beforeState = encodeJournalSnapshot(await this.read(docId));
          if (precondition && !precondition(beforeState)) throw new SavePreconditionRefused(docId);
          beforeStates.set(docId, beforeState);
        }
        const admissions = new Map<string, Awaited<ReturnType<typeof allocateAdmission>>>();
        for (const docId of uniqueSortedDocIds(entries.map((entry) => entry.docId))) {
          admissions.set(docId, await allocateAdmission(txDb, docId));
        }
        const mutated = new Set(entries.filter((e) => e.mutation).map((e) => e.docId));
        const batchOrdinals = new Map<string, number>();

        const updateRows = await txDb
          .insert(documentYjsUpdates)
          .values(
            entries.map((entry) => {
              const origin = parseOrigin(entry.meta);
              const authorityHead = admissions.get(entry.docId);
              if (!authorityHead) throw new Error("Missing allocated document admission");
              const batchOrdinal = batchOrdinals.get(entry.docId) ?? 0;
              batchOrdinals.set(entry.docId, batchOrdinal + 1);
              return {
                documentId: asDocumentId(entry.docId),
                authorityId: authorityHead.authorityId,
                authorityGeneration: authorityHead.generation,
                admissionSequence: authorityHead.admissionSequence,
                batchOrdinal,
                updateData: toBuffer(entry.update),
                originType: origin.originType,
                actorUserId: origin.actorUserId ?? null,
                actorTurnId: origin.actorTurnId ?? null,
                authoringResponseId: asModelResponseId(entry.meta.authoringResponseId) ?? null,
              };
            }),
          )
          .returning({ id: documentYjsUpdates.id });

        // PostgreSQL returning order matches insertion order for a single
        // INSERT, but sort by id to be safe (id is auto-incrementing).
        updateRows.sort((a, b) => a.id - b.id);
        const ordinals = new Map<number, number>();
        for (const [index, entry] of entries.entries()) {
          if (!entry.mutation) continue;
          ordinals.set(
            index,
            entry.mutation.wId ??
              (await reserveWriteOrdinal(txDb, {
                documentId: entry.docId,
                threadId: entry.mutation.threadId,
              })),
          );
        }

        await captureLiveEdits(
          txDb,
          new Map([...beforeStates].filter(([docId]) => mutated.has(docId))),
          entries.map((entry, index) => ({
            ...entry,
            ...(entry.mutation
              ? { mutation: { ...entry.mutation, wId: ordinals.get(index) } }
              : {}),
          })),
          updateRows,
        );

        return updateRows.map((row, index) => ({
          seq: row.id,
          beforeState: beforeStates.get(entries[index].docId) as Uint8Array,
          ...(ordinals.has(index) ? { wId: ordinals.get(index) } : {}),
        }));
      });
    },

    async reserveWriteOrdinal(documentId, threadId) {
      return reserveWriteOrdinal(db, { documentId, threadId });
    },

    async readUpdates(docId, after, through) {
      if (after >= through) return [];
      const readDb = currentDrizzleDb(db as Database) as JournalDb;
      const rows = await readDb
        .select({ update: journalTransportColumns, authorHandle: threads.ref })
        .from(documentYjsUpdates)
        .innerJoin(
          documentYjsHeads,
          and(
            eq(documentYjsHeads.documentId, documentYjsUpdates.documentId),
            eq(documentYjsHeads.authorityId, documentYjsUpdates.authorityId),
            eq(documentYjsHeads.authorityGeneration, documentYjsUpdates.authorityGeneration),
          ),
        )
        .leftJoin(turns, eq(turns.id, documentYjsUpdates.actorTurnId))
        .leftJoin(threads, eq(threads.id, turns.threadId))
        .where(
          and(
            eq(documentYjsUpdates.documentId, asDocumentId(docId)),
            gt(documentYjsUpdates.id, after),
            lte(documentYjsUpdates.id, through),
          ),
        )
        .orderBy(asc(documentYjsUpdates.id));
      return rows.map((row) => mapUpdate(row.update, "journal", row.authorHandle));
    },

    async read(docId, opts: JournalReadOptions = {}): Promise<JournalSnapshot> {
      const readDb = currentDrizzleDb(db as Database) as JournalDb;
      const checkpointBound =
        opts.since === undefined
          ? opts.until
          : Math.min(opts.until ?? Number.MAX_SAFE_INTEGER, opts.since - 1);
      const checkpoint = readDb
        .select({ state: documentYjsCheckpoints.state, upToSeq: documentYjsCheckpoints.upToSeq })
        .from(documentYjsCheckpoints)
        .where(
          and(
            eq(documentYjsCheckpoints.documentId, documentYjsHeads.documentId),
            eq(documentYjsCheckpoints.authorityId, documentYjsHeads.authorityId),
            eq(documentYjsCheckpoints.authorityGeneration, documentYjsHeads.authorityGeneration),
            checkpointBound === undefined
              ? undefined
              : lte(documentYjsCheckpoints.upToSeq, checkpointBound),
          ),
        )
        .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id))
        .limit(1)
        .as("checkpoint");
      // One statement observes authority, checkpoint and tail together. A compaction may
      // delete the folded rows, or a restore replace the authority, between separate reads.
      const rows = await readDb
        .select({
          authorityId: documentYjsHeads.authorityId,
          generation: documentYjsHeads.authorityGeneration,
          schemaVersion: documentYjsHeads.schemaVersion,
          checkpoint: {
            // A large checkpoint is transferred once, not once for every retained tail row.
            state:
              sql<Buffer | null>`case when row_number() over (order by ${documentYjsUpdates.id}) = 1
              then ${checkpoint.state} else null end`.mapWith(documentYjsCheckpoints.state),
            upToSeq: checkpoint.upToSeq,
          },
          update: journalTransportColumns,
          authorHandle: threads.ref,
        })
        .from(documentYjsHeads)
        .leftJoinLateral(checkpoint, sql`true`)
        .leftJoin(
          documentYjsUpdates,
          and(
            eq(documentYjsUpdates.documentId, documentYjsHeads.documentId),
            eq(documentYjsUpdates.authorityId, documentYjsHeads.authorityId),
            eq(documentYjsUpdates.authorityGeneration, documentYjsHeads.authorityGeneration),
            gt(documentYjsUpdates.id, sql`coalesce(${checkpoint.upToSeq}, 0)`),
            opts.since === undefined ? undefined : gte(documentYjsUpdates.id, opts.since),
            opts.until === undefined ? undefined : lte(documentYjsUpdates.id, opts.until),
          ),
        )
        .leftJoin(turns, eq(turns.id, documentYjsUpdates.actorTurnId))
        .leftJoin(threads, eq(threads.id, turns.threadId))
        .where(eq(documentYjsHeads.documentId, asDocumentId(docId)))
        .orderBy(asc(documentYjsUpdates.id));
      const head = rows[0];
      if (!head) return { checkpoint: null, updates: [] };
      assertHeadSchemaCurrent(docId, unpackCollabSchemaVersion(head.schemaVersion));
      const updates = rows.flatMap((row) =>
        row.update ? [mapUpdate(row.update, "journal", row.authorHandle)] : [],
      );
      return {
        authority: { authorityId: head.authorityId, generation: head.generation },
        checkpoint: head.checkpoint?.state ? toBytes(head.checkpoint.state) : null,
        updates,
        persistenceWatermark: Math.max(head.checkpoint?.upToSeq ?? 0, updates.at(-1)?.seq ?? 0),
      };
    },

    captureCheckpoint(docId, captured) {
      return captureDrizzleCheckpoint(db, docId, captured);
    },

    async storeCheckpoint(cut) {
      const payload = resolveCheckpointCut(cut);
      const { documentId: docId, authority: captured, upToSeq } = payload;
      const state = await materializeCurrentCheckpoint(db, cut);
      if (state === null) return;
      await runInDrizzleTransaction(db as Database, async () => {
        const txDb = currentDrizzleDb(db as Database) as JournalDb;
        await lockDocumentMutation(txDb, docId);
        // A checkpoint captured before a removal stores nothing after it.
        const current = await findDocumentAuthorityHead(txDb, docId, { living: true });
        if (
          !current ||
          current.authorityId !== captured.authorityId ||
          current.generation !== captured.generation
        )
          return;
        await testHook("checkpoint.afterAuthorityRead");
        await payload.validateInputs();
        const existing = await latestCheckpoint(txDb, docId, captured);
        if (existing && existing.upToSeq >= upToSeq) return;
        await insertCheckpoint(txDb, docId, state, upToSeq, "checkpoint", captured);
        if (existing?.upToSeq === 0 && existing.reason === "checkpoint") {
          await txDb
            .delete(documentYjsCheckpoints)
            .where(eq(documentYjsCheckpoints.id, existing.id));
        }
      });
    },

    async compact(docId, before) {
      return db.transaction(async (tx) => {
        const txDb = tx as JournalDb;
        await lockDocumentMutation(txDb, docId);
        const authorityHead = await readDocumentAuthorityHead(txDb, docId, {
          living: true,
        }).catch((cause: unknown) => {
          // A removed document keeps its history as the removal left it.
          if (isDocumentNotFoundError(cause) && cause.removal) return null;
          throw cause;
        });
        if (!authorityHead) return { updatesFolded: 0 };
        const [checkpoint] = await txDb
          .select()
          .from(documentYjsCheckpoints)
          .where(
            and(
              eq(documentYjsCheckpoints.documentId, asDocumentId(docId)),
              eq(documentYjsCheckpoints.authorityId, authorityHead.authorityId),
              eq(documentYjsCheckpoints.authorityGeneration, authorityHead.generation),
            ),
          )
          .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id))
          .limit(1);
        const checkpointSeq = checkpoint?.upToSeq ?? 0;
        // Compaction folds a contiguous seq prefix, so every retained update sits strictly
        // above the latest compacted checkpoint; reconstruction can safely start from the
        // newest checkpoint below the earliest retained update.
        const candidateRows = await txDb
          .select()
          .from(documentYjsUpdates)
          .where(
            and(
              eq(documentYjsUpdates.documentId, asDocumentId(docId)),
              eq(documentYjsUpdates.authorityId, authorityHead.authorityId),
              eq(documentYjsUpdates.authorityGeneration, authorityHead.generation),
              gt(documentYjsUpdates.id, checkpointSeq),
            ),
          )
          .orderBy(asc(documentYjsUpdates.id));
        const firstRetainedIndex = candidateRows.findIndex((row) => row.createdAt >= before);
        const foldRows =
          firstRetainedIndex === -1 ? candidateRows : candidateRows.slice(0, firstRetainedIndex);

        let compactedThroughSeq = checkpointSeq;
        if (foldRows.length > 0) {
          const doc = createCollabYDoc({ gc: false });
          if (checkpoint) Y.applyUpdate(doc, toBytes(checkpoint.state));
          for (const row of foldRows) Y.applyUpdate(doc, toBytes(row.updateData));
          compactedThroughSeq = foldRows.at(-1)?.id ?? checkpointSeq;
          await insertCheckpoint(
            txDb,
            docId,
            Y.encodeStateAsUpdate(doc),
            compactedThroughSeq,
            "compact",
            authorityHead,
          );
        }

        if (compactedThroughSeq > 0) {
          // Advance the head past every retired prefix, even when an ordinary checkpoint
          // already covers it and this compaction folds no new rows.
          await retireThrough(txDb, docId, compactedThroughSeq);

          await txDb
            .delete(documentYjsUpdates)
            .where(
              and(
                eq(documentYjsUpdates.documentId, asDocumentId(docId)),
                eq(documentYjsUpdates.authorityId, authorityHead.authorityId),
                eq(documentYjsUpdates.authorityGeneration, authorityHead.generation),
                lte(documentYjsUpdates.id, compactedThroughSeq),
              ),
            );
        }

        return { updatesFolded: foldRows.length };
      });
    },
  };
}

function createServerInitialDocumentSeeds(db: JournalDb): InitialDocumentSeeds {
  return {
    async seedInitialDocument(docId, state) {
      return runInDrizzleTransaction(db as Database, async () => {
        const txDb = currentDrizzleDb(db as Database) as JournalDb;
        await lockDocumentMutation(txDb, docId);
        // Prove the living row under the lock a removal takes: nothing writes a removed
        // document into being.
        await requireLivingDocument(txDb, asDocumentId(docId));
        await assertReadableHead(txDb, docId);
        const [checkpoint, update] = await Promise.all([
          txDb
            .select({ id: documentYjsCheckpoints.id })
            .from(documentYjsCheckpoints)
            .where(eq(documentYjsCheckpoints.documentId, asDocumentId(docId)))
            .limit(1),
          txDb
            .select({ id: documentYjsUpdates.id })
            .from(documentYjsUpdates)
            .where(eq(documentYjsUpdates.documentId, asDocumentId(docId)))
            .limit(1),
        ]);
        if (checkpoint[0] || update[0]) return false;
        // A head with no history (a head-only anomaly) is reused; otherwise this is its birth.
        await initializeHead(txDb, asDocumentId(docId));
        // An empty authority's checkpoint is a placeholder the first stored checkpoint
        // replaces; a seed with content stays as the document's first version.
        const empty = Y.decodeUpdate(state).structs.length === 0;
        await insertCheckpoint(
          txDb,
          docId,
          state,
          0,
          empty ? "checkpoint" : "seed",
          await readDocumentAuthorityHead(txDb, docId),
        );
        return true;
      });
    },

    async missingAuthorityProjection(docId) {
      const readDb = currentDrizzleDb(db as Database) as JournalDb;
      const [row] = await readDb.execute<{ markdown: string }>(sql`
        select coalesce(
          (select ${documentMarkdownProjections.markdown} from ${documentMarkdownProjections}
            where ${documentMarkdownProjections.documentId} = ${docId}),
          ''
        ) as markdown
        where not exists (select 1 from ${documentYjsCheckpoints}
            where ${documentYjsCheckpoints.documentId} = ${docId})
          and not exists (select 1 from ${documentYjsUpdates}
            where ${documentYjsUpdates.documentId} = ${docId})`);
      return row ? row.markdown : null;
    },
  };
}

export function createDrizzleCollabFacadeStore(db: JournalDb): CollabFacadeStore {
  return {
    async createCheckpoint(cut, reason) {
      const payload = resolveCheckpointCut(cut);
      const { documentId: docId, authority: captured, upToSeq } = payload;
      const state = await materializeCurrentCheckpoint(db, cut);
      if (state === null) return null;
      return runInDrizzleTransaction(db as Database, async () => {
        const tx = currentDrizzleDb(db as Database) as JournalDb;
        await lockDocumentMutation(tx, docId);
        const current = await readDocumentAuthorityHead(tx, docId, { living: true });
        if (
          current.authorityId !== captured.authorityId ||
          current.generation !== captured.generation
        )
          return null;
        await payload.validateInputs();
        const checkpointId = await insertCheckpoint(
          tx as JournalDb,
          docId,
          state,
          upToSeq,
          reason,
          captured,
        );
        return String(checkpointId);
      });
    },

    async getCheckpoint(id) {
      const checkpointId = Number(id);
      if (!Number.isSafeInteger(checkpointId)) return null;
      const [row] = await db
        .select()
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.id, checkpointId))
        .limit(1);
      return row ? mapCheckpoint(row) : null;
    },

    async listCheckpoints(docId) {
      const rows = await db
        .select()
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.documentId, asDocumentId(docId)))
        .orderBy(desc(documentYjsCheckpoints.id));
      return rows.map(mapCheckpoint);
    },

    async latestUpdate(docId) {
      const [row] = await db
        .select(journalTransportColumns)
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, asDocumentId(docId)))
        .orderBy(desc(documentYjsUpdates.id))
        .limit(1);
      return row ? mapUpdate(row, "latest") : null;
    },

    async latestUpdateSeq(docId) {
      const [row] = await db
        .select({ seq: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, asDocumentId(docId)))
        .orderBy(desc(documentYjsUpdates.id))
        .limit(1);
      if (row) return row.seq;
      const [head] = await db
        .select({ latestUpdateSeq: documentYjsHeads.latestUpdateSeq })
        .from(documentYjsHeads)
        .where(eq(documentYjsHeads.documentId, asDocumentId(docId)))
        .limit(1);
      return Number(head?.latestUpdateSeq ?? 0);
    },
  };
}

export function createDrizzleCollabPersistence(db: JournalDb): DrizzleCollabPersistence {
  const journal = createDrizzleJournal(db);
  return {
    journal,
    seeds: createServerInitialDocumentSeeds(db),
    store: createDrizzleCollabFacadeStore(db),
  };
}

function encodeJournalSnapshot(snapshot: JournalSnapshot): Uint8Array {
  const doc = storedDocument(snapshot);
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
async function captureLiveEdits(
  db: JournalDb,
  states: Map<string, Uint8Array>,
  entries: readonly import("@meridian/agent-edit/integration").JournalBatchAppendEntry[],
  rows: readonly { id: number }[],
): Promise<void> {
  for (const [docId, state] of states) {
    const doc = createCollabYDoc({ gc: false }),
      groups = new Map<
        string,
        {
          mutation: NonNullable<(typeof entries)[number]["mutation"]>;
          receipts: import("./drizzle-document-edits.js").ReceiptWrite["receipts"];
        }
      >();
    try {
      Y.applyUpdate(doc, state);
      for (const [i, entry] of entries.entries()) {
        if (entry.docId !== docId) continue;
        const receipts = captureReceiptRows(
          doc,
          (entry.mutation?.editParts ?? [entry.update]).map((update) => ({
            update,
            origin: { kind: "live", seq: rows[i].id },
          })),
        );
        if (!entry.mutation) continue;
        const key = entry.mutation.writeId ?? String(rows[i].id),
          group = groups.get(key) ?? { mutation: entry.mutation, receipts: [] };
        group.receipts.push(...receipts);
        groups.set(key, group);
      }
      for (const { mutation, receipts } of groups.values())
        await recordDocumentEdit(db, {
          documentId: asDocumentId(docId),
          threadId: asThreadId(mutation.threadId),
          turnId: asOptionalTurnId(mutation.turnId ?? undefined),
          responseId: asModelResponseId(mutation.authoringResponseId),
          editScopeId: mutation.editScopeId,
          toolCallId: mutation.toolCallId,
          actor: mutation.actorKind,
          wId: mutation.wId,
          actorUserId: mutation.userId ? asUserId(mutation.userId) : undefined,
          receipts: captureEditParts(doc, receipts).map((p, i) => ({
            ...p,
            origin: receipts[i].origin,
          })),
        });
    } finally {
      doc.destroy();
    }
  }
}
