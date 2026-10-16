/**
 * One content member of a settlement batch, at the member boundary: staging its cut,
 * admitting its merge to the live journal as one reconcile row with derivation and head, and
 * withdrawing it. A content member moves no draft journal rows. Every function takes the caller's
 * transaction explicitly; the batch owner (`drizzle-pending-settlement.ts`) holds the locks and
 * orders the members.
 */
import type { DraftBaseRevision } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branchPushOutboxUpdates,
  branchPushSettlementOutbox,
  documentYjsHeads,
  documentYjsUpdates,
  pushLineage,
} from "@meridian/database/schema";
import {
  COLLAB_SCHEMA_VERSION,
  createCollabYDoc,
  packCollabSchemaVersion,
} from "@meridian/prosemirror-schema";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { draftBranchWorks } from "../../../shared/work-draft-lifecycle.js";
import type { NoticePort } from "../../notices/index.js";
import type {
  PendingLiveSettlement,
  PreparedPushCommit,
  PushLineageRow,
} from "../domain/branch-push-contracts.js";
import { deriveDocument } from "../domain/document-derivations.js";
import { parseContentMemberInput } from "../domain/draft-apply.js";
import { parseDurableTrailSeedV1 } from "../domain/ports/change-trail-persistence.js";
import type { DocumentDerivationStore } from "../domain/ports/document-derivations.js";
import type { DocumentProjectionEffects } from "../domain/ports/document-projection-effects.js";
import type { DurableProjectionSerializer } from "../domain/ports/durable-projection.js";
import type { SettlementCut } from "../domain/ports/pending-settlement-store.js";
import { loadDocumentState } from "./document-loader.js";
import { allocateDocumentAdmission } from "./drizzle-document-authority-head.js";
import { createDrizzleJournal } from "./drizzle-journal.js";
import { joinAdmissionWithinTx } from "./drizzle-settlement-admission.js";

/** A member row and its push, read once under the batch's locks. */
export type LockedSettlementMember = {
  outbox: typeof branchPushSettlementOutbox.$inferSelect;
  push: typeof pushLineage.$inferSelect;
};

export type MemberAdmissionDeps = {
  durableProjectionSerializer: DurableProjectionSerializer;
  projectionEffects: DocumentProjectionEffects;
  derivationStore: DocumentDerivationStore;
};

/** Every member of a batch with its push, in document order (the global lock order). */
export async function readSettlementMembers(
  db: DrizzleDb,
  batchId: string,
): Promise<LockedSettlementMember[]> {
  return db
    .select({ outbox: branchPushSettlementOutbox, push: pushLineage })
    .from(branchPushSettlementOutbox)
    .innerJoin(pushLineage, eq(pushLineage.id, branchPushSettlementOutbox.pushId))
    .where(eq(branchPushSettlementOutbox.batchId, batchId))
    .orderBy(asc(branchPushSettlementOutbox.documentId));
}

/** Stages one push: its cut, update and trail seed, and the durable reconcile since the cut. */
export async function stageSettlementMemberWithinTx(
  db: DrizzleDb,
  batchId: string,
  prepared: PreparedPushCommit,
  push: PushLineageRow,
): Promise<void> {
  const durablePrePush = await materializeDurableDocumentBefore(
    db,
    prepared.branch.documentId,
    push.upstreamUpdateSeq ?? Number.MAX_SAFE_INTEGER,
  );
  const cut = createCollabYDoc({ gc: false });
  Y.applyUpdate(cut, prepared.lockCutUpdate);
  const initialReconcile = Y.encodeStateAsUpdate(durablePrePush, Y.encodeStateVector(cut));
  const decodedReconcile = Y.decodeUpdate(initialReconcile);
  durablePrePush.destroy();
  cut.destroy();
  const reconciles = decodedReconcile.structs.length > 0 || decodedReconcile.ds.clients.size > 0;
  await db.insert(branchPushSettlementOutbox).values({
    pushId: push.id,
    batchId,
    documentId: push.documentId,
    documentTitle: prepared.documentTitle,
    lockCutUpdate: Buffer.from(prepared.lockCutUpdate),
    pushUpdate: Buffer.from(prepared.pushUpdate),
    trailSeed: parseDurableTrailSeedV1(prepared.trail),
    ...(reconciles ? { joinVersion: 1, classifiedJoinVersion: 1 } : {}),
  });
  if (reconciles) {
    await db.insert(branchPushOutboxUpdates).values({
      pushId: push.id,
      ordinal: 0,
      sourceKind: "initial_reconcile",
      sourceId: push.id,
      update: Buffer.from(initialReconcile),
    });
  }
}

