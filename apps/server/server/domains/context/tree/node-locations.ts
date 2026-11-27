import type { Database } from "@meridian/database";
import { documentPreviousLocations } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

export type VacatedLocation = { contextSourceId: string; path: string; documentId: string };
export type ClaimedLocation = { contextSourceId: string; path: string };

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
