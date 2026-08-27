/**
 * In-memory ProjectPreferencesRepository for tests/local composition. Map-backed by (userId, projectId), mirroring the Drizzle adapter's read-default and partial-upsert behavior.
 */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import {
  copyProjectPreferences,
  defaultProjectPreferences,
  mergeProjectPreferences,
} from "../../domain.js";
import type { ProjectPreferencesRepository } from "../../ports/project-preferences-repository.js";

function preferenceKey(userId: UserId, projectId: ProjectId): string {
  return `${userId}\u0000${projectId}`;
}

export function createInMemoryProjectPreferencesRepository(): ProjectPreferencesRepository {
  const rows = new Map<string, ReturnType<typeof defaultProjectPreferences>>();
  const currentWorkIds = new Map<string, string>();

  return {
    async read(userId, projectId) {
      const row = rows.get(preferenceKey(userId, projectId));
      return row ? copyProjectPreferences(row) : defaultProjectPreferences();
    },

    async upsert(userId, projectId, input) {
      const key = preferenceKey(userId, projectId);
      const merged = mergeProjectPreferences(rows.get(key), input);
      rows.set(key, copyProjectPreferences(merged));
      return merged;
    },

    async getCurrentWorkId(userId, projectId) {
      return currentWorkIds.get(preferenceKey(userId, projectId)) ?? null;
    },

    async setCurrentWorkId(userId, projectId, workId) {
      currentWorkIds.set(preferenceKey(userId, projectId), workId);
    },

    async setCurrentWorkIdIfUnchanged(userId, projectId, expectedWorkId, workId) {
      const key = preferenceKey(userId, projectId);
      if ((currentWorkIds.get(key) ?? null) !== expectedWorkId) return false;
      currentWorkIds.set(key, workId);
      return true;
    },
  };
}