/**
 * Takes members that never reached live out of the batch, inside the caller's transaction: their
 * unconsumed notices are retracted and their lineage is deleted (the outbox member and its joins
 * cascade), so the idempotency key never answers "already pushed" for an Apply that didn't
 * happen. The draft keeps every change it had, so there is nothing to put back. The caller
 * retires their trail contribution.
 */
export async function withdrawSettlementMembersWithinTx(
  db: DrizzleDb,
  pushes: readonly Pick<PushLineageRow, "id">[],
  notices?: NoticePort,
): Promise<void> {
  if (pushes.length === 0) return;
  await notices?.retractForPushes(pushes.map((push) => String(push.id)));
  await db.delete(pushLineage).where(
    inArray(
      pushLineage.id,
      pushes.map((push) => push.id),
    ),
  );
}

/** Each member's lock cut and post-cut joins, read inside the completion transaction. */
export async function readSettlementCuts(
  db: DrizzleDb,
  members: readonly LockedSettlementMember[],
): Promise<SettlementCut[]> {
  const rows = members.map(({ outbox }) => outbox);
  const updates =
    rows.length > 0
      ? await db
          .select({
            pushId: branchPushOutboxUpdates.pushId,
            update: branchPushOutboxUpdates.update,
          })
          .from(branchPushOutboxUpdates)
          .where(
            inArray(
              branchPushOutboxUpdates.pushId,
              rows.map((row) => row.pushId),
            ),
          )
          .orderBy(branchPushOutboxUpdates.pushId, branchPushOutboxUpdates.ordinal)
      : [];
  return rows.map((row) => ({
    pushId: row.pushId,
    documentId: row.documentId as DocumentId,
    lockCutUpdate: row.lockCutUpdate,
    postCutUpdates: updates
      .filter(({ pushId }) => pushId === row.pushId)
      .map(({ update }) => update),
    pushUpdate: row.pushUpdate,
  }));
}

/**
 * Makes one locked member effective inside its batch's completion transaction:
 * the branch's authored rows and one reconcile row in the live journal, their
 * attribution, the certified derivation, the head, and joins into other batches.
 */
export async function admitSettlementMemberWithinTx(
  db: DrizzleDb,
  staged: LockedSettlementMember,
  deps: MemberAdmissionDeps,
): Promise<DraftBaseRevision> {
  const pushId = staged.push.id;
  const documentId = staged.outbox.documentId as DocumentId;

  const authority = await allocateDocumentAdmission(db, documentId);
  const [canonicalRow] = await db
    .insert(documentYjsUpdates)
    .values({
      documentId,
      authorityId: authority.authorityId,
      authorityGeneration: authority.generation,
      admissionSequence: authority.admissionSequence,
      batchOrdinal: 0,
      updateData: staged.outbox.pushUpdate,
      // The merge is the push: one reconcile row, the same shape a pull of live records.
      originType: "reconcile",
      actorUserId: null,
      actorTurnId: null,
    })
    .returning({ id: documentYjsUpdates.id });
  if (!canonicalRow) throw new Error(`Failed to complete staged push ${pushId}`);
  const [updated] = await db
    .update(pushLineage)
    .set({ upstreamUpdateSeq: canonicalRow.id })
    .where(and(eq(pushLineage.id, pushId), isNull(pushLineage.upstreamUpdateSeq)))
    .returning({ id: pushLineage.id });
  if (!updated) throw new Error(`Staged push ${pushId} was completed concurrently`);

  const [branchWork] = staged.push.branchId
    ? await draftBranchWorks(db, [staged.push.branchId])
    : [];
  const derivation = await deriveDocument(
    {
      store: deps.derivationStore,
      serializer: deps.durableProjectionSerializer,
    },
    documentId,
  );
  // Completion already owns the mutation transaction: a stale cut is not an
  // expected scheduling deferral here and must not certify push completion.
  if (derivation.status !== "derived")
    throw new Error(`Uncertified durable document for push ${pushId}: ${derivation.status}`);
  const { stateVector } = derivation;
  await upsertHead(db, documentId, canonicalRow.id, stateVector);
  await deps.projectionEffects.applyPushCompletion({
    documentId,
    ...(branchWork?.workId ? { workId: branchWork.workId } : {}),
    at: new Date(),
  });

  await joinAdmissionWithinTx(db, {
    documentId,
    source: { kind: "staged_push", id: String(canonicalRow.id) },
    update: staged.outbox.pushUpdate,
    excludePushId: String(pushId),
  });
  return {
    authorityId: authority.authorityId,
    authorityGeneration: authority.generation.toString(),
    seq: canonicalRow.id,
  };
}

