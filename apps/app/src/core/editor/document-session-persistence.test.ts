/** Regression coverage for detached-session IndexedDB cleanup. */

import { afterEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  clearData: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  createWhenSynced: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    readonly whenSynced = persistence.createWhenSynced();
    readonly clearData = persistence.clearData;
    readonly destroy = persistence.destroy;
  },
}));

const { DocumentSession } = await import("./document-session");

describe("DocumentSession persistence cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
    persistence.clearData.mockReset().mockResolvedValue();
    persistence.destroy.mockReset().mockResolvedValue();
    persistence.createWhenSynced.mockReset().mockResolvedValue();
  });

  it.each([
    { attached: false, clearPersistence: false },
    { attached: false, clearPersistence: true },
  ])("cleans persistence with attached=$attached, clear=$clearPersistence", async ({
    attached,
    clearPersistence,
  }) => {
    const session = new DocumentSession({
      roomKey: "doc-cleanup",
      persistence: { kind: "indexeddb", key: "test:document-session" },
    });
    if (attached) session.attachTransport(() => ({ destroy: vi.fn() }));
    await session.destroy({ clearPersistence });
    expect(persistence.clearData).toHaveBeenCalledTimes(clearPersistence ? 1 : 0);
    expect(persistence.destroy).toHaveBeenCalledTimes(clearPersistence ? 0 : 1);
  });

  it("retries only failed teardown stages and freezes the first persistence policy", async () => {
    persistence.clearData.mockRejectedValueOnce(new Error("clear failed"));
    const transportDestroy = vi.fn(async () => undefined);
    const session = new DocumentSession({
      roomKey: "doc-retry-clear",
      persistence: { kind: "indexeddb", key: "test:document-session" },
      transportFactory: () => ({ destroy: transportDestroy }),
    });
    await session.whenLocalPersistenceSynced();
    await Promise.resolve();

    await expect(session.destroy({ clearPersistence: true })).rejects.toThrow("clear failed");
    await expect(session.destroy()).resolves.toBeUndefined();

    expect(persistence.clearData).toHaveBeenCalledTimes(2);
    expect(persistence.destroy).not.toHaveBeenCalled();
    expect(transportDestroy).toHaveBeenCalledOnce();
  });

  it("settles whenSynced when a detached session is destroyed before local sync", async () => {
    persistence.createWhenSynced.mockReturnValue(new Promise(() => {}));
    const session = new DocumentSession({
      roomKey: "doc-local-pending",
      persistence: { kind: "indexeddb", key: "test:document-session" },
    });
    const synced = session.whenSynced();

    await session.destroy();

    await expect(synced).resolves.toBeUndefined();
  });

  it("cancels fresh initialization when destroyed before local replay", async () => {
    persistence.createWhenSynced.mockReturnValue(new Promise(() => {}));
    const session = new DocumentSession({
      roomKey: "doc-fresh-pending",
      persistence: { kind: "indexeddb", key: "test:fresh-pending", fresh: true },
    });
    const initialized = session.hasInitializedLocalContent();
    await session.destroy();
    expect(await initialized).toBe(false);
    expect(persistence.destroy).toHaveBeenCalledOnce();
  });

  it("attaches transport after IndexedDB has replayed local updates", async () => {
    let resolveLocalSync!: () => void;
    persistence.createWhenSynced.mockReturnValue(
      new Promise((resolve) => {
        resolveLocalSync = resolve;
      }),
    );
    const transportFactory = vi.fn(() => ({ destroy: vi.fn() }));

    const session = new DocumentSession({
      roomKey: "doc-local-replay",
      persistence: { kind: "indexeddb", key: "test:document-session" },
      transportFactory,
    });

    expect(transportFactory).not.toHaveBeenCalled();
    resolveLocalSync();
    await session.whenLocalPersistenceSynced();
    await Promise.resolve();

    expect(transportFactory).toHaveBeenCalledOnce();
    await session.destroy();
  });

  it("attaches transport after one second when IndexedDB never becomes ready", async () => {
    vi.useFakeTimers();
    persistence.createWhenSynced.mockReturnValue(new Promise(() => {}));
    const transportFactory = vi.fn(() => ({ destroy: vi.fn() }));
    const session = new DocumentSession({
      roomKey: "doc-local-blocked",
      persistence: { kind: "indexeddb", key: "test:document-session" },
      transportFactory,
    });

    expect(transportFactory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(transportFactory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transportFactory).toHaveBeenCalledOnce();

    await session.destroy();
  });
});
