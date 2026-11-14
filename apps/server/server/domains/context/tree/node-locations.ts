/**
 * The previous locations of documents: a relocation records the addresses it vacates and
 * consumes the aliases at the addresses it claims. Runs in the caller's transaction (the
 * list's replay writes `location_version` itself).
 */
import type { Database } from "@meridian/database";
import { documentPreviousLocations } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

/** A visible document's address it left: written as a previous location. */
export type VacatedLocation = { contextSourceId: string; path: string; documentId: string };
/** A visible node's final address: previous-location claims there are consumed. */
export type ClaimedLocation = { contextSourceId: string; path: string };

/**
 * History for one relocation of a whole set (contract §8.5): every vacated alias first,
 * then every final claim, so no node's old path survives as an alias where another node
 * of the set now sits (a swap, a renumber). A node in no live view never appears in either list.
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
