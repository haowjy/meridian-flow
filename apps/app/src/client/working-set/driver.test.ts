import { describe, expect, it, vi } from "vitest";

import { canSweepWorkingSet, getWorkingSetStorage, WorkingSetSyncDriver } from "./driver";
import { DeviceWorkingSetStore, type WorkingSetSnapshot } from "./store";

const pendingRecord = {
  snapshot: { recentRoutes: [], lastThreadId: null },
  pending: { baseRevision: null, localVersion: 1 },
};

describe("working-set sweep eligibility", () => {
  it("requires the real toggle, a pending report, and a session baseline", () => {
    expect(canSweepWorkingSet(true, true, pendingRecord)).toBe(true);
    expect(canSweepWorkingSet(false, true, pendingRecord)).toBe(false);
    expect(canSweepWorkingSet(true, false, pendingRecord)).toBe(false);
    expect(
      canSweepWorkingSet(true, true, {
        snapshot: pendingRecord.snapshot,
      }),
    ).toBe(false);
  });
});

describe("working-set identity sessions", () => {
  it("adopts a server revision once and returns its seeding plan on a strict-mode replay", () => {
    const storage = {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: () => undefined,
    };
    const store = new DeviceWorkingSetStore(storage);
    const driver = new WorkingSetSyncDriver(store, vi.fn());
    const result = {
      status: "row" as const,
      row: {
        userId: "user-a",
        projectId: "project-1",
        recentRoutes: [{ scheme: "kb" as const, path: "/server.md" }],
        lastThreadId: "thread-server",
        revision: 3,
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    };
    driver.configure("user-a", true);

    const first = driver.hydrate("project-1", result);
    const second = driver.hydrate("project-1", result);

    expect(second).toBe(first);
    expect(store.read("project-1")).toEqual({
      snapshot: {
        recentRoutes: [{ scheme: "kb", path: "/server.md" }],
        lastThreadId: "thread-server",
      },
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("ignores an old user's acknowledgement before sweeping the new user's pending record", async () => {
    vi.useFakeTimers();
    const store = new DeviceWorkingSetStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const responses: Array<(response: { revision: number }) => void> = [];
    const put = vi.fn(
      (_projectId: string, _snapshot: WorkingSetSnapshot, _keepalive: boolean) =>
        new Promise<{ revision: number }>((resolve) => {
          responses.push(resolve);
        }),
    );
    const driver = new WorkingSetSyncDriver(store, put);

    driver.configure("user-a", true);
    driver.establishBaseline("project-1", { status: "absent" });
    driver.setThread("project-1", "thread-a");
    driver.flush();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    driver.configure("user-b", true);
    driver.establishBaseline("project-1", { status: "absent" });
    driver.setThread("project-1", "thread-b");
    driver.flush();

    responses[0]?.({ revision: 1 });
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1]?.[1]).toEqual({ recentRoutes: [], lastThreadId: "thread-b" });
    expect(store.read("project-1")?.pending?.localVersion).toBe(1);

    responses[1]?.({ revision: 1 });
    await vi.waitFor(() => expect(store.read("project-1")?.pending).toBeUndefined());
    vi.useRealTimers();
  });
});

describe("working-set browser storage", () => {
  it("falls back when the localStorage getter throws", () => {
    const blockedWindow = Object.defineProperty({}, "localStorage", {
      get: () => {
        throw new DOMException("Access denied", "SecurityError");
      },
    }) as Pick<Window, "localStorage">;

    const storage = getWorkingSetStorage(blockedWindow);

    expect(storage.getItem("key")).toBeNull();
    expect(() => storage.setItem("key", "value")).not.toThrow();
    expect(() => storage.removeItem("key")).not.toThrow();
  });
});
