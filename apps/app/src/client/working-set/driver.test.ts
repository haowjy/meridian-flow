import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canSweepWorkingSet, getWorkingSetStorage, WorkingSetSyncDriver } from "./driver";
import {
  DeviceWorkingSetStore,
  reconcileSnapshotContextRoutes,
  type WorkingSetSnapshot,
  workingSetRouteEquals,
} from "./store";

describe("atomic context-route reconciliation", () => {
  it("treats stable identity as part of full equality and adopts the replacement identity", () => {
    const oldRoute = { documentId: "old", scheme: "kb" as const, path: "/shared.md" };
    const newRoute = { documentId: "new", scheme: "kb" as const, path: "/shared.md" };
    const store = new DeviceWorkingSetStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    store.setUser("user-a");
    store.adopt("project-1", { recentRoutes: [oldRoute], lastThreadId: null });

    expect(workingSetRouteEquals(oldRoute, newRoute)).toBe(false);
    store.adopt("project-1", { recentRoutes: [newRoute], lastThreadId: null });
    expect(store.read("project-1")?.snapshot.recentRoutes).toEqual([newRoute]);
  });

  it("removes only unowned locators and promotes in one snapshot result", () => {
    const same = { documentId: "same", scheme: "kb" as const, path: "/same.md" };
    const removed = { documentId: "removed", scheme: "kb" as const, path: "/removed.md" };
    const promoted = { documentId: "promoted", scheme: "manuscript" as const, path: "/next.md" };

    expect(
      reconcileSnapshotContextRoutes(
        { recentRoutes: [removed, same, promoted], lastThreadId: "thread-1" },
        {
          removedLocators: [removed, same],
          survivingOwnedLocators: [same, promoted],
          promote: promoted,
          clearAll: false,
        },
      ),
    ).toEqual({ recentRoutes: [promoted, same], lastThreadId: "thread-1" });
  });

  it("replaces a same-ID move in place without promoting it", () => {
    const first = { documentId: "first", scheme: "kb" as const, path: "/first.md" };
    const moved = { documentId: "moved", scheme: "kb" as const, path: "/old.md" };
    const replacement = { ...moved, path: "/new.md" };
    expect(
      reconcileSnapshotContextRoutes(
        { recentRoutes: [first, moved], lastThreadId: null },
        {
          removedLocators: [moved],
          survivingOwnedLocators: [first, replacement],
          promote: null,
          clearAll: false,
        },
      ),
    ).toEqual({ recentRoutes: [first, replacement], lastThreadId: null });
  });
});

const pendingRecord = {
  snapshot: { recentRoutes: [], lastThreadId: null },
  pending: { baseRevision: null, localVersion: 1 },
};

const pendingDriverRequests = new Map<Promise<unknown>, () => void>();

function trackDriverRequests<Args extends unknown[], Result>(
  request: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return (...args) => {
    let cancel: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new Error("driver test cleanup"));
    });
    const pending = Promise.race([request(...args), cancelled]);
    pendingDriverRequests.set(pending, cancel);
    void pending.then(
      () => pendingDriverRequests.delete(pending),
      () => pendingDriverRequests.delete(pending),
    );
    return pending;
  };
}

async function disposeDriver(driver: WorkingSetSyncDriver | undefined): Promise<void> {
  driver?.configure("test-cleanup", false);
  const requests = [...pendingDriverRequests.entries()];
  for (const [, cancel] of requests) cancel();
  await Promise.allSettled(requests.map(([request]) => request));
  await Promise.resolve();
  if (vi.isFakeTimers()) {
    await vi.runAllTimersAsync();
    vi.clearAllTimers();
  }
}

function promoteRoute(
  driver: WorkingSetSyncDriver,
  projectId: string,
  route: WorkingSetRoute,
): void {
  driver.reconcileContextRoutes(projectId, {
    removedLocators: [],
    survivingOwnedLocators: [route],
    promote: route,
    clearAll: false,
  });
}

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
  let driver: WorkingSetSyncDriver | undefined;

  afterEach(async () => {
    await disposeDriver(driver);
    driver = undefined;
    vi.useRealTimers();
  });

  it("adopts a server revision once and returns its seeding plan on a strict-mode replay", () => {
    const storage = {
      getItem: () => null,
      setItem: vi.fn(),
      removeItem: () => undefined,
    };
    const store = new DeviceWorkingSetStore(storage);
    driver = new WorkingSetSyncDriver(store, vi.fn());
    const result = {
      status: "row" as const,
      row: {
        userId: "user-a",
        projectId: "project-1",
        recentRoutes: [{ documentId: "server", scheme: "kb" as const, path: "/server.md" }],
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
        recentRoutes: [{ documentId: "server", scheme: "kb", path: "/server.md" }],
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
    driver = new WorkingSetSyncDriver(store, vi.fn());
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
  });

  it("requires fresh hydration after sync is re-enabled before pending state can push", async () => {
    vi.useFakeTimers();
    const store = new DeviceWorkingSetStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const put = vi.fn().mockResolvedValue({ revision: 7 });
    driver = new WorkingSetSyncDriver(store, trackDriverRequests(put));
    const serverRow = {
      userId: "user-a",
      projectId: "project-1",
      recentRoutes: [{ documentId: "server", scheme: "kb" as const, path: "/server.md" }],
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
        recentRoutes: [{ documentId: "server", scheme: "kb", path: "/server.md" }],
        lastThreadId: "thread-server",
      },
    });
    driver.flush();
    await vi.runAllTimersAsync();
    expect(put).not.toHaveBeenCalled();
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
    driver = new WorkingSetSyncDriver(store, trackDriverRequests(put));

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
  });
});

