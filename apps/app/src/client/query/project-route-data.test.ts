/**
 * project-route-data tests — cover the SSR loader's project-scoped query
 * seeding contract: successful resources seed independently, failed resources
 * stay null, and expected optimistic-create races do not log noise.
 */

import {
  DEFAULT_PROJECT_PREFERENCES,
  type ProjectPreferences,
} from "@meridian/contracts/preferences";
import type { ThreadListItem, Work } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/client/api/projects-api", () => ({
  listProjectThreads: vi.fn(),
  listProjectWorks: vi.fn(),
  getProjectPreferences: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  getGlobalStartContext: () => undefined,
}));

import {
  getProjectPreferences,
  listProjectThreads,
  listProjectWorks,
} from "@/client/api/projects-api";

import { projectQueryKeys } from "./project-query-keys";
import { loadProjectRouteData, seedProjectRouteData } from "./project-route-data";

const projectId = "00000000-0000-4000-8000-000000000000";

function thread(id: string): ThreadListItem {
  return {
    id,
    projectId,
    workId: null,
    userId: "user_1",
    kind: "primary",
    status: "idle",
    title: id,
    currentAgent: null,
    parentThreadId: null,
    rootThreadId: id,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    work: null,
    waitingForUser: false,
    runningTurnId: null,
  };
}

function work(id: string): Work {
  return {
    id,
    projectId,
    createdByUserId: "user_1",
    title: id,
    visibility: "private",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function preferences(overrides: Partial<ProjectPreferences> = {}): ProjectPreferences {
  return {
    ...DEFAULT_PROJECT_PREFERENCES,
    pinnedThreadIds: ["t-pinned"],
    threadGroupBy: "work",
    ...overrides,
  };
}

describe("loadProjectRouteData", () => {
  beforeEach(() => {
    vi.mocked(listProjectThreads).mockReset();
    vi.mocked(listProjectWorks).mockReset();
    vi.mocked(getProjectPreferences).mockReset();
  });

  it("fetches threads, works, and preferences in parallel and returns all three", async () => {
    vi.mocked(listProjectThreads).mockResolvedValue([thread("t1")]);
    vi.mocked(listProjectWorks).mockResolvedValue([work("w1")]);
    vi.mocked(getProjectPreferences).mockResolvedValue(preferences());

    const data = await loadProjectRouteData(projectId);

    expect(vi.mocked(getProjectPreferences)).toHaveBeenCalledWith(projectId, undefined);
    expect(data).toEqual({
      threads: [thread("t1")],
      works: [work("w1")],
      preferences: preferences(),
    });
  });

  it("returns successful resources when one underlying fetch rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listProjectThreads).mockResolvedValue([thread("t1")]);
    vi.mocked(listProjectWorks).mockResolvedValue([work("w1")]);
    vi.mocked(getProjectPreferences).mockRejectedValue(new Error("boom"));

    const data = await loadProjectRouteData(projectId);

    expect(data).toEqual({
      threads: [thread("t1")],
      works: [work("w1")],
      preferences: null,
    });
    errorSpy.mockRestore();
  });

  it("swallows the expected 'Project not found' race without logging", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listProjectThreads).mockRejectedValue(new Error("Project not found"));
    vi.mocked(listProjectWorks).mockResolvedValue([]);
    vi.mocked(getProjectPreferences).mockResolvedValue(preferences());

    const data = await loadProjectRouteData(projectId);

    expect(data).toEqual({ threads: null, works: [], preferences: preferences() });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("seedProjectRouteData", () => {
  it("seeds project-scoped threads, works, and preferences", () => {
    const client = new QueryClient();
    const prefs = preferences();

    seedProjectRouteData(client, projectId, {
      threads: [thread("t1")],
      works: [work("w1")],
      preferences: prefs,
    });

    expect(client.getQueryData(projectQueryKeys.threads(projectId))).toEqual([thread("t1")]);
    expect(client.getQueryData(projectQueryKeys.works(projectId))).toEqual([work("w1")]);
    expect(client.getQueryData(projectQueryKeys.preferences(projectId))).toEqual(prefs);
  });

  it("does not replace existing cache entries with failed loader data", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.threads(projectId), [thread("existing")]);
    const existingPrefs = preferences({ pinnedThreadIds: ["existing-pin"] });
    client.setQueryData(projectQueryKeys.preferences(projectId), existingPrefs);

    seedProjectRouteData(client, projectId, {
      threads: null,
      works: null,
      preferences: null,
    });

    expect(client.getQueryData(projectQueryKeys.threads(projectId))).toEqual([thread("existing")]);
    expect(client.getQueryData(projectQueryKeys.works(projectId))).toBeUndefined();
    expect(client.getQueryData(projectQueryKeys.preferences(projectId))).toEqual(existingPrefs);
  });
});