async function upsertHead(
  db: DrizzleDb,
  documentId: DocumentId,
  latestUpdateSeq: number,
  latestStateVector: Uint8Array,
): Promise<void> {
  const packedSchemaVersion = packCollabSchemaVersion(COLLAB_SCHEMA_VERSION);
  await db
    .insert(documentYjsHeads)
    .values({
      documentId,
      schemaVersion: packedSchemaVersion,
      latestUpdateSeq,
      latestStateVector: Buffer.from(latestStateVector),
      latestCheckpointId: null,
    })
    .onConflictDoUpdate({
      target: documentYjsHeads.documentId,
      set: {
        schemaVersion: sql`greatest(${documentYjsHeads.schemaVersion}, ${packedSchemaVersion})`,
        latestUpdateSeq,
        latestStateVector: Buffer.from(latestStateVector),
        updatedAt: sql`now()`,
      },
    });
}

export function mapLineage(row: typeof pushLineage.$inferSelect): PushLineageRow {
  return {
    id: row.id,
    branchId: row.branchId,
    documentId: row.documentId,
    journalIds: row.journalIds,
    upstreamUpdateSeq: row.upstreamUpdateSeq,
    idempotencyKey: row.idempotencyKey,
    receiptId: row.receiptId,
    threadId: row.threadId,
    turnId: row.turnId,
    input: row.applyPayload ? parseContentMemberInput(row.applyPayload) : null,
  };
}

/** A member as the settlement loop reads it: its push, cut, joins and staged trail. */
export async function readSettlementMember(
  db: DrizzleDb,
  row: {
    outbox: typeof branchPushSettlementOutbox.$inferSelect;
    push: typeof pushLineage.$inferSelect;
  },
): Promise<PendingLiveSettlement> {
  const trail = parseDurableTrailSeedV1(row.outbox.trailSeed);
  const updates = await db
    .select({ update: branchPushOutboxUpdates.update })
    .from(branchPushOutboxUpdates)
    .where(eq(branchPushOutboxUpdates.pushId, row.outbox.pushId))
    .orderBy(branchPushOutboxUpdates.ordinal);
  return {
    push: mapLineage(row.push),
    documentTitle: row.outbox.documentTitle,
    lockCutUpdate: row.outbox.lockCutUpdate,
    pushUpdate: row.outbox.pushUpdate,
    postCutUpdates: updates.map(({ update }) => update),
    trail,
    joinVersion: row.outbox.joinVersion,
  };
}

async function materializeDurableDocumentBefore(
  db: DrizzleDb,
  documentId: DocumentId,
  beforeUpdateSeq: number,
): Promise<Y.Doc> {
  const journal = createDrizzleJournal(db as Database);
  // Journal bounds are inclusive; settlement must exclude its own push update.
  const snapshot = await journal.read(documentId, { until: beforeUpdateSeq - 1 });
  const state = await loadDocumentState(journal, documentId, undefined, snapshot);
  const doc = createCollabYDoc({ gc: false });
  if (state) Y.applyUpdate(doc, state);
  return doc;
}
