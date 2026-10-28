/** Journal-locked cuts and compare-and-set writes of document derived outputs. */
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branches,
  contextSources,
  documentBlockRooms,
  documentBlocks,
  documentDrafts,
  documentLinks,
  documents,
  documentYjsHeads,
  projects,
  works,
} from "@meridian/database";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  not,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  type DrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type { DocumentLastAddress } from "../../context/document-uri-resolver.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { documentHash } from "../domain/document-derivations.js";
import {
  type DerivationScope,
  DOCUMENT_EXTRACTOR_VERSION,
  type DocumentDerivationCut,
  type DocumentDerivationOutputs,
  type DocumentDerivationStore,
} from "../domain/ports/document-derivations.js";
import { loadDocumentState } from "./document-loader.js";
import { createDrizzleJournal } from "./drizzle-journal.js";

/** Caller owns the document mutation lock for this transaction. */
export async function captureDocumentDerivation(
  tx: DrizzleDb,
  documentId: DocumentId,
  lastAddress: DocumentLastAddress,
): Promise<DocumentDerivationCut | null> {
  const [row] = await tx
    .select({
      generation: documentYjsHeads.authorityGeneration,
      admissionSequence: documentYjsHeads.nextAdmissionSequence,
      locationVersion: documents.locationVersion,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .innerJoin(documentYjsHeads, eq(documents.id, documentYjsHeads.documentId))
    .where(eq(documents.id, documentId))
    .limit(1);
  // An already-staged push must still settle after a soft deletion.
  if (!row) return null;
  // Never certify a warm room: writer admission precedes its in-memory apply.
  const state = await loadDocumentState(createDrizzleJournal(tx as Database), documentId);
  if (!state) return null;
  const address = await lastAddress(documentId);
  if (!row.deletedAt && !address)
    throw new Error(`Missing canonical URI for live document ${documentId}`);
  // Under the deleted-ancestor rule a document in a deleted folder or Work holds no address.
  const holderUri = address && !address.deleted ? address.uri : null;
  return {
    documentId,
    holderUri,
    state,
    watermark: {
      generation: row.generation,
      admissionSequence: row.admissionSequence,
      locationVersion: row.locationVersion,
      extractorVersion: DOCUMENT_EXTRACTOR_VERSION,
    },
  };
}

/** Rows per statement: bounded by the driver's parameter limit. */
const WRITE_CHUNK = 1000;

const EMPTY_DOCUMENT_HASH = documentHash([], []);

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += WRITE_CHUNK) out.push(rows.slice(at, at + WRITE_CHUNK));
  return out;
}

/**
 * Caller owns the document mutation lock for this transaction. The outputs arrive already
 * normalized and hashed: nothing here reads block text back, and the block diff writes only the
 * blocks whose content hash changed.
 */
