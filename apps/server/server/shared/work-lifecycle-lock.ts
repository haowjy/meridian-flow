/** Shared row lock for serializing Work lifecycle changes with Work-owned mutations. */
import { works } from "@meridian/database/schema";
import { asc, inArray } from "drizzle-orm";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import { LineageDraftsUnavailableError, lockLineageOwners } from "./draft-owner.js";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";
import {
  confirmScopedEdits,
  scopedEditLineageRoots,
  scopedEditWorkIds,
} from "./edit-confirmation.js";

export type LockedWorkLifecycle = "active" | "archived" | "deleted" | "missing";

/** What `lockSeamWorks` locked: each Work's lifecycle and each lineage's liveness, read under the locks. */
export type LockedOwners = {
  works: ReadonlyMap<string, LockedWork>;
  lineages: ReadonlyMap<string, "active" | "frozen">;
};

export interface LockedWork {
  state: LockedWorkLifecycle;
  handle: string | null;
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
      handle: works.handle,
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
            handle: row.handle,
          }
        : { state: "missing", handle: null },
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
 * edit grants' Works in one id order, then the lineages' draft-owner locks,
 * then the grants' confirmation. The seam takes its advisory locks after this.
 */
export async function lockSeamWorks(
  db: DrizzleDb,
  workIds: readonly string[],
  lineageRootIds: readonly string[] = [],
): Promise<LockedOwners> {
  const works = await lockWorksInIdOrder(db, [...workIds, ...scopedEditWorkIds()]);
  const lineages = await lockLineageOwners(db, [...lineageRootIds, ...scopedEditLineageRoots()]);
  await confirmScopedEdits();
  return { works, lineages };
}

/** Seam locks, then each of the seam's own Works and lineages must still be active. */
export async function requireLockedActiveWorks(
  db: DrizzleDb,
  workIds: readonly string[],
  lineageRootIds: readonly string[] = [],
): Promise<void> {
  const locked = await lockSeamWorks(db, workIds, lineageRootIds);
  for (const workId of [...new Set(workIds)].sort()) {
    const work = locked.works.get(workId);
    if (work && work.state !== "active") {
      throw new WorkLifecycleUnavailableError(workId, work.state, work.handle);
    }
  }
  for (const root of [...new Set(lineageRootIds)].sort()) {
    if (locked.lineages.get(root) !== "active") {
      throw new LineageDraftsUnavailableError(root);
    }
  }
}
