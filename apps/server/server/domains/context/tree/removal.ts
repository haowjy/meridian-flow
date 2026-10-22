/**
 * The removal record's one owner: the kernel that writes it (delete, overwrite, Work cascade,
 * the last use of a hidden creation), the two restores that clear it (a Work Restore's
 * cascade, and one deleted document's `restoreDocument`), and its reader.
 */
import type { ContextSourceId, DocumentId, FolderId, WorkId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  branchTreeChanges,
  contextSources,
  documents,
  projects,
  threads,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDb,
  runInDrizzleSavepoint,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import type {
  DocumentRemoval,
  DocumentRemovalCollab,
  DocumentRemovals,
} from "../ports/document-removal.js";
import { bumpLocationVersions } from "./node-locations.js";
import { releaseDocumentStorage } from "./node-rows.js";
import { type PlaceTarget, placeLive } from "./placement.js";
import type { NodeRef } from "./tree-view.js";
import { loadActiveBranchUses, loadDocumentIdentityRows } from "./tree-view-sql.js";

/** Works whose branches use these documents, in the caller's transaction. */
async function usingWorks(tx: DrizzleDb, ids: readonly DocumentId[]): Promise<WorkId[]> {
  const uses = await loadActiveBranchUses(tx, ids);
  return [...new Set(uses.flatMap(({ originWorkId }) => (originWorkId ? [originWorkId] : [])))];
}

export function createDocumentRemoval(
  db: Database,
  deps: {
    collab: DocumentRemovalCollab;
    /** Works the removal changed but the caller does not hold are recounted after commit. */
    workProjection: Pick<WorkProjectionMutation, "recountAfterCommit">;
  },
): DocumentRemoval {
  return {
    async remove(input) {
      const ids = [...new Set(input.documentIds)].sort();
      const tx = currentDrizzleDb(db);
      const living = (await loadDocumentIdentityRows(tx, ids)).filter((row) => !row.deleted);
      const removed = living.map((row) => row.id as DocumentId);
      if (!removed.length) return [];
      const affected = await usingWorks(tx, removed);
      const now = input.at ?? new Date();
      // A model's delete keeps its chat's owner too, who stands in once the chat is gone.
      const [chat] = input.threadId
        ? await tx
            .select({ ownerId: threads.createdByUserId })
            .from(threads)
            .where(eq(threads.id, input.threadId))
        : [];
      await tx
        .update(documents)
        .set({
          deletedAt: now,
          updatedAt: now,
          deletionReason: input.reason,
          deletedByUserId: input.userId ?? chat?.ownerId ?? null,
          deletedByWorkId: input.workId ?? null,
          deletedByThreadId: input.threadId ?? null,
          deletionCause: input.cause ?? null,
        })
        .where(inArray(documents.id, removed));
      await bumpLocationVersions(db, { documentIds: removed });
      // A Work cascade keeps hidden creations' tree uses: `restoreWorkDocuments` brings their
      // membership back with the tombstone, while a revealed document needs none. Any other
      // removal ends each branch's creation of the document but keeps its moves and deletes,
      // a branch's pending intent, as it keeps the drafts (D79, D80): Apply brings it back.
      const retired = input.workId
        ? living.filter((row) => !row.hidden).map((row) => row.id)
        : removed;
      if (retired.length) {
        const ofRetired = and(
          eq(branchTreeChanges.nodeKind, "document"),
          inArray(branchTreeChanges.nodeId, retired),
        );
        await tx
          .update(branchTreeChanges)
          .set({ created: false, updatedAt: now })
          .where(and(ofRetired, eq(branchTreeChanges.created, true)));
        await tx
          .delete(branchTreeChanges)
          .where(
            and(
              ofRetired,
              eq(branchTreeChanges.moved, false),
              eq(branchTreeChanges.deleted, false),
            ),
          );
      }
      const [record] = (await readRemovalRecords(tx, removed.slice(0, 1))).values();
      if (!record) throw new Error(`Removal of ${removed[0]} wrote no record`);
      deps.collab.registerRemoved(removed, record);
      const drafted =
        input.reason === "discarded" ? await deps.collab.closeDiscardedDrafts(removed, record) : [];
      await testHook("removal.afterRecord");
      deps.workProjection.recountAfterCommit([...affected, ...drafted]);
      if (input.reason === "discarded") await releaseDocumentStorage(db, removed);
      return removed;
    },
  };
}

/**
 * A Work Restore's documents: every one its deletion removed stands again, at the location
 * it held, and returns the Works whose branches use them, whose pending counts moved.
 */
export async function restoreWorkDocuments(
  db: Database,
  workId: WorkId,
): Promise<{
  workIds: WorkId[];
  restored: readonly { documentId: DocumentId; at: PlaceTarget["at"] }[];
}> {
  const tx = currentDrizzleDb(db);
  const rows = await tx
    .select({
      id: documents.id,
      sourceId: documents.contextSourceId,
      folderId: documents.folderId,
      name: documents.name,
      extension: documents.extension,
      hidden: documents.hidden,
    })
    .from(documents)
    .where(eq(documents.deletedByWorkId, workId))
    .orderBy(documents.createdAt, documents.id);
  const clear = {
    deletedAt: null,
    deletionReason: null,
    deletedByUserId: null,
    deletionCause: null,
    deletedByWorkId: null,
    deletedByThreadId: null,
  } as const;
  const restored: { documentId: DocumentId; at: PlaceTarget["at"] }[] = [];
  for (const row of rows) {
    if (row.hidden) {
      await tx
        .update(documents)
        .set({ ...clear, locationVersion: sql`${documents.locationVersion} + 1` })
        .where(eq(documents.id, row.id));
      restored.push({
        documentId: row.id as DocumentId,
        at: {
          contextSourceId: row.sourceId as ContextSourceId,
          parentFolderId: row.folderId as FolderId | null,
          name: row.name,
          extension: row.extension,
        },
      });
      continue;
    }
    const node: NodeRef = { kind: "document", id: row.id as DocumentId };
    const placed = await placeLive(
      db,
      {
        node,
        at: {
          contextSourceId: row.sourceId as ContextSourceId,
          parentFolderId: row.folderId as FolderId | null,
          name: row.name,
          extension: row.extension,
        },
      },
      async (parentId, at) => {
        await tx
          .update(documents)
          .set({
            ...clear,
            contextSourceId: at.contextSourceId,
            folderId: parentId,
            name: at.name,
            extension: at.extension ?? row.extension,
          })
          .where(eq(documents.id, row.id));
        await bumpLocationVersions(db, { documentIds: [row.id as DocumentId] });
      },
    );
    if (!placed.ok) throw new Error(`Work restore could not place ${row.id}: ${placed.error.code}`);
    restored.push({ documentId: row.id as DocumentId, at: placed.value.at });
  }
  return {
    workIds: await usingWorks(
      tx,
      rows.map(({ id }) => id as DocumentId),
    ),
    restored,
  };
}

/**
 * The removal a reversing caller undoes, as the document row held it right after that
 * removal: its time and the `location_version` it wrote.
 */
export type RemovalIdentity = { time: Date; locationVersion: bigint };

export type RestoreOutcome =
  | { kind: "restored"; placed: readonly NodeRef[]; at: PlaceTarget["at"] }
  | { kind: "already_living" }
  /** A different removal is current: an Undo of one delete never undoes a later one. */
  | { kind: "superseded" }
  /** Another node holds the document's path, or a path on its folder chain. */
  | { kind: "location_taken"; at: string; occupant: NodeRef }
  /** Not a document's own delete: a discard, a Work cascade, or a deleted source or project. */
  | { kind: "refused" };

/** A placement fault, carried out of the savepoint it rolls back. */
class RestoreFault extends Error {
  constructor(readonly outcome: Extract<RestoreOutcome, { kind: "location_taken" | "refused" }>) {
    super(`Restore faulted: ${outcome.kind}`);
  }
}

/**
 * Brings one deleted document back at the location it held, or at `at` (Apply of a drafted
 * move restores where the branch put it, so an old-path clash never blocks it), with every
 * folder on that path
 * (a living folder there is reused, a deleted one restored), through placement's one
 * name-claim rule. Apply restores whichever removal is current; a reversing caller (a
 * reply's rollback, the turn card's Undo) names the removal it reverses. Clears the record,
 * bumps `location_version`, settles the document's arrival and refreshes the catalog in the
 * caller's transaction. Touches no draft: drafts outlive a delete (D79). A fault rolls back
 * everything it placed. The caller holds the document's namespace, then its document lock
 * (`acquireTreeScope`).
 */
export async function restoreDocument(
  db: Database,
  input: { documentId: DocumentId; removal?: RemovalIdentity; at?: PlaceTarget["at"] },
  deps: {
    arrivals?: Pick<DocumentArrivals, "settle">;
    catalog: Pick<ContextCatalogMutationPort, "refreshSources">;
  },
): Promise<RestoreOutcome> {
  const tx = currentDrizzleDb(db);
  const [row] = await tx
    .select({
      sourceId: documents.contextSourceId,
      folderId: documents.folderId,
      name: documents.name,
      extension: documents.extension,
      hidden: documents.hidden,
      deletedAt: documents.deletedAt,
      reason: documents.deletionReason,
      byWork: documents.deletedByWorkId,
      locationVersion: documents.locationVersion,
      sourceDeleted: sql<boolean>`${contextSources.deletedAt} IS NOT NULL`,
      projectDeleted: sql<boolean>`${projects.deletedAt} IS NOT NULL`,
    })
    .from(documents)
    .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
    .leftJoin(works, eq(works.id, contextSources.workId))
    .innerJoin(
      projects,
      eq(projects.id, sql`coalesce(${contextSources.projectId}, ${works.projectId})`),
    )
    .where(eq(documents.id, input.documentId));
  if (!row) throw new Error(`Restore of unknown document ${input.documentId}`);
  if (row.deletedAt === null) return { kind: "already_living" };
  if (
    input.removal &&
    (row.deletedAt.getTime() !== input.removal.time.getTime() ||
      row.locationVersion !== input.removal.locationVersion)
  )
    return { kind: "superseded" };
  if (
    row.reason !== "deleted" ||
    row.hidden ||
    row.byWork !== null ||
    row.sourceDeleted ||
    row.projectDeleted
  )
    return { kind: "refused" };
  const node: NodeRef = { kind: "document", id: input.documentId };
  try {
    const placed = await runInDrizzleSavepoint(db, async () => {
      const landed = await placeLive(
        db,
        {
          node,
          at: input.at ?? {
            contextSourceId: row.sourceId as ContextSourceId,
            parentFolderId: row.folderId as FolderId | null,
            name: row.name,
            extension: row.extension,
          },
        },
        async (parentId, at) => {
          await currentDrizzleDb(db)
            .update(documents)
            .set({
              folderId: parentId,
              contextSourceId: at.contextSourceId,
              name: at.name,
              extension: at.extension ?? row.extension,
              deletedAt: null,
              deletionReason: null,
              deletedByUserId: null,
              deletedByThreadId: null,
              deletionCause: null,
              updatedAt: new Date(),
            })
            .where(eq(documents.id, input.documentId));
          await bumpLocationVersions(db, { documentIds: [input.documentId] });
        },
      );
      if (!landed.ok) {
        // A non-hidden document's chain holds no hidden folder, so only a taken path faults; a
        // drafted move's folders are the branch's, which placement reveals.
        if (landed.error.code !== "path_taken") {
          // A drafted move's hidden folder can be gone since; the document's own chain can't.
          if (input.at) throw new RestoreFault({ kind: "refused" });
          throw new Error(`Restore of ${input.documentId} met a broken folder chain`);
        }
        throw new RestoreFault({
          kind: "location_taken",
          at: landed.error.at,
          occupant: landed.error.occupant,
        });
      }
      return { placed: [...landed.value.ancestors, node], at: landed.value.at };
    });
    await deps.arrivals?.settle([input.documentId]);
    await deps.catalog.refreshSources(
      [
        ...new Set([
          row.sourceId as ContextSourceId,
          ...(input.at ? [input.at.contextSourceId] : []),
        ]),
      ],
      placed.placed.map((ref) => ref.id),
    );
    return { kind: "restored", ...placed };
  } catch (cause) {
    if (cause instanceof RestoreFault) return cause.outcome;
    throw cause;
  }
}

/** The `DocumentRemovals` port: `readRemovalRecords` in the caller's transaction, if any. */
export function createRemovalRecords(db: DrizzleDb): DocumentRemovals {
  return { lookup: (documentIds) => readRemovalRecords(currentDrizzleDb(db), documentIds) };
}

/**
 * The current removal record of each removed document among `documentIds`, with actor names
 * as they read now, through the handle given (the caller's transaction when it has one).
 * `documents_removal_presence` guarantees a tombstone has its reason.
 */
export async function readRemovalRecords(
  db: Pick<DrizzleDb, "select">,
  documentIds: readonly DocumentId[],
): Promise<ReadonlyMap<DocumentId, DocumentRemovalRecord>> {
  const records = new Map<DocumentId, DocumentRemovalRecord>();
  if (!documentIds.length) return records;
  const rows = await db
    .select({
      id: documents.id,
      reason: documents.deletionReason,
      time: documents.deletedAt,
      userId: documents.deletedByUserId,
      displayName: users.name,
      workName: works.name,
      chatId: threads.id,
      chatTitle: threads.title,
      cause: documents.deletionCause,
    })
    .from(documents)
    .leftJoin(users, eq(users.id, documents.deletedByUserId))
    .leftJoin(works, eq(works.id, documents.deletedByWorkId))
    .leftJoin(threads, eq(threads.id, documents.deletedByThreadId))
    .where(and(inArray(documents.id, [...documentIds]), isNotNull(documents.deletedAt)));
  for (const row of rows) {
    records.set(row.id as DocumentId, {
      reason: row.reason as DocumentRemovalRecord["reason"],
      time: (row.time as Date).toISOString(),
      actor:
        row.workName !== null
          ? { kind: "work", name: row.workName }
          : row.chatId !== null
            ? { kind: "agent", chatTitle: row.chatTitle?.trim() || null }
            : row.userId
              ? { kind: "user", userId: row.userId, displayName: row.displayName }
              : row.cause
                ? { kind: "system", cause: row.cause }
                : null,
    });
  }
  return records;
}
