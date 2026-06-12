/**
 * Shared conformance suite for WorkbenchPreferencesRepository adapters so Drizzle and in-memory preserve identical default-read and partial-upsert semantics.
 */
import { DEFAULT_WORKBENCH_PREFERENCES } from "@meridian/contracts/preferences";
import { describe, expect, it } from "vitest";
import type { WorkbenchPreferencesRepository } from "../../ports/index.js";

type PreferencesConformanceIds = {
  userId: string;
  otherUserId: string;
  workbenchId: string;
  otherWorkbenchId: string;
};

const defaultIds: PreferencesConformanceIds = {
  userId: "user-1",
  otherUserId: "user-2",
  workbenchId: "workbench-1",
  otherWorkbenchId: "workbench-2",
};

export function describeWorkbenchPreferencesRepositoryConformance(
  name: string,
  makeRepo: () => WorkbenchPreferencesRepository | Promise<WorkbenchPreferencesRepository>,
  ids: PreferencesConformanceIds = defaultIds,
): void {
  describe(`WorkbenchPreferencesRepository conformance: ${name}`, () => {
    it("returns default preferences when no row exists", async () => {
      const repo = await makeRepo();

      await expect(repo.read(ids.userId, ids.workbenchId)).resolves.toEqual(
        DEFAULT_WORKBENCH_PREFERENCES,
      );
    });

    it("merges partial updates onto defaults and existing preferences", async () => {
      const repo = await makeRepo();

      await expect(
        repo.upsert(ids.userId, ids.workbenchId, { threadGroupBy: "date" }),
      ).resolves.toEqual({
        threadGroupBy: "date",
        pinnedThreadIds: [],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      });

      await expect(
        repo.upsert(ids.userId, ids.workbenchId, { pinnedThreadIds: ["thread-1", "thread-2"] }),
      ).resolves.toEqual({
        threadGroupBy: "date",
        pinnedThreadIds: ["thread-1", "thread-2"],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      });
    });

    it("scopes preferences by both user and workbench", async () => {
      const repo = await makeRepo();

      await repo.upsert(ids.userId, ids.workbenchId, { threadGroupBy: "flat" });
      await repo.upsert(ids.userId, ids.otherWorkbenchId, {
        pinnedThreadIds: ["workbench-2-thread"],
      });
      await repo.upsert(ids.otherUserId, ids.workbenchId, { threadGroupBy: "date" });

      await expect(repo.read(ids.userId, ids.workbenchId)).resolves.toEqual({
        threadGroupBy: "flat",
        pinnedThreadIds: [],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      });
      await expect(repo.read(ids.userId, ids.otherWorkbenchId)).resolves.toEqual({
        threadGroupBy: "work",
        pinnedThreadIds: ["workbench-2-thread"],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      });
      await expect(repo.read(ids.otherUserId, ids.workbenchId)).resolves.toEqual({
        threadGroupBy: "date",
        pinnedThreadIds: [],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      });
    });

    it("returns defensive copies of pinned thread ids", async () => {
      const repo = await makeRepo();
      const created = await repo.upsert(ids.userId, ids.workbenchId, { pinnedThreadIds: ["a"] });
      created.pinnedThreadIds.push("mutated");

      const read = await repo.read(ids.userId, ids.workbenchId);
      expect(read.pinnedThreadIds).toEqual(["a"]);
    });
  });
}
