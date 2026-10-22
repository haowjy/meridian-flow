/**
 * Mints the next handle number for a project and kind. `thread` numbers chats and subagents
 * (`c12`, `p3`) from one counter; `work` numbers Works (`w3`). The upsert holds the counter row's
 * lock until the caller's transaction ends, so two creators never read the same number, and a
 * number is never given back: a deleted or purged owner's handle stays retired.
 */
import type { ProjectId } from "@meridian/contracts";
import { projectHandleCounters } from "@meridian/database/schema";
import { sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";

export type HandleCounterKind = "thread" | "work";

export async function allocateHandleNumber(
  db: DrizzleDb,
  projectId: ProjectId,
  kind: HandleCounterKind,
): Promise<number> {
  const [counter] = await currentDrizzleDb(db)
    .insert(projectHandleCounters)
    .values({ projectId, kind, n: 1 })
    .onConflictDoUpdate({
      target: [projectHandleCounters.projectId, projectHandleCounters.kind],
      set: { n: sql`${projectHandleCounters.n} + 1` },
    })
    .returning({ n: projectHandleCounters.n });
  if (!counter) throw new Error(`Failed to allocate a ${kind} handle`);
  return counter.n;
}
