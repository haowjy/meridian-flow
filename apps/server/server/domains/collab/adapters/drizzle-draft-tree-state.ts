/**
 * The tree half of the review list, read from the Work's rows (`draft_tree_nodes`, written by
 * the replay of the list) against live's (`tree_nodes`). Addresses are spelled by the tree reader.
 * A row the Work did not change (`changed` false: only a twin's suffix differs) is no row here.
 */
import { type DraftId, isDraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { pendingDocuments } from "../../context/tree/pending-documents.js";
import { type IdentityStatus, LIVE_TREE, type TreeReader } from "../../context/tree/tree-view.js";
import type {
  DraftDocumentTree,
  DraftTreeChange,
  DraftTreeStateReader,
} from "../domain/ports/draft-tree-state.js";

type Row = {
  id: string;
  exists_only_in_draft: boolean | null;
  deleted: boolean | null;
  live: boolean;
  binary: boolean;
};

/** The folders the Work has a row on: what an Apply of a folder lands. */
export async function draftFolderIds(db: Database, draftId: DraftId): Promise<{ id: string }[]> {
  if (!isDraftId(draftId)) return [];
  const rows = await currentDrizzleDb(db).execute<{ id: string }>(sql`
    SELECT b.id::text AS id
    FROM draft_tree_nodes b
    WHERE b.draft_id = ${draftId} AND b.kind = 'folder' AND b.changed`);
  return [...rows];
}

/**
 * Where live has (or, in Trash, last had) a document the Work keeps elsewhere: a Work's move of
 * a document out of its own applied delete is still a move. Null when live's address is the
 * Work's.
 */
function movedFrom(live: IdentityStatus | undefined, workUri: string | null): string | null {
  const at =
    live?.kind === "visible"
      ? live.address.uri
      : live?.kind === "deleted"
        ? (live.lastAddress?.uri ?? null)
        : null;
  return at !== null && (live?.kind === "visible" || at !== workUri) ? at : null;
}

export function createDrizzleDraftTreeState(
  db: Database,
  tree: Pick<TreeReader, "identityStatus">,
): DraftTreeStateReader {
  return {
    async read(draftId: DraftId, editedIds = [], onlyIds) {
      if (!isDraftId(draftId)) return [];
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
          t.id IS NOT NULL AS live, d.storage_url IS NOT NULL AS binary
        FROM documents d
          LEFT JOIN draft_tree_nodes b
            ON b.id = d.id AND b.draft_id = ${draftId} AND b.changed
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
            FROM (${pendingDocuments(sql`${draftId}`)}) p
            WHERE p.document_id IN (${ids(documentIds)})`)
        ).map((row) => row.document_id),
      );
      const inDraft = await tree.identityStatus({ kind: "draft", draftId }, documentIds);
      const moving = found.filter((row) => row.deleted === false && !row.exists_only_in_draft);
      const inLive = await tree.identityStatus(
        LIVE_TREE,
        moving.map((row) => row.id as DocumentId),
      );
      return found.map((row): DraftDocumentTree => {
        const id = row.id as DocumentId;
        const created = row.exists_only_in_draft === true;
        const change: DraftTreeChange | null =
          row.deleted === null ? null : created ? "created" : row.deleted ? "deleting" : "moving";
        const here = inDraft.get(id);
        const there = inLive.get(id);
        const uri =
          here?.kind === "visible"
            ? here.address.uri
            : here?.kind === "deleted"
              ? (here.lastAddress?.uri ?? null)
              : null;
        return {
          documentId: id,
          origin: created ? "created" : "edited",
          isNew: created && row.deleted === false,
          binary: row.binary,
          change,
          pending: pending.has(id),
          uri,
          movedFromUri: change === "moving" ? movedFrom(there, uri) : null,
        };
      });
    },
  };
}