export async function certifyDocumentDerivation(
  tx: DrizzleDb,
  cut: DocumentDerivationCut,
  outputs: DocumentDerivationOutputs,
  at: Date,
): Promise<boolean> {
  const w = cut.watermark;
  const [head] = await tx
    .select()
    .from(documentYjsHeads)
    .where(eq(documentYjsHeads.documentId, cut.documentId))
    .limit(1);
  if (
    !head ||
    head.authorityGeneration !== w.generation ||
    head.nextAdmissionSequence !== w.admissionSequence
  )
    return false;
  const [location] = await tx
    .select({ version: documents.locationVersion })
    .from(documents)
    .where(eq(documents.id, cut.documentId))
    .for("no key update");
  if (!location || location.version !== w.locationVersion) return false;
  const [room] = await tx
    .select()
    .from(documentBlockRooms)
    .where(eq(documentBlockRooms.documentId, cut.documentId))
    .limit(1);
  if (room && room.extractorVersion > w.extractorVersion) return false;
  if (
    room &&
    room.cutGeneration === w.generation &&
    room.cutAdmissionSeq === w.admissionSequence &&
    room.cutLocationVersion === w.locationVersion &&
    room.extractorVersion === w.extractorVersion
  )
    return true;
  const [source] = await tx
    .select({
      projectId: sql<ProjectId | null>`coalesce(${contextSources.projectId}, ${works.projectId})`,
    })
    .from(documents)
    .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
    .leftJoin(works, eq(works.id, contextSources.workId))
    .where(eq(documents.id, cut.documentId))
    .limit(1);
  const projectId = source?.projectId;
  if (!projectId) throw new Error(`Document ${cut.documentId} has no project`);

  // A re-derivation that changed no content (an extractor bump, a move) is not an edit:
  // `ls` shows `updatedAt` to the model and the writer.
  const edited = !(room?.documentHash ?? EMPTY_DOCUMENT_HASH).equals(outputs.documentHash);
  const [updated] = await tx
    .update(documents)
    .set({
      sizeBytes: outputs.documentBytes,
      ...(edited ? { updatedAt: at } : {}),
    })
    .where(and(eq(documents.id, cut.documentId), eq(documents.locationVersion, w.locationVersion)))
    .returning({ id: documents.id });
  if (!updated) return false;

  const blockOrder = outputs.blocks.map((block) => block.id);
  const roomValues = {
    projectId,
    wordCount: outputs.wordCount,
    documentBytes: BigInt(outputs.documentBytes),
    documentHash: outputs.documentHash,
    cutGeneration: w.generation,
    cutAdmissionSeq: w.admissionSequence,
    cutLocationVersion: w.locationVersion,
    extractorVersion: w.extractorVersion,
    derivedAt: at,
  };
  let roomId: number;
  if (room) {
    roomId = room.roomId;
    // The order array is rewritten only when the order moved: an edit inside a block leaves it.
    const orderMoved =
      room.blockOrder.length !== blockOrder.length ||
      room.blockOrder.some((id, index) => id !== blockOrder[index]);
    await tx
      .update(documentBlockRooms)
      .set({ ...roomValues, ...(orderMoved ? { blockOrder } : {}) })
      .where(eq(documentBlockRooms.roomId, roomId));
  } else {
    const [created] = await tx
      .insert(documentBlockRooms)
      .values({ documentId: cut.documentId, blockOrder, ...roomValues })
      .returning({ roomId: documentBlockRooms.roomId });
    roomId = (created as { roomId: number }).roomId;
  }

  const stored = new Map(
    (room
      ? await tx
          .select({ blockId: documentBlocks.blockId, contentHash: documentBlocks.contentHash })
          .from(documentBlocks)
          .where(eq(documentBlocks.roomId, roomId))
      : []
    ).map((row) => [row.blockId, row.contentHash]),
  );
  if (room && room.projectId !== projectId)
    await tx.update(documentBlocks).set({ projectId }).where(eq(documentBlocks.roomId, roomId));
  const kept = new Set(blockOrder);
  const removed = [...stored.keys()].filter((id) => !kept.has(id));
  for (const ids of chunks(removed))
    await tx
      .delete(documentBlocks)
      .where(and(eq(documentBlocks.roomId, roomId), inArray(documentBlocks.blockId, ids)));
  const written = outputs.blocks.filter(
    (block) => !stored.get(block.id)?.equals(block.contentHash),
  );
  for (const rows of chunks(written))
    await tx
      .insert(documentBlocks)
      .values(
        rows.map((block) => ({
          roomId,
          blockId: block.id,
          projectId,
          text: block.text,
          contentHash: block.contentHash,
          wordCount: block.wordCount,
        })),
      )
      .onConflictDoUpdate({
        target: [documentBlocks.roomId, documentBlocks.blockId],
        set: {
          text: sql`excluded.text`,
          contentHash: sql`excluded.content_hash`,
          wordCount: sql`excluded.word_count`,
        },
      });

  await tx.delete(documentLinks).where(eq(documentLinks.sourceDocumentId, cut.documentId));
  if (outputs.links.length)
    await tx
      .insert(documentLinks)
      .values(outputs.links.map((row) => ({ ...row, sourceDocumentId: cut.documentId })));
  return true;
}

/** Registry recovery the derive step drives; the collab domain never imports the registry. */
export type AheadRegistrationRecovery = {
  registerUnregistered(
    scope: { documentId: DocumentId } | DerivationScope | undefined,
    page: { after?: string; limit: number },
  ): Promise<{ registered: number; next: string | null }>;
};

const AHEAD_RECOVERY_PAGE = 100;

/**
 * The derived outputs are behind the document: never derived, or the room's cut differs from
 * the document's head, location or the extractor version. Needs `documentBlockRooms`
 * left-joined to `documents` and `documentYjsHeads`.
 */
const staleDerivation = or(
  isNull(documentBlockRooms.roomId),
  ne(documentBlockRooms.cutGeneration, documentYjsHeads.authorityGeneration),
  ne(documentBlockRooms.cutAdmissionSeq, documentYjsHeads.nextAdmissionSequence),
  ne(documentBlockRooms.cutLocationVersion, documents.locationVersion),
  ne(documentBlockRooms.extractorVersion, DOCUMENT_EXTRACTOR_VERSION),
) as SQL;

