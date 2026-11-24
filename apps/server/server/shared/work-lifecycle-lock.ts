import { works } from "@meridian/database/schema";
import { asc, inArray } from "drizzle-orm";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import {
  LineageDraftsUnavailableError,
  lockLineageOwners,
  readLineageOwners,
} from "./draft-owner.js";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";
import {
  confirmScopedEdits,
  scopedEditLineageRoots,
  scopedEditWorkIds,
} from "./edit-confirmation.js";

export type LockedWorkLifecycle = "active" | "archived" | "deleted" | "missing";

export type LockedOwners = {
  works: ReadonlyMap<string, LockedWork>;
  lineages: ReadonlyMap<string, "active" | "frozen">;
};

export interface LockedWork {
  state: LockedWorkLifecycle;
  handle: string | null;
}

const lifecycleOf = (
  row: { archivedAt: unknown; deletedAt: unknown } | undefined,
): LockedWorkLifecycle =>
  !row ? "missing" : row.deletedAt ? "deleted" : row.archivedAt !== null ? "archived" : "active";

export async function readOwners(
  db: DrizzleDb,
  workIds: readonly string[],
  lineageRootIds: readonly string[],
): Promise<LockedOwners> {
  const ids = [...new Set(workIds)];
  const rows = ids.length
    ? await currentDrizzleDb(db)
        .select({
          id: works.id,
          handle: works.handle,
          archivedAt: works.archivedAt,
          deletedAt: works.deletedAt,
        })
        .from(works)
        .where(inArray(works.id, ids))
    : [];
  const found = new Map(rows.map((row) => [row.id as string, row]));
  return {
    works: new Map(
      ids.map((id) => [
        id,
        { state: lifecycleOf(found.get(id)), handle: found.get(id)?.handle ?? null },
      ]),
    ),
    lineages: await readLineageOwners(db, lineageRootIds),
  };
}

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
    locked.set(id, { state: lifecycleOf(row), handle: row?.handle ?? null });
  }
  return locked;
}

export async function lockWorkLifecycle(
  db: DrizzleDb,
  workId: string,
): Promise<LockedWorkLifecycle> {
  return (await lockWorksInIdOrder(db, [workId])).get(workId)?.state ?? "missing";
}

export async function lockSeamWorks(
  db: DrizzleDb,
  workIds: readonly string[],
  lineageRootIds: readonly string[] = [],
): Promise<LockedOwners> {
  const works = await lockWorksInIdOrder(db, [...workIds, ...scopedEditWorkIds()]);
  const lineages = await lockLineageOwners(db, [...lineageRootIds, ...scopedEditLineageRoots()]);
  const locked = { works, lineages };
  await confirmScopedEdits(locked);
  return locked;
}

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