describe("working-set browser storage", () => {
  it("deletes obsolete unversioned and partially invalid persisted state", () => {
    const removeItem = vi.fn();
    const storage = {
      getItem: () =>
        JSON.stringify({
          userId: "user-a",
          projects: {
            valid: { snapshot: { recentRoutes: [], lastThreadId: null } },
            obsolete: {
              snapshot: {
                recentRoutes: [{ scheme: "kb", path: "/locator-only.md" }],
                lastThreadId: null,
              },
            },
          },
        }),
      setItem: vi.fn(),
      removeItem,
    };
    const store = new DeviceWorkingSetStore(storage);
    store.setUser("user-a");

    expect(removeItem).toHaveBeenCalledWith("meridian:working-set");
    expect(store.projectIds()).toEqual([]);
  });

  it("reloads the versioned stable-identity DTO without transforming it", () => {
    const documentId = "00000000-0000-0000-0000-000000000001";
    const store = new DeviceWorkingSetStore({
      getItem: () =>
        JSON.stringify({
          schemaVersion: 2,
          userId: "user-a",
          projects: {
            project: {
              snapshot: {
                recentRoutes: [{ documentId, scheme: "scratch", path: "/notes.md", workId: null }],
                lastThreadId: null,
              },
            },
          },
        }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    store.setUser("user-a");
    expect(store.read("project")?.snapshot.recentRoutes).toEqual([
      { documentId, scheme: "scratch", path: "/notes.md", workId: null },
    ]);
  });

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
  let driver: WorkingSetSyncDriver | undefined;

  afterEach(async () => {
    await disposeDriver(driver);
    driver = undefined;
    vi.useRealTimers();
  });

  const serverRowAt = (revision: number) => ({
    userId: "user-a",
    projectId: "project-1",
    recentRoutes: [{ documentId: "server", scheme: "kb" as const, path: `/rev-${revision}.md` }],
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
    driver = new WorkingSetSyncDriver(store, trackDriverRequests(put), trackDriverRequests(get));

    driver.configure("user-a", true);
    driver.hydrate("project-1", { status: "row", row: serverRowAt(22) });
    promoteRoute(driver, "project-1", {
      documentId: "document-route",
      scheme: "kb",
      path: "/local.md",
    });
    expect(store.read("project-1")?.pending).toMatchObject({ baseRevision: 22, localVersion: 1 });

    driver.markSuspectOnReconnect();
    driver.flush();
    await vi.advanceTimersByTimeAsync(0);

    expect(put).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
    expect(store.read("project-1")?.pending).toBeUndefined();
    expect(store.read("project-1")?.snapshot.recentRoutes[0]).toEqual({
      documentId: "server",
      scheme: "kb",
      path: "/rev-23.md",
    });

    promoteRoute(driver, "project-1", {
      documentId: "document-route",
      scheme: "kb",
      path: "/after-reconcile.md",
    });
    driver.flush();
    await vi.runAllTimersAsync();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[1].recentRoutes[0]).toEqual({
      documentId: "document-route",
      scheme: "kb",
      path: "/after-reconcile.md",
    });
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
    driver = new WorkingSetSyncDriver(store, trackDriverRequests(put), trackDriverRequests(get));

    driver.configure("user-a", true);
    driver.hydrate("project-1", { status: "row", row: serverRowAt(22) });
    promoteRoute(driver, "project-1", {
      documentId: "document-route",
      scheme: "kb",
      path: "/local.md",
    });

    driver.markSuspectOnReconnect();
    driver.flush();
    await vi.runAllTimersAsync();

    expect(get).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]?.[1].recentRoutes[0]).toEqual({
      documentId: "document-route",
      scheme: "kb",
      path: "/local.md",
    });
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
    driver = new WorkingSetSyncDriver(store, trackDriverRequests(put), trackDriverRequests(get));

    driver.configure("user-a", true);
    driver.hydrate("project-1", { status: "row", row: serverRowAt(22) });
    promoteRoute(driver, "project-1", {
      documentId: "document-route",
      scheme: "kb",
      path: "/local.md",
    });
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
    driver = new WorkingSetSyncDriver(store, trackDriverRequests(put), trackDriverRequests(get));

    driver.configure("user-a", true);
    driver.hydrate("project-1", { status: "row", row: serverRowAt(22) });
    promoteRoute(driver, "project-1", {
      documentId: "document-route",
      scheme: "kb",
      path: "/local.md",
    });
    driver.markSuspectOnReconnect();
    driver.hydrate("project-1", { status: "row", row: serverRowAt(22) });

    driver.flush();
    await vi.runAllTimersAsync();

    expect(get).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
