/**
 * Which tree lists a Work's tree spans, and the Work's pending records in them. A Work's drafted
 * records are in the list of the source they were made in: its project's list, or the account's
 * for `user://`. The lists are read through the store's `read`, at the journal's head.
 */
import type { BranchId, DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { pendingRecords, type TreeRecord } from "@meridian/project-tree";
import { sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TreeList, TreeListStore } from "../../context/ports/tree-list-store.js";

/** The lists a Work's branch can hold records in: its project's, and its owner's account list. */
export async function treeListsOfBranch(db: DrizzleDb, branchId: BranchId): Promise<TreeList[]> {
  const [row] = await currentDrizzleDb(db).execute<{ project_id: string; user_id: string }>(sql`
    SELECT b.project_id::text AS project_id, p.user_id::text AS user_id
    FROM branches b JOIN projects p ON p.id = b.project_id WHERE b.id = ${branchId}::uuid`);
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

/** A pending record with the list that holds it. */
export type PendingTreeRecord = { list: TreeList; record: TreeRecord };

/** The Work's pending tree records in every list it spans, each list in list order. */
export async function readPendingTreeRecords(
  db: Database,
  store: Pick<TreeListStore, "read">,
  branchId: BranchId,
): Promise<PendingTreeRecord[]> {
  const lists = await treeListsOfBranch(db, branchId);
  return store.read({
    lists,
    view: (copies) =>
      copies.flatMap(({ writer }, at) =>
        pendingRecords(writer.doc, branchId).map((record) => ({
          list: lists[at] as TreeList,
          record,
        })),
      ),
  });
}

/**
 * The pending records that are one document's item: the ones made on it, and a drafted delete
 * of a folder above it that took it along.
 */
export function recordsOfItem(
  records: readonly TreeRecord[],
  documentId: DocumentId,
): TreeRecord[] {
  return records.filter(
    (record) =>
      record.node === documentId ||
      (record.type === "delete" && record.cascade.includes(documentId)),
  );
}