export function createDrizzleDocumentDerivationStore(
  db: Database,
  lastAddress: DocumentLastAddress,
  aheads?: { registry: AheadRegistrationRecovery; eventSink?: EventSink },
): DocumentDerivationStore {
  const page = async (
    scope: Parameters<AheadRegistrationRecovery["registerUnregistered"]>[0],
    after: string | undefined,
  ): Promise<{ registered: number; next: string | null }> => {
    if (!aheads) return { registered: 0, next: null };
    try {
      return await aheads.registry.registerUnregistered(scope, {
        after,
        limit: AHEAD_RECOVERY_PAGE,
      });
    } catch (cause) {
      if (aheads.eventSink)
        emitEvent(aheads.eventSink, {
          level: "warn",
          source: "collab.document_derivation",
          name: "ahead_registration.failed",
          payload: unknownToEventPayload(cause),
        });
      return { registered: 0, next: null };
    }
  };
  /** Every page in scope; each page starts after the last key attempted, so it terminates. */
  const drain = async (scope: Parameters<typeof page>[0]) => {
    let registered = 0;
    let after: string | undefined;
    do {
      const progress = await page(scope, after);
      registered += progress.registered;
      after = progress.next ?? undefined;
    } while (after);
    return registered;
  };
  return {
    async registerAheads(documentId) {
      const register = async () => {
        await drain({ documentId });
      };
      // Inside create or push completion the rows are not committed yet; registration takes
      // namespace keys in its own root transaction, so it waits for this commit (§6.1, O6).
      if (!deferUntilDrizzleCommit(register)) await register();
    },
    drainAheads: (scope) => drain(scope),
    recoverAheads: (after) => page(undefined, after),
    capture(documentId) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        await lockDocumentMutation(tx, documentId);
        return captureDocumentDerivation(tx, documentId, lastAddress);
      });
    },
    certify(cut, outputs, at) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        await lockDocumentMutation(tx, cut.documentId);
        return certifyDocumentDerivation(tx, cut, outputs, at);
      });
    },
    async grepTexts(ids, { draftWorkId }) {
      if (!ids.length) return new Map();
      // The watermark and the text come from one snapshot: one statement.
      const rows = await currentDrizzleDb(db)
        .select({
          id: documentBlockRooms.documentId,
          text: sql<string>`coalesce((
            select string_agg(${documentBlocks.text}, E'\n' order by o.position)
            from unnest(${documentBlockRooms.blockOrder}) with ordinality as o(block_id, position)
            join ${documentBlocks} on ${documentBlocks.roomId} = ${documentBlockRooms.roomId}
              and ${documentBlocks.blockId} = o.block_id
          ), '')`,
        })
        .from(documentBlockRooms)
        .innerJoin(documents, eq(documents.id, documentBlockRooms.documentId))
        .innerJoin(documentYjsHeads, eq(documentYjsHeads.documentId, documents.id))
        .where(
          and(
            inArray(documentBlockRooms.documentId, ids),
            not(staleDerivation),
            // A draft reader sees the draft, which the live room doesn't hold.
            draftWorkId
              ? notExists(
                  currentDrizzleDb(db)
                    .select({ one: sql`1` })
                    .from(documentDrafts)
                    .innerJoin(branches, eq(branches.id, documentDrafts.branchId))
                    .where(
                      and(
                        eq(documentDrafts.documentId, documents.id),
                        eq(documentDrafts.kind, "work_draft"),
                        eq(documentDrafts.status, "active"),
                        eq(branches.status, "active"),
                        eq(branches.originWorkId, draftWorkId),
                      ),
                    ),
                )
              : undefined,
          ),
        );
      return new Map(rows.map((row) => [row.id, row.text]));
    },
    async stale(scope, page) {
      // LIMIT bounds returned stale rows, not the cross-table freshness scan.
      const projectId = sql`coalesce(${contextSources.projectId}, ${works.projectId})`;
      const rows = await currentDrizzleDb(db)
        .select({ id: documents.id })
        .from(documents)
        .innerJoin(documentYjsHeads, eq(documentYjsHeads.documentId, documents.id))
        .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
        .leftJoin(works, eq(works.id, contextSources.workId))
        .leftJoin(projects, sql`${projects.id} = ${projectId}`)
        .leftJoin(documentBlockRooms, eq(documentBlockRooms.documentId, documents.id))
        .where(
          and(
            isNull(documents.deletedAt),
            staleDerivation,
            scope
              ? scope.personalOwnerId
                ? eq(projects.userId, scope.personalOwnerId)
                : sql`${projectId} = ${scope.projectId}`
              : undefined,
            page?.after ? gt(documents.id, page.after) : undefined,
          ),
        )
        .orderBy(asc(documents.id))
        .limit(page?.limit ?? 100);
      return rows.map((row) => row.id as DocumentId);
    },
  };
}
