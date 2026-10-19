/** Live subtree discovery for content copying. Hidden/deleted descendants never enter the cut. */
import type { ContextSourceId, FolderId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { LIVE_TREE, visibleDocuments, visibleFolders } from "./tree-view.js";

export async function readLiveSubtree(db: Database, sourceId: ContextSourceId, rootId: FolderId) {
  const tx = currentDrizzleDb(db);
  const folders = visibleFolders(LIVE_TREE);
  const tree = await tx.execute<{
    id: FolderId;
    parent_id: FolderId | null;
    name: string;
    depth: number;
  }>(sql`
    WITH RECURSIVE live_folders AS (SELECT * FROM ${folders}), subtree AS (
      SELECT id, parent_id, name, 0 AS depth FROM live_folders
      WHERE id = ${rootId} AND context_source_id = ${sourceId}
      UNION ALL
      SELECT child.id, child.parent_id, child.name, parent.depth + 1
      FROM live_folders child JOIN subtree parent ON child.parent_id = parent.id
      WHERE child.context_source_id = ${sourceId}
    ) SELECT * FROM subtree ORDER BY depth, id`);
  const ids = Array.from(tree, (folder) => folder.id);
  const documents = visibleDocuments(LIVE_TREE);
  return {
    folders: Array.from(tree),
    documents: ids.length
      ? await tx.select().from(documents).where(inArray(documents.folderId, ids))
      : [],
  };
}
