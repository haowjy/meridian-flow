/**
 * The one verified scope acquisition for tree mutations whose namespaces are not known up
 * front: end of use, Discard, hidden-node repair, and Apply's reveal and restore. It reads
 * which sources the documents sit in (and, for a branch's creates, where the branch placed
 * them), locks those namespaces, reads again, and only then takes the document locks. The
 * caller owns its transaction and its retry: a scope that moved throws
 * `TreeScopeChangedError`, and the caller aborts and starts over, so no namespace is ever
 * taken while a document lock is held.
 */
import type { BranchId, ContextSourceId, DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { lockDocumentNamespaces } from "../adapters/context-fs/document-locations.js";
import { lockDocuments } from "./node-rows.js";
import { loadBranchCreatedDocuments, loadDocumentIdentityRows } from "./tree-view-sql.js";

/** What a tree mutation touches: documents, and every source they sit in now or in a branch. */
export type TreeScope = {
  documentIds: readonly DocumentId[];
  sourceIds: readonly ContextSourceId[];
};

/**
 * What to lock: each branch's created documents (all of them, or the named ones) at their
 * rows and at the branch's location, and other documents where they sit now (an item's
 * text, a document Apply restores, a node a read repairs). Tombstones count where they sit.
 */
export type TreeScopeRequest = {
  branches?: readonly { branchId: BranchId; documentIds?: readonly DocumentId[] }[];
  documentIds?: readonly DocumentId[];
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
