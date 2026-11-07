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
import { resolveAbsorbedFolders } from "./folder-normalization.js";
import { bumpLocationVersions, recordLocationHistory } from "./node-locations.js";
import { moveNode } from "./node-moves.js";
import { type PlaceTarget, placeLiveCycle } from "./placement.js";
import { applyLiveRank } from "./sibling-order.js";
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
      rank: documents.rank,
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
                rank: row.rank,
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
  | { kind: "ancestor_taken" }
  | { kind: "folder_missing" }
  | { kind: "refused" };

/**
 * Moves a dependency cycle as one namespace change. The documents leave the live namespace
 * together before any target is claimed, so a swap does not invent temporary public names.
 * The caller holds every source namespace and document row in the cycle.
 */
export async function movePlacementCycle(
  db: Database,
  moves: readonly { documentId: DocumentId; to: PlaceTarget["at"] }[],
  deps: {
    arrivals?: Pick<DocumentArrivals, "settle">;
    catalog: Pick<ContextCatalogMutationPort, "refreshSources">;
  },
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const ids = moves.map(({ documentId }) => documentId);
  const rows = await tx
    .select({
      id: documents.id,
      sourceId: documents.contextSourceId,
      folderId: documents.folderId,
      name: documents.name,
      extension: documents.extension,
      hidden: documents.hidden,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(inArray(documents.id, ids));
  if (
    rows.length !== ids.length ||
    rows.some(({ hidden, deletedAt }) => hidden || deletedAt !== null)
  )
    throw new Error("A placement cycle requires living documents");
  const chains = await loadFolderChains(tx, [
    ...rows.map(({ folderId }) => folderId),
    ...moves.map(({ to }) => to.parentFolderId),
  ]);
  const before = new Map(
    rows.map((row) => [
      row.id as DocumentId,
      {
        contextSourceId: row.sourceId,
        path: [
          ...(row.folderId
            ? [...(chains.get(row.folderId) ?? [])].reverse().map(({ name }) => name)
            : []),
          row.extension ? `${row.name}.${row.extension}` : row.name,
        ].join("/"),
      },
    ]),
  );
  const now = new Date();
  await tx
    .update(documents)
    .set({ hidden: true, updatedAt: now })
    .where(inArray(documents.id, ids));
  const placed = await placeLiveCycle(
    db,
    moves.map((move) => ({
      node: { kind: "document" as const, id: move.documentId },
      at: move.to,
    })),
    async (placements) => {
      for (const { target, parentId, at } of placements)
        await tx
          .update(documents)
          .set({
            contextSourceId: at.contextSourceId,
            folderId: parentId,
            name: at.name,
            extension: at.extension ?? "",
            updatedAt: now,
          })
          .where(inArray(documents.id, [target.node.id]));
      await tx
        .update(documents)
        .set({ hidden: false, updatedAt: now })
        .where(inArray(documents.id, ids));
    },
  );
  if (!placed.ok) throw new Error(`Placement cycle failed: ${placed.error.code}`);
  const finalRows = await tx
    .select({
      id: documents.id,
      sourceId: documents.contextSourceId,
      folderId: documents.folderId,
      name: documents.name,
      extension: documents.extension,
    })
    .from(documents)
    .where(inArray(documents.id, ids));
  const finalChains = await loadFolderChains(
    tx,
    finalRows.map(({ folderId }) => folderId),
  );
  await recordLocationHistory(db, {
    vacated: ids.map((documentId) => ({
      ...(before.get(documentId) as { contextSourceId: string; path: string }),
      documentId,
    })),
    claimed: finalRows.map((row) => {
      return {
        contextSourceId: row.sourceId,
        path: [
          ...(row.folderId
            ? [...(finalChains.get(row.folderId) ?? [])].reverse().map(({ name }) => name)
            : []),
          row.extension ? `${row.name}.${row.extension}` : row.name,
        ].join("/"),
      };
    }),
  });
  await bumpLocationVersions(db, { documentIds: ids });
  await deps.arrivals?.settle(ids);
  await deps.catalog.refreshSources(
    [
      ...new Set([
        ...rows.map(({ sourceId }) => sourceId),
        ...moves.map(({ to }) => to.contextSourceId),
      ]),
    ],
    ids,
  );
}

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
    /** Apply reconciles branch-relative neighbours after every tree lifecycle path lands. */
    deferOrder?: boolean;
  },
): Promise<ReturnMoveOutcome> {
  const tx = currentDrizzleDb(db);
  let sourceId = input.to.rootSourceId as ContextSourceId | null;
  let dir: string[] = [];
  if (input.to.folderId) {
    const requested = input.to.folderId as FolderId;
    const folderId = (await resolveAbsorbedFolders(db, [requested])).get(requested) ?? requested;
    const chain = (await loadFolderChains(tx, [folderId])).get(folderId);
    if (!chain?.length || chain.some((folder) => folder.deleted)) return { kind: "folder_missing" };
    const [folder] = await tx
      .select({ sourceId: folders.contextSourceId })
      .from(folders)
      .where(inArray(folders.id, [folderId]));
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
    return moved.error.code === "conflict" ? { kind: "ancestor_taken" } : { kind: "refused" };
  const [placed] = await tx
    .select({ sourceId: documents.contextSourceId, folderId: documents.folderId })
    .from(documents)
    .where(inArray(documents.id, [input.documentId]));
  if (!placed) return { kind: "refused" };
  if (!deps.deferOrder)
    await applyLiveRank(db, {
      documentId: input.documentId,
      sourceId: placed.sourceId,
      parentId: placed.folderId,
      rank: input.to.rank,
    });
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
      rank: documents.rank,
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
      rank: landed.rank,
    },
  };
}
