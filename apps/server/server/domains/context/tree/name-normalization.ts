/** Hidden-node yielding for the exact claims a live tree write installed. */
import type { ContextSourceId, DocumentId, FolderId } from "@meridian/contracts";
import {
  allocateFilename,
  documentPartsForNamespaceClaim,
  folderDocumentName,
  renderFilename,
} from "@meridian/contracts/protocol";
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

function matchingClaim(
  claim: { kind: "document" | "folder"; filename: string },
  at: Pick<Claim, "contextSourceId" | "parentId">,
  excludeId?: string,
) {
  const documentParts = documentPartsForNamespaceClaim(claim);
  return {
    document: sql`d.deleted_at IS NULL
      AND d.context_source_id = ${at.contextSourceId}::uuid
      AND d.folder_id IS NOT DISTINCT FROM ${at.parentId}::uuid
      AND ${
        documentParts
          ? sql`d.name = ${documentParts.name} AND d.extension = ${documentParts.extension}`
          : sql`false`
      }
      AND ${excludeId ? sql`d.id <> ${excludeId}::uuid` : sql`true`}`,
    folder: sql`f.deleted_at IS NULL
      AND f.context_source_id = ${at.contextSourceId}::uuid
      AND f.parent_id IS NOT DISTINCT FROM ${at.parentId}::uuid
      AND ${
        claim.kind === "document"
          ? sql`f.document_alias = ${claim.filename}`
          : sql`f.name = ${claim.filename}`
      }
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
    const matching = matchingClaim({ kind: installed.kind, filename }, installed);
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
  const desired =
    claim.kind === "document"
      ? ({ kind: "document", name: claim.name, extension: claim.extension } as const)
      : ({ kind: "folder", name: claim.name } as const);
  const filename = await allocateFilename(desired, async (candidate) => {
    const matching = matchingClaim(candidate, claim, claim.id);
    const [row] = await tx.execute<{ taken: boolean }>(sql`SELECT EXISTS (
      SELECT 1 FROM documents d WHERE ${matching.document}
      UNION ALL
      SELECT 1 FROM folders f WHERE ${matching.folder}
    ) AS taken`);
    return row?.taken ?? false;
  });
  const now = new Date();
  if (claim.kind === "document") {
    const name = claim.extension ? filename.slice(0, -(claim.extension.length + 1)) : filename;
    await tx
      .update(documents)
      .set({ name, updatedAt: now })
      .where(eq(documents.id, claim.id as DocumentId));
    await bumpLocationVersions(db, { documentIds: [claim.id as DocumentId] });
    return;
  }
  await tx
    .update(folders)
    .set({ name: filename, documentAlias: folderDocumentName(filename), updatedAt: now })
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
