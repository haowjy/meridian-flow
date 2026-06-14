// @ts-nocheck
/** Route-core tests for GET/PUT project preferences: verifies ownership gating, default reads, partial persistence, and body validation. */
import { DEFAULT_PROJECT_PREFERENCES } from "@meridian/contracts/preferences";
import { describe, expect, it } from "vitest";
import { createInMemoryPackageStore } from "../domains/packages/index.js";
import { createInMemoryProjectPreferencesRepository } from "../domains/preferences/index.js";
import { createInMemoryProjectRepository as createProjects } from "../domains/projects/index.js";
import {
  handleGetProjectPreferencesRequest,
  handlePutProjectPreferencesRequest,
  parseUpdateProjectPreferencesRequest,
} from "./project-preferences-route.js";

function makeDeps() {
  return {
    projectRepo: createProjects(),
    preferences: createInMemoryProjectPreferencesRepository(),
    packageRepository: createInMemoryPackageStore({
      agents: [
        {
          id: "agent-1",
          projectId: null,
          slug: "segmentation",
          body: "",
          meta: { name: "Segmentation", mode: "primary" },
          config: {},
          packageInstallId: null,
          originalContentChecksum: null,
          sourceType: "builtin",
          enabled: true,
        },
      ],
    }),
  };
}

describe("project preferences route core", () => {
  it("returns defaults for an owned project without a preference row", async () => {
    const { projectRepo, preferences, packageRepository } = makeDeps();
    await projectRepo.create({ id: "project-1", userId: "user-1" });

    await expect(
      handleGetProjectPreferencesRequest(
        { projectRepo, preferences, packageRepository },
        { projectId: "project-1", userId: "user-1" },
      ),
    ).resolves.toEqual({ preferences: DEFAULT_PROJECT_PREFERENCES });
  });

  it("persists partial preference updates per user and project", async () => {
    const { projectRepo, preferences, packageRepository } = makeDeps();
    await projectRepo.create({ id: "project-1", userId: "user-1" });

    await expect(
      handlePutProjectPreferencesRequest(
        { projectRepo, preferences, packageRepository },
        { projectId: "project-1", userId: "user-1", body: { pinnedThreadIds: ["t1"] } },
      ),
    ).resolves.toEqual({
      preferences: {
        threadGroupBy: "work",
        pinnedThreadIds: ["t1"],
        defaultAgentSlug: null,
        autoResume: DEFAULT_PROJECT_PREFERENCES.autoResume,
      },
    });

    await expect(
      handlePutProjectPreferencesRequest(
        { projectRepo, preferences, packageRepository },
        { projectId: "project-1", userId: "user-1", body: { threadGroupBy: "flat" } },
      ),
    ).resolves.toEqual({
      preferences: {
        threadGroupBy: "flat",
        pinnedThreadIds: ["t1"],
        defaultAgentSlug: null,
        autoResume: DEFAULT_PROJECT_PREFERENCES.autoResume,
      },
    });
  });

  it("rejects unknown defaultAgentSlug values", async () => {
    const { projectRepo, preferences, packageRepository } = makeDeps();
    await projectRepo.create({ id: "project-1", userId: "user-1" });

    await expect(
      handlePutProjectPreferencesRequest(
        { projectRepo, preferences, packageRepository },
        { projectId: "project-1", userId: "user-1", body: { defaultAgentSlug: "missing" } },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects non-owner access before writing preferences", async () => {
    const { projectRepo, preferences, packageRepository } = makeDeps();
    await projectRepo.create({ id: "project-1", userId: "owner" });

    await expect(
      handlePutProjectPreferencesRequest(
        { projectRepo, preferences, packageRepository },
        { projectId: "project-1", userId: "intruder", body: { threadGroupBy: "date" } },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(preferences.read("intruder", "project-1")).resolves.toEqual(
      DEFAULT_PROJECT_PREFERENCES,
    );
  });

  it("validates the PUT body contract", () => {
    expect(parseUpdateProjectPreferencesRequest({ threadGroupBy: "date" })).toEqual({
      threadGroupBy: "date",
    });
    expect(parseUpdateProjectPreferencesRequest({ pinnedThreadIds: ["a", "b"] })).toEqual({
      pinnedThreadIds: ["a", "b"],
    });
    expect(parseUpdateProjectPreferencesRequest({ defaultAgentSlug: "segmentation" })).toEqual({
      defaultAgentSlug: "segmentation",
    });
    expect(parseUpdateProjectPreferencesRequest({ defaultAgentSlug: null })).toEqual({
      defaultAgentSlug: null,
    });
    expect(
      parseUpdateProjectPreferencesRequest({ autoResume: { enabled: false, timeoutMs: 1000 } }),
    ).toEqual({
      autoResume: { enabled: false, timeoutMs: 1000 },
    });
    expect(() => parseUpdateProjectPreferencesRequest({ threadGroupBy: "workish" })).toThrow();
    expect(() => parseUpdateProjectPreferencesRequest({ pinnedThreadIds: ["a", 1] })).toThrow();
    expect(() =>
      parseUpdateProjectPreferencesRequest({ autoResume: { enabled: true, timeoutMs: 0 } }),
    ).toThrow();
  });
});
