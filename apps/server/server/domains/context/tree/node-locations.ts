/**
 * The tree's location writers: a claim consumes previous-location aliases at a path, a
 * relocation records the aliases it vacates, and every namespace change bumps
 * `location_version`. All run in the caller's transaction under its namespace locks.
 */
import type { Database } from "@meridian/database";
import { documentPreviousLocations, documents, folders } from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

/** Called only after a successful claim; an outer rollback restores consumed history. */
export async function claimDocumentLocation(
  db: Database,
  sourceId: string,
  parentId: string | null,
  filename: string,
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const rows = await tx.execute<{ path: string }>(sql`
    WITH RECURSIVE parents AS (
      SELECT id, parent_id, name AS path FROM folders WHERE id = ${parentId}::uuid
      UNION ALL
      SELECT f.id, f.parent_id, f.name || '/' || p.path FROM folders f JOIN parents p ON f.id = p.parent_id
    )
    SELECT path FROM parents WHERE parent_id IS NULL
  `);
  const path = parentId === null ? filename : `${rows[0]?.path}/${filename}`;
  if (parentId !== null && !rows[0]) throw new Error("Namespace parent not found");
  await tx
    .delete(documentPreviousLocations)
    .where(
      and(
        eq(documentPreviousLocations.contextSourceId, sourceId),
        eq(documentPreviousLocations.path, path),
      ),
    );
}

/** A visible document's address it left: written as a previous location. */
export type VacatedLocation = { contextSourceId: string; path: string; documentId: string };
/** A visible node's final address: previous-location claims there are consumed. */
export type ClaimedLocation = { contextSourceId: string; path: string };

/**
 * History for one relocation of a whole set (contract §8.5): every vacated alias first,
 * then every final claim, so no node's old path survives as an alias where another node
 * of the set now sits (a swap, a renumber). Hidden nodes never appear in either list: a
 * hidden location was never a live address. Versions are `bumpLocationVersions`'.
 */
export async function recordLocationHistory(
  db: Database,
  history: { vacated: readonly VacatedLocation[]; claimed: readonly ClaimedLocation[] },
): Promise<void> {
  const tx = currentDrizzleDb(db);
  // Bound statement parameter counts, not the atomic operation. Every batch joins the same transaction.
  for (const [sourceId, entries] of bySource(history.vacated)) {
    for (let offset = 0; offset < entries.length; offset += 500) {
      const batch = entries.slice(offset, offset + 500);
      await consumeClaims(db, sourceId, batch);
      await tx.insert(documentPreviousLocations).values(
        batch.map((entry) => ({
          contextSourceId: sourceId,
          path: entry.path,
          documentId: entry.documentId,
        })),
      );
    }
  }
  for (const [sourceId, entries] of bySource(history.claimed)) {
    for (let offset = 0; offset < entries.length; offset += 500) {
      await consumeClaims(db, sourceId, entries.slice(offset, offset + 500));
    }
  }
}

function bySource<T extends { contextSourceId: string }>(entries: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const entry of entries) {
    grouped.set(entry.contextSourceId, [...(grouped.get(entry.contextSourceId) ?? []), entry]);
  }
  return grouped;
}

async function consumeClaims(
  db: Database,
  sourceId: string,
  entries: readonly { path: string }[],
): Promise<void> {
  await currentDrizzleDb(db)
    .delete(documentPreviousLocations)
    .where(
      and(
        eq(documentPreviousLocations.contextSourceId, sourceId),
        inArray(
          documentPreviousLocations.path,
          entries.map((entry) => entry.path),
        ),
      ),
    );
}

/**
 * Every namespace lifecycle change bumps `location_version` on what it changes (contract
 * §8.4): moves, deletes, restores, reveals, tombstones. Batched by 500 in the caller's
 * transaction.
 */
export async function bumpLocationVersions(
  db: Database,
  ids: { documentIds?: readonly string[]; folderIds?: readonly string[] },
): Promise<void> {
  const tx = currentDrizzleDb(db);
  const documentIds = [...new Set(ids.documentIds ?? [])];
  const folderIds = [...new Set(ids.folderIds ?? [])];
  for (let offset = 0; offset < documentIds.length; offset += 500) {
    await tx
      .update(documents)
      .set({ locationVersion: sql`${documents.locationVersion} + 1` })
      .where(inArray(documents.id, documentIds.slice(offset, offset + 500)));
  }
  for (let offset = 0; offset < folderIds.length; offset += 500) {
    await tx
      .update(folders)
      .set({ locationVersion: sql`${folders.locationVersion} + 1` })
      .where(inArray(folders.id, folderIds.slice(offset, offset + 500) as never));
  }
}
