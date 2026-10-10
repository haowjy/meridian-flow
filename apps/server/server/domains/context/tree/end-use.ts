/**
 * End of use (contract §12.2 steps 3–5, §12.4, §12.5): a draft stops using documents it
 * created, and what no active draft uses any more is tombstoned, its storage released,
 * with every hidden ancestor it leaves empty; a rolled-back reply's create is retracted
 * the same way, and an inconsistent hidden node met by a read is repaired by it too.
 *
 * Every function runs in its caller's transaction, which holds the Work, the draft (when
 * there is one) and the namespaces. Hidden nodes are tombstoned, never hard-deleted.
 */
import type { ContextSourceId, DocumentId, DraftId, FolderId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { lockDocumentNamespaces } from "../adapters/context-fs/document-locations.js";
import { dropDraftSettlements } from "../adapters/link-ahead-draft-settlements.js";
import { dropDocumentRows } from "./draft-tree-store.js";
import {
  lockDocuments,
  releaseDocumentStorage,
  tombstoneDocuments,
  tombstoneFolders,
} from "./node-rows.js";
import { treeHook } from "./test-hooks.js";
import { loadFolderChains } from "./tree-addresses.js";
import type { NodeRef } from "./tree-view.js";
import {
  isUnusedHiddenFolder,
  loadActiveDraftUses,
  loadDocumentIdentityRows,
  loadDraftCreatedDocuments,
} from "./tree-view-sql.js";

/** What an end of use tombstoned, and the stored objects to delete once it commits. */
export type EndedUse = { tombstoned: readonly NodeRef[]; releasedObjects: readonly string[] };

const NOTHING_ENDED: EndedUse = Object.freeze({ tombstoned: [], releasedObjects: [] });

/**
 * The draft stops using these documents: its rows and its settlements naming them go,
 * then each hidden document no active draft uses any more is tombstoned (`tombstoneUnused`).
 * A revealed document is live and stays.
 */
export async function endUse(
  db: Database,
  input: { draftId: DraftId; documentIds: readonly DocumentId[] },
): Promise<EndedUse> {
  const ids = [...new Set(input.documentIds)].sort();
  if (ids.length === 0) return NOTHING_ENDED;
  await dropDocumentRows(db, { draftId: input.draftId, documentIds: ids });
  await dropDraftSettlements(db, { draftId: input.draftId, documentIds: ids });
  return tombstoneUnused(db, ids);
}

/**
 * Each of these documents that is hidden, not a tombstone, and used by no active draft is
 * tombstoned under its lock (`deleted_at`, a location version bump, `hidden` kept) and
 * its storage released (R8); then its hidden folders bottom-up while nothing live sits
 * under them and no draft places anything there (`keepFolders`: a create that is about
 * to place its own document in that folder). The caller holds the namespaces of the
 * documents' sources. A binary's object keys come back for deletion after commit.
 */
export async function tombstoneUnused(
  db: Database,
  documentIds: readonly DocumentId[],
  options: { keepFolders?: boolean } = {},
): Promise<EndedUse> {
  const ids = [...new Set(documentIds)].sort();
  if (ids.length === 0) return NOTHING_ENDED;
  await lockDocuments(db, ids);
  const tx = currentDrizzleDb(db);
  const rows = await loadDocumentIdentityRows(tx, ids);
  const used = new Set((await loadActiveDraftUses(tx, ids)).map((use) => use.documentId));
  const ending = rows.filter((row) => row.hidden && !row.deleted && !used.has(row.id));
  await treeHook("endUse.afterRevalidate");
  if (ending.length === 0) return NOTHING_ENDED;
  const endingIds = ending.map((row) => row.id);
  await tombstoneDocuments(db, endingIds);
  await releaseDocumentStorage(db, endingIds);
  const tombstoned: NodeRef[] = endingIds.map((id) => ({ kind: "document" as const, id }));
  const releasedObjects = ending.flatMap((row) => (row.storageUrl ? [row.storageUrl] : []));
  if (options.keepFolders) return { tombstoned, releasedObjects };
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
    await tombstoneFolders(db, [folderId]);
    tombstoned.push({ kind: "folder", id: folderId });
  }
  return { tombstoned, releasedObjects };
}

/** The documents a draft's end of use touches, and every source they sit in now or in the draft. */
export type EndUseScope = {
  documentIds: readonly DocumentId[];
  sourceIds: readonly ContextSourceId[];
};

/**
 * What ending the draft's use of these created documents (every one it created, when
 * `documentIds` is absent) touches. Read before the namespace locks; the caller locks
 * with `lockEndUseScope` and then reads it again to prove it held still.
 */
export async function endUseScope(
  db: Database,
  input: { draftId: DraftId; documentIds?: readonly DocumentId[] },
): Promise<EndUseScope> {
  const named = input.documentIds ? new Set(input.documentIds) : null;
  const created = (await loadDraftCreatedDocuments(currentDrizzleDb(db), input.draftId)).filter(
    (each) => !named || named.has(each.row.id),
  );
  const sourceIds = new Set<ContextSourceId>();
  for (const { row, draft } of created) {
    sourceIds.add(row.contextSourceId);
    if (draft.contextSourceId) sourceIds.add(draft.contextSourceId);
  }
  return {
    documentIds: created.map((each) => each.row.id).sort(),
    sourceIds: [...sourceIds].sort(),
  };
}

/**
 * §14's order after the draft row: the namespaces of `scope`'s sources and of where
 * `alsoDocumentIds` sit, then every one of those documents' locks in id order.
 */
export async function lockEndUseScope(
  db: Database,
  scope: EndUseScope,
  alsoDocumentIds: readonly DocumentId[] = [],
): Promise<void> {
  const ids = [...new Set([...scope.documentIds, ...alsoDocumentIds])];
  await lockDocumentNamespaces(db, ids, scope.sourceIds);
  await lockDocuments(db, ids);
}

/** Whether `later` stays inside what `locked` covered: no new document, no new source. */
export function withinScope(locked: EndUseScope, later: EndUseScope): boolean {
  const documents = new Set(locked.documentIds);
  const sources = new Set(locked.sourceIds);
  return (
    later.documentIds.every((id) => documents.has(id)) &&
    later.sourceIds.every((id) => sources.has(id))
  );
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
