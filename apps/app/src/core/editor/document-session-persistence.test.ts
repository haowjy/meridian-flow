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
    persistence.clearData.mockClear();
    persistence.destroy.mockClear();
    persistence.createWhenSynced.mockReset().mockResolvedValue();
  });

  it("preserves IndexedDB when a never-attached session is destroyed", async () => {
    const session = new DocumentSession({
      roomKey: "doc-never-materialized",
      enableIndexedDb: true,
    });

    await session.destroy();

    expect(persistence.destroy).toHaveBeenCalledOnce();
    expect(persistence.clearData).not.toHaveBeenCalled();
  });

  it("preserves an attached room cache unless cleanup is explicitly requested", async () => {
    const session = new DocumentSession({ roomKey: "doc-materialized", enableIndexedDb: true });
    session.attachTransport(() => ({ destroy: vi.fn() }));

    await session.destroy();

    expect(persistence.destroy).toHaveBeenCalledOnce();
    expect(persistence.clearData).not.toHaveBeenCalled();
  });

  it("can explicitly clear an attached room cache after server deletion", async () => {
    const session = new DocumentSession({ roomKey: "doc-deleted", enableIndexedDb: true });
    session.attachTransport(() => ({ destroy: vi.fn() }));

    await session.destroy({ clearPersistence: true });

    expect(persistence.clearData).toHaveBeenCalledOnce();
    expect(persistence.destroy).not.toHaveBeenCalled();
  });

  it("can explicitly clear a detached empty room cache after confirmed cleanup", async () => {
    const session = new DocumentSession({ roomKey: "doc-empty", enableIndexedDb: true });

    await session.destroy({ clearPersistence: true });

    expect(persistence.clearData).toHaveBeenCalledOnce();
    expect(persistence.destroy).not.toHaveBeenCalled();
  });

  it("settles whenSynced when a detached session is destroyed before local sync", async () => {
    persistence.createWhenSynced.mockReturnValue(new Promise(() => {}));
    const session = new DocumentSession({ roomKey: "doc-local-pending", enableIndexedDb: true });
    const synced = session.whenSynced();

    await session.destroy();

    await expect(synced).resolves.toBeUndefined();
  });
});
