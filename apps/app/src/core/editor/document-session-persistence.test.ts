/** Regression coverage for session IndexedDB teardown.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - IndexedDB teardown policy and retry
 * - one-second persistence readiness timeout
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  destroy: vi.fn(async () => {}),
  createWhenSynced: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("y-indexeddb", () => ({
  IndexeddbPersistence: class {
    readonly whenSynced = persistence.createWhenSynced();
    readonly destroy = persistence.destroy;
  },
}));

const { DocumentSession } = await import("./document-session");

describe("DocumentSession persistence cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
    persistence.destroy.mockReset().mockResolvedValue();
    persistence.createWhenSynced.mockReset().mockResolvedValue();
  });

  it("retries only failed teardown stages", async () => {
    persistence.destroy.mockRejectedValueOnce(new Error("destroy failed"));
    const transportDestroy = vi.fn(async () => undefined);
    const session = new DocumentSession({
      roomKey: "doc-retry-clear",
      persistence: { kind: "indexeddb", key: "test:document-session" },
      transportFactory: () => ({ unacknowledgedUpdates: () => null, destroy: transportDestroy }),
    });
    await session.whenLocalPersistenceSynced();
    await Promise.resolve();

    await expect(session.destroy()).rejects.toThrow("destroy failed");
    await expect(session.destroy()).resolves.toBeUndefined();

    expect(persistence.destroy).toHaveBeenCalledTimes(2);
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

  it("attaches transport after one second when IndexedDB never becomes ready", async () => {
    vi.useFakeTimers();
    persistence.createWhenSynced.mockReturnValue(new Promise(() => {}));
    const transportFactory = vi.fn(() => ({ unacknowledgedUpdates: () => null, destroy: vi.fn() }));
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
