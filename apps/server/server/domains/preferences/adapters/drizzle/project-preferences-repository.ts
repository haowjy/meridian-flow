/**
 * Drizzle ProjectPreferencesRepository: persists (userId, projectId) preferences in project_user_preferences with atomic partial upserts.
 * Key decision: the conflict update only sets fields present in the partial request, so concurrent independent group/pin writes do not need a read-modify-write round trip.
 */
import type {
  ProjectPreferences,
  ThreadGroupBy,
  UpdateProjectPreferencesRequest,
} from "@meridian/contracts/preferences";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { projectUserPreferences } from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { defaultProjectPreferences, mergeProjectPreferences } from "../../domain.js";
import type { ProjectPreferencesRepository } from "../../ports/index.js";

type ProjectPreferencesRow = typeof projectUserPreferences.$inferSelect;

function mapPreferences(row: ProjectPreferencesRow): ProjectPreferences {
  return {
    threadGroupBy: row.threadGroupBy as ThreadGroupBy,
    pinnedThreadIds: [...row.pinnedThreadIds],
    defaultAgentSlug: row.defaultAgentSlug,
    autoResume: {
      enabled: row.autoResumeEnabled,
      timeoutMs: row.autoResumeTimeoutMs,
    },
  };
}

export interface DrizzleProjectPreferencesRepositoryDeps {
  db: Database;
}

export function createDrizzleProjectPreferencesRepository(
  deps: DrizzleProjectPreferencesRepositoryDeps,
): ProjectPreferencesRepository {
  const { db } = deps;

  return {
    async read(userId: UserId, projectId: ProjectId): Promise<ProjectPreferences> {
      const [row] = await db
        .select()
        .from(projectUserPreferences)
        .where(
          and(
            eq(projectUserPreferences.userId, userId),
            eq(projectUserPreferences.projectId, projectId),
          ),
        )
        .limit(1);
      return row ? mapPreferences(row) : defaultProjectPreferences();
    },

    async upsert(
      userId: UserId,
      projectId: ProjectId,
      input: UpdateProjectPreferencesRequest,
    ): Promise<ProjectPreferences> {
      const defaultsForInsert = mergeProjectPreferences(null, input);
      const set: Partial<typeof projectUserPreferences.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.threadGroupBy !== undefined) set.threadGroupBy = input.threadGroupBy;
      if (input.pinnedThreadIds !== undefined) set.pinnedThreadIds = [...input.pinnedThreadIds];
      if (input.defaultAgentSlug !== undefined) set.defaultAgentSlug = input.defaultAgentSlug;
      if (input.autoResume !== undefined) {
        set.autoResumeEnabled = input.autoResume.enabled;
        set.autoResumeTimeoutMs = input.autoResume.timeoutMs;
      }

      const [row] = await db
        .insert(projectUserPreferences)
        .values({
          userId,
          projectId,
          threadGroupBy: defaultsForInsert.threadGroupBy,
          pinnedThreadIds: defaultsForInsert.pinnedThreadIds,
          defaultAgentSlug: defaultsForInsert.defaultAgentSlug,
          autoResumeEnabled: defaultsForInsert.autoResume?.enabled,
          autoResumeTimeoutMs: defaultsForInsert.autoResume?.timeoutMs,
        })
        .onConflictDoUpdate({
          target: [projectUserPreferences.userId, projectUserPreferences.projectId],
          set,
        })
        .returning();
      if (!row) throw new Error("Failed to upsert project preferences");
      return mapPreferences(row);
    },
  };
}
