/**
 * Reads and writes of `branch_tree_changes`: what one branch says about a node. A created row
 * holds identity and attribution (its place is the document row's, §6.2); a drafted move or
 * delete holds the branch's facts, which `writeBranchTreeFacts` alone writes. Folders are
 * implied by what a branch places under them (O-2).
 */
import type {
  BranchId,
  BranchTreeFacts,
  DocumentId,
  ThreadId,
  TreePlacement,
  TurnId,
} from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branchTreeChanges } from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";

/** The branch created (or joined) this document; its place is the document row's. The branch can't already have the row. */
export async function recordCreated(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    createdBy?: { threadId: ThreadId; turnId?: TurnId };
  },
): Promise<void> {
  await currentDrizzleDb(db)
    .insert(branchTreeChanges)
    .values({
      branchId: input.branchId,
      nodeKind: "document",
      nodeId: input.documentId,
      created: true,
      createdThreadId: input.createdBy?.threadId ?? null,
      createdTurnId: input.createdBy?.turnId ?? null,
    });
}

/** The branch stops saying anything about these documents (its settlements are the registry's). */
export async function dropDocumentRows(
  db: Database,
  input: { branchId: BranchId; documentIds: readonly DocumentId[] },
): Promise<void> {
  if (input.documentIds.length === 0) return;
  await currentDrizzleDb(db)
    .delete(branchTreeChanges)
    .where(
      and(
        eq(branchTreeChanges.branchId, input.branchId),
        eq(branchTreeChanges.nodeKind, "document"),
        inArray(branchTreeChanges.nodeId, [...input.documentIds]),
      ),
    );
}

const NO_FACTS: BranchTreeFacts = { row: false, created: false, moved: null, deleted: false };

/**
 * Each branch's facts about each document, as a tree entry records them: "no row" too, so
 * an inverse can tell a document that follows live from one moved to where live happens to be.
 */
export async function readBranchTreeFacts(
  db: Pick<DrizzleDb, "select">,
  branchIds: readonly BranchId[],
  documentIds: readonly DocumentId[],
): Promise<Map<BranchId, Map<DocumentId, BranchTreeFacts>>> {
  const out = new Map<BranchId, Map<DocumentId, BranchTreeFacts>>(
    branchIds.map((branchId) => [
      branchId,
      new Map(documentIds.map((documentId) => [documentId, NO_FACTS])),
    ]),
  );
  if (!branchIds.length || !documentIds.length) return out;
  const rows = await db
    .select({
      branchId: branchTreeChanges.branchId,
      nodeId: branchTreeChanges.nodeId,
      created: branchTreeChanges.created,
      moved: branchTreeChanges.moved,
      deleted: branchTreeChanges.deleted,
      folderId: branchTreeChanges.movedFolderId,
      rootSourceId: branchTreeChanges.movedRootSourceId,
      name: branchTreeChanges.movedName,
      extension: branchTreeChanges.movedExtension,
    })
    .from(branchTreeChanges)
    .where(
      and(
        eq(branchTreeChanges.nodeKind, "document"),
        inArray(branchTreeChanges.branchId, [...branchIds]),
        inArray(branchTreeChanges.nodeId, [...documentIds]),
      ),
    );
  for (const row of rows)
    out.get(row.branchId)?.set(row.nodeId as DocumentId, {
      row: true,
      created: row.created,
      moved:
        row.moved && row.name !== null && row.extension !== null
          ? {
              folderId: row.folderId,
              rootSourceId: row.rootSourceId,
              name: row.name,
              extension: row.extension,
            }
          : null,
      deleted: row.deleted,
    });
  return out;
}

/**
 * Writes `facts` as the branch's row on a document: the one writer of drafted moves and
 * deletes, and of their inverses, which write back the facts an entry recorded. Every write
 * takes a new revision from the sequence (a value never recurs, so a frozen Apply click can
 * tell); the first `base_version` stays while a move or delete does. Facts that say nothing
 * remove the row: a document that follows live again. Created attribution is kept; the latest
 * move or delete's is `changedBy`. The caller holds the Work, the branch and the document lock.
 */
export async function writeBranchTreeFacts(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    facts: BranchTreeFacts;
    /** `documents.location_version` now: the base a first move or delete records. */
    locationVersion: bigint;
    changedBy: { threadId: ThreadId; turnId?: TurnId } | null;
  },
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const { facts } = input;
  const key = and(
    eq(branchTreeChanges.branchId, input.branchId),
    eq(branchTreeChanges.nodeKind, "document"),
    eq(branchTreeChanges.nodeId, input.documentId),
  );
  if (!facts.row || !(facts.created || facts.moved || facts.deleted)) {
    await tx.delete(branchTreeChanges).where(key);
    return;
  }
  const changed = facts.moved !== null || facts.deleted;
  const moved: TreePlacement | null = facts.moved;
  const values = {
    created: facts.created,
    moved: moved !== null,
    movedFolderId: moved?.folderId ?? null,
    movedRootSourceId: moved?.folderId ? null : (moved?.rootSourceId ?? null),
    movedName: moved?.name ?? null,
    movedExtension: moved?.extension ?? null,
    deleted: facts.deleted,
    changedThreadId: changed ? (input.changedBy?.threadId ?? null) : null,
    changedTurnId: changed ? (input.changedBy?.turnId ?? null) : null,
  };
  await tx
    .insert(branchTreeChanges)
    .values({
      branchId: input.branchId,
      nodeKind: "document",
      nodeId: input.documentId,
      ...values,
      baseVersion: changed ? input.locationVersion : null,
    })
    .onConflictDoUpdate({
      target: [branchTreeChanges.branchId, branchTreeChanges.nodeKind, branchTreeChanges.nodeId],
      set: {
        ...values,
        revision: sql`nextval('branch_tree_change_revision')`,
        baseVersion: changed
          ? sql`coalesce(${branchTreeChanges.baseVersion}, ${input.locationVersion}::bigint)`
          : null,
        updatedAt: new Date(),
      },
    });
}
