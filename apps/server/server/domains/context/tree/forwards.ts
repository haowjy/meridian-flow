/**
 * Document forwards: a device's create that joined a branch's hidden document leaves its
 * minted id meaning the joined one (`document_forwards`). The device's id never has a
 * `documents` row. Every function runs in its caller's transaction; a forward is written
 * in the reveal's own transaction, so a join and its forward commit together.
 */
import type { ContextSourceId, DocumentId, ProjectId } from "@meridian/contracts";
import { renderFilename } from "@meridian/contracts/protocol";
import { type Database, documentForwards } from "@meridian/database";
import { and, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import { chainPrefix, loadFolderChains } from "./tree-addresses.js";
import { loadDocumentIdentityRows } from "./tree-view-sql.js";

/** Writes `fromId → toId`. A replay of the same join is a no-op; a different target is a fault. */
export async function recordForward(
  db: Database,
  input: { fromId: DocumentId; toId: DocumentId; projectId: ProjectId },
): Promise<void> {
  const tx = currentDrizzleDb(db);
  await tx
    .insert(documentForwards)
    .values({
      fromDocumentId: input.fromId,
      toDocumentId: input.toId,
      projectId: input.projectId,
    })
    .onConflictDoNothing();
  const target = await findForward(db, input.fromId, input.projectId);
  if (target !== input.toId) {
    throw new Error(`Document ${input.fromId} already forwards to ${target ?? "another project"}`);
  }
}

/** The document `fromId` forwards to within `projectId`, else null. */
export async function findForward(
  db: Database,
  fromId: string,
  projectId: ProjectId,
): Promise<DocumentId | null> {
  if (!isUuid(fromId)) return null;
  const [row] = await currentDrizzleDb(db)
    .select({ to: documentForwards.toDocumentId })
    .from(documentForwards)
    .where(
      and(eq(documentForwards.fromDocumentId, fromId), eq(documentForwards.projectId, projectId)),
    )
    .limit(1);
  return row?.to ?? null;
}

/** The ids forwarded into each of `toIds`, for the catalog's `joinedFrom`. */
export async function loadJoinedFrom(
  db: Database,
  toIds: readonly DocumentId[],
): Promise<ReadonlyMap<DocumentId, readonly DocumentId[]>> {
  const out = new Map<DocumentId, DocumentId[]>();
  if (toIds.length === 0) return out;
  const rows = await currentDrizzleDb(db)
    .select({ from: documentForwards.fromDocumentId, to: documentForwards.toDocumentId })
    .from(documentForwards)
    .where(inArray(documentForwards.toDocumentId, [...toIds]))
    .orderBy(documentForwards.createdAt, documentForwards.fromDocumentId);
  for (const row of rows) out.set(row.to, [...(out.get(row.to) ?? []), row.from]);
  return out;
}

/**
 * Where a document is, or last was: its source, source-relative path, and whether it is
 * deleted. A hidden document has no live place and answers null.
 */
export async function lastLocationOf(
  db: Database,
  id: DocumentId,
): Promise<{ contextSourceId: ContextSourceId; path: string; deleted: boolean } | null> {
  const tx = currentDrizzleDb(db);
  const [row] = await loadDocumentIdentityRows(tx, [id]);
  if (!row || row.hidden) return null;
  const chains = await loadFolderChains(tx, [row.folderId]);
  const prefix = row.folderId === null ? "" : chainPrefix(chains.get(row.folderId) ?? []);
  return {
    contextSourceId: row.contextSourceId,
    path: `${prefix}${renderFilename(row.name, row.extension)}`,
    deleted: row.deleted,
  };
}
