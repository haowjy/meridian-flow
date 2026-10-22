/**
 * The one verified scope acquisition for tree mutations whose namespaces are not known up
 * front: end of use, Discard, hidden-node repair, Apply's reveal and restore, and the
 * inverses of moves and deletes (a reply's rollback, the turn card, the model's undo). It reads
 * which sources the documents sit in (and, for a branch, where it placed them and every folder
 * its unsettled moves hold), locks those namespaces, reads again, and only then takes the document locks. The
 * caller owns its transaction and its retry: a scope that moved throws
 * `TreeScopeChangedError`, and the caller aborts and starts over, so no namespace is ever
 * taken while a document lock is held.
 */
import type { BranchId, ContextSourceId, DocumentId, TreePlacement } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { lockDocumentNamespaces } from "../adapters/context-fs/document-locations.js";
import { readHeldFolders } from "./branch-tree-store.js";
import { placementSources } from "./live-tree-state.js";
import { lockDocuments } from "./node-rows.js";
import { loadBranchTreeRows, loadDocumentIdentityRows } from "./tree-view-sql.js";

/** What a tree mutation touches: documents, and every source they or a branch's held folders sit in. */
export type TreeScope = {
  documentIds: readonly DocumentId[];
  sourceIds: readonly ContextSourceId[];
};

/**
 * What to lock: each branch's documents with a row or a held folder (all of them, or the named
 * ones) where they sit, where the branch has them, and where every folder its drafted moves
 * hold sits now (the effective placement is a read model; cleanup prunes all of these), other
 * documents where they sit now (an item's text, a document Apply restores, a node a read
 * repairs), and sources a mutation writes into that no row names yet. Tombstones count where
 * they sit.
 */
export type TreeScopeRequest = {
  branches?: readonly { branchId: BranchId; documentIds?: readonly DocumentId[] }[];
  documentIds?: readonly DocumentId[];
  /**
   * Placements the mutation will write that no row names yet (a move's undo returns to its
   * old folder): each locks its folder's source as it is now, so a folder moved since is
   * locked where it went.
   */
  placements?: readonly TreePlacement[];
  /** Sources the mutation writes into by id (a drafted move's destination). */
  sourceIds?: readonly ContextSourceId[];
};

/** The scope moved (a document changed source) between reading and locking it: start over. */
export class TreeScopeChangedError extends Error {
  constructor() {
    super("A tree mutation's scope changed while its namespaces were being locked");
    this.name = "TreeScopeChangedError";
  }
}

/** The scope as it reads now, unlocked. */
export async function readTreeScope(db: Database, request: TreeScopeRequest): Promise<TreeScope> {
  const tx = currentDrizzleDb(db);
  const documentIds = new Set<DocumentId>();
  const sourceIds = new Set<ContextSourceId>();
  const others = new Set(request.documentIds ?? []);
  for (const { branchId, documentIds: named } of request.branches ?? []) {
    for (const row of await loadBranchTreeRows(tx, branchId, named)) {
      documentIds.add(row.id);
      sourceIds.add(row.contextSourceId);
      sourceIds.add(row.effective.contextSourceId);
    }
    // Every folder the branch's moves hold, masked by a delete or left by a later move or an
    // undo to no row: settlement prunes them, so cleanup locks where they sit now.
    for (const held of await readHeldFolders(tx, branchId, named)) {
      others.add(held.documentId);
      sourceIds.add(held.contextSourceId);
    }
  }
  for (const row of await loadDocumentIdentityRows(tx, [...others])) {
    documentIds.add(row.id);
    sourceIds.add(row.contextSourceId);
  }
  for (const id of await placementSources(db, request.placements ?? [])) sourceIds.add(id);
  for (const id of request.sourceIds ?? []) sourceIds.add(id);
  return { documentIds: [...documentIds].sort(), sourceIds: [...sourceIds].sort() };
}

/**
 * After the caller's Work and branch locks (§14): the namespaces of exactly the sources
 * read, then the scope read again; a document that moved to a source not locked, or a new
 * one, throws `TreeScopeChangedError`. Then the document locks, id order. Once a source's
 * namespace is held nothing moves out of it, so the scope holds.
 */
export async function acquireTreeScope(
  db: Database,
  request: TreeScopeRequest,
): Promise<TreeScope> {
  const scope = await readTreeScope(db, request);
  await lockDocumentNamespaces(db, [], scope.sourceIds);
  const again = await readTreeScope(db, request);
  const documents = new Set(scope.documentIds);
  const sources = new Set(scope.sourceIds);
  if (
    !again.documentIds.every((id) => documents.has(id)) ||
    !again.sourceIds.every((id) => sources.has(id))
  ) {
    throw new TreeScopeChangedError();
  }
  await lockDocuments(db, scope.documentIds);
  return scope;
}
