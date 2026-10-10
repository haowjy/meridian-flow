/**
 * End of use (contract §12.2 steps 3–5, §12.5): a draft stops using documents it created,
 * and what no active draft uses any more is tombstoned with every hidden ancestor it
 * leaves empty; a rolled-back reply's create is retracted the same way.
 *
 * Every function runs in its caller's transaction, which holds the Work, the draft and
 * the namespaces. Hidden nodes are tombstoned, never hard-deleted; storage release is
 * lane D's.
 */
import type { DocumentId, DraftId, FolderId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { dropDraftSettlements } from "../adapters/link-ahead-draft-settlements.js";
import { dropDocumentRows } from "./draft-tree-store.js";
import { lockDocuments, tombstoneDocuments, tombstoneFolder } from "./node-rows.js";
import { treeHook } from "./test-hooks.js";
import { loadFolderChains } from "./tree-addresses.js";
import type { NodeRef } from "./tree-view.js";
import {
  isUnusedHiddenFolder,
  loadActiveDraftUses,
  loadDocumentIdentityRows,
} from "./tree-view-sql.js";

/**
 * The draft stops using these documents: its rows and its settlements naming them go,
 * then each hidden document no active draft uses any more is tombstoned under its lock,
 * and its hidden folders bottom-up while nothing live sits under them and no draft
 * places anything there. A revealed document is live and stays.
 */
export async function endUse(
  db: Database,
  input: { draftId: DraftId; documentIds: readonly DocumentId[] },
): Promise<{ tombstoned: readonly NodeRef[]; releasedObjects: readonly string[] }> {
  const ids = [...new Set(input.documentIds)].sort();
  if (ids.length === 0) return { tombstoned: [], releasedObjects: [] };
  await dropDocumentRows(db, { draftId: input.draftId, documentIds: ids });
  await dropDraftSettlements(db, { draftId: input.draftId, documentIds: ids });
  await lockDocuments(db, ids);
  const tx = currentDrizzleDb(db);
  const rows = await loadDocumentIdentityRows(tx, ids);
  const used = new Set((await loadActiveDraftUses(tx, ids)).map((use) => use.documentId));
  const ending = rows.filter((row) => row.hidden && !row.deleted && !used.has(row.id));
  await treeHook("endUse.afterRevalidate");
  const tombstoned: NodeRef[] = [];
  if (ending.length === 0) return { tombstoned, releasedObjects: [] };
  await tombstoneDocuments(
    db,
    ending.map((row) => row.id),
  );
  tombstoned.push(...ending.map((row) => ({ kind: "document" as const, id: row.id })));
  // Every ancestor of every ended document, deepest first: a folder is judged only after
  // all of the batch's folders beneath it, so a sibling still alive at first glance never
  // leaves its parent behind.
  const chains = await loadFolderChains(
    tx,
    ending.map((row) => row.folderId),
  );
  const depthOf = new Map<FolderId, number>();
  for (const chain of chains.values()) {
    chain.forEach((folder, index) => {
      const depth = chain.length - index;
      depthOf.set(folder.id, Math.max(depthOf.get(folder.id) ?? 0, depth));
    });
  }
  const deepestFirst = [...depthOf.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  for (const folderId of deepestFirst) {
    if (!(await isUnusedHiddenFolder(tx, folderId))) continue;
    await tombstoneFolder(db, folderId);
    tombstoned.push({ kind: "folder", id: folderId });
  }
  return {
    tombstoned,
    releasedObjects: ending.flatMap((row) => (row.storageUrl ? [row.storageUrl] : [])),
  };
}

/**
 * Reverse a draft's create for a rolled-back reply or a failed create (§12.5, O-11). The
 * tree half only: collab's `retractBranch` decides whether the draft's text branch holds
 * another contribution (then the create stands) and otherwise removes it; the draft's use
 * then ends.
 */
export async function retractCreate(
  db: Database,
  input: {
    draftId: DraftId;
    documentId: DocumentId;
    retractBranch(): Promise<"retracted" | "stands">;
  },
): Promise<{ retracted: boolean; tombstoned: readonly NodeRef[] }> {
  await lockDocuments(db, [input.documentId]);
  const uses = await loadActiveDraftUses(currentDrizzleDb(db), [input.documentId]);
  if (!uses.some((use) => use.draftId === input.draftId)) {
    return { retracted: false, tombstoned: [] };
  }
  if ((await input.retractBranch()) === "stands") return { retracted: false, tombstoned: [] };
  const ended = await endUse(db, { draftId: input.draftId, documentIds: [input.documentId] });
  return { retracted: true, tombstoned: ended.tombstoned };
}
