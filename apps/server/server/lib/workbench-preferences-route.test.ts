// @ts-nocheck
/** Route-core tests for GET/PUT workbench preferences: verifies ownership gating, default reads, partial persistence, and body validation. */
import { DEFAULT_WORKBENCH_PREFERENCES } from "@meridian/contracts/preferences";
import { describe, expect, it } from "vitest";
import { createInMemoryPackageStore } from "../domains/packages/index.js";
import { createInMemoryWorkbenchPreferencesRepository } from "../domains/preferences/index.js";
import { createInMemoryWorkbenchRepository as createWorkbenchs } from "../domains/workbenches/index.js";
import {
  handleGetWorkbenchPreferencesRequest,
  handlePutWorkbenchPreferencesRequest,
  parseUpdateWorkbenchPreferencesRequest,
} from "./workbench-preferences-route.js";

function makeDeps() {
  return {
    workbenchRepo: createWorkbenchs(),
    preferences: createInMemoryWorkbenchPreferencesRepository(),
    packageRepository: createInMemoryPackageStore({
      agents: [
        {
          id: "agent-1",
          workbenchId: null,
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

describe("workbench preferences route core", () => {
  it("returns defaults for an owned workbench without a preference row", async () => {
    const { workbenchRepo, preferences, packageRepository } = makeDeps();
    await workbenchRepo.create({ id: "workbench-1", userId: "user-1" });

    await expect(
      handleGetWorkbenchPreferencesRequest(
        { workbenchRepo, preferences, packageRepository },
        { workbenchId: "workbench-1", userId: "user-1" },
      ),
    ).resolves.toEqual({ preferences: DEFAULT_WORKBENCH_PREFERENCES });
  });

  it("persists partial preference updates per user and workbench", async () => {
    const { workbenchRepo, preferences, packageRepository } = makeDeps();
    await workbenchRepo.create({ id: "workbench-1", userId: "user-1" });

    await expect(
      handlePutWorkbenchPreferencesRequest(
        { workbenchRepo, preferences, packageRepository },
        { workbenchId: "workbench-1", userId: "user-1", body: { pinnedThreadIds: ["t1"] } },
      ),
    ).resolves.toEqual({
      preferences: {
        threadGroupBy: "work",
        pinnedThreadIds: ["t1"],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      },
    });

    await expect(
      handlePutWorkbenchPreferencesRequest(
        { workbenchRepo, preferences, packageRepository },
        { workbenchId: "workbench-1", userId: "user-1", body: { threadGroupBy: "flat" } },
      ),
    ).resolves.toEqual({
      preferences: {
        threadGroupBy: "flat",
        pinnedThreadIds: ["t1"],
        defaultAgentSlug: null,
        autoResume: DEFAULT_WORKBENCH_PREFERENCES.autoResume,
      },
    });
  });

  it("rejects unknown defaultAgentSlug values", async () => {
    const { workbenchRepo, preferences, packageRepository } = makeDeps();
    await workbenchRepo.create({ id: "workbench-1", userId: "user-1" });

    await expect(
      handlePutWorkbenchPreferencesRequest(
        { workbenchRepo, preferences, packageRepository },
        { workbenchId: "workbench-1", userId: "user-1", body: { defaultAgentSlug: "missing" } },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects non-owner access before writing preferences", async () => {
    const { workbenchRepo, preferences, packageRepository } = makeDeps();
    await workbenchRepo.create({ id: "workbench-1", userId: "owner" });

    await expect(
      handlePutWorkbenchPreferencesRequest(
        { workbenchRepo, preferences, packageRepository },
        { workbenchId: "workbench-1", userId: "intruder", body: { threadGroupBy: "date" } },
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(preferences.read("intruder", "workbench-1")).resolves.toEqual(
      DEFAULT_WORKBENCH_PREFERENCES,
    );
  });

  it("validates the PUT body contract", () => {
    expect(parseUpdateWorkbenchPreferencesRequest({ threadGroupBy: "date" })).toEqual({
      threadGroupBy: "date",
    });
    expect(parseUpdateWorkbenchPreferencesRequest({ pinnedThreadIds: ["a", "b"] })).toEqual({
      pinnedThreadIds: ["a", "b"],
    });
    expect(parseUpdateWorkbenchPreferencesRequest({ defaultAgentSlug: "segmentation" })).toEqual({
      defaultAgentSlug: "segmentation",
    });
    expect(parseUpdateWorkbenchPreferencesRequest({ defaultAgentSlug: null })).toEqual({
      defaultAgentSlug: null,
    });
    expect(
      parseUpdateWorkbenchPreferencesRequest({ autoResume: { enabled: false, timeoutMs: 1000 } }),
    ).toEqual({
      autoResume: { enabled: false, timeoutMs: 1000 },
    });
    expect(() => parseUpdateWorkbenchPreferencesRequest({ threadGroupBy: "workish" })).toThrow();
    expect(() => parseUpdateWorkbenchPreferencesRequest({ pinnedThreadIds: ["a", 1] })).toThrow();
    expect(() =>
      parseUpdateWorkbenchPreferencesRequest({ autoResume: { enabled: true, timeoutMs: 0 } }),
    ).toThrow();
  });
});
