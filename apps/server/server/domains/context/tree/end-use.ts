/**
 * End of use (contract §12.2 steps 3–5, §12.4, §12.5): a branch stops using documents it
 * created, and what no active branch uses any more is tombstoned, its storage released,
 * with every hidden ancestor it leaves empty; a rolled-back reply's create is retracted
 * the same way, and an inconsistent hidden node met by a read is repaired by it too.
 *
 * Every function runs in its caller's transaction, which holds the Work, the branch (when
 * there is one) and the namespaces; the Work's pending count follows at that transaction's
 * commit. Hidden nodes are tombstoned, never hard-deleted.
 */
import type { BranchId, DocumentId } from "@meridian/contracts";
import type { RetractionCause } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import type { DocumentRemoval } from "../ports/document-removal.js";
import { dropDocumentRows, pruneHiddenFolders } from "./branch-tree-store.js";
import { lockDocuments, type RemovalInitiator } from "./node-rows.js";
import type { NodeRef } from "./tree-view.js";
import { loadActiveBranchUses, loadDocumentIdentityRows } from "./tree-view-sql.js";

/** What an end of use tombstoned, and the stored objects to delete once it commits. */
export type EndedUse = {
  tombstoned: readonly NodeRef[];
  releasedObjects: readonly string[];
};

const NOTHING_ENDED: EndedUse = Object.freeze({ tombstoned: [], releasedObjects: [] });

/**
 * The branch stops using these documents: its rows go (settling its moves and deletes, and
 * pruning the hidden folders only those moves used), then each hidden document no active
 * branch uses any more is tombstoned (`tombstoneUnused`).
 * A revealed document is live and stays.
 */
export async function endUse(
  db: Database,
  input: {
    branchId: BranchId;
    documentIds: readonly DocumentId[];
    actor: RemovalInitiator;
    removal: DocumentRemoval;
  },
): Promise<EndedUse> {
  const ids = [...new Set(input.documentIds)].sort();
  if (ids.length === 0) return NOTHING_ENDED;
  const pruned = await dropDocumentRows(db, {
    branchId: input.branchId,
    documentIds: ids,
    settle: { as: "discarded", userId: "userId" in input.actor ? input.actor.userId : null },
  });
  const ended = await tombstoneUnused(db, ids, { actor: input.actor, removal: input.removal });
  return { ...ended, tombstoned: [...pruned, ...ended.tombstoned] };
}

/**
 * Each of these documents that is hidden, not a tombstone, and used by no active branch is
 * tombstoned under its lock (`deleted_at`, a location version bump, `hidden` kept) and
 * its storage released (R8); then its hidden folders bottom-up while nothing live sits
 * under them and no branch places anything there (`keepFolders`: a create that is about
 * to place its own document in that folder). The caller holds the namespaces of the
 * documents' sources. A binary's object keys come back for deletion after commit.
 */
export async function tombstoneUnused(
  db: Database,
  documentIds: readonly DocumentId[],
  options: {
    keepFolders?: boolean;
    actor: RemovalInitiator;
    removal: DocumentRemoval;
  },
): Promise<EndedUse> {
  const ids = [...new Set(documentIds)].sort();
  if (ids.length === 0) return NOTHING_ENDED;
  await lockDocuments(db, ids);
  const tx = currentDrizzleDb(db);
  const rows = await loadDocumentIdentityRows(tx, ids);
  const used = new Set((await loadActiveBranchUses(tx, ids)).map((use) => use.documentId));
  const ending = rows.filter((row) => row.hidden && !row.deleted && !used.has(row.id));
  await testHook("endUse.afterRevalidate");
  if (ending.length === 0) return NOTHING_ENDED;
  const removed = await options.removal.remove({
    documentIds: ending.map((row) => row.id),
    reason: "discarded",
    ...options.actor,
  });
  const tombstoned: NodeRef[] = removed.map((id) => ({ kind: "document" as const, id }));
  const releasedObjects = ending.flatMap((row) => (row.storageUrl ? [row.storageUrl] : []));
  if (options.keepFolders) return { tombstoned, releasedObjects };
  tombstoned.push(
    ...(await pruneHiddenFolders(
      db,
      ending.map((row) => row.folderId),
    )),
  );
  return { tombstoned, releasedObjects };
}

/**
 * Which of `ids` are hidden now, read in the caller's transaction. Under the caller's
 * document locks this is the visibility an end of use acts on (another Work's Apply may
 * have revealed a branch's create since the caller resolved it).
 */
export async function hiddenDocumentIds(
  db: Database,
  ids: readonly DocumentId[],
): Promise<ReadonlySet<DocumentId>> {
  const rows = await loadDocumentIdentityRows(currentDrizzleDb(db), [...new Set(ids)]);
  return new Set(rows.filter((row) => row.hidden).map((row) => row.id));
}

/**
 * Reverse a branch's create for a rolled-back reply or a failed create (§12.5, O-11). The
 * tree half only: collab's `retractDraft` decides whether the document's draft holds
 * another contribution (then the create stands) and otherwise closes it; the branch's use
 * then ends.
 */
export async function retractCreate(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    cause: RetractionCause;
    removal: DocumentRemoval;
    retractDraft(): Promise<"retracted" | "stands">;
  },
): Promise<{ retracted: boolean; tombstoned: readonly NodeRef[] }> {
  await lockDocuments(db, [input.documentId]);
  const uses = await loadActiveBranchUses(currentDrizzleDb(db), [input.documentId]);
  if (!uses.some((use) => use.branchId === input.branchId)) {
    return { retracted: false, tombstoned: [] };
  }
  if ((await input.retractDraft()) === "stands") return { retracted: false, tombstoned: [] };
  const ended = await endUse(db, {
    branchId: input.branchId,
    documentIds: [input.documentId],
    actor: { cause: input.cause },
    removal: input.removal,
  });
  return { retracted: true, tombstoned: ended.tombstoned };
}
