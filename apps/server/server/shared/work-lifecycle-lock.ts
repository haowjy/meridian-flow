/** Shared row lock for serializing Work lifecycle changes with Work-owned mutations. */
import { works } from "@meridian/database/schema";
import { asc, inArray } from "drizzle-orm";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";
import { confirmScopedEdits, scopedEditWorkIds } from "./edit-confirmation.js";

export type LockedWorkLifecycle = "active" | "archived" | "deleted" | "missing";

export interface LockedWork {
  state: LockedWorkLifecycle;
  slug: string | null;
}

/**
 * Lock several Works in one global order, sorted by id, so writers spanning
 * Works never deadlock each other (file-access §5), and read each one's
 * lifecycle under the lock. `FOR NO KEY UPDATE` serializes lifecycle changes
 * without blocking foreign-key references to the row.
 */
export async function lockWorksInIdOrder(
  db: DrizzleDb,
  workIds: readonly string[],
): Promise<ReadonlyMap<string, LockedWork>> {
  const ids = [...new Set(workIds)].sort();
  const locked = new Map<string, LockedWork>();
  if (ids.length === 0) return locked;
  const rows = await currentDrizzleDb(db)
    .select({
      id: works.id,
      slug: works.slug,
      archivedAt: works.archivedAt,
      deletedAt: works.deletedAt,
    })
    .from(works)
    .where(inArray(works.id, ids))
    .orderBy(asc(works.id))
    .for("no key update");
  const found = new Map(rows.map((row) => [row.id as string, row]));
  for (const id of ids) {
    const row = found.get(id);
    locked.set(
      id,
      row
        ? {
            state: row.deletedAt ? "deleted" : row.archivedAt !== null ? "archived" : "active",
            slug: row.slug,
          }
        : { state: "missing", slug: null },
    );
  }
  return locked;
}

export async function lockWorkLifecycle(
  db: DrizzleDb,
  workId: string,
): Promise<LockedWorkLifecycle> {
  return (await lockWorksInIdOrder(db, [workId])).get(workId)?.state ?? "missing";
}

/**
 * A write seam's first locks (file-access §5): its own Works and the bound
 * edit grants' Works in one id order, then the grants' confirmation. The seam
 * takes its advisory locks after this. Returns every locked Work's lifecycle.
 */
export async function lockSeamWorks(
  db: DrizzleDb,
  workIds: readonly string[],
): Promise<ReadonlyMap<string, LockedWork>> {
  const locked = await lockWorksInIdOrder(db, [...workIds, ...scopedEditWorkIds()]);
  await confirmScopedEdits();
  return locked;
}

/** Seam Work locks, then each of the seam's own Works must still be active. */
export async function requireLockedActiveWorks(
  db: DrizzleDb,
  workIds: readonly string[],
): Promise<void> {
  const locked = await lockSeamWorks(db, workIds);
  for (const workId of [...new Set(workIds)].sort()) {
    const work = locked.get(workId);
    if (work && work.state !== "active") {
      throw new WorkLifecycleUnavailableError(workId, work.state, work.slug);
    }
  }
}
