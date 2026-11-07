/** Hidden-node yielding for the exact claims a live tree write installed. */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import { filenameSplits, firstFreeName, renderFilename } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, folders } from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { bumpLocationVersions } from "./node-locations.js";
import type { NodeRef } from "./tree-view.js";
import { loadSubtreeNodes } from "./tree-view-sql.js";

type Claim = {
  id: string;
  kind: "document" | "folder";
  contextSourceId: ContextSourceId;
  parentId: FolderId | null;
  name: string;
  extension: string;
  hidden: boolean;
  createdAt: Date;
};

/** The live rows whose rendered filename (a folder's whole name) is `filename` under `at`. */
function matchingClaim(
  filename: string,
  at: Pick<Claim, "contextSourceId" | "parentId">,
  excludeId?: string,
) {
  const splits = filenameSplits(filename).map(
    (split) => sql`(d.name = ${split.name} AND d.extension = ${split.extension})`,
  );
  return {
    document: sql`d.deleted_at IS NULL
      AND d.context_source_id = ${at.contextSourceId}::uuid
      AND d.folder_id IS NOT DISTINCT FROM ${at.parentId}::uuid
      AND (${sql.join(splits, sql` OR `)})
      AND ${excludeId ? sql`d.id <> ${excludeId}::uuid` : sql`true`}`,
    folder: sql`f.deleted_at IS NULL
      AND f.context_source_id = ${at.contextSourceId}::uuid
      AND f.parent_id IS NOT DISTINCT FROM ${at.parentId}::uuid
      AND f.name = ${filename}
      AND ${excludeId ? sql`f.id <> ${excludeId}::uuid` : sql`true`}`,
  };
}

/** Make only hidden nodes conflicting with claims this write installed or reparented yield. */
export async function normalizeNames(db: Database, arrivals: readonly NodeRef[]): Promise<void> {
  const tx = currentDrizzleDb(db);
  const seen = new Set<string>();
  for (const arrival of arrivals) {
    if (seen.has(`${arrival.kind}:${arrival.id}`)) continue;
    seen.add(`${arrival.kind}:${arrival.id}`);
    const [installed] = await tx.execute<Claim>(
      arrival.kind === "document"
        ? sql`SELECT id::text, 'document'::text AS kind, context_source_id::text AS "contextSourceId",
            folder_id::text AS "parentId", name, extension, hidden, created_at AS "createdAt"
          FROM documents WHERE id = ${arrival.id}::uuid AND deleted_at IS NULL`
        : sql`SELECT id::text, 'folder'::text AS kind, context_source_id::text AS "contextSourceId",
            parent_id::text AS "parentId", name, ''::text AS extension, hidden, created_at AS "createdAt"
          FROM folders WHERE id = ${arrival.id}::uuid AND deleted_at IS NULL`,
    );
    if (!installed) continue;
    const filename =
      installed.kind === "document"
        ? renderFilename(installed.name, installed.extension)
        : installed.name;
    const matching = matchingClaim(filename, installed);
    const losers = await tx.execute<Claim>(sql`
      SELECT * FROM (
        SELECT d.id::text, 'document'::text AS kind, d.context_source_id::text AS "contextSourceId",
          d.folder_id::text AS "parentId", d.name, d.extension, d.hidden, d.created_at AS "createdAt"
        FROM documents d WHERE ${matching.document}
        UNION ALL
        SELECT f.id::text, 'folder'::text, f.context_source_id::text, f.parent_id::text,
          f.name, ''::text, f.hidden, f.created_at
        FROM folders f WHERE ${matching.folder}
      ) n ORDER BY hidden ASC, (kind = 'folder') DESC, "createdAt", id`);
    for (const loser of losers.slice(1)) if (loser.hidden) await renameHiddenClaim(db, loser);
  }
}

async function renameHiddenClaim(db: Database, claim: Claim): Promise<void> {
  const tx = currentDrizzleDb(db);
  const taken = await tx.execute<{ filename: string }>(sql`
    SELECT CASE WHEN d.extension = '' THEN d.name ELSE d.name || '.' || d.extension END AS filename
    FROM documents d
    WHERE d.deleted_at IS NULL AND d.context_source_id = ${claim.contextSourceId}::uuid
      AND d.folder_id IS NOT DISTINCT FROM ${claim.parentId}::uuid AND d.id <> ${claim.id}::uuid
    UNION ALL
    SELECT f.name FROM folders f
    WHERE f.deleted_at IS NULL AND f.context_source_id = ${claim.contextSourceId}::uuid
      AND f.parent_id IS NOT DISTINCT FROM ${claim.parentId}::uuid AND f.id <> ${claim.id}::uuid
    UNION ALL
    SELECT CASE WHEN c.moved_extension = '' THEN c.moved_name
                ELSE c.moved_name || '.' || c.moved_extension END
    FROM branch_tree_changes c
    WHERE c.node_kind = 'document' AND c.moved AND NOT c.deleted AND c.node_id <> ${claim.id}::uuid
      AND c.moved_folder_id IS NOT DISTINCT FROM ${claim.parentId}::uuid
      AND (c.moved_folder_id IS NOT NULL OR c.moved_root_source_id = ${claim.contextSourceId}::uuid)`);
  const free = firstFreeName(claim, new Set(taken.map((row) => row.filename)));
  const now = new Date();
  if (claim.kind === "document") {
    await tx
      .update(documents)
      .set({ name: free.name, updatedAt: now })
      .where(eq(documents.id, claim.id as DocumentId));
    await bumpLocationVersions(db, { documentIds: [claim.id as DocumentId] });
    return;
  }
  await tx
    .update(folders)
    .set({ name: free.filename, updatedAt: now })
    .where(eq(folders.id, claim.id as FolderId));
  const subtree = await loadSubtreeNodes(tx, [claim.id as FolderId]);
  await bumpLocationVersions(db, {
    folderIds: [
      claim.id as FolderId,
      ...subtree.filter((n) => n.kind === "folder").map((n) => n.id as FolderId),
    ],
    documentIds: subtree.filter((n) => n.kind === "document").map((n) => n.id as DocumentId),
  });
}
