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
import type { BranchId, ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { RetractionCause } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import { lockDocumentNamespaces } from "../adapters/context-fs/document-locations.js";
import type { DocumentRemoval } from "../ports/document-removal.js";
import { dropDocumentRows } from "./branch-tree-store.js";
import { lockDocuments, type RemovalInitiator, tombstoneFolders } from "./node-rows.js";
import { loadFolderChains } from "./tree-addresses.js";
import type { NodeRef } from "./tree-view.js";
import {
  isUnusedHiddenFolder,
  loadActiveBranchUses,
  loadBranchCreatedDocuments,
  loadDocumentIdentityRows,
} from "./tree-view-sql.js";

/** What an end of use tombstoned, and the stored objects to delete once it commits. */
export type EndedUse = {
  tombstoned: readonly NodeRef[];
  releasedObjects: readonly string[];
};

const NOTHING_ENDED: EndedUse = Object.freeze({ tombstoned: [], releasedObjects: [] });

/**
 * The branch stops using these documents: its rows go,
 * then each hidden document no active branch uses any more is tombstoned (`tombstoneUnused`).
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
  await dropDocumentRows(db, { branchId: input.branchId, documentIds: ids });
  return tombstoneUnused(db, ids, { actor: input.actor, removal: input.removal });
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

/** What an end of use touches: documents, and every source they sit in now or in a branch. */
export type EndUseScope = {
  documentIds: readonly DocumentId[];
  sourceIds: readonly ContextSourceId[];
};

/**
 * What to lock for an end of use: each branch's created documents (all of them, or the
 * named ones) at their rows and at the branch's location, and other documents where they
 * sit now (an item's text, a node a read repairs).
 */
export type EndUseRequest = {
  branches?: readonly { branchId: BranchId; documentIds?: readonly DocumentId[] }[];
  documentIds?: readonly DocumentId[];
};

/** The scope moved (a document changed source) between reading and locking it: start over. */
export class EndUseScopeChangedError extends Error {
  constructor() {
    super("An end of use's scope changed while its namespaces were being locked");
    this.name = "EndUseScopeChangedError";
  }
}

/** The scope as it reads now, unlocked. */
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

export async function readEndUseScope(db: Database, request: EndUseRequest): Promise<EndUseScope> {
  const tx = currentDrizzleDb(db);
  const documentIds = new Set<DocumentId>();
  const sourceIds = new Set<ContextSourceId>();
  for (const { branchId, documentIds: named } of request.branches ?? []) {
    const only = named ? new Set(named) : null;
    for (const row of await loadBranchCreatedDocuments(tx, branchId)) {
      if (only && !only.has(row.id)) continue;
      documentIds.add(row.id);
      sourceIds.add(row.contextSourceId);
    }
  }
  for (const row of await loadDocumentIdentityRows(tx, [...new Set(request.documentIds ?? [])])) {
    documentIds.add(row.id);
    sourceIds.add(row.contextSourceId);
  }
  return { documentIds: [...documentIds].sort(), sourceIds: [...sourceIds].sort() };
}

/**
 * The one verified acquisition every end of use takes, after the caller's Work and branch
 * locks (§14): the namespaces of exactly the sources read, then the scope read again; a
 * document that moved to a source not locked, or a new one, throws
 * `EndUseScopeChangedError`, so the caller aborts its transaction and rediscovers (no
 * namespace is ever taken while holding a document lock). Then the document locks, id
 * order. Once a source's namespace is held nothing moves out of it, so the scope holds.
 */
export async function acquireEndUseScope(
  db: Database,
  request: EndUseRequest,
): Promise<EndUseScope> {
  const scope = await readEndUseScope(db, request);
  await lockDocumentNamespaces(db, [], scope.sourceIds);
  const again = await readEndUseScope(db, request);
  const documents = new Set(scope.documentIds);
  const sources = new Set(scope.sourceIds);
  if (
    !again.documentIds.every((id) => documents.has(id)) ||
    !again.sourceIds.every((id) => sources.has(id))
  ) {
    throw new EndUseScopeChangedError();
  }
  await lockDocuments(db, scope.documentIds);
  return scope;
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
