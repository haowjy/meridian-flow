/**
 * Drizzle ProjectPreferencesRepository: persists (userId, projectId) preferences in project_user_preferences with atomic partial upserts.
 * Key decision: the conflict update only sets fields present in the partial request, so concurrent independent group/pin writes do not need a read-modify-write round trip.
 */
import type {
  ProjectPreferences,
  ThreadGroupBy,
  UpdateProjectPreferencesRequest,
} from "@meridian/contracts/preferences";
import type { ProjectId, UserId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { projectUserPreferences } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import { defaultProjectPreferences, mergeProjectPreferences } from "../../domain.js";
import type { ProjectPreferencesRepository } from "../../ports/project-preferences-repository.js";

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
      const [row] = await currentDrizzleDb(db)
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

      const [row] = await currentDrizzleDb(db)
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

    async getCurrentWorkId(userId: UserId, projectId: ProjectId): Promise<WorkId | null> {
      const [row] = await currentDrizzleDb(db)
        .select({ currentWorkId: projectUserPreferences.currentWorkId })
        .from(projectUserPreferences)
        .where(
          and(
            eq(projectUserPreferences.userId, userId),
            eq(projectUserPreferences.projectId, projectId),
          ),
        )
        .limit(1);
      return row?.currentWorkId ?? null;
    },

    async setCurrentWorkId(userId: UserId, projectId: ProjectId, workId: WorkId): Promise<void> {
      await currentDrizzleDb(db)
        .insert(projectUserPreferences)
        .values({ userId, projectId, currentWorkId: workId })
        .onConflictDoUpdate({
          target: [projectUserPreferences.userId, projectUserPreferences.projectId],
          set: { currentWorkId: workId, updatedAt: new Date() },
        });
    },

    async setCurrentWorkIdIfUnchanged(
      userId: UserId,
      projectId: ProjectId,
      expectedWorkId: WorkId | null,
      workId: WorkId,
    ): Promise<boolean> {
      const activeDb = currentDrizzleDb(db);
      const [updated] = await activeDb
        .update(projectUserPreferences)
        .set({ currentWorkId: workId, updatedAt: new Date() })
        .where(
          and(
            eq(projectUserPreferences.userId, userId),
            eq(projectUserPreferences.projectId, projectId),
            expectedWorkId === null
              ? isNull(projectUserPreferences.currentWorkId)
              : eq(projectUserPreferences.currentWorkId, expectedWorkId),
          ),
        )
        .returning({ userId: projectUserPreferences.userId });
      if (updated) return true;
      if (expectedWorkId !== null) return false;

      const [inserted] = await activeDb
        .insert(projectUserPreferences)
        .values({ userId, projectId, currentWorkId: workId })
        .onConflictDoNothing()
        .returning({ userId: projectUserPreferences.userId });
      return Boolean(inserted);
    },
  };
}
