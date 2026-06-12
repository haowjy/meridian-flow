// @ts-nocheck
/**
 * Drizzle WorkbenchPreferencesRepository: persists (userId, workbenchId) preferences in workbench_user_preferences with atomic partial upserts.
 * Key decision: the conflict update only sets fields present in the partial request, so concurrent independent group/pin writes do not need a read-modify-write round trip.
 */
import type {
  ThreadGroupBy,
  UpdateWorkbenchPreferencesRequest,
  WorkbenchPreferences,
} from "@meridian/contracts/preferences";
import type { UserId, WorkbenchId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { workbenchUserPreferences } from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { defaultWorkbenchPreferences, mergeWorkbenchPreferences } from "../../domain.js";
import type { WorkbenchPreferencesRepository } from "../../ports/index.js";

type WorkbenchPreferencesRow = typeof workbenchUserPreferences.$inferSelect;

function mapPreferences(row: WorkbenchPreferencesRow): WorkbenchPreferences {
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

export interface DrizzleWorkbenchPreferencesRepositoryDeps {
  db: Database;
}

export function createDrizzleWorkbenchPreferencesRepository(
  deps: DrizzleWorkbenchPreferencesRepositoryDeps,
): WorkbenchPreferencesRepository {
  const { db } = deps;

  return {
    async read(userId: UserId, workbenchId: WorkbenchId): Promise<WorkbenchPreferences> {
      const [row] = await db
        .select()
        .from(workbenchUserPreferences)
        .where(
          and(
            eq(workbenchUserPreferences.userId, userId),
            eq(workbenchUserPreferences.workbenchId, workbenchId),
          ),
        )
        .limit(1);
      return row ? mapPreferences(row) : defaultWorkbenchPreferences();
    },

    async upsert(
      userId: UserId,
      workbenchId: WorkbenchId,
      input: UpdateWorkbenchPreferencesRequest,
    ): Promise<WorkbenchPreferences> {
      const defaultsForInsert = mergeWorkbenchPreferences(null, input);
      const set: Partial<typeof workbenchUserPreferences.$inferInsert> = {
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
        .insert(workbenchUserPreferences)
        .values({
          userId,
          workbenchId,
          threadGroupBy: defaultsForInsert.threadGroupBy,
          pinnedThreadIds: defaultsForInsert.pinnedThreadIds,
          defaultAgentSlug: defaultsForInsert.defaultAgentSlug,
          autoResumeEnabled: defaultsForInsert.autoResume?.enabled,
          autoResumeTimeoutMs: defaultsForInsert.autoResume?.timeoutMs,
        })
        .onConflictDoUpdate({
          target: [workbenchUserPreferences.userId, workbenchUserPreferences.workbenchId],
          set,
        })
        .returning();
      if (!row) throw new Error("Failed to upsert workbench preferences");
      return mapPreferences(row);
    },
  };
}
