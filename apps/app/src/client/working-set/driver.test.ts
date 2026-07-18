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

    expect(second).toEqual(first);
    expect(store.read("project-1")).toEqual({
      snapshot: {
        recentRoutes: [{ scheme: "kb", path: "/server.md" }],
        lastThreadId: "thread-server",
      },
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("re-runs precedence when local state changes under the same server revision", () => {
    vi.useFakeTimers();
    const store = new DeviceWorkingSetStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const driver = new WorkingSetSyncDriver(store, vi.fn());
    const result = {
      status: "row" as const,
      row: {
        userId: "user-a",
        projectId: "project-1",
        recentRoutes: [],
        lastThreadId: null,
        revision: 3,
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    };
    driver.configure("user-a", true);
    expect(driver.hydrate("project-1", result).status).toBe("server");
    driver.setThread("project-1", "thread-local");

    expect(driver.hydrate("project-1", result)).toEqual({ status: "local", revision: 3 });
    expect(store.read("project-1")?.snapshot.lastThreadId).toBe("thread-local");
    vi.useRealTimers();
  });

  it("requires fresh hydration after sync is re-enabled before pending state can push", async () => {
    vi.useFakeTimers();
    const store = new DeviceWorkingSetStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const put = vi.fn().mockResolvedValue({ revision: 7 });
    const driver = new WorkingSetSyncDriver(store, put);
    const serverRow = {
      userId: "user-a",
      projectId: "project-1",
      recentRoutes: [{ scheme: "kb" as const, path: "/server.md" }],
      lastThreadId: "thread-server",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };

    driver.configure("user-a", true);
    driver.hydrate("project-1", { status: "row", row: { ...serverRow, revision: 5 } });
    driver.configure("user-a", false);
    driver.setThread("project-1", "thread-local");
    expect(store.read("project-1")?.pending?.baseRevision).toBe(5);

    driver.configure("user-a", true);
    driver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).not.toHaveBeenCalled();

    expect(
      driver.hydrate("project-1", { status: "row", row: { ...serverRow, revision: 6 } }),
    ).toMatchObject({ status: "server", row: { revision: 6 } });
    expect(store.read("project-1")).toEqual({
      snapshot: {
        recentRoutes: [{ scheme: "kb", path: "/server.md" }],
        lastThreadId: "thread-server",
      },
    });
    driver.flush();
    await vi.runAllTimersAsync();
    expect(put).not.toHaveBeenCalled();
    vi.useRealTimers();
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
    driver.hydrate("project-1", { status: "absent" });
    driver.setThread("project-1", "thread-a");
    driver.flush();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    driver.configure("user-b", true);
    driver.hydrate("project-1", { status: "absent" });
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

describe("suspect baseline recovery", () => {
  const serverRowAt = (revision: number) => ({
    userId: "user-a",
    projectId: "project-1",
    recentRoutes: [{ scheme: "kb" as const, path: `/rev-${revision}.md` }],
    lastThreadId: "thread-server",
    revision,
    updatedAt: "2026-07-17T00:00:00.000Z",
  });

  it("reconciles offline conflict before pushing (S4 interleaving)", async () => {
    vi.useFakeTimers();
    const store = new DeviceWorkingSetStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const get = vi.fn().mockResolvedValueOnce(serverRowAt(23)).mockResolvedValue(serverRowAt(23));
    const put = vi.fn().mockResolvedValue({ revision: 24 });
    const driver = new WorkingSetSyncDriver(store, put, get);

    driver.configure("user-a", true);
    driver.hydrate("project-1", { status: "row", row: serverRowAt(22) });
    driver.promoteRoute("project-1", { scheme: "kb", path: "/local.md" });
    expect(store.read("project-1")?.pending).toMatchObject({ baseRevision: 22, localVersion: 1 });

    driver.markSuspectOnReconnect();
    driver.flush();
    await vi.advanceTimersByTimeAsync(0);

    expect(put).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
    expect(store.read("project-1")?.pending).toBeUndefined();
    expect(store.read("project-1")?.snapshot.recentRoutes[0]).toEqual({
      scheme: "kb",
      path: "/rev-23.md",
    });

    driver.promoteRoute("project-1", { scheme: "kb", path: "/after-reconcile.md" });
    driver.flush();
    await vi.runAllTimersAsync();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[1].recentRoutes[0]).toEqual({
      scheme: "kb",
      path: "/after-reconcile.md",
    });
    vi.useRealTimers();
  });

  it("pushes after offline recovery when the server row still matches", async () => {
    vi.useFakeTimers();
    const store = new DeviceWorkingSetStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const get = vi.fn().mockResolvedValue(serverRowAt(22));
    const put = vi.fn().mockResolvedValue({ revision: 23 });
    const driver = new WorkingSetSyncDriver(store, put, get);

    driver.configure("user-a", true);
    driver.hydrate("project-1", { status: "row", row: serverRowAt(22) });
    driver.promoteRoute("project-1", { scheme: "kb", path: "/local.md" });

    driver.markSuspectOnReconnect();
    driver.flush();
    await vi.runAllTimersAsync();

    expect(get).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[1].recentRoutes[0]).toEqual({ scheme: "kb", path: "/local.md" });
    vi.useRealTimers();
  });

  it("withholds further PUTs after failure until a successful GET", async () => {
    vi.useFakeTimers();
    const store = new DeviceWorkingSetStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(serverRowAt(22));
    const put = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ revision: 23 });
    const driver = new WorkingSetSyncDriver(store, put, get);

    driver.configure("user-a", true);
    driver.hydrate("project-1", { status: "row", row: serverRowAt(22) });
    driver.promoteRoute("project-1", { scheme: "kb", path: "/local.md" });
    driver.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenCalledTimes(1);

    driver.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(put).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);

    driver.flush();
    await vi.runAllTimersAsync();
    expect(get).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not resurrect a confirmed baseline from loader data while suspect", async () => {
    vi.useFakeTimers();
    const store = new DeviceWorkingSetStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const get = vi.fn().mockResolvedValue(serverRowAt(22));
    const put = vi.fn().mockResolvedValue({ revision: 23 });
    const driver = new WorkingSetSyncDriver(store, put, get);

    driver.configure("user-a", true);
    driver.hydrate("project-1", { status: "row", row: serverRowAt(22) });
    driver.promoteRoute("project-1", { scheme: "kb", path: "/local.md" });
    driver.markSuspectOnReconnect();
    driver.hydrate("project-1", { status: "row", row: serverRowAt(22) });

    driver.flush();
    await vi.runAllTimersAsync();

    expect(get).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
