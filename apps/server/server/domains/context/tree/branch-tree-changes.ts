/**
 * A branch's drafted moves and deletes (D26, design-v2 §1): facts on its row, never a change
 * to the shared tree. A move places the document in the branch (missing folders are made
 * hidden, as a branch's create makes them); a delete hides it there; an inverse writes back
 * the facts its entry recorded. Live is untouched until the writer applies them.
 *
 * Every function runs in its caller's transaction, which holds the drafting Work, the branch
 * and the namespaces of every source involved (where the branch has the document, and where it
 * goes); the document lock is taken here.
 */
import {
  type BranchId,
  type BranchTreeFacts,
  type ContextSourceId,
  type DocumentId,
  type FolderId,
  sameBranchFacts,
  type ThreadId,
  type TreePlacement,
  type TurnId,
  type UserId,
} from "@meridian/contracts";
import { allocateFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import {
  readBranchTreeFacts,
  settleBranchEntries,
  writeBranchTreeFacts,
} from "./branch-tree-store.js";
import { filePath, insertFolder, lockDocuments } from "./node-rows.js";
import { walkFolders } from "./placement.js";
import { chainPrefix, loadFolderChains } from "./tree-addresses.js";
import { createTreeReader, type TreeView } from "./tree-view.js";
import {
  findHiddenFolder,
  loadDocumentIdentityRows,
  loadFolderIdentityRows,
} from "./tree-view-sql.js";

/** What a drafted tree change did to the branch's row: the transition its tree entry records. */
export type BranchTreeChange = { before: BranchTreeFacts; after: BranchTreeFacts };

export type BranchTreeFault =
  /** The branch's view doesn't show the document (any more). */
  | { code: "not_found" }
  /** The move names the place the branch already has it. */
  | { code: "already_there" }
  /** Another node holds the destination, or a document a folder on its way. */
  | { code: "conflict"; occupantKind: "file" | "folder" }
  /** Two nodes share a path on the way. */
  | { code: "ambiguous" };

type ChangedBy = { threadId: ThreadId; turnId?: TurnId } | null;

async function factsOf(
  db: Database,
  branchId: BranchId,
  documentId: DocumentId,
): Promise<BranchTreeFacts> {
  const facts = (await readBranchTreeFacts(currentDrizzleDb(db), [branchId], [documentId]))
    .get(branchId)
    ?.get(documentId);
  if (!facts) throw new Error(`No facts read for ${documentId}`);
  return facts;
}

async function locationVersion(db: Database, documentId: DocumentId): Promise<bigint> {
  const [row] = await loadDocumentIdentityRows(currentDrizzleDb(db), [documentId]);
  if (!row) throw new Error(`Unknown document ${documentId}`);
  return row.locationVersion;
}

/**
 * The branch moves a document it shows to `to`: its row says `moved` there, and the folders
 * the branch doesn't see yet are made hidden (a hidden folder at the path is joined). The
 * destination is a claim as a document in the branch's view; there is no overwrite.
 */
export async function moveInBranch(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    to: {
      contextSourceId: ContextSourceId;
      dir: readonly string[];
      name: string;
      extension: string;
    };
    changedBy: ChangedBy;
  },
): Promise<Result<BranchTreeChange, BranchTreeFault>> {
  const view: TreeView = { kind: "branch", branchId: input.branchId };
  const tree = createTreeReader(db);
  await lockDocuments(db, [input.documentId]);
  if ((await tree.findById(view, input.documentId)).kind !== "found")
    return Err({ code: "not_found" });
  const { contextSourceId } = input.to;
  const desiredPath = filePath(input.to.dir, input.to.name, input.to.extension);
  const occupant = await tree.resolvePath(view, {
    contextSourceId,
    path: desiredPath,
    as: "document",
  });
  if (occupant.kind === "ambiguous") return Err({ code: "ambiguous" });
  if (occupant.kind === "found") {
    if (occupant.node.kind === "document" && occupant.node.document.id === input.documentId)
      return Err({ code: "already_there" });
  }
  const filename = await allocateFilename(
    { kind: "document", name: input.to.name, extension: input.to.extension },
    async ({ filename }) => {
      const found = await tree.resolvePath(view, {
        contextSourceId,
        path: filePath(input.to.dir, filename, ""),
        as: "document",
      });
      if (found.kind === "not_found") return false;
      if (found.kind === "ambiguous") return true;
      return !(found.node.kind === "document" && found.node.document.id === input.documentId);
    },
  );
  const landedName = input.to.extension
    ? filename.slice(0, -(input.to.extension.length + 1))
    : filename;
  const walk = await walkFolders(db, view, contextSourceId, input.to.dir, async (gap) => {
    const at = { contextSourceId, ...gap };
    return (await findHiddenFolder(db, at)) ?? (await insertFolder(db, at, { hidden: true }));
  });
  if (walk.kind === "occupied")
    return Err(walk.occupant.kind === "ambiguous" ? { code: "ambiguous" } : conflictWithFile);
  if (walk.kind !== "walked") throw new Error("A branch's folder walk fills every gap");
  const before = await factsOf(db, input.branchId, input.documentId);
  const after: BranchTreeFacts = {
    row: true,
    created: before.created,
    moved: {
      folderId: walk.folderId,
      rootSourceId: walk.folderId === null ? contextSourceId : null,
      name: landedName,
      extension: input.to.extension,
    },
    deleted: false,
  };
  await writeBranchTreeFacts(db, {
    branchId: input.branchId,
    documentId: input.documentId,
    facts: after,
    locationVersion: await locationVersion(db, input.documentId),
    changedBy: input.changedBy,
  });
  return Ok({ before, after });
}

