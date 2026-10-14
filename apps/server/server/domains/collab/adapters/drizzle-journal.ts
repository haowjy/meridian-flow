/** Drizzle-backed collab persistence for Yjs updates, checkpoints, and lifecycle. */

import type {
  DocumentLifecycle,
  JournalReadOptions,
  JournalSnapshot,
  PersistedUpdate,
  UpdateJournal,
  UpdateMeta,
} from "@meridian/agent-edit/integration";
import { captureEditParts, unwrapDoc } from "@meridian/agent-edit/integration";
import type { DocumentAuthorityId, ModelResponseId } from "@meridian/contracts";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  agentEditWidCounters,
  collabStagedStates,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
} from "@meridian/database";
import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  createCollabYDoc,
  packCollabSchemaVersion,
  unpackCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, asc, desc, eq, gt, gte, lte, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  isInDrizzleTransaction,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { requireAgentWriteGrant } from "../../../shared/edit-confirmation.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import type { CapturedCheckpointCut } from "../domain/checkpoint-cut.js";
import { RetiredDocumentHandleError } from "../domain/document-handle.js";
import type {
  CheckpointAuthority,
  CheckpointJournal,
} from "../domain/ports/checkpoint-authority.js";
import type { DocumentLandingJournal } from "../domain/ports/document-landing-journal.js";
import type { InitialDocumentSeeds } from "../domain/ports/initial-document-seeds.js";
import {
  insertionAttributions,
  materializeCandidateProvenance,
  materializeProvenanceForDoc,
} from "../domain/provenance.js";
import { DocumentSchemaMajorMismatchError, isStaleSchema } from "../domain/stale-schema.js";
import { resolveCheckpointCut } from "./checkpoint-capability.js";
import { captureDrizzleCheckpoint } from "./drizzle-checkpoint-capture.js";
import {
  allocateDocumentAdmission,
  ensureAndReadDocumentAuthorityHead,
  findDocumentAuthorityHead,
} from "./drizzle-document-authority-head.js";
import { captureReceiptRows, recordDocumentEdit } from "./drizzle-document-edits.js";
import { joinAdmissionWithinTx } from "./drizzle-pending-settlement.js";
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
  DocumentLandingJournal & {
    headSchemaVersion(documentId: string): Promise<CollabSchemaVersion | null>;
  };

