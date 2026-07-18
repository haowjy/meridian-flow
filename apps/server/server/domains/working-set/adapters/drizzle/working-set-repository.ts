/** Drizzle working-set repository with an atomic revision increment on whole-snapshot replacement. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { projectUserWorkingSets } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import type { WorkingSetRepository } from "../../ports/working-set-repository.js";

export function createDrizzleWorkingSetRepository(deps: { db: Database }): WorkingSetRepository {
  return {
    async get(userId: UserId, projectId: ProjectId) {
      const [row] = await deps.db
        .select()
        .from(projectUserWorkingSets)
        .where(
          and(
            eq(projectUserWorkingSets.userId, userId),
            eq(projectUserWorkingSets.projectId, projectId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async upsert(userId, projectId, snapshot) {
      const [row] = await deps.db
        .insert(projectUserWorkingSets)
        .values({ userId, projectId, ...snapshot, revision: 1 })
        .onConflictDoUpdate({
          target: [projectUserWorkingSets.userId, projectUserWorkingSets.projectId],
          set: {
            recentRoutes: snapshot.recentRoutes,
            lastThreadId: snapshot.lastThreadId,
            revision: sql`${projectUserWorkingSets.revision} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning({ revision: projectUserWorkingSets.revision });
      if (!row) throw new Error("Failed to upsert project working set");
      return row;
    },
  };
}