const conflictWithFile: BranchTreeFault = { code: "conflict", occupantKind: "file" };

/**
 * The branch deletes a document it shows: its row says `deleted`, which hides the document
 * and its text changes in the branch only. A move under it is kept, masked, for the delete's
 * undo; the text draft stays active, so the undo loses nothing.
 */
export async function deleteInBranch(
  db: Database,
  input: { branchId: BranchId; documentId: DocumentId; changedBy: ChangedBy },
): Promise<Result<BranchTreeChange, Extract<BranchTreeFault, { code: "not_found" }>>> {
  await lockDocuments(db, [input.documentId]);
  const view: TreeView = { kind: "branch", branchId: input.branchId };
  if ((await createTreeReader(db).findById(view, input.documentId)).kind !== "found")
    return Err({ code: "not_found" });
  const before = await factsOf(db, input.branchId, input.documentId);
  const after: BranchTreeFacts = { ...before, row: true, deleted: true };
  await writeBranchTreeFacts(db, {
    branchId: input.branchId,
    documentId: input.documentId,
    facts: after,
    locationVersion: await locationVersion(db, input.documentId),
    changedBy: input.changedBy,
  });
  return Ok({ before, after });
}

/**
 * The writer discards the branch's move or delete of a document (a tree line, or the tree half
 * of an item's Discard): the row keeps only a creation, and its drafted entries are settled as
 * discarded, which prunes every hidden folder they held that nothing else uses. False when it
 * had neither.
 */
export async function discardBranchTreeFacts(
  db: Database,
  input: { branchId: BranchId; documentId: DocumentId; userId: UserId | null },
): Promise<{ discarded: boolean }> {
  await lockDocuments(db, [input.documentId]);
  const facts = await factsOf(db, input.branchId, input.documentId);
  if (!facts.moved && !facts.deleted) return { discarded: false };
  await writeBranchTreeFacts(db, {
    branchId: input.branchId,
    documentId: input.documentId,
    facts: { ...facts, moved: null, deleted: false },
    locationVersion: await locationVersion(db, input.documentId),
    changedBy: null,
  });
  await settleBranchEntries(db, {
    branchId: input.branchId,
    documentIds: [input.documentId],
    settle: { as: "discarded", userId: input.userId },
  });
  return { discarded: true };
}

/** Why a branch inverse can't write its facts back, under the caller's locks. */
export type BranchFactsFault = "superseded" | "folder_missing" | "location_taken";

/**
 * Writes back the facts a drafted tree entry recorded (an undo writes its `before`, a redo its
 * `after`): only while the row still holds `expected`, into a moved folder that still stands,
 * and only where the branch's view has room for the document it shows again.
 */
export async function writeBackBranchFacts(
  db: Database,
  input: {
    branchId: BranchId;
    documentId: DocumentId;
    expected: BranchTreeFacts;
    facts: BranchTreeFacts;
    changedBy: ChangedBy;
  },
): Promise<BranchFactsFault | null> {
  await lockDocuments(db, [input.documentId]);
  const current = await factsOf(db, input.branchId, input.documentId);
  if (!sameBranchFacts(current, input.expected)) return "superseded";
  let facts = input.facts;
  const moved = facts.moved;
  if (moved?.folderId) {
    // A hidden folder is gone once tombstoned; a live folder deleted since still shows in the
    // branch above the document, as a draft that outlived a delete does (D79).
    const [folder] = await loadFolderIdentityRows(currentDrizzleDb(db), [
      moved.folderId as FolderId,
    ]);
    if (!folder || (folder.hidden && folder.deleted)) return "folder_missing";
  }
  if (!facts.deleted) facts = await freeFactsInBranch(db, { ...input, facts });
  await writeBranchTreeFacts(db, {
    branchId: input.branchId,
    documentId: input.documentId,
    facts,
    locationVersion: await locationVersion(db, input.documentId),
    changedBy: input.changedBy,
  });
  return null;
}

/** Another node the branch shows holds the place `facts` give the document. */
async function freeFactsInBranch(
  db: Database,
  input: { branchId: BranchId; documentId: DocumentId; facts: BranchTreeFacts },
): Promise<BranchTreeFacts> {
  const [row] = await loadDocumentIdentityRows(currentDrizzleDb(db), [input.documentId]);
  if (!row) return input.facts;
  const at: TreePlacement = input.facts.moved ?? {
    folderId: row.folderId,
    rootSourceId: row.folderId ? null : row.contextSourceId,
    name: row.name,
    extension: row.extension,
  };
  const folderId = at.folderId as FolderId | null;
  const [folder] = folderId ? await loadFolderIdentityRows(currentDrizzleDb(db), [folderId]) : [];
  const contextSourceId = (folder?.contextSourceId ?? at.rootSourceId) as ContextSourceId | null;
  if (!contextSourceId) return input.facts;
  const chain = folderId
    ? ((await loadFolderChains(currentDrizzleDb(db), [folderId])).get(folderId) ?? [])
    : [];
  const prefix = chainPrefix(chain);
  const view = { kind: "branch", branchId: input.branchId } as const;
  const filename = await allocateFilename(
    { kind: "document", name: at.name, extension: at.extension },
    async ({ filename }) => {
      const [here] = await createTreeReader(db).occupancy(view, [
        { contextSourceId, path: prefix + filename, as: "document" },
      ]);
      return (
        !!here && (here.documents.some((id) => id !== input.documentId) || here.folders.length > 0)
      );
    },
  );
  const name = at.extension ? filename.slice(0, -(at.extension.length + 1)) : filename;
  if (name === at.name) return input.facts;
  return {
    ...input.facts,
    moved: { ...at, name },
  };
}
