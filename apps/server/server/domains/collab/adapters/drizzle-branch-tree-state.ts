/**
 * The tree half of the review list, read from the Work's rows (`branch_tree_nodes`, written by
 * the replay of the list) against live's (`tree_nodes`). Addresses are spelled by the tree reader.
 */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { pendingDocuments } from "../../context/tree/pending-documents.js";
import { LIVE_TREE, type TreeReader } from "../../context/tree/tree-view.js";
import type {
  BranchDocumentTree,
  BranchTreeChange,
  BranchTreeStateReader,
} from "../domain/ports/branch-tree-state.js";

type Row = {
  id: string;
  exists_only_in_draft: boolean | null;
  deleted: boolean | null;
  live: boolean;
  live_trashed: boolean;
  binary: boolean;
  revision: string | null;
};

/** One digest of everything a Work's row says, so a click that froze it sees any later change. */
const REVISION = sql`md5(concat_ws('|', b.context_source_id::text, coalesce(b.parent_id::text, ''),
  b.name, b.rank, b.deleted::text, b.exists_only_in_draft::text))`;

export function createDrizzleBranchTreeState(
  db: Database,
  tree: Pick<TreeReader, "identityStatus">,
): BranchTreeStateReader {
  return {
    async read(branchId: BranchId, editedIds = [], onlyIds) {
      if (!isUuid(branchId)) return [];
      const edited = editedIds.filter(isUuid);
      const only = onlyIds?.filter(isUuid);
      const tx = currentDrizzleDb(db);
      const ids = (list: readonly string[]) =>
        sql.join(
          list.filter(isUuid).map((id) => sql`${id}::uuid`),
          sql`, `,
        );
      const rows = await tx.execute<Row>(sql`
        SELECT d.id::text AS id, b.exists_only_in_draft, b.deleted,
          t.id IS NOT NULL AS live, coalesce(t.trash_record IS NOT NULL, false) AS live_trashed,
          d.storage_url IS NOT NULL AS binary,
          CASE WHEN b.id IS NULL THEN NULL ELSE ${REVISION} END AS revision
        FROM documents d
          LEFT JOIN branch_tree_nodes b ON b.id = d.id AND b.branch_id = ${branchId}::uuid
          LEFT JOIN tree_nodes t ON t.id = d.id
        WHERE (b.id IS NOT NULL
          OR (t.trash_record IS NULL AND t.id IS NOT NULL
            AND ${edited.length ? sql`d.id IN (${ids(edited)})` : sql`false`}))
          ${only ? (only.length ? sql`AND d.id IN (${ids(only)})` : sql`AND false`) : sql``}`);
      const found = [...rows];
      if (found.length === 0) return [];
      const documentIds = found.map((row) => row.id as DocumentId);
      const pending = new Set(
        (
          await tx.execute<{ document_id: string }>(sql`
            SELECT p.document_id::text AS document_id
            FROM (${pendingDocuments(sql`${branchId}::uuid`)}) p
            WHERE p.document_id IN (${ids(documentIds)})`)
        ).map((row) => row.document_id),
      );
      const inBranch = await tree.identityStatus({ kind: "branch", branchId }, documentIds);
      const moving = found.filter((row) => row.deleted === false && !row.exists_only_in_draft);
      const inLive = await tree.identityStatus(
        LIVE_TREE,
        moving.map((row) => row.id as DocumentId),
      );
      return found.map((row): BranchDocumentTree => {
        const id = row.id as DocumentId;
        const created = row.exists_only_in_draft === true;
        const change: BranchTreeChange | null =
          row.deleted === null ? null : created ? "created" : row.deleted ? "deleting" : "moving";
        const here = inBranch.get(id);
        const there = inLive.get(id);
        return {
          documentId: id,
          origin: created ? "created" : "edited",
          isNew: created && row.deleted === false,
          binary: row.binary,
          deletedLive: change === "moving" && row.live_trashed,
          change,
          revision: row.revision,
          pending: pending.has(id),
          uri:
            here?.kind === "visible"
              ? here.address.uri
              : here?.kind === "deleted"
                ? (here.lastAddress?.uri ?? null)
                : null,
          movedFromUri: change === "moving" && there?.kind === "visible" ? there.address.uri : null,
        };
      });
    },
  };
}
