// @ts-nocheck
/**
 * workbench-route-data tests — cover the SSR loader's workbench-scoped query
 * seeding contract: successful resources seed independently, failed resources
 * stay null, and expected optimistic-create races do not log noise.
 */

import {
  DEFAULT_WORKBENCH_PREFERENCES,
  type WorkbenchPreferences,
} from "@meridian/contracts/preferences";
import type { ThreadListItem, Work } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/client/api/workbenches-api", () => ({
  listWorkbenchThreads: vi.fn(),
  listWorkbenchWorks: vi.fn(),
  getWorkbenchPreferences: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  getGlobalStartContext: () => undefined,
}));

import {
  getWorkbenchPreferences,
  listWorkbenchThreads,
  listWorkbenchWorks,
} from "@/client/api/workbenches-api";

import { workbenchQueryKeys } from "./workbench-query-keys";
import { loadWorkbenchRouteData, seedWorkbenchRouteData } from "./workbench-route-data";

const workbenchId = "00000000-0000-4000-8000-000000000000";

function thread(id: string): ThreadListItem {
  return {
    id,
    workbenchId,
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
    workbenchId,
    title: id,
    description: null,
    status: "active",
    visibility: "private",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function preferences(overrides: Partial<WorkbenchPreferences> = {}): WorkbenchPreferences {
  return {
    ...DEFAULT_WORKBENCH_PREFERENCES,
    pinnedThreadIds: ["t-pinned"],
    threadGroupBy: "work",
    ...overrides,
  };
}

describe("loadWorkbenchRouteData", () => {
  beforeEach(() => {
    vi.mocked(listWorkbenchThreads).mockReset();
    vi.mocked(listWorkbenchWorks).mockReset();
    vi.mocked(getWorkbenchPreferences).mockReset();
  });

  it("fetches threads, works, and preferences in parallel and returns all three", async () => {
    vi.mocked(listWorkbenchThreads).mockResolvedValue([thread("t1")]);
    vi.mocked(listWorkbenchWorks).mockResolvedValue([work("w1")]);
    vi.mocked(getWorkbenchPreferences).mockResolvedValue(preferences());

    const data = await loadWorkbenchRouteData(workbenchId);

    expect(vi.mocked(getWorkbenchPreferences)).toHaveBeenCalledWith(workbenchId, undefined);
    expect(data).toEqual({
      threads: [thread("t1")],
      works: [work("w1")],
      preferences: preferences(),
    });
  });

  it("returns successful resources when one underlying fetch rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listWorkbenchThreads).mockResolvedValue([thread("t1")]);
    vi.mocked(listWorkbenchWorks).mockResolvedValue([work("w1")]);
    vi.mocked(getWorkbenchPreferences).mockRejectedValue(new Error("boom"));

    const data = await loadWorkbenchRouteData(workbenchId);

    expect(data).toEqual({
      threads: [thread("t1")],
      works: [work("w1")],
      preferences: null,
    });
    errorSpy.mockRestore();
  });

  it("swallows the expected 'Workbench not found' race without logging", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listWorkbenchThreads).mockRejectedValue(new Error("Workbench not found"));
    vi.mocked(listWorkbenchWorks).mockResolvedValue([]);
    vi.mocked(getWorkbenchPreferences).mockResolvedValue(preferences());

    const data = await loadWorkbenchRouteData(workbenchId);

    expect(data).toEqual({ threads: null, works: [], preferences: preferences() });
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("seedWorkbenchRouteData", () => {
  it("seeds workbench-scoped threads, works, and preferences", () => {
    const client = new QueryClient();
    const prefs = preferences();

    seedWorkbenchRouteData(client, workbenchId, {
      threads: [thread("t1")],
      works: [work("w1")],
      preferences: prefs,
    });

    expect(client.getQueryData(workbenchQueryKeys.threads(workbenchId))).toEqual([thread("t1")]);
    expect(client.getQueryData(workbenchQueryKeys.works(workbenchId))).toEqual([work("w1")]);
    expect(client.getQueryData(workbenchQueryKeys.preferences(workbenchId))).toEqual(prefs);
  });

  it("does not replace existing cache entries with failed loader data", () => {
    const client = new QueryClient();
    client.setQueryData(workbenchQueryKeys.threads(workbenchId), [thread("existing")]);
    const existingPrefs = preferences({ pinnedThreadIds: ["existing-pin"] });
    client.setQueryData(workbenchQueryKeys.preferences(workbenchId), existingPrefs);

    seedWorkbenchRouteData(client, workbenchId, {
      threads: null,
      works: null,
      preferences: null,
    });

    expect(client.getQueryData(workbenchQueryKeys.threads(workbenchId))).toEqual([
      thread("existing"),
    ]);
    expect(client.getQueryData(workbenchQueryKeys.works(workbenchId))).toBeUndefined();
    expect(client.getQueryData(workbenchQueryKeys.preferences(workbenchId))).toEqual(existingPrefs);
  });
});
