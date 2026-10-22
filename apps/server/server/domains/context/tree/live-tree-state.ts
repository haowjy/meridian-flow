/**
 * A document's live placement as an edit history's tree entry records it (`LiveTreeState`), and
 * the moves that return a document to a recorded placement: a move's undo or redo. The caller
 * holds the namespaces of every source involved, then the document locks (`acquireTreeScope`,
 * with the recorded placements in `placements`).
 */
import type {
  ContextSourceId,
  DocumentId,
  FolderId,
  LiveTreeState,
  TreePlacement,
} from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";
import type { DocumentArrivals } from "../ports/document-arrivals.js";
import { moveNode } from "./node-moves.js";
import { loadFolderChains } from "./tree-addresses.js";

/**
 * Each document's live state: living where it sits, or removed by its current removal. A
 * hidden document (a branch's creation) has no live state: null.
 */
export async function readLiveTreeStates(
  db: Pick<DrizzleDb, "select">,
  ids: readonly DocumentId[],
): Promise<Map<DocumentId, LiveTreeState | null>> {
  const states = new Map<DocumentId, LiveTreeState | null>();
  if (!ids.length) return states;
  const rows = await db
    .select({
      id: documents.id,
      hidden: documents.hidden,
      sourceId: documents.contextSourceId,
      folderId: documents.folderId,
      name: documents.name,
      extension: documents.extension,
      deletedAt: documents.deletedAt,
      locationVersion: documents.locationVersion,
    })
    .from(documents)
    .where(inArray(documents.id, [...ids]));
  for (const row of rows)
    states.set(
      row.id as DocumentId,
      row.hidden
        ? null
        : row.deletedAt
          ? {
              living: false,
              removal: {
                time: row.deletedAt.toISOString(),
                locationVersion: row.locationVersion.toString(),
              },
            }
          : {
              living: true,
              at: {
                folderId: row.folderId,
                rootSourceId: row.folderId ? null : row.sourceId,
                name: row.name,
                extension: row.extension,
              },
            },
    );
  return states;
}

/** The sources recorded placements sit in now: a folder's current source, or the root's own. */
export async function placementSources(
  db: Database,
  placements: readonly TreePlacement[],
): Promise<ContextSourceId[]> {
  const sources = new Set<ContextSourceId>();
  const folderIds = new Set<FolderId>();
  for (const at of placements)
    if (at.folderId) folderIds.add(at.folderId as FolderId);
    else if (at.rootSourceId) sources.add(at.rootSourceId as ContextSourceId);
  if (folderIds.size)
    for (const row of await currentDrizzleDb(db)
      .select({ sourceId: folders.contextSourceId })
      .from(folders)
      .where(inArray(folders.id, [...folderIds])))
      sources.add(row.sourceId);
  return [...sources].sort();
}

export type ReturnMoveOutcome =
  | { kind: "moved"; at: TreePlacement }
  | { kind: "location_taken" }
  | { kind: "folder_missing" }
  | { kind: "refused" };

/**
 * Moves a living document back to a recorded placement, in the folder where that folder is now
 * (a folder moved since carries the return with it). A deleted folder is gone: the document
 * isn't brought back into a folder nobody restored. Settles arrivals and refreshes the catalog
 * in the caller's transaction.
 */
export async function moveToPlacement(
  db: Database,
  input: { documentId: DocumentId; from: TreePlacement; to: TreePlacement },
  deps: {
    arrivals?: Pick<DocumentArrivals, "settle">;
    catalog: Pick<ContextCatalogMutationPort, "refreshSources">;
  },
): Promise<ReturnMoveOutcome> {
  const tx = currentDrizzleDb(db);
  let sourceId = input.to.rootSourceId as ContextSourceId | null;
  let dir: string[] = [];
  if (input.to.folderId) {
    const chain = (await loadFolderChains(tx, [input.to.folderId as FolderId])).get(
      input.to.folderId as FolderId,
    );
    if (!chain?.length || chain.some((folder) => folder.deleted)) return { kind: "folder_missing" };
    const [folder] = await tx
      .select({ sourceId: folders.contextSourceId })
      .from(folders)
      .where(inArray(folders.id, [input.to.folderId as FolderId]));
    sourceId = folder?.sourceId ?? null;
    dir = [...chain].reverse().map((folder) => folder.name);
  }
  if (!sourceId) return { kind: "folder_missing" };
  const [fromSource] = (await placementSources(db, [input.from])) as (
    | ContextSourceId
    | undefined
  )[];
  const moved = await moveNode(db, {
    node: { kind: "document", id: input.documentId },
    to: { contextSourceId: sourceId, dir, name: input.to.name, extension: input.to.extension },
    filetype: null,
  });
  if (!moved.ok)
    return moved.error.code === "conflict" ? { kind: "location_taken" } : { kind: "refused" };
  await deps.arrivals?.settle(moved.value.documentIds);
  await deps.catalog.refreshSources(
    [...new Set([sourceId, ...(fromSource ? [fromSource] : [])])],
    [input.documentId],
  );
  const [landed] = await tx
    .select({
      sourceId: documents.contextSourceId,
      folderId: documents.folderId,
      name: documents.name,
      extension: documents.extension,
    })
    .from(documents)
    .where(inArray(documents.id, [input.documentId]));
  if (!landed) return { kind: "refused" };
  return {
    kind: "moved",
    at: {
      folderId: landed.folderId,
      rootSourceId: landed.folderId ? null : landed.sourceId,
      name: landed.name,
      extension: landed.extension,
    },
  };
}
