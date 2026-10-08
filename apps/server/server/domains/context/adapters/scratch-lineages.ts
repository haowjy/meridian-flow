/** Project-local first-chat lookup, including trashed first chats. */
import type { Database } from "@meridian/database";
import { threads } from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { ScratchLineage, ScratchLineages } from "../scratch-owner.js";

export function createDrizzleScratchLineages(db: Database): ScratchLineages {
  async function list(projectId: string): Promise<ScratchLineage[]> {
    const rows = await currentDrizzleDb(db)
      .select({
        projectId: threads.projectId,
        rootThreadId: threads.id,
        rootThreadRef: threads.ref,
      })
      .from(threads)
      .where(and(eq(threads.projectId, projectId), eq(threads.rootThreadId, threads.id)));
    return rows.flatMap((row) =>
      row.rootThreadRef ? [{ ...row, rootThreadRef: row.rootThreadRef }] : [],
    );
  }
  return {
    list,
    async byId(projectId, rootThreadId) {
      return (await list(projectId)).find((row) => row.rootThreadId === rootThreadId) ?? null;
    },
    async rootForThreadRef(projectId, ref) {
      const [member] = await currentDrizzleDb(db)
        .select({ rootThreadId: threads.rootThreadId })
        .from(threads)
        .where(and(eq(threads.projectId, projectId), eq(threads.ref, ref)))
        .limit(1);
      return member
        ? ((await list(projectId)).find((row) => row.rootThreadId === member.rootThreadId) ?? null)
        : null;
    },
    async byRef(projectId, ref) {
      return (await list(projectId)).find((row) => row.rootThreadRef === ref) ?? null;
    },
  };
}