export type DrizzleCollabPersistence = {
  journal: CollabJournal;
  lifecycle: DocumentLifecycle & InitialDocumentSeeds;
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

function metaFromUpdateRow(row: JournalTransportRow, mode: UpdateMetaMode): UpdateMeta {
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

function mapUpdate(row: JournalTransportRow, mode: UpdateMetaMode = "journal"): PersistedUpdate {
  return {
    seq: row.id,
    update: toBytes(row.updateData),
    meta: metaFromUpdateRow(row, mode),
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

async function readHeadSchemaVersion(
  db: JournalDb,
  documentId: string,
): Promise<CollabSchemaVersion | null> {
  const [row] = await db
    .select({ schemaVersion: documentYjsHeads.schemaVersion })
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, asDocumentId(documentId)))
    .limit(1);
  return row ? unpackCollabSchemaVersion(row.schemaVersion) : null;
}

function assertHeadSchemaCurrent(docId: string, storedVersion: CollabSchemaVersion | null): void {
  if (storedVersion !== null && isStaleSchema(storedVersion, COLLAB_SCHEMA_VERSION)) {
    throw new DocumentSchemaMajorMismatchError(docId, storedVersion, COLLAB_SCHEMA_VERSION);
  }
}

async function assertReadableHead(db: JournalDb, docId: string): Promise<void> {
  assertHeadSchemaCurrent(docId, await readHeadSchemaVersion(db, docId));
}

async function upsertHead(
  db: JournalDb,
  documentId: string,
  input: {
    latestUpdateSeq?: number;
    latestStateVector?: Uint8Array | null;
    latestCheckpointId?: number | null;
  } = {},
): Promise<void> {
  const packedSchemaVersion = packCollabSchemaVersion(COLLAB_SCHEMA_VERSION);
  await db
    .insert(documentYjsHeads)
    .values({
      documentId: asDocumentId(documentId),
      schemaVersion: packedSchemaVersion,
      latestUpdateSeq: input.latestUpdateSeq ?? 0,
      latestStateVector: input.latestStateVector ? toBuffer(input.latestStateVector) : null,
      latestCheckpointId: input.latestCheckpointId ?? null,
    })
    .onConflictDoUpdate({
      target: documentYjsHeads.documentId,
      set: {
        // Heads advance schema_version monotonically so a downgraded server cannot
        // erase the stale-schema fence by stamping an older COLLAB_SCHEMA_VERSION.
        schemaVersion: sql`greatest(${documentYjsHeads.schemaVersion}, ${packedSchemaVersion})`,
        ...(input.latestUpdateSeq !== undefined ? { latestUpdateSeq: input.latestUpdateSeq } : {}),
        ...(input.latestStateVector !== undefined
          ? {
              latestStateVector: input.latestStateVector ? toBuffer(input.latestStateVector) : null,
            }
          : {}),
        ...(input.latestCheckpointId !== undefined
          ? { latestCheckpointId: input.latestCheckpointId }
          : {}),
        updatedAt: sql`now()`,
      },
    });
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

  await upsertHead(db, documentId, {
    latestUpdateSeq: upToSeq,
    latestStateVector: toBytes(row.stateVector),
    latestCheckpointId: row.id,
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

async function appendUpdate(
  db: JournalDb,
  documentId: string,
  update: Uint8Array,
  meta: UpdateMeta,
  authority?: { authorityId: string; generation: bigint },
): Promise<{ seq: number; joinedSettlement: boolean }> {
  const origin = parseOrigin(meta);
  await validateAppendAuthority(db, documentId, authority);
  const receiptState =
    origin.originType === "human"
      ? encodeJournalSnapshot(await createDrizzleJournal(db).read(documentId))
      : undefined;
  const authorityHead = await allocateDocumentAdmission(db, documentId);
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
  if (receiptState) {
    const doc = createCollabYDoc({ gc: false });
    let receipts: import("./drizzle-document-edits.js").ReceiptWrite["receipts"];
    try {
      Y.applyUpdate(doc, receiptState);
      receipts = captureReceiptRows(doc, [{ update, origin: { kind: "live", seq: row.id } }]);
    } finally {
      doc.destroy();
    }
    await recordDocumentEdit(db, {
      documentId: asDocumentId(documentId),
      actor: "human",
      actorUserId: origin.actorUserId,
      receipts,
    });
  }
  // Every admitted content mutation invalidates an unresolved settlement cut.
  const joinedSettlement =
    (await joinAdmissionWithinTx(db, {
      documentId: asDocumentId(documentId),
      source: { kind: "journal", id: String(row.id) },
      update,
    })) > 0;
  return { seq: row.id, joinedSettlement };
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
  const journal: CollabJournal = {
    async admitDocumentLanding(docId, onlySeed, prepare) {
      return runInDrizzleTransaction(db as Database, async () => {
        const tx = await enterJournalSeam(db, [docId], []);
        const [head] = await tx
          .select({
            next: documentYjsHeads.nextAdmissionSequence,
            generation: documentYjsHeads.authorityGeneration,
          })
          .from(documentYjsHeads)
          .where(eq(documentYjsHeads.documentId, asDocumentId(docId)));
        // Admission sequences restart on restore. A replaced authority can never
        // prove pristine-since-initial-seed, even when its restored text is empty.
        if (onlySeed && head && (head.next !== 1n || head.generation !== 1n)) return null;
        const prepared = await prepare(await journal.read(docId));
        const { seq } = await appendUpdate(tx, docId, prepared.update, prepared.meta);
        return { seq, update: prepared.update, meta: { ...prepared.meta, seq } };
      });
    },
    headSchemaVersion: (documentId) => readHeadSchemaVersion(db, documentId),

    async append(docId, update, meta, authority) {
      return runInDrizzleTransaction(db as Database, async () => {
        const txDb = await enterJournalSeam(db, [docId], agentAuthored(meta) ? [docId] : []);
        return (await appendUpdate(txDb, docId, update, meta, authority)).seq;
      });
    },

    async appendWriterUpdate(docId, update, meta, authority) {
      return runInDrizzleTransaction(db as Database, async () => {
        // A live room binds its edit grant around each frame (file-access §7).
        const txDb = await enterJournalSeam(db, [docId], []);
        return appendUpdate(txDb, docId, update, meta, authority);
      });
    },

    async appendBatch(entries) {
      if (entries.length === 0) return [];
      // Inside a reply's save the rows join its one transaction (D42) and stay
      // staged until it commits; otherwise this call owns a durable transaction.
      const journalCommitKind = isInDrizzleTransaction() ? "staged" : "durable";
      return runInDrizzleTransaction(db as Database, async () => {
        const txDb = await enterJournalSeam(
          db,
          entries.map((entry) => entry.docId),
          entries.filter((entry) => agentAuthored(entry.meta)).map((entry) => entry.docId),
        );
        for (const entry of entries)
          await validateAppendAuthority(txDb, entry.docId, entry.authority);
        const admissions = new Map<string, Awaited<ReturnType<typeof allocateDocumentAdmission>>>();
        for (const docId of uniqueSortedDocIds(entries.map((entry) => entry.docId))) {
          admissions.set(docId, await allocateDocumentAdmission(txDb, docId));
        }
        const receiptStates = new Map<string, Uint8Array>();
        for (const docId of uniqueSortedDocIds(
          entries.filter((e) => e.mutation).map((e) => e.docId),
        ))
          receiptStates.set(docId, encodeJournalSnapshot(await this.read(docId)));
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
        for (const [index, entry] of entries.entries()) {
          const updateRow = updateRows[index];
          if (!updateRow) throw new Error("Missing inserted journal row for settlement join");
          await joinAdmissionWithinTx(txDb, {
            documentId: asDocumentId(entry.docId),
            source: { kind: "journal", id: String(updateRow.id) },
            update: entry.update,
          });
        }

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
          receiptStates,
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
          journalCommitKind,
          ...(ordinals.has(index) ? { wId: ordinals.get(index) } : {}),
        }));
      });
    },

    async materializeDestructiveProvenance(input) {
      const readDb = currentDrizzleDb(db as Database) as JournalDb;
      const authorityHead = await ensureAndReadDocumentAuthorityHead(readDb, input.docId);
      const rows = await readDb
        .select({
          authorityId: documentYjsUpdates.authorityId,
          generation: documentYjsUpdates.authorityGeneration,
          admissionSequence: documentYjsUpdates.admissionSequence,
          batchOrdinal: documentYjsUpdates.batchOrdinal,
          journalRowId: documentYjsUpdates.id,
          originType: documentYjsUpdates.originType,
          actorUserId: documentYjsUpdates.actorUserId,
          update: documentYjsUpdates.updateData,
        })
        .from(documentYjsUpdates)
        .where(
          and(
            eq(documentYjsUpdates.documentId, asDocumentId(input.docId)),
            eq(documentYjsUpdates.authorityId, authorityHead.authorityId),
            eq(documentYjsUpdates.authorityGeneration, authorityHead.generation),
          ),
        )
        .orderBy(
          documentYjsUpdates.admissionSequence,
          documentYjsUpdates.batchOrdinal,
          documentYjsUpdates.id,
        );
      const [checkpoint] = await readDb
        .select({
          id: documentYjsCheckpoints.id,
          authorityId: documentYjsCheckpoints.authorityId,
          generation: documentYjsCheckpoints.authorityGeneration,
          attributionManifest: documentYjsCheckpoints.attributionManifest,
        })
        .from(documentYjsCheckpoints)
        .where(
          and(
            eq(documentYjsCheckpoints.documentId, asDocumentId(input.docId)),
            eq(documentYjsCheckpoints.authorityId, authorityHead.authorityId),
            eq(documentYjsCheckpoints.authorityGeneration, authorityHead.generation),
          ),
        )
        .orderBy(desc(documentYjsCheckpoints.upToSeq), desc(documentYjsCheckpoints.id))
        .limit(1);
      const retainedAttributions = checkpoint
        ? parseAttributionManifest(checkpoint.attributionManifest, {
            authorityId: checkpoint.authorityId,
            generation: checkpoint.generation,
            checkpointId: String(checkpoint.id),
          }).attributions
        : [];
      const before = materializeProvenanceForDoc({
        doc: unwrapDoc(input.before),
        rows: rows.map((row) => ({
          ...row,
          journalRowId: BigInt(row.journalRowId),
          update: new Uint8Array(row.update),
        })),
        retainedAttributions,
        fallbackBirthClass: input.fallbackProvenance ?? "writer_protected",
      });
      const afterCandidate = materializeCandidateProvenance(
        unwrapDoc(input.afterCandidate),
        before,
      );
      return {
        before: before.map((run) => ({
          target: run.target,
          root: run.root,
          provenance: run.birthClass,
        })),
        afterCandidate: afterCandidate.map((run) => ({
          target: run.target,
          root: run.root,
          provenance: run.birthClass,
        })),
      };
    },

    async reserveWriteOrdinal(documentId, threadId) {
      return reserveWriteOrdinal(db, { documentId, threadId });
    },

    async read(docId, opts: JournalReadOptions = {}): Promise<JournalSnapshot> {
      const readDb = currentDrizzleDb(db as Database) as JournalDb;
      await assertReadableHead(readDb, docId);

      // Capture once: neither a checkpoint nor retained history may choose
      // authority for this read. Sequence bounds stay within this generation.
      const authorityHead = await findDocumentAuthorityHead(readDb, docId);
      if (!authorityHead) return { checkpoint: null, updates: [] };
      const checkpointBound =
        opts.since === undefined
          ? opts.until
          : Math.min(opts.until ?? Number.MAX_SAFE_INTEGER, opts.since - 1);
      const checkpoint = await latestCheckpoint(readDb, docId, authorityHead, checkpointBound);
      const conditions = [
        eq(documentYjsUpdates.documentId, asDocumentId(docId)),
        eq(documentYjsUpdates.authorityId, authorityHead.authorityId),
        eq(documentYjsUpdates.authorityGeneration, authorityHead.generation),
        gt(documentYjsUpdates.id, checkpoint?.upToSeq ?? 0),
      ];
      if (opts.since !== undefined) conditions.push(gte(documentYjsUpdates.id, opts.since));
      if (opts.until !== undefined) conditions.push(lte(documentYjsUpdates.id, opts.until));

      const rows = await readDb
        .select(journalTransportColumns)
        .from(documentYjsUpdates)
        .where(and(...conditions))
        .orderBy(asc(documentYjsUpdates.id));

      return {
        authority: { authorityId: authorityHead.authorityId, generation: authorityHead.generation },
        checkpoint: checkpoint ? toBytes(checkpoint.state) : null,
        updates: rows.map((row) => mapUpdate(row)),
        persistenceWatermark: Math.max(checkpoint?.upToSeq ?? 0, rows.at(-1)?.id ?? 0),
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
        const current = await findDocumentAuthorityHead(txDb, docId);
        if (
          !current ||
          current.authorityId !== captured.authorityId ||
          current.generation !== captured.generation
        )
          return;
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
        const authorityHead = await ensureAndReadDocumentAuthorityHead(txDb, docId);
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
          // Publish every retired prefix, even when an ordinary checkpoint
          // already covers it and this compaction folds no new rows.
          await txDb
            .update(documentYjsHeads)
            .set({
              retiredThroughSeq: sql`greatest(${documentYjsHeads.retiredThroughSeq}, ${compactedThroughSeq})`,
            })
            .where(eq(documentYjsHeads.documentId, asDocumentId(docId)));

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
  return journal;
}

export function createServerDocumentLifecycle(
  db: JournalDb,
  journal: UpdateJournal,
): DocumentLifecycle & InitialDocumentSeeds {
  return {
    async stageInitialStates(stagingId, projectId, generation, seeds) {
      if (seeds.length === 0) return;
      await currentDrizzleDb(db as Database)
        .insert(collabStagedStates)
        .values(
          seeds.map((seed) => ({
            ...seed,
            stagingId,
            projectId,
            generation,
            state: toBuffer(seed.state),
            stateVector: toBuffer(seed.stateVector),
          })),
        );
    },
    async commitStagedStates(stagingId) {
      const tx = currentDrizzleDb(db as Database);
      // These identities have never been live. Never adopt another authority head.
      await tx.execute(sql`
        insert into document_yjs_heads (document_id, schema_version)
        select document_id, ${packCollabSchemaVersion(COLLAB_SCHEMA_VERSION)}
        from collab_staged_states where staging_id = ${stagingId}`);
      await tx.execute(sql`
        insert into document_yjs_checkpoints
          (document_id, authority_id, authority_generation, state, state_vector, attribution_manifest, up_to_seq, reason)
        select s.document_id, h.authority_id, h.authority_generation,
          s.state, s.state_vector, s.attribution_manifest, 0, 'seed'
        from collab_staged_states s join document_yjs_heads h on h.document_id = s.document_id
        where s.staging_id = ${stagingId}`);
      await tx.execute(sql`
        update document_yjs_heads h set latest_checkpoint_id = c.id,
          latest_state_vector = c.state_vector, latest_update_seq = 0, updated_at = now()
        from document_yjs_checkpoints c, collab_staged_states s
        where s.staging_id = ${stagingId} and c.document_id = s.document_id
          and h.document_id = s.document_id and c.up_to_seq = 0
          and c.authority_id = h.authority_id and c.authority_generation = h.authority_generation`);
      return tx
        .delete(collabStagedStates)
        .where(eq(collabStagedStates.stagingId, stagingId))
        .returning({
          documentId: collabStagedStates.documentId,
          markdown: collabStagedStates.markdown,
        });
    },
    async discardStagedStates(stagingId, limit) {
      const tx = currentDrizzleDb(db as Database);
      await tx.execute(sql`delete from collab_staged_states where staging_id = ${stagingId}
        and document_id in (select document_id from collab_staged_states where staging_id = ${stagingId} order by document_id ${limit === undefined ? sql`` : sql`limit ${limit}`})`);
      const [row] = await tx
        .select({ id: collabStagedStates.documentId })
        .from(collabStagedStates)
        .where(eq(collabStagedStates.stagingId, stagingId))
        .limit(1);
      return { remaining: !!row };
    },
    async seedInitialDocument(docId, state) {
      return runInDrizzleTransaction(db as Database, async () => {
        const txDb = currentDrizzleDb(db as Database) as JournalDb;
        await lockDocumentMutation(txDb, docId);
        await assertReadableHead(txDb, docId);
        await upsertHead(txDb, docId);
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
        await insertCheckpoint(
          txDb,
          docId,
          state,
          0,
          "seed",
          await ensureAndReadDocumentAuthorityHead(txDb, docId),
        );
        return true;
      });
    },
    async ensureDocument(docId) {
      const lifecycleDb = currentDrizzleDb(db as Database) as JournalDb;
      // Never stamp a head before verifying the stored head is not stale.
      await assertReadableHead(lifecycleDb, docId);
      const snapshot = await journal.read(docId);
      // Existing authority is already initialized. Do not retain a head-row
      // update lock in an ambient context command before its root journal batch.
      if (snapshot.checkpoint || snapshot.updates.length > 0) return;
      await upsertHead(lifecycleDb, docId);

      // The Yjs tables FK to documents.id; callers must create the documents row first.
      await runInDrizzleTransaction(db as Database, async () => {
        const txDb = currentDrizzleDb(db as Database) as JournalDb;
        await lockDocumentMutation(txDb, docId);
        const authority = await ensureAndReadDocumentAuthorityHead(txDb, docId);
        const cut = await createDrizzleJournal(txDb).captureCheckpoint(docId, authority);
        if (cut) await createDrizzleJournal(txDb).storeCheckpoint(cut);
      });
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
        const current = await findDocumentAuthorityHead(tx, docId);
        if (
          !current ||
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
    lifecycle: createServerDocumentLifecycle(db, journal),
    store: createDrizzleCollabFacadeStore(db),
  };
}

function encodeJournalSnapshot(snapshot: JournalSnapshot): Uint8Array {
  const doc = createCollabYDoc({ gc: false });
  try {
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
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
