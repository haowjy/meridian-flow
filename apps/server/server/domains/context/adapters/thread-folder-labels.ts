/** Batched presentation for associated roots, independent of their stored basenames. */
import type { Database } from "@meridian/database";
import { threads } from "@meridian/database/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { LIVE_TREE, visibleFolders } from "../tree/tree-view.js";

export async function loadThreadFolderLabels(
  db: Pick<Database, "select">,
  folderIds: readonly string[],
): Promise<Map<string, string>> {
  if (folderIds.length === 0) return new Map();
  const vf = visibleFolders(LIVE_TREE);
  const parent = alias(threads, "notes_parent");
  const rows = await db
    .select({ id: vf.id, title: threads.title, kind: threads.kind, parentTitle: parent.title })
    .from(vf)
    .leftJoin(threads, eq(threads.id, vf.threadId))
    .leftJoin(parent, eq(parent.id, threads.parentThreadId))
    .where(and(inArray(vf.id, folderIds), isNotNull(vf.threadId)));
  return new Map(
    rows.map((row) => [
      row.id,
      row.kind === "subagent"
        ? `${row.parentTitle?.trim() || "Untitled chat"} (subagent)`
        : row.title?.trim() || "Untitled chat",
    ]),
  );
}
