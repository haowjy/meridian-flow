/**
 * Shared conformance suite for WorkbenchPreferencesRepository adapters so Drizzle and in-memory preserve identical default-read and partial-upsert semantics.
 */
import { DEFAULT_WORKBENCH_PREFERENCES } from "@meridian/contracts/preferences";
import { describe, expect, it } from "vitest";
import type { WorkbenchPreferencesRepository } from "../../ports/index.js";

export function describeWorkbenchPreferencesRepositoryConformance(
  name: string,
  makeRepo: () => WorkbenchPreferencesRepository | Promise<WorkbenchPreferencesRepository>,
): void {
  describe(`WorkbenchPreferencesRepository conformance: ${name}`, () => {
    it("returns default preferences when no row exists", async () => {
      const repo = await makeRepo();

      await expect(repo.read("user-1", "workbench-1")).resolves.toEqual(
        DEFAULT_WORKBENCH_PREFERENCES,
      );
    });

    it("merges partial updates onto defaults and existing preferences", async () => {
      const repo = await makeRepo();

      await expect(
        repo.upsert("user-1", "workbench-1", { threadGroupBy: "date" }),
      ).resolves.toEqual({
        threadGroupBy: "date",
        pinnedThreadIds: [],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      });

      await expect(
        repo.upsert("user-1", "workbench-1", { pinnedThreadIds: ["thread-1", "thread-2"] }),
      ).resolves.toEqual({
        threadGroupBy: "date",
        pinnedThreadIds: ["thread-1", "thread-2"],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      });
    });

    it("scopes preferences by both user and workbench", async () => {
      const repo = await makeRepo();

      await repo.upsert("user-1", "workbench-1", { threadGroupBy: "flat" });
      await repo.upsert("user-1", "workbench-2", { pinnedThreadIds: ["workbench-2-thread"] });
      await repo.upsert("user-2", "workbench-1", { threadGroupBy: "date" });

      await expect(repo.read("user-1", "workbench-1")).resolves.toEqual({
        threadGroupBy: "flat",
        pinnedThreadIds: [],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      });
      await expect(repo.read("user-1", "workbench-2")).resolves.toEqual({
        threadGroupBy: "work",
        pinnedThreadIds: ["workbench-2-thread"],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      });
      await expect(repo.read("user-2", "workbench-1")).resolves.toEqual({
        threadGroupBy: "date",
        pinnedThreadIds: [],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      });
    });

    it("returns defensive copies of pinned thread ids", async () => {
      const repo = await makeRepo();
      const created = await repo.upsert("user-1", "workbench-1", { pinnedThreadIds: ["a"] });
      created.pinnedThreadIds.push("mutated");

      const read = await repo.read("user-1", "workbench-1");
      expect(read.pinnedThreadIds).toEqual(["a"]);
    });
  });
}
