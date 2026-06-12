// @ts-nocheck
/**
 * In-memory WorkbenchPreferencesRepository for tests/local composition. Map-backed by (userId, workbenchId), mirroring the Drizzle adapter's read-default and partial-upsert behavior.
 */
import type { UserId, WorkbenchId } from "@meridian/contracts/runtime";
import {
  copyWorkbenchPreferences,
  defaultWorkbenchPreferences,
  mergeWorkbenchPreferences,
} from "../../domain.js";
import type { WorkbenchPreferencesRepository } from "../../ports/index.js";

function preferenceKey(userId: UserId, workbenchId: WorkbenchId): string {
  return `${userId}\u0000${workbenchId}`;
}

export function createInMemoryWorkbenchPreferencesRepository(): WorkbenchPreferencesRepository {
  const rows = new Map<string, ReturnType<typeof defaultWorkbenchPreferences>>();

  return {
    async read(userId, workbenchId) {
      const row = rows.get(preferenceKey(userId, workbenchId));
      return row ? copyWorkbenchPreferences(row) : defaultWorkbenchPreferences();
    },

    async upsert(userId, workbenchId, input) {
      const key = preferenceKey(userId, workbenchId);
      const merged = mergeWorkbenchPreferences(rows.get(key), input);
      rows.set(key, copyWorkbenchPreferences(merged));
      return merged;
    },
  };
}
