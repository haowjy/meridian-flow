/** Work row guards: stable lifecycle reads, projection mutation, and lifecycle transitions. */
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
 * lifecycle under the requested guard. KEY SHARE guards stability without
 * blocking metadata/activity updates; lifecycle changes explicitly take UPDATE.
 */
async function lockWorkRows(
  db: DrizzleDb,
  workIds: readonly string[],
  strength: "key share" | "no key update" | "update",
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
    .for(strength);
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

/** Projection writers serialize with each other, but not lifecycle-only readers. */
export function lockWorksInIdOrder(db: DrizzleDb, workIds: readonly string[]) {
  return lockWorkRows(db, workIds, "no key update");
}

/** Lifecycle transitions take UPDATE; ordinary activity updates remain compatible. */
export function lockStableWorksInIdOrder(db: DrizzleDb, workIds: readonly string[]) {
  return lockWorkRows(db, workIds, "key share");
}

export async function lockWorkLifecycle(
  db: DrizzleDb,
  workId: string,
): Promise<LockedWorkLifecycle> {
  return (await lockWorkRows(db, [workId], "update")).get(workId)?.state ?? "missing";
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
  const locked = await lockStableWorksInIdOrder(db, [...workIds, ...scopedEditWorkIds()]);
  await confirmScopedEdits();
  for (const workId of [...new Set(workIds)].sort()) {
    const work = locked.get(workId);
    if (work && work.state !== "active") {
      throw new WorkLifecycleUnavailableError(workId, work.state, work.slug);
    }
  }
}
