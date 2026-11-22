/**
 * Which tree lists a Work's tree spans. A Work's drafted records are in the list of the source
 * they were made in: its project's list, or the account's for `user://`.
 */
import type { DraftId } from "@meridian/contracts";
import type { TreeSaw } from "@meridian/contracts/drafts";
import { sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";

/** The lists a Work's draft can hold records in: its project's, and its owner's account list. */
export async function treeListsOfDraft(db: DrizzleDb, draftId: DraftId): Promise<TreeList[]> {
  const [row] = await currentDrizzleDb(db).execute<{ project_id: string; user_id: string }>(sql`
    SELECT b.project_id::text AS project_id, p.user_id::text AS user_id
    FROM drafts b JOIN projects p ON p.id = b.project_id WHERE b.id = ${draftId}`);
  if (!row) return [];
  return [
    { kind: "project", projectId: row.project_id },
    { kind: "account", userId: row.user_id },
  ];
}

/** The list that claimed a node id: the one whose records and rows hold the node. */
export async function treeListOfNode(db: DrizzleDb, nodeId: string): Promise<TreeList | null> {
  const [row] = await currentDrizzleDb(db).execute<{
    project_id: string | null;
    user_id: string | null;
  }>(sql`
    SELECT p.id::text AS project_id, u.id::text AS user_id
    FROM tree_node_ids n
      LEFT JOIN projects p ON p.tree_list_id = n.list_id
      LEFT JOIN users u ON u.tree_list_id = n.list_id
    WHERE n.id = ${nodeId}::uuid`);
  if (row?.project_id) return { kind: "project", projectId: row.project_id };
  if (row?.user_id) return { kind: "account", userId: row.user_id };
  return null;
}

/** The list that holds each of `nodeIds`, in one read; a node no list holds is absent. */
export async function treeListsOfNodes(
  db: DrizzleDb,
  nodeIds: readonly string[],
): Promise<Map<string, TreeList>> {
  if (nodeIds.length === 0) return new Map();
  const rows = await currentDrizzleDb(db).execute<{
    id: string;
    project_id: string | null;
    user_id: string | null;
  }>(sql`
    SELECT n.id::text AS id, p.id::text AS project_id, u.id::text AS user_id
    FROM tree_node_ids n
      LEFT JOIN projects p ON p.tree_list_id = n.list_id
      LEFT JOIN users u ON u.tree_list_id = n.list_id
    WHERE n.id IN (${sql.join(
      nodeIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
  return new Map(
    rows.flatMap((row): [string, TreeList][] =>
      row.project_id
        ? [[row.id, { kind: "project", projectId: row.project_id }]]
        : row.user_id
          ? [[row.id, { kind: "account", userId: row.user_id }]]
          : [],
    ),
  );
}

/**
 * The cut a review list is drawn at: each of the draft's lists, its id and version vector
 * as the list stands. Read before the rows, at READ COMMITTED: the copy is never ahead of what
 * committed and rows read after it are at least as new, so the only error is a record the cut
 * misses, which stays pending. A REPEATABLE READ snapshot would let the copy run ahead of rows.
 */
export async function treeCutOf(
  db: DrizzleDb,
  treeLists: Pick<TreeListStore, "read">,
  draftId: DraftId,
): Promise<TreeSaw> {
  const lists = await treeListsOfDraft(db, draftId);
  if (lists.length === 0) return {};
  return treeLists.read({
    lists,
    view: (ends) =>
      Object.fromEntries(
        ends.map((end, at) => [
          (lists[at] as TreeList).kind,
          {
            list: end.list,
            vector: Buffer.from(end.writer.doc.oplogVersion().encode()).toString("base64"),
          },
        ]),
      ),
  });
}
