/**
 * Shared conformance suite for ProjectPreferencesRepository adapters so Drizzle and in-memory preserve identical default-read and partial-upsert semantics.
 */
import { DEFAULT_PROJECT_PREFERENCES } from "@meridian/contracts/preferences";
import { describe, expect, it } from "vitest";
import type { ProjectPreferencesRepository } from "../../ports/index.js";

type PreferencesConformanceIds = {
  userId: string;
  otherUserId: string;
  projectId: string;
  otherProjectId: string;
};

const defaultIds: PreferencesConformanceIds = {
  userId: "user-1",
  otherUserId: "user-2",
  projectId: "project-1",
  otherProjectId: "project-2",
};

export function describeProjectPreferencesRepositoryConformance(
  name: string,
  makeRepo: () => ProjectPreferencesRepository | Promise<ProjectPreferencesRepository>,
  ids: PreferencesConformanceIds = defaultIds,
): void {
  describe(`ProjectPreferencesRepository conformance: ${name}`, () => {
    it("returns default preferences when no row exists", async () => {
      const repo = await makeRepo();

      await expect(repo.read(ids.userId, ids.projectId)).resolves.toEqual(
        DEFAULT_PROJECT_PREFERENCES,
      );
    });

    it("merges partial updates onto defaults and existing preferences", async () => {
      const repo = await makeRepo();

      await expect(
        repo.upsert(ids.userId, ids.projectId, { threadGroupBy: "date" }),
      ).resolves.toEqual({
        threadGroupBy: "date",
        pinnedThreadIds: [],
        defaultAgentSlug: null,
        autoResume: DEFAULT_PROJECT_PREFERENCES.autoResume,
      });

      await expect(
        repo.upsert(ids.userId, ids.projectId, { pinnedThreadIds: ["thread-1", "thread-2"] }),
      ).resolves.toEqual({
        threadGroupBy: "date",
        pinnedThreadIds: ["thread-1", "thread-2"],
        defaultAgentSlug: null,
        autoResume: DEFAULT_PROJECT_PREFERENCES.autoResume,
      });
    });

    it("scopes preferences by both user and project", async () => {
      const repo = await makeRepo();

      await repo.upsert(ids.userId, ids.projectId, { threadGroupBy: "flat" });
      await repo.upsert(ids.userId, ids.otherProjectId, {
        pinnedThreadIds: ["project-2-thread"],
      });
      await repo.upsert(ids.otherUserId, ids.projectId, { threadGroupBy: "date" });

      await expect(repo.read(ids.userId, ids.projectId)).resolves.toEqual({
        threadGroupBy: "flat",
        pinnedThreadIds: [],
        defaultAgentSlug: null,
        autoResume: DEFAULT_PROJECT_PREFERENCES.autoResume,
      });
      await expect(repo.read(ids.userId, ids.otherProjectId)).resolves.toEqual({
        threadGroupBy: "work",
        pinnedThreadIds: ["project-2-thread"],
        defaultAgentSlug: null,
        autoResume: DEFAULT_PROJECT_PREFERENCES.autoResume,
      });
      await expect(repo.read(ids.otherUserId, ids.projectId)).resolves.toEqual({
        threadGroupBy: "date",
        pinnedThreadIds: [],
        defaultAgentSlug: null,
        autoResume: DEFAULT_PROJECT_PREFERENCES.autoResume,
      });
    });

    it("returns defensive copies of pinned thread ids", async () => {
      const repo = await makeRepo();
      const created = await repo.upsert(ids.userId, ids.projectId, { pinnedThreadIds: ["a"] });
      created.pinnedThreadIds.push("mutated");

      const read = await repo.read(ids.userId, ids.projectId);
      expect(read.pinnedThreadIds).toEqual(["a"]);
    });
  });
}
