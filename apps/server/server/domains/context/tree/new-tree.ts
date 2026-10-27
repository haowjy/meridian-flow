/**
 * Set-based insert of a tree of brand-new live nodes: a Copy's result. One statement per
 * batch of rows replaces one create per node (about fifteen statements each), so the time the
 * namespace lock is held grows with the bytes written, not with a round trip per document.
 *
 * The caller holds the namespace lock and has proven that no live or hidden node holds a
 * root's name. Everything below a root sits in a folder this call creates, so nothing else
 * can hold its name. That is what lets this skip, per node, what a single create does for an
 * occupied namespace: the occupancy check, the hidden-candidate pick and the yield of hidden
 * nodes that claim the same name (`createLive`, `normalizeNames`).
 */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import type { ContextSiblingPosition } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documentMarkdownProjections, documents, folders } from "@meridian/database/schema";
import { generateNKeysBetween } from "fractional-indexing";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { ContextEntryConflictError } from "../ports/context-document-store.js";
import type { BinaryNode, TrackedNode } from "./hidden-node-types.js";
import { type ClaimedLocation, recordLocationHistory } from "./node-locations.js";
import { documentRowValues, folderRowValues } from "./node-rows.js";
import { arrivalRanks, placeLiveSibling } from "./sibling-order.js";
import { loadDocumentIdentityRows, loadFolderIdentityRows } from "./tree-view-sql.js";

export type NewTreeNode =
  | {
      kind: "folder";
      id: FolderId;
      name: string;
      /** The children's ordering; a manual folder's children take ranks in the order given. */
      orderPolicy: "default" | "manual";
      children: readonly NewTreeNode[];
    }
  | {
      kind: "document";
      id: DocumentId;
      name: string;
      extension: string;
      /** Source-relative path with the extension: the address this row claims. */
      path: string;
      node: TrackedNode | BinaryNode;
    };

/** Rows per statement: bounds the parameter count, not the atomic operation. */
const BATCH = 500;

type ParentRun = {
  parentId: FolderId | null;
  nodes: readonly NewTreeNode[];
  ranks: readonly (string | null)[];
};

/**
 * Insert `roots` under `parentId`, every folder before the rows inside it. The roots arrive
 * as a run by the parent's ordinary rule, then move to `position` when one is given:
 * `stale-anchor` when the sibling it names is gone. Otherwise the ids it created, for the
 * caller's catalog refresh and arrivals.
 */
export async function insertNewTree(
  db: Database,
  input: {
    sourceId: ContextSourceId;
    parentId: FolderId | null;
    roots: readonly NewTreeNode[];
    position?: ContextSiblingPosition;
  },
): Promise<{ folderIds: FolderId[]; binaryIds: DocumentId[] } | "stale-anchor"> {
  const { sourceId, parentId, roots } = input;
  // A client may mint a root's identity (`copyId`). Any row already holding it — live,
  // hidden, deleted, another source's, or a document's — makes it unusable. A replay never
  // comes here (its receipt answers it), so every holder is a conflict. Descendants are
  // server-minted, so only roots need the check.
  const rootIds = roots.map((root) => root.id);
  const [heldFolders, heldDocuments] = await Promise.all([
    loadFolderIdentityRows(db, rootIds as FolderId[]),
    loadDocumentIdentityRows(db, rootIds as DocumentId[]),
  ]);
  if (heldFolders.length > 0 || heldDocuments.length > 0) {
    throw new ContextEntryConflictError(heldFolders.length > 0 ? "folder" : "file");
  }
  const folderRows: (ReturnType<typeof folderRowValues> & { rank: string | null })[] = [];
  const documentRows: (ReturnType<typeof documentRowValues> & { rank: string | null })[] = [];
  const projectionRows: { documentId: DocumentId }[] = [];
  const claimed: ClaimedLocation[] = [];
  const binaryIds: DocumentId[] = [];

  // Breadth first: a folder's row is inserted before the rows that name it as their parent.
  let runs: ParentRun[] = [
    {
      parentId,
      nodes: roots,
      ranks: await arrivalRanks(db, { sourceId, parentId, count: roots.length }),
    },
  ];
  while (runs.length > 0) {
    const next: ParentRun[] = [];
    for (const run of runs) {
      run.nodes.forEach((node, index) => {
        const rank = run.ranks[index] ?? null;
        if (node.kind === "folder") {
          folderRows.push({
            ...folderRowValues(
              { contextSourceId: sourceId, parentId: run.parentId, name: node.name },
              { hidden: false, id: node.id, orderPolicy: node.orderPolicy },
            ),
            rank,
          });
          if (node.children.length > 0) {
            next.push({
              parentId: node.id,
              nodes: node.children,
              ranks:
                node.orderPolicy === "manual"
                  ? generateNKeysBetween(null, null, node.children.length)
                  : [],
            });
          }
          return;
        }
        documentRows.push({
          ...documentRowValues(
            {
              contextSourceId: sourceId,
              folderId: run.parentId,
              name: node.name,
              extension: node.extension,
            },
            node.node,
            { hidden: false, id: node.id },
          ),
          rank,
        });
        if (node.node.kind === "tracked") projectionRows.push({ documentId: node.id });
        else binaryIds.push(node.id);
        claimed.push({ contextSourceId: sourceId, path: node.path });
      });
    }
    runs = next;
  }

  const tx = currentDrizzleDb(db);
  for (let offset = 0; offset < folderRows.length; offset += BATCH) {
    await tx.insert(folders).values(folderRows.slice(offset, offset + BATCH));
  }
  for (let offset = 0; offset < documentRows.length; offset += BATCH) {
    await tx.insert(documents).values(documentRows.slice(offset, offset + BATCH));
  }
  for (let offset = 0; offset < projectionRows.length; offset += BATCH) {
    await tx
      .insert(documentMarkdownProjections)
      .values(projectionRows.slice(offset, offset + BATCH));
  }
  // A path an old document vacated is claimed by the live one that now sits there.
  await recordLocationHistory(db, { vacated: [], claimed });

  let position = input.position;
  for (const root of roots) {
    if (!position) break;
    const placed = await placeLiveSibling(db, {
      node: { kind: root.kind, id: root.id },
      sourceId,
      parentId,
      position,
      arrived: false,
    });
    if (placed === "stale-anchor") return placed;
    position = { kind: "after", siblingId: root.id };
  }
  return { folderIds: folderRows.flatMap((row) => (row.id ? [row.id] : [])), binaryIds };
}
