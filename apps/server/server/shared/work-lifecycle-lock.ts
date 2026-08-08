/** Shared row lock for serializing Work lifecycle changes with Work-owned mutations. */
import type { Database } from "@meridian/database";
import { works } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { currentDrizzleDb } from "./drizzle-transaction.js";

export type LockedWorkLifecycle = "active" | "deleted" | "missing";

/** A lifecycle row was authoritatively absent after taking its database lock. */
export class WorkLifecycleUnavailableError extends Error {
  constructor(
    readonly workId: string,
    readonly state: Exclude<LockedWorkLifecycle, "active">,
  ) {
    super(`Work not found: ${workId}`);
    this.name = "WorkLifecycleUnavailableError";
  }
}

export async function lockWorkLifecycle(
  db: Database,
  workId: string,
): Promise<LockedWorkLifecycle> {
  const [work] = await currentDrizzleDb(db)
    .select({ deletedAt: works.deletedAt })
    .from(works)
    .where(eq(works.id, workId))
    .limit(1)
    .for("update");
  if (!work) return "missing";
  return work.deletedAt ? "deleted" : "active";
}

export async function requireLockedActiveWork(db: Database, workId: string): Promise<void> {
  const state = await lockWorkLifecycle(db, workId);
  if (state !== "active") throw new WorkLifecycleUnavailableError(workId, state);
}
