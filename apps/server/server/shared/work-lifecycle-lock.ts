/** Shared row lock for serializing Work lifecycle changes with Work-owned mutations. */
import { works } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";

export type LockedWorkLifecycle = "active" | "archived" | "deleted" | "missing";

type LockedWork = { state: LockedWorkLifecycle; slug: string | null };

async function lockWork(db: DrizzleDb, workId: string): Promise<LockedWork> {
  const [work] = await currentDrizzleDb(db)
    .select({ deletedAt: works.deletedAt, slug: works.slug, status: works.status })
    .from(works)
    .where(eq(works.id, workId))
    .limit(1)
    .for("update");
  if (!work) return { state: "missing", slug: null };
  return {
    state: work.deletedAt ? "deleted" : work.status === "archived" ? "archived" : "active",
    slug: work.slug,
  };
}

export async function lockWorkLifecycle(
  db: DrizzleDb,
  workId: string,
): Promise<LockedWorkLifecycle> {
  return (await lockWork(db, workId)).state;
}

export async function requireLockedActiveWork(db: DrizzleDb, workId: string): Promise<void> {
  const work = await lockWork(db, workId);
  if (work.state !== "active") {
    throw new WorkLifecycleUnavailableError(workId, work.state, work.slug);
  }
}
