/**
 * The tree half of the review list, read from the Work's rows (`branch_tree_nodes`, written by
 * the replay of the list) against live's (`tree_nodes`). Addresses are spelled by the tree reader.
 */
import type { BranchId, DraftOwner } from "@meridian/contracts";
import type { DocumentId, ProjectId, ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { type SQL, sql } from "drizzle-orm";
import { ownerOfColumns } from "../../../shared/draft-owner.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { pendingDocuments } from "../../context/tree/pending-documents.js";
import { LIVE_TREE, type NodeAddress, type TreeReader } from "../../context/tree/tree-view.js";
import { ownsScratch } from "../../file-policy/index.js";
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
};

/** The folders the Work has a row on: what an Apply of a folder lands. */
export async function branchFolderIds(db: Database, branchId: BranchId): Promise<{ id: string }[]> {
  if (!isUuid(branchId)) return [];
  const rows = await currentDrizzleDb(db).execute<{ id: string }>(sql`
    SELECT b.id::text AS id
    FROM branch_tree_nodes b
    WHERE b.branch_id = ${branchId}::uuid AND b.kind = 'folder'`);
  return [...rows];
}

/** Whose Scratch an address is in; null for any other source. */
function scratchOwnerOf(address: NodeAddress): DraftOwner | null {
  if (address.scheme !== "scratch") return null;
  if (address.workId) return { kind: "work", workId: address.workId };
  return address.rootThreadId
    ? {
        kind: "lineage",
        projectId: address.projectId,
        rootThreadId: address.rootThreadId as ThreadId,
      }
    : null;
}

/**
 * The display name of the notes each document is in, for the documents in a Scratch the branch's
 * owner doesn't own (`ownsScratch`): a Work's name, or a conversation's title else its ref.
 */
async function otherNotesNames(
  db: Database,
  branchId: BranchId,
  addresses: ReadonlyMap<DocumentId, NodeAddress>,
): Promise<ReadonlyMap<DocumentId, string>> {
  const tx = currentDrizzleDb(db);
  const [branch] = await tx.execute<{
    project_id: string;
    work_id: string | null;
    root_thread_id: string | null;
  }>(sql`
    SELECT project_id::text, origin_work_id::text AS work_id,
      origin_root_thread_id::text AS root_thread_id
    FROM branches WHERE id = ${branchId}::uuid`);
  const own = branch
    ? ownerOfColumns({
        projectId: branch.project_id as ProjectId,
        workId: branch.work_id,
        rootThreadId: branch.root_thread_id,
      })
    : null;
  const others = new Map<DocumentId, DraftOwner>();
  for (const [documentId, address] of addresses) {
    const place = scratchOwnerOf(address);
    if (place && !(own && ownsScratch(own, place))) others.set(documentId, place);
  }
  if (others.size === 0) return new Map();
  const idsOf = (kind: DraftOwner["kind"]) => [
    ...new Set(
      [...others.values()].flatMap((owner) => (owner.kind === kind ? [ownerId(owner)] : [])),
    ),
  ];
  const named = (list: string[], query: (ids: SQL) => SQL) =>
    list.length === 0
      ? []
      : tx.execute<{ id: string; name: string }>(
          query(
            sql.join(
              list.map((id) => sql`${id}::uuid`),
              sql`, `,
            ),
          ),
        );
  const rows = [
    ...(await named(
      idsOf("work"),
      (ids) => sql`SELECT id::text AS id, name FROM works WHERE id IN (${ids})`,
    )),
    ...(await named(
      idsOf("lineage"),
      (ids) =>
        sql`SELECT id::text AS id, coalesce(nullif(trim(title), ''), ref) AS name FROM threads WHERE id IN (${ids})`,
    )),
  ];
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return new Map(
    [...others].flatMap(([documentId, owner]) => {
      const name = names.get(ownerId(owner));
      return name ? [[documentId, name] as const] : [];
    }),
  );
}

const ownerId = (owner: DraftOwner) => (owner.kind === "work" ? owner.workId : owner.rootThreadId);

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
          d.storage_url IS NOT NULL AS binary
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
      const addressOf = (id: DocumentId) => {
        const status = inBranch.get(id);
        return status?.kind === "visible"
          ? status.address
          : status?.kind === "deleted"
            ? status.lastAddress
            : null;
      };
      const addresses = new Map(
        documentIds.flatMap((id) => {
          const address = addressOf(id);
          return address ? [[id, address] as const] : [];
        }),
      );
      const notesNames = await otherNotesNames(db, branchId, addresses);
      return found.map((row): BranchDocumentTree => {
        const id = row.id as DocumentId;
        const created = row.exists_only_in_draft === true;
        const change: BranchTreeChange | null =
          row.deleted === null ? null : created ? "created" : row.deleted ? "deleting" : "moving";
        const there = inLive.get(id);
        return {
          documentId: id,
          origin: created ? "created" : "edited",
          isNew: created && row.deleted === false,
          binary: row.binary,
          deletedLive: change === "moving" && row.live_trashed,
          change,
          pending: pending.has(id),
          uri: addressOf(id)?.uri ?? null,
          notesName: notesNames.get(id) ?? null,
          movedFromUri: change === "moving" && there?.kind === "visible" ? there.address.uri : null,
        };
      });
    },
  };
}
