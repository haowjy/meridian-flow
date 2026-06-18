/**
 * document-session-registry tests — union-of-openers retention lifecycle,
 * deferred teardown grace window, and R14 soft-cap guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const destroyedDocumentIds: string[] = [];

vi.mock("@/core/transport/hocuspocus-document-transport", () => ({
  createHocuspocusDocumentTransport: () => ({
    whenSynced: Promise.resolve(),
    synced: true,
    subscribeStatus: (listener: (state: { kind: "connected" }) => void) => {
      listener({ kind: "connected" });
      return () => {};
    },
    destroy: () => {},
  }),
}));

vi.mock("./document-session", async (importOriginal) => {
  const original = await importOriginal<typeof import("./document-session")>();
  return {
    ...original,
    DocumentSession: class extends original.DocumentSession {
      override async destroy(): Promise<void> {
        destroyedDocumentIds.push(this.documentId);
        await super.destroy();
      }
    },
  };
});

import { getDocumentSessionRegistry } from "./document-session-registry";

const DESKTOP_OWNER = "desktop-context-editor-mount-host";
const TEARDOWN_GRACE_MS = 3_000;

describe("DocumentSessionRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    getDocumentSessionRegistry().destroyAll();
    destroyedDocumentIds.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a session alive while any opener retains the document", () => {
    const registry = getDocumentSessionRegistry();

    registry.retain("desktop", ["doc-a"]);
    expect(registry.has("doc-a")).toBe(true);

    registry.retain("mobile", ["doc-a"]);
    expect(registry.has("doc-a")).toBe(true);

    registry.release("desktop");
    expect(registry.has("doc-a")).toBe(true);
    expect(destroyedDocumentIds).toEqual([]);

    registry.release("mobile");
    expect(registry.has("doc-a")).toBe(true);
    expect(destroyedDocumentIds).toEqual([]);

    vi.advanceTimersByTime(TEARDOWN_GRACE_MS);
    expect(registry.has("doc-a")).toBe(false);
    expect(destroyedDocumentIds).toEqual(["doc-a"]);
  });

  it("reconciles the union of open sets across retain updates", () => {
    const registry = getDocumentSessionRegistry();

    registry.retain("owner-a", ["doc-1", "doc-2"]);
    registry.retain("owner-b", ["doc-2", "doc-3"]);
    expect(registry.has("doc-1")).toBe(true);
    expect(registry.has("doc-2")).toBe(true);
    expect(registry.has("doc-3")).toBe(true);

    registry.retain("owner-a", ["doc-1"]);
    expect(registry.has("doc-2")).toBe(true);
    expect(registry.has("doc-3")).toBe(true);

    registry.retain("owner-b", []);
    expect(registry.has("doc-1")).toBe(true);
    expect(registry.has("doc-2")).toBe(true);
    expect(registry.has("doc-3")).toBe(true);
    expect(destroyedDocumentIds).toEqual([]);

    vi.advanceTimersByTime(TEARDOWN_GRACE_MS);
    expect(registry.has("doc-1")).toBe(true);
    expect(registry.has("doc-2")).toBe(false);
    expect(registry.has("doc-3")).toBe(false);
    expect(destroyedDocumentIds.sort()).toEqual(["doc-2", "doc-3"]);

    registry.release("owner-a");
    expect(registry.has("doc-1")).toBe(true);
    expect(destroyedDocumentIds.sort()).toEqual(["doc-2", "doc-3"]);

    vi.advanceTimersByTime(TEARDOWN_GRACE_MS);
    expect(registry.has("doc-1")).toBe(false);
    expect(destroyedDocumentIds.sort()).toEqual(["doc-1", "doc-2", "doc-3"]);
  });

  it("does not destroy on rapid release then retain within the grace window", () => {
    const registry = getDocumentSessionRegistry();
    const sessionBefore = registry.get("doc-a");

    // Mirrors React strict mode: mount retain → unmount release → remount retain.
    registry.retain(DESKTOP_OWNER, ["doc-a"]);
    registry.release(DESKTOP_OWNER);
    registry.retain(DESKTOP_OWNER, ["doc-a"]);

    expect(registry.has("doc-a")).toBe(true);
    expect(registry.get("doc-a")).toBe(sessionBefore);
    expect(destroyedDocumentIds).toEqual([]);

    vi.advanceTimersByTime(TEARDOWN_GRACE_MS - 1);
    expect(registry.has("doc-a")).toBe(true);
    expect(destroyedDocumentIds).toEqual([]);
  });

  it("destroys after the grace window when release is not followed by retain", () => {
    const registry = getDocumentSessionRegistry();

    registry.retain(DESKTOP_OWNER, ["doc-a"]);
    registry.release(DESKTOP_OWNER);

    expect(registry.has("doc-a")).toBe(true);
    expect(destroyedDocumentIds).toEqual([]);

    vi.advanceTimersByTime(TEARDOWN_GRACE_MS);
    expect(registry.has("doc-a")).toBe(false);
    expect(destroyedDocumentIds).toEqual(["doc-a"]);
  });

  it("destroyAll cancels pending teardown timers and destroys immediately", () => {
    const registry = getDocumentSessionRegistry();

    registry.retain(DESKTOP_OWNER, ["doc-a", "doc-b"]);
    registry.release(DESKTOP_OWNER);
    expect(destroyedDocumentIds).toEqual([]);

    registry.destroyAll();
    expect(destroyedDocumentIds.sort()).toEqual(["doc-a", "doc-b"]);

    vi.advanceTimersByTime(TEARDOWN_GRACE_MS);
    expect(destroyedDocumentIds.sort()).toEqual(["doc-a", "doc-b"]);
  });

  it("warns once when live session count exceeds the soft cap", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = getDocumentSessionRegistry();
    const ids = Array.from({ length: 51 }, (_, index) => `doc-${index}`);

    registry.retain("test-owner", ids);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("exceeds soft cap");
  });
});
