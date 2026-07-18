import { describe, expect, it } from "vitest";

import {
  acknowledgeWorkingSet,
  clearSnapshotRoutes,
  DeviceWorkingSetStore,
  mutateWorkingSet,
  promoteSnapshotRoute,
  removeSnapshotRoute,
  setSnapshotThread,
  WORKING_SET_STORAGE_KEY,
  type WorkingSetSnapshot,
  type WorkingSetStorage,
} from "./store";

function memoryStorage(initial?: Record<string, string>): WorkingSetStorage {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe("working-set store", () => {
  it("deduplicates promoted routes, moves them to the front, and caps recents at three", () => {
    const first = { scheme: "kb" as const, path: "/first.md" };
    const second = { scheme: "user" as const, path: "/second.md" };
    const third = { scheme: "manuscript" as const, path: "/third.md" };
    const fourth = { scheme: "kb" as const, path: "/fourth.md" };
    let snapshot: WorkingSetSnapshot = { recentRoutes: [], lastThreadId: null };
    for (const route of [first, second, third, fourth, second]) {
      snapshot = promoteSnapshotRoute(snapshot, route);
    }
    expect(snapshot.recentRoutes).toEqual([second, fourth, third]);
    expect(promoteSnapshotRoute(snapshot, second)).toBe(snapshot);
  });

  it("clears and removes routes without changing no-op snapshots", () => {
    const route = { scheme: "kb" as const, path: "/notes.md" };
    const snapshot = { recentRoutes: [route], lastThreadId: null };
    expect(removeSnapshotRoute(snapshot, { scheme: "user", path: "/missing.md" })).toBe(snapshot);
    expect(removeSnapshotRoute(snapshot, route).recentRoutes).toEqual([]);
    expect(clearSnapshotRoutes(snapshot).recentRoutes).toEqual([]);
    const empty = { recentRoutes: [], lastThreadId: null };
    expect(clearSnapshotRoutes(empty)).toBe(empty);
  });

  it("sets a thread only when it changes", () => {
    const snapshot = { recentRoutes: [], lastThreadId: null };
    const changed = setSnapshotThread(snapshot, "thread-1");
    expect(changed.lastThreadId).toBe("thread-1");
    expect(setSnapshotThread(changed, "thread-1")).toBe(changed);
  });

  it("creates pending from the confirmed baseline and bumps its local version", () => {
    const first = mutateWorkingSet(undefined, 7, (snapshot) =>
      promoteSnapshotRoute(snapshot, { scheme: "kb", path: "/notes.md" }),
    );
    expect(first?.pending).toEqual({ baseRevision: 7, localVersion: 1 });
    const second = mutateWorkingSet(first, 99, (snapshot) =>
      setSnapshotThread(snapshot, "thread-1"),
    );
    expect(second?.pending).toEqual({ baseRevision: 7, localVersion: 2 });
    expect(mutateWorkingSet(second, 99, (snapshot) => snapshot)).toBe(second);
  });

  it("drains only the local version acknowledged by the server", () => {
    const sent = {
      snapshot: { recentRoutes: [], lastThreadId: "thread-1" },
      pending: { baseRevision: null, localVersion: 2 },
    };
    expect(acknowledgeWorkingSet(sent, 2, 4)).toEqual({
      status: "drained",
      record: { snapshot: sent.snapshot },
    });
    expect(acknowledgeWorkingSet(sent, 1, 4)).toEqual({
      status: "advanced",
      record: { ...sent, pending: { baseRevision: 4, localVersion: 2 } },
    });
  });

  it("discards another user's persisted state before exposing it", () => {
    const storage = memoryStorage({
      [WORKING_SET_STORAGE_KEY]: JSON.stringify({
        userId: "user-1",
        projects: {
          project: {
            snapshot: {
              recentRoutes: [{ scheme: "kb", path: "/private.md" }],
              lastThreadId: null,
            },
          },
        },
      }),
    });
    const store = new DeviceWorkingSetStore(storage);
    store.setUser("user-2");
    expect(store.read("project")).toBeUndefined();
    expect(storage.getItem(WORKING_SET_STORAGE_KEY)).toBeNull();
  });

  it("round-trips valid records and ignores malformed storage", () => {
    const storage = memoryStorage();
    const writer = new DeviceWorkingSetStore(storage);
    writer.setUser("user-1");
    writer.report("project", null, (snapshot) =>
      promoteSnapshotRoute(snapshot, { scheme: "scratch", path: "/notes.md", workId: "work-1" }),
    );
    const reader = new DeviceWorkingSetStore(storage);
    reader.setUser("user-1");
    expect(reader.read("project")?.snapshot.recentRoutes).toEqual([
      { scheme: "scratch", path: "/notes.md", workId: "work-1" },
    ]);

    const malformed = memoryStorage({ [WORKING_SET_STORAGE_KEY]: "not json" });
    const malformedStore = new DeviceWorkingSetStore(malformed);
    malformedStore.setUser("user-1");
    expect(malformedStore.read("project")).toBeUndefined();
  });
});
